import { env } from '../../config/env.js';
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
  let sent = 0;
  let failed = 0;
  const deadline = performance.now() + config.OUTBOX_RUN_BUDGET_MS;
  const hasTime = () => performance.now() + config.SMTP_SEND_TIMEOUT_MS + 5_000 < deadline;

  for (let i = 0; i < config.OUTBOX_BATCH_SIZE && hasTime(); i++) {
    const message = await outbox.claimMessage();
    if (!message) break;
    // Rendering/DB errors retain the lease for recovery; never retry SMTP here.
    const payload = message.payload as unknown as NotificationPayload;
    const rendered = renderEmail(payload, planUrlFor(payload));
    while (hasTime()) {
      const batch = await outbox.beginBatch(message);
      if (!batch) break;
      let remaining = batch.remaining_recipients;
      let failure: 'SMTP_REJECTED' | 'DELIVERY_UNKNOWN' | null = null;
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
      // Outside the SMTP catch: a failed acknowledgement write is ambiguous,
      // not an SMTP rejection. Recovery observes the durable in_flight marker.
      const complete = await outbox.finishBatch(message, batch, remaining, failure);
      if (failure) {
        failed++;
        logger.warn({ outboxId: message.id, batch: batch.batch_no,
          attempt: batch.attempt_count, failure }, 'notification delivery deferred');
        break;
      }
      if (complete) { sent++; break; }
    }
    await outbox.releaseMessage(message);
  }
  if (sent || failed) logger.info({ sent, failed, transport: mailer.mode }, 'outbox batch processed');
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
