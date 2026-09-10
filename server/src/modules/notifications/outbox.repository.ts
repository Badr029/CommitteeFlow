import type { Queryable } from '../../db/index.js';
import { queryOne, queryRows } from '../../db/index.js';

/**
 * Transactional outbox (spec §50, §51).
 *
 * A booking write inserts the booking, its history entry and its outbox message
 * in one transaction. SMTP is never on the request path, so a mail server that
 * is slow or down cannot fail — or even delay — a booking.
 */

export type OutboxEventType =
  | 'BOOKING_CREATED'
  | 'BOOKING_UPDATED'
  | 'BOOKING_CANCELLED'
  /** A booking that should never have existed, removed from the plan. */
  | 'BOOKING_DELETED'
  /** One summary per import batch, never one per imported booking (spec §32). */
  | 'PLAN_IMPORTED';
export type OutboxStatus = 'PENDING' | 'SENT' | 'FAILED';

export interface EnqueueEmailInput {
  eventType: OutboxEventType;
  /** Null for events that describe the plan as a whole rather than one booking. */
  bookingId: string | null;
  recipients: string[];
  subject: string;
  payload: Record<string, unknown>;
}

export async function enqueueEmail(
  input: EnqueueEmailInput,
  executor?: Queryable,
): Promise<void> {
  // No recipients is a legitimate state (everyone opted out); the CHECK
  // constraint requires a non-empty array, so skip the row entirely.
  if (input.recipients.length === 0) return;

  await queryOne(
    `INSERT INTO email_outbox (event_type, booking_id, recipients, subject, payload)
     VALUES ($1, $2, $3::text[], $4, $5::jsonb)`,
    [
      input.eventType,
      input.bookingId,
      input.recipients,
      input.subject,
      JSON.stringify(input.payload),
    ],
    executor,
  );
}

export interface OutboxMessage {
  id: number;
  eventType: OutboxEventType;
  bookingId: string | null;
  recipients: string[];
  subject: string;
  payload: Record<string, unknown>;
  attemptCount: number;
}

/**
 * Claims a batch of due messages for this worker.
 *
 * `FOR UPDATE SKIP LOCKED` means several app containers can run the worker
 * concurrently without ever sending the same email twice — no external queue
 * required (spec §74 rules out Kafka/RabbitMQ/Redis for the MVP).
 */
export async function claimDueMessages(
  limit: number,
  tx: Queryable,
): Promise<OutboxMessage[]> {
  const rows = await queryRows<{
    id: number;
    event_type: OutboxEventType;
    booking_id: string | null;
    recipients: string[];
    subject: string;
    payload: Record<string, unknown>;
    attempt_count: number;
  }>(
    `SELECT id, event_type, booking_id, recipients, subject, payload, attempt_count
       FROM email_outbox
      WHERE status <> 'SENT' AND next_attempt_at <= now()
      ORDER BY next_attempt_at, id
      LIMIT $1
      FOR UPDATE SKIP LOCKED`,
    [limit],
    tx,
  );

  return rows.map((row) => ({
    id: row.id,
    eventType: row.event_type,
    bookingId: row.booking_id,
    recipients: row.recipients,
    subject: row.subject,
    payload: row.payload,
    attemptCount: row.attempt_count,
  }));
}

export async function markSent(id: number, executor?: Queryable): Promise<void> {
  await queryOne(
    `UPDATE email_outbox
        SET status = 'SENT', sent_at = now(), attempt_count = attempt_count + 1, last_error = NULL
      WHERE id = $1`,
    [id],
    executor,
  );
}

/**
 * Records a failure and schedules the retry.
 *
 * Backoff is exponential with a ceiling; once `maxAttempts` is reached the row
 * stays FAILED with its last error so an operator can see what happened rather
 * than the message vanishing.
 */
export async function markFailed(
  id: number,
  error: string,
  maxAttempts: number,
  executor?: Queryable,
): Promise<void> {
  await queryOne(
    `UPDATE email_outbox
        SET status = 'FAILED',
            attempt_count = attempt_count + 1,
            last_error = $2,
            next_attempt_at = CASE
              WHEN attempt_count + 1 >= $3 THEN 'infinity'::timestamptz
              ELSE now() + make_interval(secs => least(power(4, attempt_count + 1), 3600))
            END
      WHERE id = $1`,
    [id, error.slice(0, 2000), maxAttempts],
    executor,
  );
}

export async function countByStatus(
  executor?: Queryable,
): Promise<Record<OutboxStatus, number>> {
  const rows = await queryRows<{ status: OutboxStatus; count: number }>(
    'SELECT status, count(*)::int AS count FROM email_outbox GROUP BY status',
    [],
    executor,
  );
  const result: Record<OutboxStatus, number> = { PENDING: 0, SENT: 0, FAILED: 0 };
  for (const row of rows) result[row.status] = row.count;
  return result;
}
