import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import { query } from '../../src/db/index.js';
import { closePool } from '../../src/db/pool.js';
import { beginBatch, claimMessage, enqueueEmail, finishBatch } from '../../src/modules/notifications/outbox.repository.js';
import * as repository from '../../src/modules/notifications/outbox.repository.js';
import { setMailer } from '../../src/modules/notifications/mailer.js';
import { processOutboxBatch } from '../../src/modules/notifications/outbox.worker.js';
import { resetDatabase, useRecordingMailer } from '../helpers/harness.js';

async function enqueue(count = 2) {
  await enqueueEmail({ eventType: 'PLAN_IMPORTED', bookingId: null,
    recipients: Array.from({ length: count }, (_, i) => `synthetic-${i}@example.test`),
    subject: 'Synthetic import', payload: { eventType: 'PLAN_IMPORTED', batchId: 'fixture',
      filename: 'synthetic.csv', actorName: 'Test', importedRows: 1, skippedRows: 0,
      warningRows: 0, firstBookingDate: null, lastBookingDate: null } });
}

describe('BUG-016 durable delivery', () => {
  beforeEach(resetDatabase);
  afterAll(closePool);

  it('competing workers cannot send a row already being transmitted', async () => {
    const mailer = useRecordingMailer();
    await enqueue();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const original = mailer.send.bind(mailer);
    vi.spyOn(mailer, 'send').mockImplementationOnce(async (email) => {
      entered();
      await blocked;
      await original(email);
    });
    const first = processOutboxBatch();
    await started;
    try {
      await processOutboxBatch();
    } finally { release(); }
    await first;
    expect(mailer.sent).toHaveLength(1);
  });

  it('delivers 530 recipients in 11 persistent batches and never reprocesses SENT work', async () => {
    const mailer = useRecordingMailer();
    await enqueue(530);
    expect(await processOutboxBatch()).toEqual({ sent: 1, failed: 0 });
    expect(mailer.sent.map((email) => email.to.length)).toEqual([...Array<number>(10).fill(50), 30]);
    expect(new Set(mailer.sent.flatMap((email) => email.to)).size).toBe(530);
    expect(new Set(mailer.sent.map((email) => email.messageId)).size).toBe(11);
    expect((await query("SELECT 1 FROM email_outbox_batches WHERE status = 'SENT'")).rowCount).toBe(11);
    expect(await processOutboxBatch()).toEqual({ sent: 0, failed: 0 });
    expect(mailer.sent).toHaveLength(11);
  });

  it('retries a failed batch without repeating an earlier successful batch', async () => {
    const mailer = useRecordingMailer();
    await enqueue(101);
    const original = mailer.send.bind(mailer);
    const send = vi.spyOn(mailer, 'send').mockImplementationOnce(original)
      .mockRejectedValueOnce(Object.assign(new Error('private SMTP detail'), { responseCode: 451 }));
    expect(await processOutboxBatch()).toEqual({ sent: 0, failed: 1 });
    const retryId = send.mock.calls[1]?.[0].messageId;
    expect(mailer.sent).toHaveLength(1);
    await query("UPDATE email_outbox SET next_attempt_at = now() - interval '1 second'");
    expect(await processOutboxBatch()).toEqual({ sent: 1, failed: 0 });
    expect(mailer.sent).toHaveLength(3);
    expect(mailer.sent[1]?.messageId).toBe(retryId);
    expect((await query('SELECT attempt_count FROM email_outbox_batches ORDER BY batch_no')).rows)
      .toEqual([{ attempt_count: 1 }, { attempt_count: 2 }, { attempt_count: 1 }]);
  });

  it('persists partial SMTP acceptance and retries only rejected recipients', async () => {
    await enqueue(3);
    const send = vi.fn().mockImplementationOnce(async (email) => ({ accepted: [email.to[0]] }))
      .mockImplementation(async (email) => ({ accepted: email.to }));
    setMailer({ mode: 'smtp', send, verify: async () => true, close: async () => {} });
    expect(await processOutboxBatch()).toEqual({ sent: 0, failed: 1 });
    await query("UPDATE email_outbox SET next_attempt_at = now() - interval '1 second'");
    expect(await processOutboxBatch()).toEqual({ sent: 1, failed: 0 });
    expect(send.mock.calls[1]?.[0].to).toEqual(['synthetic-1@example.test', 'synthetic-2@example.test']);
    expect(send.mock.calls[1]?.[0].messageId).toBe(send.mock.calls[0]?.[0].messageId);
  });

  it('records ambiguous acceptance, delays retries, and stops at the attempt limit', async () => {
    const mailer = useRecordingMailer();
    await enqueue();
    const send = vi.spyOn(mailer, 'send').mockRejectedValue(Object.assign(new Error('recipient/token redacted'), { code: 'ETIMEDOUT' }));
    for (let i = 0; i < 6; i++) {
      expect(await processOutboxBatch()).toEqual({ sent: 0, failed: 1 });
      const row = (await query('SELECT status, attempt_count, last_error, next_attempt_at FROM email_outbox')).rows[0]!;
      expect(row.status).toBe('FAILED');
      expect(row.attempt_count).toBe(i + 1);
      expect(row.last_error).toBe('DELIVERY_UNKNOWN');
      expect(await processOutboxBatch()).toEqual({ sent: 0, failed: 0 });
      if (i < 5) {
        expect(row.next_attempt_at.getTime()).toBeGreaterThan(Date.now() + 890_000);
        await query("UPDATE email_outbox SET next_attempt_at = now() - interval '1 second'");
      } else expect(row.next_attempt_at).toBe(Infinity);
    }
    expect(send).toHaveBeenCalledTimes(6);
    expect(new Set(send.mock.calls.map(([email]) => email.messageId)).size).toBe(1);
    expect(mailer.sent).toHaveLength(0);
  });

  it('recovers expired in-flight work as ambiguous and fences the old worker', async () => {
    await enqueue();
    const first = (await claimMessage())!;
    const batch = (await beginBatch(first))!;
    expect(await claimMessage()).toBeUndefined();
    await query("UPDATE email_outbox SET lease_until = now() - interval '1 second'");
    expect(await claimMessage()).toBeUndefined();
    await expect(finishBatch(first, batch, [], null)).rejects.toThrow('OUTBOX_CLAIM_LOST');
    expect((await query('SELECT last_error, in_flight, attempt_count FROM email_outbox_batches')).rows[0])
      .toEqual({ last_error: 'DELIVERY_UNKNOWN', in_flight: false, attempt_count: 1 });
    await query("UPDATE email_outbox SET next_attempt_at = now() - interval '1 second'");
    const second = (await claimMessage())!;
    expect(second.claim_token).not.toBe(first.claim_token);
    await expect(beginBatch(first)).rejects.toThrow('OUTBOX_CLAIM_LOST');
    expect((await beginBatch(second))?.attempt_count).toBe(2);
  });

  it('does not lose successful batches when a worker crashes before its next send', async () => {
    const mailer = useRecordingMailer();
    await enqueue(51);
    const first = (await claimMessage())!;
    const batch = (await beginBatch(first))!;
    await finishBatch(first, batch, [], null);
    await query("UPDATE email_outbox SET lease_until = now() - interval '1 second'");
    expect(await processOutboxBatch()).toEqual({ sent: 1, failed: 0 });
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.to).toEqual(['synthetic-50@example.test']);
  });

  it('retains legacy SENT rows and initializes legacy pending rows only once', async () => {
    await enqueue(51);
    await query("UPDATE email_outbox SET status = 'SENT', sent_at = now()");
    expect(await claimMessage()).toBeUndefined();
    await enqueue(51);
    const message = (await claimMessage())!;
    await query("UPDATE email_outbox SET lease_until = now() - interval '1 second' WHERE id = $1", [message.id]);
    expect((await claimMessage())?.id).toBe(message.id);
    expect((await query('SELECT 1 FROM email_outbox_batches')).rowCount).toBe(2);
  });

  it('commits exactly one claim under simultaneous database contention', async () => {
    await enqueue();
    const claims = await Promise.all(Array.from({ length: 10 }, () => claimMessage()));
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it('leaves delivery ambiguous when SMTP succeeds but the database acknowledgement fails', async () => {
    const mailer = useRecordingMailer();
    await enqueue();
    vi.spyOn(repository, 'finishBatch').mockRejectedValueOnce(new Error('synthetic DB disconnect'));
    await expect(processOutboxBatch()).rejects.toThrow('synthetic DB disconnect');
    expect(mailer.sent).toHaveLength(1);
    expect(await processOutboxBatch()).toEqual({ sent: 0, failed: 0 });
    expect((await query('SELECT in_flight FROM email_outbox_batches')).rows[0]?.in_flight).toBe(true);
    expect((await query('SELECT status FROM email_outbox')).rows[0]?.status).toBe('PENDING');
    await query("UPDATE email_outbox SET lease_until = now() - interval '1 second'");
    expect(await processOutboxBatch()).toEqual({ sent: 0, failed: 0 });
    expect((await query('SELECT last_error FROM email_outbox')).rows[0]?.last_error).toBe('DELIVERY_UNKNOWN');
  });

  it('releases between batches when the invocation budget runs low and resumes safely', async () => {
    const mailer = useRecordingMailer();
    await enqueue(51);
    let elapsed = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    const original = mailer.send.bind(mailer);
    vi.spyOn(mailer, 'send').mockImplementationOnce(async (email) => {
      await original(email); elapsed = 20_000;
    });
    expect(await processOutboxBatch()).toEqual({ sent: 0, failed: 0 });
    expect(mailer.sent).toHaveLength(1);
    expect((await query('SELECT claim_token FROM email_outbox')).rows[0]?.claim_token).toBeNull();
    expect(await processOutboxBatch()).toEqual({ sent: 1, failed: 0 });
    expect(mailer.sent).toHaveLength(2);
  });
});
