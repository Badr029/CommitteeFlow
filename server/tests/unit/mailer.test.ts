import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { SmtpMailer, type OutgoingEmail } from '../../src/modules/notifications/mailer.js';
import { classifyDeliveryFailure, deliveryMessageId } from '../../src/modules/notifications/outbox.worker.js';
import { parseEnvFrom } from '../../src/config/env.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });

/** Isolated SMTP protocol fixture; never forwards messages or contacts Mailpit. */
async function smtpFixture(options: { loseAck?: boolean; rejectSecond?: boolean; stallGreeting?: boolean } = {}) {
  const messages: string[] = [];
  const recipients: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    if (options.stallGreeting) return;
    socket.write('220 localhost synthetic SMTP\r\n');
    let buffer = '';
    let data = false;
    let body = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      while (buffer.includes('\r\n')) {
        const offset = buffer.indexOf('\r\n');
        const line = buffer.slice(0, offset);
        buffer = buffer.slice(offset + 2);
        if (data) {
          if (line === '.') {
            messages.push(body); data = false; body = '';
            if (!options.loseAck) socket.write('250 accepted\r\n');
          } else body += line + '\r\n';
        } else if (/^(EHLO|HELO)/.test(line)) socket.write('250 localhost\r\n');
        else if (line.startsWith('MAIL FROM')) socket.write('250 sender ok\r\n');
        else if (line.startsWith('RCPT TO')) {
          recipients.push(line);
          socket.write(options.rejectSecond && recipients.length === 2 ? '550 rejected\r\n' : '250 recipient ok\r\n');
        } else if (line === 'DATA') { data = true; socket.write('354 send data\r\n'); }
        else if (line === 'QUIT') socket.end('221 bye\r\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const port = (server.address() as net.AddressInfo).port;
  return { messages, recipients, sockets, mailer: new SmtpMailer('CommitteeFlow <sender@example.test>',
    { host: '127.0.0.1', port, secure: false, ignoreTLS: true }, 500) };
}
const email: OutgoingEmail = { to: ['one@example.test', 'two@example.test'],
  messageId: '<synthetic.0@notifications.committeeflow.invalid>', subject: 'Synthetic', text: 'Fixture', html: '<p>Fixture</p>' };

describe('BUG-016 SMTP protocol', () => {
  it('sends a stable ID, private BCC, and only intended envelope recipients', async () => {
    const fixture = await smtpFixture();
    expect(await fixture.mailer.send(email)).toEqual({ accepted: email.to });
    expect(fixture.messages).toHaveLength(1);
    expect(fixture.messages[0]).toContain(`Message-ID: ${email.messageId}`);
    expect(fixture.messages[0]).not.toMatch(/^bcc:/im);
    expect(fixture.messages[0]).not.toContain('one@example.test');
    expect(fixture.recipients).toEqual(['RCPT TO:<one@example.test>', 'RCPT TO:<two@example.test>']);
  });
  it('returns only recipients acknowledged after partial RCPT rejection', async () => {
    const fixture = await smtpFixture({ rejectSecond: true });
    expect(await fixture.mailer.send(email)).toEqual({ accepted: [email.to[0]] });
    expect(fixture.messages).toHaveLength(1);
  });
  it('closes SMTP at the absolute deadline after acceptance without acknowledgement', async () => {
    const fixture = await smtpFixture({ loseAck: true });
    await expect(fixture.mailer.send(email)).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    expect(fixture.messages).toHaveLength(1); // Captured, despite the sender seeing failure.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fixture.sockets.size).toBe(0);
  });
  it('times out before acceptance without transmitting a message', async () => {
    const fixture = await smtpFixture({ stallGreeting: true });
    await expect(fixture.mailer.send(email)).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    expect(fixture.messages).toHaveLength(0);
  });
  it('classifies unknown outcomes conservatively and identifiers deterministically', () => {
    expect(classifyDeliveryFailure({ responseCode: 451 })).toBe('SMTP_REJECTED');
    expect(classifyDeliveryFailure({ code: 'ECONNREFUSED' })).toBe('SMTP_REJECTED');
    expect(classifyDeliveryFailure({ code: 'ETIMEDOUT', command: 'DATA' })).toBe('DELIVERY_UNKNOWN');
    expect(classifyDeliveryFailure(new Error('private details'))).toBe('DELIVERY_UNKNOWN');
    expect(deliveryMessageId('event-1', 0)).toBe(deliveryMessageId('event-1', 0));
    expect(deliveryMessageId('event-1', 0)).not.toBe(deliveryMessageId('event-1', 1));
    expect(deliveryMessageId('event-1', 0)).not.toBe(deliveryMessageId('event-2', 0));
  });
  it('rejects leases and execution budgets shorter than SMTP bounds', () => {
    const base = { DATABASE_URL: 'unused', SESSION_SECRET: 'synthetic-test-secret' };
    expect(() => parseEnvFrom({ ...base, OUTBOX_LEASE_SECONDS: '30' })).toThrow();
    expect(() => parseEnvFrom({ ...base, OUTBOX_RUN_BUDGET_MS: '30000' })).toThrow();
    expect(() => parseEnvFrom({ ...base, OUTBOX_RECIPIENT_BATCH_SIZE: '0' })).toThrow();
    expect(() => parseEnvFrom({ ...base, OUTBOX_PARENT_CONCURRENCY: '0' })).toThrow();
    expect(() => parseEnvFrom({ ...base, OUTBOX_PARENT_CONCURRENCY: '6' })).toThrow();
    expect(parseEnvFrom(base).OUTBOX_RECIPIENT_BATCH_SIZE).toBe(50);
    expect(parseEnvFrom(base).OUTBOX_PARENT_CONCURRENCY).toBe(2);
  });
});
