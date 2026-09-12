import net from 'node:net';
import tls from 'node:tls';
import nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

export interface OutgoingEmail {
  to: string[];
  messageId: string;
  subject: string;
  text: string;
  html: string;
}
export interface DeliveryResult { accepted: string[] }
export interface Mailer {
  readonly mode: 'smtp' | 'log';
  send(email: OutgoingEmail): Promise<DeliveryResult | void>;
  verify(): Promise<boolean>;
  close(): Promise<void>;
}

/** One bounded SMTP connection per persistent recipient batch. */
export class SmtpMailer implements Mailer {
  readonly mode = 'smtp' as const;
  private readonly sockets = new Set<net.Socket>();
  constructor(private readonly from: string, private readonly options: SMTPTransport.Options,
    private readonly timeoutMs: number) {}

  async send(email: OutgoingEmail): Promise<DeliveryResult> {
    let socket: net.Socket | undefined;
    let expired = false;
    const timeoutError = Object.assign(new Error('SMTP delivery acknowledgement unknown'), { code: 'ETIMEDOUT' });
    let rejectDeadline!: (error: Error) => void;
    const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
    const timer = setTimeout(() => {
      expired = true;
      // Promise.race alone leaves SMTP running and permits duplicates after retry.
      // Own and destroy the socket, including an in-progress TLS connection.
      socket?.destroy();
      rejectDeadline(timeoutError);
    }, this.timeoutMs);
    const transport = nodemailer.createTransport({
      ...this.options,
      connectionTimeout: this.timeoutMs,
      greetingTimeout: this.timeoutMs,
      socketTimeout: this.timeoutMs,
      getSocket: (_options: unknown, callback: (error: Error | null,
        result?: { connection: net.Socket; secured: boolean }) => void) => {
        if (expired) { callback(timeoutError); return; }
        const host = this.options.host ?? 'localhost';
        const port = this.options.port ?? (this.options.secure ? 465 : 587);
        let answered = false;
        const ready = () => {
          if (answered) return;
          answered = true;
          if (expired) { socket?.destroy(); callback(timeoutError); return; }
          callback(null, { connection: socket!, secured: !!this.options.secure });
        };
        socket = this.options.secure
          ? tls.connect({ ...this.options.tls, host, port, servername: this.options.tls?.servername ?? host }, ready)
          : net.connect({ host, port }, ready);
        this.sockets.add(socket);
        socket.once('error', (error) => {
          if (!answered) { answered = true; callback(error); }
        });
      },
    } as SMTPTransport.Options);
    try {
      const info = await Promise.race([transport.sendMail({
        from: this.from,
        to: this.from,
        bcc: email.to,
        // A visible To header must not add the sender to every envelope batch.
        envelope: { from: this.from.match(/<([^<>]+)>/)?.[1] ?? this.from, to: email.to },
        messageId: email.messageId,
        subject: email.subject, text: email.text, html: email.html,
      }), deadline]);
      return { accepted: info.accepted.map((address) => typeof address === 'string' ? address : address.address) };
    } finally {
      clearTimeout(timer);
      socket?.destroy();
      if (socket) this.sockets.delete(socket);
      transport.close();
    }
  }

  async verify(): Promise<boolean> {
    const transport = nodemailer.createTransport({ ...this.options,
      connectionTimeout: this.timeoutMs, greetingTimeout: this.timeoutMs, socketTimeout: this.timeoutMs });
    try { await transport.verify(); return true; }
    catch { logger.warn('SMTP verification failed'); return false; }
    finally { transport.close(); }
  }
  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
  }
}

class LogMailer implements Mailer {
  readonly mode = 'log' as const;
  async send(email: OutgoingEmail): Promise<void> {
    logger.info({ recipients: email.to.length, transport: 'log' },
      'email NOT delivered (no SMTP configured) — logged instead');
  }
  async verify(): Promise<boolean> { return true; }
  async close(): Promise<void> { /* nothing to close */ }
}
let mailer: Mailer | undefined;
export function getMailer(): Mailer {
  if (!mailer) {
    const config = env();
    if (!config.SMTP_HOST) {
      logger.warn('SMTP_HOST is not set — notification emails will be logged, not delivered');
      mailer = new LogMailer();
    } else {
      mailer = new SmtpMailer(config.SMTP_FROM, {
        host: config.SMTP_HOST, port: config.SMTP_PORT, secure: config.SMTP_SECURE,
        ...(config.SMTP_USERNAME ? { auth: { user: config.SMTP_USERNAME, pass: config.SMTP_PASSWORD ?? '' } } : {}),
      }, config.SMTP_SEND_TIMEOUT_MS);
    }
  }
  return mailer;
}
export function setMailer(replacement: Mailer | undefined): void { mailer = replacement; }
