import { env } from '../../config/env.js';
import { withTransaction } from '../../db/index.js';
import { logger } from '../../lib/logger.js';
import { getMailer } from './mailer.js';
import * as outbox from './outbox.repository.js';
import { renderEmail, type NotificationPayload } from './templates.js';

/**
 * Outbox worker (spec §50).
 *
 * Runs inside the API process for the MVP. It is written so that moving it to a
 * separate container later is a deployment change, not a rewrite: claiming uses
 * `FOR UPDATE SKIP LOCKED`, so any number of workers can run side by side.
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

  // Each message is claimed, sent and marked inside its own transaction so a
  // failure on one cannot roll back the successful sends beside it.
  const claimed = await withTransaction((tx) => outbox.claimDueMessages(config.OUTBOX_BATCH_SIZE, tx));

  for (const message of claimed) {
    const payload = message.payload as unknown as NotificationPayload;
    try {
      const rendered = renderEmail(payload, planUrlFor(payload));
      await mailer.send({
        to: message.recipients,
        subject: message.subject,
        text: rendered.text,
        html: rendered.html,
      });
      await outbox.markSent(message.id);
      sent += 1;
    } catch (error) {
      failed += 1;
      const reason = error instanceof Error ? error.message : String(error);
      await outbox.markFailed(message.id, reason, config.OUTBOX_MAX_ATTEMPTS);
      logger.error(
        {
          err: error,
          outboxId: message.id,
          eventType: message.eventType,
          attempt: message.attemptCount + 1,
        },
        'failed to deliver notification email',
      );
    }
  }

  if (sent > 0 || failed > 0) {
    logger.info({ sent, failed, transport: mailer.mode }, 'outbox batch processed');
  }
  return { sent, failed };
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
