import { env } from '../../config/env.js';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { logger } from '../../lib/logger.js';
import { getMailer } from './mailer.js';
import * as outbox from './outbox.repository.js';
import { renderEmail, type NotificationPayload } from './templates.js';

/**
 * Outbox worker (spec §50).
 *
 * Runs inside the API process for the MVP. It is written so that moving it to a
 * separate container later is a deployment change, not a rewrite: claiming uses
 * durable leased claims and fenced updates, so workers can run side by side.
 */

let timer: NodeJS.Timeout | undefined;
let running = false;

/**
 * Processes one batch. Exported so tests can drive the worker deterministically
 * instead of waiting on a timer.
 */
export async function processOutboxBatch(): Promise<{ sent: number; failed: number }> {
  const config = env();
  const mailer = getMailer();
  const runId = randomUUID();
  let sent = 0;
  let failed = 0;
  let attemptsStarted = 0;
  let budgetStopLogged = false;
  const startedAt = performance.now();
  const deadline = performance.now() + config.OUTBOX_RUN_BUDGET_MS;
  const minimumStartBudgetMs = config.SMTP_SEND_TIMEOUT_MS + 5_000;
  const remainingBudgetMs = () => Math.max(0, Math.round(deadline - performance.now()));
  const hasTime = () => remainingBudgetMs() > minimumStartBudgetMs;
  const logBudgetStop = () => {
    if (budgetStopLogged) return;
    budgetStopLogged = true;
    logger.info({ runId, stopReason: 'RUN_BUDGET', remainingBudgetMs: remainingBudgetMs(),
      minimumStartBudgetMs }, 'outbox worker stopped before another SMTP attempt');
  };
  const reserveAttempt = () => {
    if (!hasTime()) { logBudgetStop(); return false; }
    if (attemptsStarted >= config.OUTBOX_BATCH_SIZE) return false;
    attemptsStarted++;
    return true;
  };

  const processLane = async (lane: number) => {
    while (hasTime() && attemptsStarted < config.OUTBOX_BATCH_SIZE) {
      const message = await outbox.claimMessage();
      if (!message) break;
      // Rendering/DB errors retain the lease for recovery; never retry SMTP here.
      const payload = message.payload as unknown as NotificationPayload;
      const rendered = renderEmail(payload, planUrlFor(payload));
      if (!reserveAttempt()) {
        await outbox.releaseMessage(message);
        break;
      }
      const batch = await outbox.beginBatch(message);
      if (!batch) {
        attemptsStarted--;
        await outbox.releaseMessage(message);
        continue;
      }
      let remaining = batch.remaining_recipients;
      let failure: 'SMTP_REJECTED' | 'DELIVERY_UNKNOWN' | null = null;
      const smtpStartedAt = performance.now();
      logger.info({ runId, lane, outboxId: message.id, eventType: message.event_type,
        batch: batch.batch_no, attempt: batch.attempt_count,
        recipientCount: batch.remaining_recipients.length,
        queueWaitMs: Math.max(0, message.claimed_at.getTime() - message.created_at.getTime()),
        remainingBudgetMs: remainingBudgetMs() }, 'notification SMTP attempt started');
      try {
        const result = await mailer.send({
          to: batch.remaining_recipients,
          messageId: deliveryMessageId(message.delivery_key, batch.batch_no),
          subject: message.subject, text: rendered.text, html: rendered.html,
        });
        // A fulfilled sendMail may still have rejected some RCPT commands.
        const accepted = new Set(result?.accepted ?? batch.remaining_recipients);
        remaining = batch.remaining_recipients.filter((recipient) => !accepted.has(recipient));
        if (remaining.length) failure = 'SMTP_REJECTED';
      } catch (error) {
        failure = classifyDeliveryFailure(error);
      }
      const smtpDurationMs = Math.max(0, Math.round(performance.now() - smtpStartedAt));
      // Outside the SMTP catch: a failed acknowledgement write is ambiguous,
      // not an SMTP rejection. Recovery observes the durable in_flight marker.
      const complete = await outbox.finishBatch(message, batch, remaining, failure);
      logger.info({ runId, lane, outboxId: message.id, eventType: message.event_type,
        batch: batch.batch_no, attempt: batch.attempt_count,
        recipientCount: batch.remaining_recipients.length,
        remainingRecipientCount: remaining.length, smtpDurationMs,
        outcome: failure ?? 'SENT', parentComplete: complete,
        remainingBudgetMs: remainingBudgetMs() }, 'notification SMTP attempt finished');
      if (failure) {
        failed++;
        logger.warn({ runId, outboxId: message.id, batch: batch.batch_no,
          attempt: batch.attempt_count, failure }, 'notification delivery deferred');
      } else if (complete) {
        sent++;
      }
      // Release after one child batch so another eligible parent gets a turn.
      // A failed acknowledgement write throws before this point and retains the
      // durable in-flight marker/lease for conservative recovery.
      await outbox.releaseMessage(message);
    }
    if (!hasTime()) logBudgetStop();
  };

  const lanes = await Promise.allSettled(Array.from(
    { length: config.OUTBOX_PARENT_CONCURRENCY }, (_, lane) => processLane(lane + 1)));
  const rejected = lanes.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (rejected) throw rejected.reason;
  if (attemptsStarted || failed) logger.info({ runId, sent, failed, attemptsStarted,
    parentConcurrency: config.OUTBOX_PARENT_CONCURRENCY,
    durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
    stopReason: !hasTime() ? 'RUN_BUDGET' : attemptsStarted >= config.OUTBOX_BATCH_SIZE
      ? 'ATTEMPT_LIMIT' : 'NO_ELIGIBLE_WORK', transport: mailer.mode }, 'outbox batch processed');
  return { sent, failed };
}

export function deliveryMessageId(key: string, batch: number): string {
  return `<${key}.${batch}@notifications.committeeflow.invalid>`;
}

export function classifyDeliveryFailure(error: unknown): 'SMTP_REJECTED' | 'DELIVERY_UNKNOWN' {
  const details = error as { code?: string; command?: string; responseCode?: number } | null;
  // An explicit negative SMTP reply or a connection/auth failure precedes acceptance.
  if (details && ((details.responseCode ?? 0) >= 400 ||
    ['ECONNECTION', 'ECONNREFUSED', 'EDNS', 'EAUTH', 'EENVELOPE'].includes(details.code ?? ''))) {
    return 'SMTP_REJECTED';
  }
  // Timeouts, resets, missing final DATA acknowledgement and unknown errors
  // cannot prove non-delivery. No raw error text or recipient addresses persist.
  return 'DELIVERY_UNKNOWN';
}

function planUrlFor(payload: NotificationPayload): string {
  const base = env().APP_PUBLIC_URL.replace(/\/+$/, '');

  if (payload.eventType === 'PLAN_IMPORTED') {
    // An import has no single row to highlight, so it opens the first month it
    // touched — where the newly imported bookings actually are.
    const month = payload.firstBookingDate?.slice(0, 7) ?? '';
    return month ? `${base}/plan?month=${month}` : `${base}/plan`;
  }

  const month = payload.bookingDate?.slice(0, 7) ?? '';
  // Deep-links to the month the booking belongs to, and highlights the row.
  return month ? `${base}/plan?month=${month}&booking=${payload.bookingId}` : base;
}

export function startOutboxWorker(): void {
  const config = env();
  if (!config.OUTBOX_WORKER_ENABLED) {
    logger.info('outbox worker disabled by configuration');
    return;
  }
  if (timer) return;

  const tick = async () => {
    if (running) return; // A slow batch must not overlap the next tick.
    running = true;
    try {
      await processOutboxBatch();
    } catch (error) {
      logger.error({ err: error }, 'outbox worker tick failed');
    } finally {
      running = false;
    }
  };

  timer = setInterval(() => void tick(), config.OUTBOX_POLL_INTERVAL_MS);
  // Never hold the process open just for the worker.
  timer.unref();
  logger.info({ intervalMs: config.OUTBOX_POLL_INTERVAL_MS }, 'outbox worker started');

  void tick();
}

export function stopOutboxWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}
