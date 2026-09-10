import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

/**
 * SMTP transport.
 *
 * When SMTP_HOST is not configured the transport falls back to logging the
 * message instead of delivering it. That keeps the whole booking → outbox →
 * worker path exercisable before company SMTP is provisioned, without silently
 * pretending mail was delivered: every logged message says so explicitly.
 */

export interface OutgoingEmail {
  to: string[];
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  readonly mode: 'smtp' | 'log';
  send(email: OutgoingEmail): Promise<void>;
  verify(): Promise<boolean>;
  close(): Promise<void>;
}

class SmtpMailer implements Mailer {
  readonly mode = 'smtp' as const;
  private readonly transporter: Transporter;

  constructor(private readonly from: string, options: nodemailer.TransportOptions) {
    this.transporter = nodemailer.createTransport(options);
  }

  async send(email: OutgoingEmail): Promise<void> {
    await this.transporter.sendMail({
      from: this.from,
      // Recipients go in BCC: a plan-wide notification must not disclose the
      // full internal distribution list to everyone who receives it.
      bcc: email.to,
      to: this.from,
      subject: email.subject,
      text: email.text,
      html: email.html,
    });
  }

  async verify(): Promise<boolean> {
    try {
      await this.transporter.verify();
      return true;
    } catch (error) {
      logger.warn({ err: error }, 'SMTP verification failed');
      return false;
    }
  }

  async close(): Promise<void> {
    this.transporter.close();
  }
}

class LogMailer implements Mailer {
  readonly mode = 'log' as const;

  async send(email: OutgoingEmail): Promise<void> {
    logger.info(
      { recipients: email.to.length, subject: email.subject, transport: 'log' },
      'email NOT delivered (no SMTP configured) — logged instead',
    );
  }

  async verify(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    // Nothing to close.
  }
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
        host: config.SMTP_HOST,
        port: config.SMTP_PORT,
        secure: config.SMTP_SECURE,
        ...(config.SMTP_USERNAME
          ? { auth: { user: config.SMTP_USERNAME, pass: config.SMTP_PASSWORD ?? '' } }
          : {}),
      } as nodemailer.TransportOptions);
    }
  }
  return mailer;
}

/** Test seam — lets suites assert on what would have been sent. */
export function setMailer(replacement: Mailer | undefined): void {
  mailer = replacement;
}
