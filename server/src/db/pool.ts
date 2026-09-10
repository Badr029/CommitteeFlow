import pg from 'pg';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

const { Pool, types } = pg;

/**
 * Type parsing overrides.
 *
 * node-postgres converts DATE and TIMESTAMP columns into JavaScript `Date`
 * objects using the *server process* timezone, which silently shifts a
 * `booking_date` across a day boundary. The Committee Plan is a calendar
 * artefact: a booking on 2026-10-06 is on 2026-10-06 everywhere. So DATE and
 * TIME stay strings all the way to the client (spec §9, §10).
 */
types.setTypeParser(types.builtins.DATE, (value) => value);
types.setTypeParser(types.builtins.TIME, (value) => value);
types.setTypeParser(types.builtins.TIMETZ, (value) => value);
// NUMERIC as string by default loses ergonomics for KVA; parse to number.
// (KV is text, not numeric — it stores voltage ratios like 11/0.4.)
types.setTypeParser(types.builtins.NUMERIC, (value) => (value === null ? null : Number(value)));
// int8 (bigserial ids, COUNT(*)) — safe to narrow, our tables never approach 2^53.
types.setTypeParser(types.builtins.INT8, (value) => (value === null ? null : Number(value)));

let pool: pg.Pool | undefined;

/**
 * Shared connection pool (spec §55). One pool per process — never a connection
 * per request.
 */
export function getPool(): pg.Pool {
  if (!pool) {
    const config = env();
    pool = new Pool({
      connectionString: config.DATABASE_URL,
      max: config.DB_POOL_MAX,
      idleTimeoutMillis: config.DB_IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: config.DB_CONNECTION_TIMEOUT_MS,
      application_name: 'committeeflow',
    });

    pool.on('error', (error) => {
      // An idle client failing must not take the process down.
      logger.error({ err: error }, 'unexpected error on idle database client');
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    const closing = pool;
    pool = undefined;
    await closing.end();
  }
}
