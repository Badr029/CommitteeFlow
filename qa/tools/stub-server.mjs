import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Evidence harness.
 *
 * Serves the real built SPA from `client/dist` with the same Content-Security-
 * Policy the application sets in production, backed by a fixed set of API
 * responses instead of PostgreSQL.
 *
 * This exists because the four frontend defects in the register live entirely in
 * client CSS and markup — they do not depend on the database, and reproducing
 * them must not depend on it either. Nothing here is used by the application.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const distPath = path.join(repoRoot, 'client', 'dist');

/** Byte-for-byte the policy `server/src/app.ts` sends in production. */
export const PRODUCTION_CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

const USER = { id: 'user-1', name: 'Ahmed Hassan', email: 'ahmed@committeeflow.test' };

const SESSION = {
  user: {
    ...USER,
    role: 'PROJECT_ENGINEER',
    canManagePlanConfiguration: false,
    notifyByEmail: true,
    permissions: { canCreateBooking: true, canManagePlanConfiguration: false, canExport: true },
  },
  settings: {
    bookingSlotUniqueness: 'NONE',
    bookingEditPolicy: 'ANY_ENGINEER',
    bookingFutureHorizonMonths: 6,
    notificationAudience: 'ALL_ACTIVE_USERS',
  },
  csrfToken: 'evidence-harness-token',
};

const FIELD_DEFS = [
  ['booking_date', 'Date', 'DATE', 'SYSTEM', true],
  ['booking_time', 'Time', 'TIME', 'SYSTEM', true],
  ['off_no', 'OFF No.', 'TEXT', 'STANDARD', true],
  ['order_name', 'Order Name', 'TEXT', 'STANDARD', true],
  ['committee', 'Committee', 'TEXT', 'STANDARD', true],
  ['qty', 'Qty', 'NUMBER', 'STANDARD', false],
  ['kva', 'KVA', 'NUMBER', 'STANDARD', false],
  ['kv', 'KV', 'TEXT', 'STANDARD', false],
  ['status', 'Status', 'TEXT', 'STANDARD', false],
  ['notes', 'Notes', 'LONG_TEXT', 'STANDARD', false],
  ['customer_name', 'Customer Name', 'TEXT', 'STANDARD', false],
];

const PLAN_FIELDS = {
  fields: FIELD_DEFS.map(([fieldKey, label, fieldType, fieldClass, isRequired], index) => ({
    id: `field-${index + 1}`,
    fieldKey,
    label,
    helpText: fieldKey === 'booking_date' ? 'The day the committee slot is booked for.' : null,
    fieldType,
    fieldClass,
    storageStrategy: 'COLUMN',
    isRequired,
    isVisible: true,
    displayOrder: (index + 1) * 10,
    options: [],
    isActive: true,
    archivedAt: null,
    editability: {
      canRename: true,
      canReorder: true,
      canToggleVisibility: fieldClass !== 'SYSTEM',
      canToggleRequired: fieldClass !== 'SYSTEM',
      canEditOptions: false,
      canChangeType: false,
      canArchive: false,
      lockedReason: fieldClass === 'SYSTEM' ? 'This field is required by the application.' : null,
      populatedBookingCount: 14,
    },
  })),
};

const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function makeBooking(index, [date, time, committee, offNo, order, qty, kva, kv, status, customer, notes]) {
  const [y, m, d] = date.split('-').map(Number);
  return {
    id: `booking-${index}`,
    bookingDate: date,
    bookingTime: time,
    displayDay: WEEKDAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()],
    offNo,
    orderName: order,
    committee,
    qty,
    kva,
    kv,
    status,
    notes,
    customerName: customer,
    customFields: {},
    bookingState: 'ACTIVE',
    cancelledBy: null,
    cancelledAt: null,
    cancellationReason: null,
    dataSource: 'MANUAL',
    externalReference: null,
    createdBy: USER,
    createdAt: '2026-09-01T08:00:00.000Z',
    updatedBy: USER,
    updatedAt: '2026-09-01T08:00:00.000Z',
    version: 1,
  };
}

const ROWS = [
  ['2026-09-09', '09:00', 'North Committee', '202601066', 'Transformer 2B', 3, 1500, 11, 'Planned', 'Aweer Maintenance', null],
  ['2026-09-09', '09:00', 'North Committee', '202501261', 'HV Cable Box', 1, 630, 11, 'Planned', 'Dubai Municipality', 'Cable route confirmed'],
  ['2026-09-09', '13:00', 'South Committee', '202601449', 'Aweer Feeder Pillar', 2, 2000, 33, 'In review', 'Emirates Steel', null],
  ['2026-09-10', '09:00', 'North Committee', '202601401', 'Package Substation 4', 4, 1000, 11, 'Planned', 'ADNOC Onshore', null],
  ['2026-09-10', '14:00', 'HV Committee', '202601512', 'GIS Bay Extension', 1, 4000, 132, 'Planned', 'DEWA', 'Drawings received'],
  ['2026-09-15', '10:00', 'South Committee', '202601588', 'Compact Substation', 2, 800, 11, 'Planned', 'Aldar Properties', null],
  ['2026-09-15', '10:00', 'South Committee', '202601590', 'Distribution Board Set', 12, null, 0.4, 'Done', 'Aldar Properties', null],
  ['2026-09-22', '09:30', 'North Committee', '202601604', 'Dry Type Transformer', 2, 1250, 11, 'Planned', 'Masdar City', null],
  ['2026-09-28', '11:00', 'HV Committee', '202601611', 'Power Transformer 20 MVA', 1, 20000, 132, 'Planned', 'TRANSCO', 'Factory acceptance test'],
  ['2026-09-16', '09:00', 'North Committee', '202601620', 'Unit Substation 11kV', 2, 1600, 11, 'Planned', 'Emaar', null],
  ['2026-09-16', '09:00', 'North Committee', '202601621', 'Auxiliary Transformer', 1, 500, 11, 'Planned', 'Emaar', null],
  ['2026-09-17', '13:30', 'South Committee', '202601633', 'Cast Resin Transformer', 3, 1000, 11, 'In review', 'Sharjah Electricity', null],
  ['2026-09-23', '10:00', 'HV Committee', '202601641', 'GIS Switchgear 132kV', 1, 12000, 132, 'Planned', 'DEWA', 'Type test certificates due'],
  ['2026-09-24', '09:00', 'North Committee', '202601652', 'Package Substation 6', 2, 1250, 11, 'Planned', 'ADNOC Onshore', null],
  ['2026-09-24', '14:00', 'South Committee', '202601660', 'Feeder Pillar Batch', 8, null, 11, 'Planned', 'Etihad Rail', null],
  ['2026-09-29', '09:30', 'North Committee', '202601671', 'Dry Type Transformer 2', 4, 800, 11, 'Done', 'Masdar City', null],
];

const BOOKINGS = ROWS.map((row, index) => makeBooking(index + 1, row));

const BOOKING_LIST = {
  bookings: BOOKINGS,
  facets: {
    committees: ['HV Committee', 'North Committee', 'South Committee'],
    statuses: ['Done', 'In review', 'Planned'],
    creators: [USER],
  },
  range: { from: '2026-09-01', to: '2026-09-30' },
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
};

/** Why a column has no destination — the importer's own wording. */
function reasonFor(header, fieldKey, kvDeclined) {
  if (header === 'KV' && kvDeclined) {
    return 'KV stores a number, but this column holds values like \u201c11/0.4\u201d. Map it to a text field, or ignore it.';
  }
  if (fieldKey === null) {
    return 'No Committee Plan field matches this column. Choose one, or ignore the column.';
  }
  return null;
}

/**
 * A preview of a Committee Plan file whose KV column holds voltage ratios.
 *
 * Shaped exactly like the importer's own response, so the mapping step renders
 * from it as it would from the server. `mode: 'kvIsNumeric'` returns what the
 * pre-fix build answered, when KV was a numeric column and the importer had to
 * decline it rather than file `11/0.4` in it.
 *
 * Both modes leave one column — the sheet's running number — with nowhere to
 * go, which is what stops the drawer at the mapping step in the first place.
 */
function importPreview(mode) {
  const kvDeclined = mode === 'kvIsNumeric';
  const columns = [
    ['Date', 'booking_date', ['2026-09-09', '2026-09-09', '2026-09-10']],
    ['Time', 'booking_time', ['09:00', '10:00', '09:00']],
    ['OFF No.', 'off_no', ['202601066', '202501261', '202601401']],
    ['Order Name', 'order_name', ['Transformer 2B', 'HV Cable Box', 'Package Substation 4']],
    ['Committee', 'committee', ['North Committee', 'Epower', 'North Committee']],
    ['Qty', 'qty', ['3', '1', '4']],
    ['KVA', 'kva', ['1500', '630', '1000']],
    ['KV', kvDeclined ? null : 'kv', ['11/0.4', '22/0.4', '6.6/0.42']],
    ['Serial', null, ['1', '2', '3']],
  ];

  const ROWS_IN = [
    ['2026-09-09', '09:00', '202601066', 'Transformer 2B', 'North Committee', '3', '1500', '11/0.4'],
    ['2026-09-09', '10:00', '202501261', 'HV Cable Box', 'Epower', '1', '630', '22/0.4'],
    ['2026-09-10', '09:00', '202601401', 'Package Substation 4', 'North Committee', '4', '1000', '6.6/0.42'],
  ];
  const KEYS = ['booking_date', 'booking_time', 'off_no', 'order_name', 'committee', 'qty', 'kva', 'kv'];

  const rows = ROWS_IN.map((cells, index) => {
    const display = {};
    const values = {};
    KEYS.forEach((key, position) => {
      if (key === 'kv' && kvDeclined) return;
      display[key] = cells[position];
      values[key] = cells[position];
    });
    return {
      index,
      sourceRowNumber: index + 2,
      status: 'valid',
      issues: [],
      values,
      display,
      duplicate: null,
    };
  });

  return {
    batchId: 'evidence-batch',
    filename: 'Committee Plan for September V5.xlsx',
    fileType: 'XLSX',
    fileSizeBytes: 48_128,
    sheetName: 'CommitteeFlow_Import',
    availableSheets: ['CommitteeFlow_Import'],
    truncated: false,
    columns: columns.map(([header, fieldKey, sampleValues], index) => ({
      header,
      index,
      suggestedFieldKey: fieldKey,
      confidence: fieldKey ? 'exact' : 'uncertain',
      reason: reasonFor(header, fieldKey, kvDeclined),
      sampleValues,
    })),
    mapping: Object.fromEntries(columns.map(([header, fieldKey]) => [header, fieldKey])),
    fields: PLAN_FIELDS.fields.map((field) => ({
      fieldKey: field.fieldKey,
      label: field.label,
      isRequired: field.isRequired,
      fieldType: field.fieldType,
    })),
    rows,
    summary: { total: 3, valid: 3, warnings: 0, errors: 0, duplicates: 0 },
  };
}

/**
 * @param {{ inlineThemeScript?: boolean, signedOut?: boolean, importMode?: string }} options
 *   `inlineThemeScript` restores the pre-fix `index.html`, which carried the
 *   theme bootstrap as an inline <script>. Used only to reproduce DEF-003.
 *   `signedOut` starts the harness with no session, so the sign-in screen is
 *   what the browser lands on.
 *   `importMode` selects which build's importer answers a preview.
 */
export function startStubServer(options = {}) {
  // Session state, so a capture can sign in and out the way a tester would.
  let signedIn = !options.signedOut;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;

    res.setHeader('Content-Security-Policy', PRODUCTION_CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (pathname.startsWith('/api/')) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      if (pathname === '/api/auth/session') {
        if (!signedIn) {
          res.statusCode = 401;
          return res.end(
            JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' } }),
          );
        }
        return res.end(JSON.stringify(SESSION));
      }
      if (pathname === '/api/auth/login') {
        signedIn = true;
        return res.end(JSON.stringify(SESSION));
      }
      if (pathname === '/api/auth/logout') {
        signedIn = false;
        res.statusCode = 204;
        return res.end();
      }
      if (pathname === '/api/imports/preview') {
        return res.end(JSON.stringify(importPreview(options.importMode)));
      }
      if (pathname === '/api/plan-fields') return res.end(JSON.stringify(PLAN_FIELDS));
      if (pathname === '/api/settings') return res.end(JSON.stringify(SESSION.settings));
      if (pathname === '/api/bookings/session-preview') {
        const inSession = BOOKINGS.filter(
          (b) =>
            b.bookingDate === url.searchParams.get('date') &&
            b.bookingTime === url.searchParams.get('time') &&
            b.committee === url.searchParams.get('committee'),
        );
        return res.end(
          JSON.stringify({
            bookingDate: url.searchParams.get('date'),
            bookingTime: url.searchParams.get('time'),
            committee: url.searchParams.get('committee'),
            count: inSession.length,
            bookings: inSession.map((b) => ({
              id: b.id,
              offNo: b.offNo,
              orderName: b.orderName,
              customerName: b.customerName,
              status: b.status,
              createdBy: USER,
            })),
          }),
        );
      }
      if (pathname === '/api/bookings') return res.end(JSON.stringify(BOOKING_LIST));
      if (pathname === '/api/activity') {
        return res.end(JSON.stringify({ entries: [], page: 1, limit: 50, hasMore: false }));
      }
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'stub' } }));
    }

    const filePath = path.join(distPath, pathname);
    if (pathname !== '/' && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      res.setHeader('Content-Type', MIME[path.extname(filePath)] ?? 'application/octet-stream');
      return res.end(fs.readFileSync(filePath));
    }

    let html = fs.readFileSync(path.join(distPath, 'index.html'), 'utf8');
    if (options.inlineThemeScript) {
      // The exact markup that shipped before DEF-003 was fixed.
      html = html.replace(
        /<script src="\/theme-init\.js"><\/script>/,
        `<script>
      (function () {
        try {
          var stored = localStorage.getItem('committeeflow.theme');
          var theme =
            stored === 'light' || stored === 'dark'
              ? stored
              : window.matchMedia('(prefers-color-scheme: dark)').matches
                ? 'dark'
                : 'light';
          document.documentElement.dataset.theme = theme;
        } catch (e) {
          document.documentElement.dataset.theme = 'light';
        }
      })();
    </script>`,
      );
    }
    res.setHeader('Content-Type', MIME['.html']);
    res.end(html);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ port, url: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}
