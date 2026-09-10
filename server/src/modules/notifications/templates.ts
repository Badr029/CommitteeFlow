import type { Booking, BookingFieldChange } from '@shared/api-types.js';

/**
 * Notification content (spec §16, §17).
 *
 * The email says *what changed* and links to the live plan. It deliberately
 * carries no spreadsheet attachment — attaching a new file to every message is
 * precisely the workflow this product replaces.
 */

export interface BookingNotificationPayload {
  eventType: 'BOOKING_CREATED' | 'BOOKING_UPDATED' | 'BOOKING_CANCELLED' | 'BOOKING_DELETED';
  bookingId: string;
  bookingDate: string;
  bookingTime: string;
  offNo: string | null;
  orderName: string | null;
  committee: string | null;
  actorName: string;
  changes: BookingFieldChange[];
  reason?: string | null;
}

/**
 * One import, one message (spec §32).
 *
 * A forty-row import must not become forty emails, so this payload describes
 * the *batch* rather than a booking. It carries no bookingId at all — inventing
 * one would make a summary masquerade as a single-booking notification.
 */
export interface ImportNotificationPayload {
  eventType: 'PLAN_IMPORTED';
  batchId: string;
  filename: string;
  actorName: string;
  importedRows: number;
  skippedRows: number;
  warningRows: number;
  firstBookingDate: string | null;
  lastBookingDate: string | null;
}

export type NotificationPayload = BookingNotificationPayload | ImportNotificationPayload;

const EVENT_VERB: Record<
  'BOOKING_CREATED' | 'BOOKING_UPDATED' | 'BOOKING_CANCELLED' | 'BOOKING_DELETED',
  string
> = {
  BOOKING_CREATED: 'booked',
  BOOKING_UPDATED: 'updated',
  BOOKING_CANCELLED: 'cancelled',
  /*
   * "removed", not "deleted": the reader needs to know the booking has left the
   * plan, and a cancelled one has not. Saying "deleted" for both would make the
   * two mails indistinguishable, which is the confusion this event exists to
   * avoid.
   */
  BOOKING_DELETED: 'removed',
};

export function buildSubject(payload: NotificationPayload): string {
  if (payload.eventType === 'PLAN_IMPORTED') {
    // Deliberately not "34 bookings imported": the subject is what lands in a
    // crowded inbox, and "the plan changed" is the part that needs reading.
    return `Committee Plan updated: ${payload.importedRows} booking${
      payload.importedRows === 1 ? '' : 's'
    } imported`;
  }
  const identifier = payload.offNo ?? payload.orderName ?? 'a committee slot';
  const verb = EVENT_VERB[payload.eventType];
  return `Committee Plan: ${identifier} ${verb} — ${formatDate(payload.bookingDate)}`;
}

export function buildPayload(
  eventType: BookingNotificationPayload['eventType'],
  booking: Booking,
  actorName: string,
  changes: BookingFieldChange[],
): BookingNotificationPayload {
  return {
    eventType,
    bookingId: booking.id,
    bookingDate: booking.bookingDate,
    bookingTime: booking.bookingTime,
    offNo: booking.offNo,
    orderName: booking.orderName,
    committee: booking.committee,
    actorName,
    changes,
    ...(eventType === 'BOOKING_CANCELLED' ? { reason: booking.cancellationReason } : {}),
  };
}

export interface ImportBatchSummary {
  id: string;
  originalFilename: string;
  importedRows: number;
  skippedRows: number;
  warningRows: number;
  firstBookingDate: string | null;
  lastBookingDate: string | null;
}

export function buildImportPayload(
  batch: ImportBatchSummary,
  actorName: string,
): ImportNotificationPayload {
  return {
    eventType: 'PLAN_IMPORTED',
    batchId: batch.id,
    filename: batch.originalFilename,
    actorName,
    importedRows: batch.importedRows,
    skippedRows: batch.skippedRows,
    warningRows: batch.warningRows,
    firstBookingDate: batch.firstBookingDate,
    lastBookingDate: batch.lastBookingDate,
  };
}

export interface RenderedEmail {
  text: string;
  html: string;
}

export function renderEmail(payload: NotificationPayload, planUrl: string): RenderedEmail {
  if (payload.eventType === 'PLAN_IMPORTED') return renderImportEmail(payload, planUrl);
  const heading = headingFor(payload);
  const facts: Array<[string, string]> = [
    ['Date', `${formatDate(payload.bookingDate)}`],
    ['Time', payload.bookingTime],
  ];
  if (payload.offNo) facts.push(['OFF No.', payload.offNo]);
  if (payload.orderName) facts.push(['Order', payload.orderName]);
  if (payload.committee) facts.push(['Committee', payload.committee]);
  if (payload.reason) facts.push(['Reason', payload.reason]);

  const changeLines = payload.changes.map(
    (change) => `${change.label}: ${formatValue(change.from)} → ${formatValue(change.to)}`,
  );

  const text = [
    heading,
    '',
    ...facts.map(([label, value]) => `${label}: ${value}`),
    ...(changeLines.length > 0 ? ['', 'What changed:', ...changeLines.map((line) => `  ${line}`)] : []),
    '',
    'The Committee Plan in CommitteeFlow is always the current version.',
    `View the current plan: ${planUrl}`,
  ].join('\n');

  const html = `<!doctype html>
<html lang="en"><body style="margin:0;background:#f4f5f7;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a1d21">
  <table role="presentation" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e3e5e8;border-radius:10px">
    <tr><td style="padding:24px 24px 8px">
      <p style="margin:0 0 4px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#6b7280">Committee Plan</p>
      <h1 style="margin:0;font-size:18px;line-height:1.4;font-weight:600">${escapeHtml(heading)}</h1>
    </td></tr>
    <tr><td style="padding:8px 24px">
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;font-size:14px">
        ${facts
          .map(
            ([label, value]) =>
              `<tr><td style="padding:6px 12px 6px 0;color:#6b7280;white-space:nowrap">${escapeHtml(label)}</td><td style="padding:6px 0;font-weight:500">${escapeHtml(value)}</td></tr>`,
          )
          .join('')}
      </table>
    </td></tr>
    ${
      changeLines.length > 0
        ? `<tr><td style="padding:8px 24px">
      <p style="margin:0 0 6px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#6b7280">What changed</p>
      <ul style="margin:0;padding-left:18px;font-size:14px;line-height:1.7">
        ${payload.changes
          .map(
            (change) =>
              `<li><strong>${escapeHtml(change.label)}</strong>: ${escapeHtml(
                formatValue(change.from),
              )} &rarr; ${escapeHtml(formatValue(change.to))}</li>`,
          )
          .join('')}
      </ul>
    </td></tr>`
        : ''
    }
    <tr><td style="padding:16px 24px 24px">
      <a href="${escapeHtml(planUrl)}" style="display:inline-block;background:#0f4c81;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:14px;font-weight:600">View the current plan</a>
      <p style="margin:14px 0 0;font-size:12px;color:#6b7280">CommitteeFlow holds the current Committee Plan. No spreadsheet is attached — the link above is always up to date.</p>
    </td></tr>
  </table>
</body></html>`;

  return { text, html };
}

function headingFor(payload: BookingNotificationPayload): string {
  const identifier = payload.offNo ? `OFF ${payload.offNo}` : (payload.orderName ?? 'a committee slot');
  switch (payload.eventType) {
    case 'BOOKING_CREATED':
      return `${payload.actorName} booked ${identifier}`;
    case 'BOOKING_UPDATED':
      return `${payload.actorName} updated ${identifier}`;
    case 'BOOKING_CANCELLED':
      return `${payload.actorName} cancelled ${identifier}`;
    case 'BOOKING_DELETED':
      return `${payload.actorName} removed ${identifier} from the plan`;
    default: {
      const never: never = payload.eventType;
      return String(never);
    }
  }
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') return JSON.stringify(value);
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- primitives only past this point
  return String(value);
}

function formatDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * Escapes every value interpolated into the HTML body.
 *
 * Notes and custom field values are user-controlled; an email client is just
 * another HTML renderer, so the same rule as the SPA applies (spec §61).
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The one message an import sends (spec §32).
 *
 * Says what the import did to the plan as a whole and which dates it touched,
 * then links to the plan. Individual bookings are not listed: a forty-row
 * import would produce an unreadable wall, and the plan itself is the place to
 * read them.
 */
function renderImportEmail(payload: ImportNotificationPayload, planUrl: string): RenderedEmail {
  const heading = `${payload.actorName} imported bookings into the Committee Plan`;

  const facts: Array<[string, string]> = [
    ['File', payload.filename],
    ['Imported', `${payload.importedRows} booking${payload.importedRows === 1 ? '' : 's'}`],
  ];
  if (payload.skippedRows > 0) facts.push(['Skipped', `${payload.skippedRows} rows`]);
  if (payload.warningRows > 0) facts.push(['Warnings', `${payload.warningRows} rows`]);
  if (payload.firstBookingDate && payload.lastBookingDate) {
    facts.push([
      'Affected dates',
      payload.firstBookingDate === payload.lastBookingDate
        ? formatDate(payload.firstBookingDate)
        : `${formatDate(payload.firstBookingDate)} – ${formatDate(payload.lastBookingDate)}`,
    ]);
  }

  const text = [
    heading,
    '',
    ...facts.map(([label, value]) => `${label}: ${value}`),
    '',
    'The Committee Plan in CommitteeFlow is always the current version.',
    `View the current plan: ${planUrl}`,
  ].join('\n');

  const html = `<!doctype html>
<html lang="en"><body style="margin:0;background:#f4f5f7;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a1d21">
  <table role="presentation" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e3e5e8;border-radius:10px">
    <tr><td style="padding:24px 24px 8px">
      <p style="margin:0 0 4px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#6b7280">Committee Plan</p>
      <h1 style="margin:0;font-size:18px;line-height:1.4;font-weight:600">${escapeHtml(heading)}</h1>
    </td></tr>
    <tr><td style="padding:8px 24px">
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;font-size:14px">
        ${facts
          .map(
            ([label, value]) =>
              `<tr><td style="padding:6px 12px 6px 0;color:#6b7280;white-space:nowrap">${escapeHtml(label)}</td><td style="padding:6px 0;font-weight:500">${escapeHtml(value)}</td></tr>`,
          )
          .join('')}
      </table>
    </td></tr>
    <tr><td style="padding:16px 24px 24px">
      <a href="${escapeHtml(planUrl)}" style="display:inline-block;background:#0f4c81;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:14px;font-weight:600">View the current plan</a>
      <p style="margin:14px 0 0;font-size:12px;color:#6b7280">CommitteeFlow holds the current Committee Plan. No spreadsheet is attached — the link above is always up to date.</p>
    </td></tr>
  </table>
</body></html>`;

  return { text, html };
}
