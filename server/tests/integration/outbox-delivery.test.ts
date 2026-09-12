import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import { query } from '../../src/db/index.js';
import { closePool } from '../../src/db/pool.js';
import { beginBatch, claimMessage, enqueueEmail, finishBatch, releaseMessage, type OutboxEventType } from '../../src/modules/notifications/outbox.repository.js';
import * as repository from '../../src/modules/notifications/outbox.repository.js';
import { setMailer } from '../../src/modules/notifications/mailer.js';
import { processOutboxBatch } from '../../src/modules/notifications/outbox.worker.js';
import { createUser, resetDatabase, useRecordingMailer } from '../helpers/harness.js';

async function enqueue(count = 2) {
  await enqueueEmail({ eventType: 'PLAN_IMPORTED', bookingId: null,
    recipients: Array.from({ length: count }, (_, i) => `synthetic-${i}@example.test`),
    subject: 'Synthetic import', payload: { eventType: 'PLAN_IMPORTED', batchId: 'fixture',
      filename: 'synthetic.csv', actorName: 'Test', importedRows: 1, skippedRows: 0,
      warningRows: 0, firstBookingDate: null, lastBookingDate: null } });
}

async function createBookingScope(offNo: string): Promise<string> {
  const owner = await createUser({ role: 'PROJECT_ENGINEER' });
  const result = await query<{ id: string }>(`INSERT INTO bookings
    (booking_date, booking_time, off_no, order_name, committee, created_by, updated_by)
    VALUES ('2026-10-06', '10:00', $1, 'Synthetic booking', 'Test committee', $2, $2)
    RETURNING id`, [offNo, owner.id]);
  return result.rows[0]!.id;
}

async function enqueueBooking(bookingId: string, eventType: Exclude<OutboxEventType, 'PLAN_IMPORTED'>,
  count: number): Promise<void> {
  await enqueueEmail({ eventType, bookingId,
    recipients: Array.from({ length: count }, (_, i) => `${bookingId}-${i}@example.test`),
    subject: `Synthetic ${eventType}`, payload: { eventType, bookingId,
      bookingDate: '2026-10-06', bookingTime: '10:00', offNo: 'SYNTHETIC',
      orderName: 'Synthetic booking', committee: 'Test committee', actorName: 'Test', changes: [] } });
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
    // The two successful siblings commit; only the rejected child is retried.
    expect(mailer.sent).toHaveLength(2);
    await query("UPDATE email_outbox SET next_attempt_at = now() - interval '1 second'");
    expect(await processOutboxBatch()).toEqual({ sent: 1, failed: 0 });
    expect(mailer.sent).toHaveLength(3);
    expect(mailer.sent[2]?.messageId).toBe(retryId);
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

  it('releases after a child wave when the invocation budget runs low and resumes safely', async () => {
    const mailer = useRecordingMailer();
    await enqueue(201);
    let elapsed = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    const original = mailer.send.bind(mailer);
    vi.spyOn(mailer, 'send').mockImplementationOnce(async (email) => {
      await original(email); elapsed = 20_000;
    });
    expect(await processOutboxBatch()).toEqual({ sent: 0, failed: 0 });
    expect(mailer.sent).toHaveLength(3);
    expect((await query('SELECT claim_token FROM email_outbox')).rows[0]?.claim_token).toBeNull();
    expect(await processOutboxBatch()).toEqual({ sent: 1, failed: 0 });
    expect(mailer.sent).toHaveLength(5);
  });
});

describe('BUG-017 outbox fairness', () => {
  beforeEach(resetDatabase);
  afterAll(closePool);

  it('runs one parent child batches up to the configured child limit', async () => {
    const booking = await createBookingScope('CHILD-BOUND');
    await enqueueBooking(booking, 'BOOKING_CREATED', 201);
    let active = 0;
    let maximumActive = 0;
    let started = 0;
    let release!: () => void;
    let waveReady!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const firstWave = new Promise<void>((resolve) => { waveReady = resolve; });
    setMailer({ mode: 'smtp', verify: async () => true, close: async () => {},
      send: async (email) => {
        active++;
        started++;
        maximumActive = Math.max(maximumActive, active);
        if (started === 3) waveReady();
        await blocked;
        active--;
        return { accepted: email.to };
      } });

    const run = processOutboxBatch();
    await firstWave;
    expect(started).toBe(3);
    expect(maximumActive).toBe(3);
    release();
    expect(await run).toEqual({ sent: 1, failed: 0 });
    expect(started).toBe(5);
    expect(maximumActive).toBe(3);
  });

  it('completes an independent parent in the same invocation as a large parent', async () => {
    const mailer = useRecordingMailer();
    const bookingA = await createBookingScope('FAIR-A');
    const bookingB = await createBookingScope('FAIR-B');
    await enqueueBooking(bookingA, 'BOOKING_CREATED', 101);
    await enqueueBooking(bookingB, 'BOOKING_CREATED', 1);
    const parents = (await query<{ delivery_key: string }>(
      'SELECT delivery_key FROM email_outbox ORDER BY id')).rows;

    expect(await processOutboxBatch()).toEqual({ sent: 2, failed: 0 });

    const order = mailer.sent.map((message) => message.messageId);
    expect(order).toContain(`<${parents[1]!.delivery_key}.0@notifications.committeeflow.invalid>`);
    expect(order.filter((id) => id.includes(parents[0]!.delivery_key))).toHaveLength(3);
  });

  it('drains three independent parents under bounded parent lanes', async () => {
    const mailer = useRecordingMailer();
    const bookings = await Promise.all(['ROUND-A', 'ROUND-B', 'ROUND-C'].map(createBookingScope));
    await enqueueBooking(bookings[0]!, 'BOOKING_CREATED', 101);
    await enqueueBooking(bookings[1]!, 'BOOKING_CREATED', 51);
    await enqueueBooking(bookings[2]!, 'BOOKING_CREATED', 1);
    const parents = (await query<{ delivery_key: string }>(
      'SELECT delivery_key FROM email_outbox ORDER BY id')).rows;

    expect(await processOutboxBatch()).toEqual({ sent: 3, failed: 0 });

    const order = mailer.sent.map((message) => message.messageId);
    expect(order.filter((id) => id.includes(parents[0]!.delivery_key))).toHaveLength(3);
    expect(order.filter((id) => id.includes(parents[1]!.delivery_key))).toHaveLength(2);
    expect(order.filter((id) => id.includes(parents[2]!.delivery_key))).toHaveLength(1);
  });

  it('preserves same-booking lifecycle order while another booking progresses', async () => {
    const mailer = useRecordingMailer();
    const bookingA = await createBookingScope('ORDER-A');
    const bookingB = await createBookingScope('ORDER-B');
    await enqueueBooking(bookingA, 'BOOKING_CREATED', 51);
    await enqueueBooking(bookingA, 'BOOKING_UPDATED', 1);
    await enqueueBooking(bookingA, 'BOOKING_CANCELLED', 1);
    await enqueueBooking(bookingB, 'BOOKING_CREATED', 1);
    const parents = (await query<{ delivery_key: string }>(
      'SELECT delivery_key FROM email_outbox ORDER BY id')).rows;

    expect(await processOutboxBatch()).toEqual({ sent: 4, failed: 0 });

    const order = mailer.sent.map((message) => message.messageId);
    const createdDone = order.indexOf(`<${parents[0]!.delivery_key}.1@notifications.committeeflow.invalid>`);
    const updated = order.indexOf(`<${parents[1]!.delivery_key}.0@notifications.committeeflow.invalid>`);
    const cancelled = order.indexOf(`<${parents[2]!.delivery_key}.0@notifications.committeeflow.invalid>`);
    const independent = order.indexOf(`<${parents[3]!.delivery_key}.0@notifications.committeeflow.invalid>`);
    expect(independent).toBeLessThan(updated);
    expect(createdDone).toBeLessThan(updated);
    expect(updated).toBeLessThan(cancelled);
  });

  it('lets a claimed booking coexist only with an independent ordering scope', async () => {
    const bookingA = await createBookingScope('CLAIM-A');
    const bookingB = await createBookingScope('CLAIM-B');
    await enqueueBooking(bookingA, 'BOOKING_CREATED', 51);
    await enqueueBooking(bookingA, 'BOOKING_UPDATED', 1);
    await enqueueBooking(bookingB, 'BOOKING_CREATED', 1);

    const first = (await claimMessage())!;
    const second = (await claimMessage())!;
    expect(first.booking_id).toBe(bookingA);
    expect(second.booking_id).toBe(bookingB);
    expect(await claimMessage()).toBeUndefined();
    await releaseMessage(first);
    await releaseMessage(second);
  });

  it('serializes plan-wide events whose booking id is null', async () => {
    await enqueue(51);
    await enqueue(1);

    const first = (await claimMessage())!;
    expect(first.booking_id).toBeNull();
    expect(await claimMessage()).toBeUndefined();
    await releaseMessage(first);

    const mailer = useRecordingMailer();
    expect(await processOutboxBatch()).toEqual({ sent: 2, failed: 0 });
    const parents = (await query<{ delivery_key: string }>(
      'SELECT delivery_key FROM email_outbox ORDER BY id')).rows;
    const order = mailer.sent.map((message) => message.messageId);
    expect(order.indexOf(`<${parents[0]!.delivery_key}.1@notifications.committeeflow.invalid>`))
      .toBeLessThan(order.indexOf(`<${parents[1]!.delivery_key}.0@notifications.committeeflow.invalid>`));
  });

  it('keeps duplicate protection with concurrent invocations and several parents', async () => {
    const mailer = useRecordingMailer();
    const bookings = await Promise.all(['RACE-A', 'RACE-B', 'RACE-C'].map(createBookingScope));
    for (const booking of bookings) await enqueueBooking(booking, 'BOOKING_CREATED', 51);

    await Promise.all([processOutboxBatch(), processOutboxBatch()]);

    expect(mailer.sent).toHaveLength(6);
    expect(new Set(mailer.sent.map((message) => message.messageId)).size).toBe(6);
    expect((await query("SELECT 1 FROM email_outbox WHERE status = 'SENT'")).rowCount).toBe(3);
  });

  it('starts an independent parent while a large parent SMTP batch is still slow', async () => {
    const bookingA = await createBookingScope('SLOW-FAIR-A');
    const bookingB = await createBookingScope('SLOW-FAIR-B');
    await enqueueBooking(bookingA, 'BOOKING_CREATED', 101);
    await enqueueBooking(bookingB, 'BOOKING_CREATED', 1);
    const parents = (await query<{ delivery_key: string }>(
      'SELECT delivery_key FROM email_outbox ORDER BY id')).rows;
    const largeFirst = `<${parents[0]!.delivery_key}.0@notifications.committeeflow.invalid>`;
    const independent = `<${parents[1]!.delivery_key}.0@notifications.committeeflow.invalid>`;
    let releaseLarge!: () => void;
    let largeStarted!: () => void;
    let independentStarted!: () => void;
    const largeBlocked = new Promise<void>((resolve) => { releaseLarge = resolve; });
    const largeObserved = new Promise<void>((resolve) => { largeStarted = resolve; });
    const independentObserved = new Promise<void>((resolve) => { independentStarted = resolve; });
    const order: string[] = [];
    setMailer({ mode: 'smtp', verify: async () => true, close: async () => {},
      send: async (email) => {
        order.push(email.messageId);
        if (email.messageId === independent) independentStarted();
        if (email.messageId === largeFirst) {
          largeStarted();
          await largeBlocked;
        }
        return { accepted: email.to };
      } });

    const run = processOutboxBatch();
    await Promise.race([
      Promise.all([largeObserved, independentObserved]),
      new Promise<never>((_, reject) => setTimeout(
        () => reject(new Error('independent parent remained starved behind slow SMTP')), 1000)),
    ]);
    expect(order).toContain(largeFirst);
    expect(order).toContain(independent);
    releaseLarge();
    expect(await run).toEqual({ sent: 2, failed: 0 });
  });

  it('bounds total SMTP work to parent times child concurrency and lets parent C follow', async () => {
    const bookings = await Promise.all(['SLOW-A', 'SLOW-B', 'SLOW-C'].map(createBookingScope));
    for (const booking of bookings) await enqueueBooking(booking, 'BOOKING_CREATED', 201);
    let active = 0;
    let maximumActive = 0;
    let started = 0;
    let release!: () => void;
    let firstWave!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const sixStarted = new Promise<void>((resolve) => { firstWave = resolve; });
    setMailer({ mode: 'smtp', verify: async () => true, close: async () => {},
      send: async (email) => {
        active++;
        started++;
        maximumActive = Math.max(maximumActive, active);
        if (started === 6) firstWave();
        await blocked;
        active--;
        return { accepted: email.to };
      } });

    const run = processOutboxBatch();
    await sixStarted;
    expect(started).toBe(6);
    expect(maximumActive).toBe(6);
    release();
    expect(await run).toEqual({ sent: 3, failed: 0 });
    expect(started).toBe(15);
    expect(maximumActive).toBe(6);
  });
});
