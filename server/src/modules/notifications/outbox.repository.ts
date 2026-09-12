import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { withTransaction, type Queryable, queryOne, queryRows } from '../../db/index.js';

export type OutboxEventType = 'BOOKING_CREATED' | 'BOOKING_UPDATED' | 'BOOKING_CANCELLED' | 'BOOKING_DELETED' | 'PLAN_IMPORTED';
export type OutboxStatus = 'PENDING' | 'SENT' | 'FAILED';
export interface EnqueueEmailInput {
  eventType: OutboxEventType;
  bookingId: string | null;
  recipients: string[];
  subject: string;
  payload: Record<string, unknown>;
}

/** Booking/history/outbox remain in the caller's single transaction. */
export async function enqueueEmail(input: EnqueueEmailInput, executor?: Queryable): Promise<void> {
  if (!input.recipients.length) return;
  await queryOne(`INSERT INTO email_outbox (event_type, booking_id, recipients, subject, payload)
    VALUES ($1, $2, $3::text[], $4, $5::jsonb)`,
  [input.eventType, input.bookingId, [...new Set(input.recipients)], input.subject, JSON.stringify(input.payload)], executor);
}

export interface ClaimedMessage {
  id: number;
  delivery_key: string;
  claim_token: string;
  event_type: OutboxEventType;
  booking_id: string | null;
  created_at: Date;
  claimed_at: Date;
  subject: string;
  payload: Record<string, unknown>;
}
export interface DeliveryBatch {
  batch_no: number;
  remaining_recipients: string[];
  attempt_count: number;
}

/** Claim only work about to run. Claims survive COMMIT and are fenced by UUID. */
export async function claimMessage(): Promise<ClaimedMessage | undefined> {
  const config = env();
  return withTransaction(async (tx) => {
    // Crash recovery is conservative: any interrupted SMTP attempt is ambiguous.
    // Lock expired parents before changing children; all delivery paths use this order.
    const expired = await queryRows<{ id: number }>(`SELECT id FROM email_outbox
      WHERE status <> 'SENT' AND lease_until <= clock_timestamp()
      ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`, [config.OUTBOX_BATCH_SIZE], tx);
    for (const row of expired) {
      const interrupted = await queryRows(`UPDATE email_outbox_batches
        SET in_flight = false, status = 'FAILED', last_error = 'DELIVERY_UNKNOWN'
        WHERE outbox_id = $1 AND in_flight RETURNING batch_no`, [row.id], tx);
      await queryOne(`UPDATE email_outbox SET claim_token = NULL, lease_until = NULL,
        status = CASE WHEN $2 THEN 'FAILED'::outbox_status ELSE status END,
        last_error = CASE WHEN $2 THEN 'DELIVERY_UNKNOWN' ELSE last_error END,
        next_attempt_at = CASE
          WHEN EXISTS (SELECT 1 FROM email_outbox_batches WHERE outbox_id = $1
            AND status <> 'SENT' AND attempt_count >= $3) THEN 'infinity'::timestamptz
          WHEN $2 THEN clock_timestamp() + make_interval(secs => $4)
          ELSE clock_timestamp() END WHERE id = $1`,
      [row.id, interrupted.length > 0, config.OUTBOX_MAX_ATTEMPTS, config.OUTBOX_AMBIGUOUS_RETRY_SECONDS], tx);
    }
    const message = await queryOne<ClaimedMessage>(`UPDATE email_outbox AS target SET
        claim_token = $1, lease_until = clock_timestamp() + make_interval(secs => $2)
      WHERE target.id = (SELECT candidate.id FROM email_outbox AS candidate
        WHERE candidate.status <> 'SENT' AND candidate.claim_token IS NULL
          AND candidate.next_attempt_at <= clock_timestamp()
          AND NOT EXISTS (SELECT 1 FROM email_outbox AS predecessor
            WHERE predecessor.status <> 'SENT' AND predecessor.id < candidate.id
              AND predecessor.booking_id IS NOT DISTINCT FROM candidate.booking_id)
        ORDER BY candidate.next_attempt_at, candidate.id
        LIMIT 1 FOR UPDATE OF candidate SKIP LOCKED)
      RETURNING target.id, target.delivery_key, target.claim_token,
        target.event_type, target.booking_id, target.created_at,
        clock_timestamp() AS claimed_at, target.subject, target.payload`,
    [randomUUID(), config.OUTBOX_LEASE_SECONDS], tx);
    if (!message) return undefined;
    // Snapshot once, including legacy unsent rows. Existing batches never repartition.
    await queryOne(`INSERT INTO email_outbox_batches
        (outbox_id, batch_no, recipients, remaining_recipients)
      SELECT o.id, n, o.recipients[n*$2+1:(n+1)*$2], o.recipients[n*$2+1:(n+1)*$2]
      FROM email_outbox o CROSS JOIN LATERAL
        generate_series(0, (cardinality(o.recipients)-1)/$2) n
      WHERE o.id = $1 AND NOT EXISTS
        (SELECT 1 FROM email_outbox_batches WHERE outbox_id = o.id)`,
    [message.id, config.OUTBOX_RECIPIENT_BATCH_SIZE], tx);
    return message;
  });
}

/** Count the attempt durably BEFORE sending; crashes cannot reset retry limits. */
export async function beginBatches(message: ClaimedMessage, limit: number): Promise<DeliveryBatch[]> {
  const config = env();
  return withTransaction(async (tx) => {
    const owner = await queryOne(`UPDATE email_outbox
      SET lease_until = clock_timestamp() + make_interval(secs => $3)
      WHERE id = $1 AND claim_token = $2 AND lease_until > clock_timestamp()
        AND status <> 'SENT' RETURNING id`,
    [message.id, message.claim_token, config.OUTBOX_LEASE_SECONDS], tx);
    if (!owner) throw new Error('OUTBOX_CLAIM_LOST');
    const batches = await queryRows<DeliveryBatch>(`UPDATE email_outbox_batches
      SET in_flight = true, attempt_count = attempt_count + 1
      WHERE (outbox_id, batch_no) IN (
        SELECT outbox_id, batch_no FROM email_outbox_batches WHERE outbox_id = $1
          AND status <> 'SENT' AND attempt_count < $2 AND NOT in_flight
          ORDER BY batch_no LIMIT $3 FOR UPDATE SKIP LOCKED)
        AND outbox_id = $1
      RETURNING batch_no, remaining_recipients, attempt_count`,
    [message.id, config.OUTBOX_MAX_ATTEMPTS, limit], tx);
    if (batches.length) await queryOne(`UPDATE email_outbox SET attempt_count = attempt_count + $2 WHERE id = $1`, [message.id, batches.length], tx);
    return batches;
  });
}

export async function beginBatch(message: ClaimedMessage): Promise<DeliveryBatch | undefined> {
  return (await beginBatches(message, 1))[0];
}

/** SMTP result and parent summary commit together; a DB failure leaves the lease. */
export async function finishBatch(message: ClaimedMessage, batch: DeliveryBatch,
  remaining: string[], failure: 'SMTP_REJECTED' | 'DELIVERY_UNKNOWN' | null): Promise<boolean> {
  const config = env();
  return withTransaction(async (tx) => {
    const owner = await queryOne(`SELECT id FROM email_outbox WHERE id = $1
      AND claim_token = $2 AND lease_until > clock_timestamp() AND status <> 'SENT'
      FOR UPDATE`, [message.id, message.claim_token], tx);
    if (!owner) throw new Error('OUTBOX_CLAIM_LOST');
    await queryOne(`UPDATE email_outbox_batches SET remaining_recipients = $3,
      status = CASE WHEN cardinality($3::text[]) = 0 THEN 'SENT'::outbox_status ELSE 'FAILED'::outbox_status END,
      sent_at = CASE WHEN cardinality($3::text[]) = 0 THEN clock_timestamp() ELSE NULL END,
      in_flight = false, last_error = $4 WHERE outbox_id = $1 AND batch_no = $2 AND in_flight`,
    [message.id, batch.batch_no, remaining, failure], tx);
    const unfinished = await queryOne(`SELECT 1 FROM email_outbox_batches WHERE outbox_id = $1 AND status <> 'SENT'`, [message.id], tx);
    if (!unfinished) {
      await queryOne(`UPDATE email_outbox SET status = 'SENT', sent_at = clock_timestamp(),
        last_error = NULL, claim_token = NULL, lease_until = NULL WHERE id = $1`, [message.id], tx);
      return true;
    }
    // Successful siblings do not clear a failure recorded by another child in
    // the same concurrent wave. The wave finalizer owns the parent summary.
    if (failure) {
      const delay = failure === 'DELIVERY_UNKNOWN' ? config.OUTBOX_AMBIGUOUS_RETRY_SECONDS : Math.min(4 ** batch.attempt_count, 3600);
      await queryOne(`UPDATE email_outbox SET status = 'FAILED', last_error = $2,
        next_attempt_at = CASE WHEN $3 >= $4
          THEN 'infinity'::timestamptz ELSE clock_timestamp() + make_interval(secs => $5) END
        WHERE id = $1`, [message.id, failure, batch.attempt_count, config.OUTBOX_MAX_ATTEMPTS, delay], tx);
    }
    return false;
  });
}

/** Summarise a completed child wave and release its fenced parent claim. */
export async function finalizeMessage(message: ClaimedMessage): Promise<boolean> {
  const config = env();
  return withTransaction(async (tx) => {
    const owner = await queryOne(`SELECT id FROM email_outbox WHERE id = $1
      AND claim_token = $2 AND lease_until > clock_timestamp() AND status <> 'SENT'
      FOR UPDATE`, [message.id, message.claim_token], tx);
    if (!owner) return false;
    const state = await queryOne<{ unfinished: number; in_flight: number; exhausted: number }>(`
      SELECT count(*) FILTER (WHERE status <> 'SENT')::int AS unfinished,
             count(*) FILTER (WHERE in_flight)::int AS in_flight,
             count(*) FILTER (WHERE status <> 'SENT' AND attempt_count >= $2)::int AS exhausted
        FROM email_outbox_batches WHERE outbox_id = $1`,
    [message.id, config.OUTBOX_MAX_ATTEMPTS], tx);
    if ((state?.in_flight ?? 0) > 0) return false;
    if ((state?.unfinished ?? 0) === 0) {
      await queryOne(`UPDATE email_outbox SET status = 'SENT', sent_at = clock_timestamp(),
        last_error = NULL, claim_token = NULL, lease_until = NULL WHERE id = $1`, [message.id], tx);
      return true;
    }
    await queryOne(`UPDATE email_outbox SET
      status = CASE WHEN $2 > 0 OR last_error IS NOT NULL THEN 'FAILED'::outbox_status ELSE 'PENDING'::outbox_status END,
      next_attempt_at = CASE WHEN $2 > 0 THEN 'infinity'::timestamptz
        WHEN last_error IS NULL THEN clock_timestamp() ELSE next_attempt_at END,
      claim_token = NULL, lease_until = NULL WHERE id = $1`,
    [message.id, state?.exhausted ?? 0], tx);
    return false;
  });
}

export async function releaseMessage(message: ClaimedMessage): Promise<void> {
  await queryOne(`UPDATE email_outbox SET claim_token = NULL, lease_until = NULL
    WHERE id = $1 AND claim_token = $2 AND status <> 'SENT'
      AND NOT EXISTS (SELECT 1 FROM email_outbox_batches WHERE outbox_id = $1 AND in_flight)`,
  [message.id, message.claim_token]);
}

export async function countByStatus(executor?: Queryable): Promise<Record<OutboxStatus, number>> {
  const rows = await queryRows<{ status: OutboxStatus; count: number }>(
    'SELECT status, count(*)::int AS count FROM email_outbox GROUP BY status', [], executor);
  const result: Record<OutboxStatus, number> = { PENDING: 0, SENT: 0, FAILED: 0 };
  for (const row of rows) result[row.status] = row.count;
  return result;
}
