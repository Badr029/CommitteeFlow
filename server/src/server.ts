import app from './app.js';
import { env } from './config/env.js';
import { closePool, getPool } from './db/pool.js';
import { logger } from './lib/logger.js';
import { getMailer } from './modules/notifications/mailer.js';
import { startOutboxWorker, stopOutboxWorker } from './modules/notifications/outbox.worker.js';

/**
 * Process entry point.
 *
 * Fails fast on a bad environment or an unreachable database — a container that
 * starts but cannot serve is worse than one that never starts.
 */
async function main(): Promise<void> {
  const config = env();

  try {
    await getPool().query('SELECT 1');
    logger.info('database connection established');
  } catch (error) {
    logger.fatal({ err: error }, 'cannot reach the database — exiting');
    process.exit(1);
  }

  await assertSchemaIsMigrated();

  const mailer = getMailer();
  if (mailer.mode === 'smtp') {
    // A failing verify is logged, not fatal: mail is asynchronous by design and
    // the outbox will retry (spec §50).
    void mailer.verify();
  }

  
  const server = app.listen(config.PORT, () => {
    logger.info(
      { port: config.PORT, env: config.NODE_ENV, mailer: mailer.mode },
      'CommitteeFlow API listening',
    );
  });

  startOutboxWorker();

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    stopOutboxWorker();

    server.close(async () => {
      try {
        await mailer.close();
        await closePool();
      } catch (error) {
        logger.error({ err: error }, 'error during shutdown');
      }
      process.exit(0);
    });

    // Do not let a hung connection block the container forever.
    setTimeout(() => {
      logger.error('forced shutdown after timeout');
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandled promise rejection');
  });
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'uncaught exception — exiting');
    process.exit(1);
  });
}

/**
 * Refuses to serve an unmigrated database.
 *
 * Without this the process starts happily and then fails every request with a
 * 500 about a missing relation — which reads like a bug rather than a missing
 * deployment step. Migrations are run explicitly, not on boot, so that several
 * app containers starting at once cannot race each other.
 */
async function assertSchemaIsMigrated(): Promise<void> {
  const required = ['users', 'bookings', 'plan_field_definitions', 'session', 'email_outbox'];

  const { rows } = await getPool().query<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [required],
  );

  const present = new Set(rows.map((row) => row.table_name));
  const missing = required.filter((table) => !present.has(table));

  if (missing.length > 0) {
    logger.fatal(
      { missing },
      'the database has not been migrated — run `npm run migrate:up --workspace server` and start again',
    );
    process.exit(1);
  }
}

void main();
