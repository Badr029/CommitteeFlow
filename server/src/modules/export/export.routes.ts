import { Router } from 'express';
import { asyncHandler, parseQuery } from '../../lib/http.js';
import { currentUser, requireAuth } from '../../middleware/authenticate.js';
import { logger } from '../../lib/logger.js';
import * as planFields from '../plan-config/plan-fields.repository.js';
import { listBookings, listBookingsSchema } from '../bookings/bookings.service.js';
import { buildExcel, buildPdf, exportFileName } from './export.service.js';

/**
 * Export endpoints (spec §18, §38).
 *
 * Available to both roles — a Viewer's job includes producing the sheet for a
 * meeting. The same date-range and filter parameters as the plan view apply, so
 * an export always reproduces exactly what the user is looking at.
 */
export function exportRouter(): Router {
  const router = Router();

  router.use(requireAuth);

  router.get(
    '/excel',
    asyncHandler(async (req, res) => {
      const context = await buildContext(req);
      const buffer = await buildExcel(context);

      res
        .status(200)
        .setHeader(
          'Content-Type',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        )
        .setHeader(
          'Content-Disposition',
          `attachment; filename="${exportFileName(context.range, 'xlsx')}"`,
        )
        .setHeader('Content-Length', String(buffer.byteLength))
        .end(buffer);

      logger.info(
        { userId: context.generatedBy, range: context.range, rows: context.bookings.length, format: 'xlsx' },
        'plan exported',
      );
    }),
  );

  router.get(
    '/pdf',
    asyncHandler(async (req, res) => {
      const context = await buildContext(req);
      const buffer = await buildPdf(context);

      res
        .status(200)
        .setHeader('Content-Type', 'application/pdf')
        .setHeader(
          'Content-Disposition',
          `attachment; filename="${exportFileName(context.range, 'pdf')}"`,
        )
        .setHeader('Content-Length', String(buffer.byteLength))
        .end(buffer);

      logger.info(
        { userId: context.generatedBy, range: context.range, rows: context.bookings.length, format: 'pdf' },
        'plan exported',
      );
    }),
  );

  return router;
}

async function buildContext(req: Parameters<Parameters<typeof asyncHandler>[0]>[0]) {
  const query = parseQuery(listBookingsSchema, req.query);
  const [fields, result] = await Promise.all([planFields.listAll(), listBookings(query)]);

  return {
    fields,
    bookings: result.bookings,
    range: result.range,
    generatedBy: currentUser(req).name,
    generatedAt: new Date(),
  };
}
