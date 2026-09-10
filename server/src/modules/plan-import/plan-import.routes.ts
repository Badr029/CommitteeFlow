import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { asyncHandler, noStore, parseQuery, parseUuidParam } from '../../lib/http.js';
import { badRequest } from '../../lib/errors.js';
import { currentUser, requireAuth, requireEngineer } from '../../middleware/authenticate.js';
import { writeRateLimiter } from '../../middleware/rate-limit.js';
import { ACCEPTED_EXTENSIONS, MAX_FILE_BYTES, formatBytes } from './file-guard.js';
import {
  confirmImportSchema,
  confirmImport,
  getBatch,
  listBatches,
  previewImport,
} from './plan-import.service.js';

/**
 * Import routes (spec §39).
 *
 * Two endpoints, and the split is the safety property: `preview` parses and
 * validates but writes no booking, `confirm` writes. An upload can never reach
 * the live plan without a second, deliberate request (§5).
 *
 * The file is held in memory and never written to disk (§7). Multer's own
 * limits are the first bound; `file-guard` then re-checks the bytes, because a
 * limit that only exists in middleware is a limit that moves when middleware
 * is reordered.
 */

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_BYTES,
    files: 1,
    // The multipart body carries a mapping and a row list beside the file.
    fields: 12,
    fieldSize: 512 * 1024,
    parts: 20,
  },
});

/**
 * Turns multer's own failures into the product's error shape.
 *
 * Left alone, a file over the limit surfaces as an unhandled `MulterError` with
 * a stack — exactly what §41 says never to leak.
 */
function singleFile(field: string) {
  const handler = upload.single(field);
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res, (error: unknown) => {
      if (!error) {
        next();
        return;
      }
      if (error instanceof multer.MulterError) {
        switch (error.code) {
          case 'LIMIT_FILE_SIZE':
            next(badRequest(`That file is larger than the ${formatBytes(MAX_FILE_BYTES)} limit.`));
            return;
          case 'LIMIT_FILE_COUNT':
          case 'LIMIT_UNEXPECTED_FILE':
            next(badRequest('Upload one file at a time.'));
            return;
          default:
            next(badRequest('That upload could not be read. Try selecting the file again.'));
            return;
        }
      }
      next(error);
    });
  };
}

function requireFile(req: Request): { originalname: string; mimetype: string; buffer: Buffer } {
  const file = req.file;
  if (!file || !file.buffer) {
    throw badRequest('Choose an Excel or CSV file to import.');
  }
  return { originalname: file.originalname, mimetype: file.mimetype, buffer: file.buffer };
}

/**
 * Multipart fields arrive as strings, so JSON-bearing fields are parsed here
 * rather than trusted. A malformed one is the user's file picker misbehaving,
 * not something to crash on.
 */
function parseJsonField<T>(raw: unknown, schema: z.ZodType<T>, field: string): T | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') throw badRequest(`The ${field} field is malformed.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw badRequest(`The ${field} field is malformed.`);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) throw badRequest(`The ${field} field is malformed.`);
  return result.data;
}

const mappingFieldSchema = z.record(z.string(), z.union([z.string(), z.null()]));
const rowIndexesSchema = z.array(z.number().int().min(0));

const historyQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export function planImportRouter(): Router {
  const router = Router();

  router.use(requireAuth);

  /**
   * Reading import history is available to anyone signed in — it is audit
   * information, and a Viewer being able to see that the plan was imported is
   * the point of recording it.
   */
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const { page, limit } = parseQuery(historyQuerySchema, req.query);
      const { batches, hasMore } = await listBatches(page, limit);
      noStore(res);
      res.json({ batches, page, limit, hasMore });
    }),
  );

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = parseUuidParam(req.params['id']);
      noStore(res);
      res.json(await getBatch(id));
    }),
  );

  /*
   * Everything below writes, or could be used to probe the parser, so it is
   * behind the engineer guard and the write rate limiter. The service repeats
   * the role check at the object level (§42).
   */

  router.post(
    '/preview',
    requireEngineer,
    writeRateLimiter(),
    singleFile('file'),
    asyncHandler(async (req, res) => {
      const file = requireFile(req);
      const body = req.body as Record<string, unknown>;

      const mapping = parseJsonField(body['mapping'], mappingFieldSchema, 'mapping');
      const sheetRaw = body['sheet'];
      const sheet = typeof sheetRaw === 'string' && sheetRaw !== '' ? sheetRaw : undefined;

      const preview = await previewImport(file, { sheet, mapping }, currentUser(req));
      noStore(res);
      res.json(preview);
    }),
  );

  router.post(
    '/:id/confirm',
    requireEngineer,
    writeRateLimiter(),
    singleFile('file'),
    asyncHandler(async (req, res) => {
      const id = parseUuidParam(req.params['id']);
      const file = requireFile(req);
      const body = req.body as Record<string, unknown>;

      const rowIndexes = parseJsonField(body['rowIndexes'], rowIndexesSchema, 'rowIndexes');
      const mapping = parseJsonField(body['mapping'], mappingFieldSchema, 'mapping');
      const sheetRaw = body['sheet'];

      const input = confirmImportSchema.safeParse({
        rowIndexes: rowIndexes ?? [],
        ...(typeof sheetRaw === 'string' && sheetRaw !== '' ? { sheet: sheetRaw } : {}),
        ...(mapping ? { mapping } : {}),
      });
      if (!input.success) {
        throw badRequest('Choose at least one row to import.');
      }

      const result = await confirmImport(id, file, input.data, currentUser(req));
      noStore(res);
      res.status(201).json(result);
    }),
  );

  return router;
}

export { ACCEPTED_EXTENSIONS };
