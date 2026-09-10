import { badRequest } from '../../lib/errors.js';

/**
 * What an uploaded file must survive before a parser is allowed near it.
 *
 * An import endpoint accepts a byte stream from a browser, so the file is
 * hostile until proven otherwise. Three independent checks have to agree —
 * extension, declared MIME type, and the bytes themselves — because each can be
 * forged on its own: an attacker controls the filename and the Content-Type
 * header, and a victim can be tricked into uploading something they did not
 * inspect. The magic number is the only one the sender cannot simply assert.
 *
 * Everything here works on a Buffer held in memory. Nothing is written to disk,
 * so there is no path to traverse, no temporary file to leak, and nothing for a
 * later request to read back (§7).
 */

export type ImportFileType = 'XLSX' | 'XLS' | 'CSV';

/**
 * 5 MB.
 *
 * A Committee Plan month is tens of rows; the reference September workbook is
 * 8 KB. Five megabytes is three orders of magnitude of headroom and still small
 * enough that a hostile upload cannot exhaust the process's memory — which is
 * the point, since parsing happens in memory.
 */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

/**
 * 5000 data rows.
 *
 * Above this the request stops being a plan import and starts being a bulk
 * load, which belongs in a different tool. Bounded so a zip-bomb-shaped
 * spreadsheet — a tiny file that expands to millions of cells — cannot turn
 * into an unbounded loop (§42).
 */
export const MAX_DATA_ROWS = 5000;

/** 60 columns. A plan has eleven; sixty is a wide sheet, not a pivot table. */
export const MAX_COLUMNS = 60;

interface FormatSpec {
  type: ImportFileType;
  extensions: readonly string[];
  mimeTypes: readonly string[];
}

const FORMATS: readonly FormatSpec[] = [
  {
    type: 'XLSX',
    extensions: ['.xlsx'],
    mimeTypes: [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel.sheet.macroEnabled.12',
      'application/octet-stream',
      'application/zip',
      '',
    ],
  },
  {
    type: 'XLS',
    extensions: ['.xls'],
    mimeTypes: ['application/vnd.ms-excel', 'application/msexcel', 'application/octet-stream', ''],
  },
  {
    type: 'CSV',
    extensions: ['.csv'],
    mimeTypes: ['text/csv', 'application/csv', 'text/plain', 'application/octet-stream', ''],
  },
];

export const ACCEPTED_EXTENSIONS = FORMATS.flatMap((f) => f.extensions);

/**
 * Formats that look like a spreadsheet but are refused on purpose.
 *
 * Naming them individually turns "that did not work" into "that will never
 * work, here is why" — and macro-enabled workbooks are refused as a category,
 * not because the parser would run the macros (it would not), but because
 * accepting them invites a workflow where someone mails one around expecting
 * it to behave like Excel.
 */
const EXPLICITLY_REFUSED: Record<string, string> = {
  '.xlsm': 'Macro-enabled workbooks are not accepted. Save the sheet as .xlsx and upload that.',
  '.xlsb': 'Binary workbooks (.xlsb) are not accepted. Save the sheet as .xlsx and upload that.',
  '.pdf':
    'PDF is not supported. CommitteeFlow imports structured spreadsheets only — export the plan as Excel or CSV.',
  '.doc': 'Word documents are not supported. Upload an Excel or CSV file.',
  '.docx': 'Word documents are not supported. Upload an Excel or CSV file.',
  '.txt': 'Plain text is not supported. Save the file as .csv if it is comma-separated.',
  '.numbers': 'Apple Numbers files are not supported. Export as .xlsx or .csv and upload that.',
  '.ods': 'OpenDocument spreadsheets are not supported. Save as .xlsx or .csv and upload that.',
};

/** ZIP local file header — every .xlsx is a zip container. */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
/** OLE2 compound document header — the legacy .xls container. */
const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function startsWith(buffer: Buffer, magic: readonly number[]): boolean {
  if (buffer.length < magic.length) return false;
  return magic.every((byte, index) => buffer[index] === byte);
}

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot).toLowerCase();
}

export interface CheckedUpload {
  type: ImportFileType;
  /** Sanitised for display and storage. Never used as a filesystem path. */
  filename: string;
  sizeBytes: number;
  buffer: Buffer;
}

/**
 * Strips a filename down to something safe to store and echo back.
 *
 * Directory separators and traversal segments are removed rather than escaped:
 * this value is only ever displayed and written to a text column, and the
 * cheapest way to guarantee it can never be resolved as a path is for it to
 * contain no path syntax at all.
 */
export function safeDisplayFilename(original: string): string {
  const base = original.split(/[/\\]/).pop() ?? 'upload';
  const cleaned = base
    .replace(/\.{2,}/g, '.')
    // Control characters would corrupt a log line or a rendered cell.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  const safe = cleaned === '' || cleaned === '.' ? 'upload' : cleaned;
  return safe.length > 255 ? `${safe.slice(0, 200)}…${safe.slice(-40)}` : safe;
}

/**
 * Decides whether a byte stream may be handed to a parser, and as what.
 *
 * Throws a user-facing message on every rejection — never a parser exception,
 * never a path, never a stack (§41).
 */
export function checkUpload(input: {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
}): CheckedUpload {
  const filename = safeDisplayFilename(input.originalname);
  const extension = extensionOf(filename);

  if (input.buffer.length === 0) {
    throw badRequest('That file is empty.');
  }
  if (input.buffer.length > MAX_FILE_BYTES) {
    throw badRequest(
      `That file is ${formatBytes(input.buffer.length)}. The limit is ${formatBytes(MAX_FILE_BYTES)}.`,
    );
  }

  const refusal = EXPLICITLY_REFUSED[extension];
  if (refusal) throw badRequest(refusal);

  const format = FORMATS.find((candidate) => candidate.extensions.includes(extension));
  if (!format) {
    throw badRequest(
      `${extension === '' ? 'That file has no extension' : `${extension} files are not supported`}. Upload an Excel (.xlsx, .xls) or CSV (.csv) file.`,
    );
  }

  // The browser's Content-Type is advisory — a mismatch is worth refusing, but
  // an empty or generic type is normal and is allowed by the format's list.
  const declaredMime = (input.mimetype || '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (!format.mimeTypes.includes(declaredMime)) {
    throw badRequest(
      `That file says it is “${declaredMime}”, which does not match a ${extension} file. Upload an Excel or CSV file.`,
    );
  }

  assertContentMatchesFormat(format.type, input.buffer, extension);

  return {
    type: format.type,
    filename,
    sizeBytes: input.buffer.length,
    buffer: input.buffer,
  };
}

/**
 * The check the sender cannot forge.
 *
 * A `.xlsx` that is not a zip, or a `.xls` that is not an OLE2 document, is
 * either corrupt or renamed — both are refused before a parser sees a byte.
 */
function assertContentMatchesFormat(type: ImportFileType, buffer: Buffer, extension: string): void {
  switch (type) {
    case 'XLSX': {
      if (!startsWith(buffer, ZIP_MAGIC)) {
        if (startsWith(buffer, OLE2_MAGIC)) {
          throw badRequest(
            'That file is named .xlsx but is really an older .xls workbook. Rename it to .xls, or re-save it as .xlsx from Excel.',
          );
        }
        throw badRequest(
          'That .xlsx file is not a valid Excel workbook. It may be corrupted, or renamed from another format.',
        );
      }
      return;
    }
    case 'XLS': {
      if (!startsWith(buffer, OLE2_MAGIC)) {
        if (startsWith(buffer, ZIP_MAGIC)) {
          throw badRequest(
            'That file is named .xls but is really a newer .xlsx workbook. Rename it to .xlsx and upload it again.',
          );
        }
        throw badRequest(
          'That .xls file is not a valid Excel workbook. It may be corrupted, or renamed from another format.',
        );
      }
      return;
    }
    case 'CSV': {
      // CSV has no signature, so the test is the opposite one: it must not be a
      // container pretending to be text.
      if (startsWith(buffer, ZIP_MAGIC) || startsWith(buffer, OLE2_MAGIC)) {
        throw badRequest(
          'That file is named .csv but is really an Excel workbook. Rename it to .xlsx or .xls, or export it as CSV from Excel.',
        );
      }
      if (looksBinary(buffer)) {
        throw badRequest(
          `That ${extension} file does not look like text. Export it as CSV from Excel and upload that.`,
        );
      }
      return;
    }
    default: {
      const never: never = type;
      throw new Error(`unhandled import file type: ${String(never)}`);
    }
  }
}

/**
 * A NUL byte in the first few kilobytes means this is not a text file.
 *
 * Deliberately crude: it exists to catch a binary renamed to `.csv`, not to
 * validate encoding. UTF-8 and UTF-16 text both survive it, and a false
 * positive would only ever be a genuinely binary file.
 */
function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  // UTF-16 text is legitimately full of NULs; recognise its BOM first.
  if (sample.length >= 2) {
    const bom = (sample[0] ?? 0) << 8 | (sample[1] ?? 0);
    if (bom === 0xfffe || bom === 0xfeff) return false;
  }
  return sample.includes(0x00);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
