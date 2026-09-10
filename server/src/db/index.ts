import type pg from 'pg';
import { getPool } from './pool.js';

/**
 * Thin data-access surface over `pg`.
 *
 * Every call site passes values as parameters — this module never interpolates
 * user-controlled data into SQL text (spec §44).
 */

/** Anything that can run a query: the pool, or a client inside a transaction. */
export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<pg.QueryResult<R>>;
}

export async function query<R extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values: readonly unknown[] = [],
  executor: Queryable = getPool(),
): Promise<pg.QueryResult<R>> {
  return executor.query<R>(text, values);
}

export async function queryRows<R extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values: readonly unknown[] = [],
  executor: Queryable = getPool(),
): Promise<R[]> {
  const result = await query<R>(text, values, executor);
  return result.rows;
}

export async function queryOne<R extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values: readonly unknown[] = [],
  executor: Queryable = getPool(),
): Promise<R | undefined> {
  const result = await query<R>(text, values, executor);
  return result.rows[0];
}

/**
 * Runs `fn` inside a single transaction (spec §72).
 *
 * Booking writes are only correct if the row, its history entry and its outbox
 * message commit together — or not at all.
 */
export async function withTransaction<T>(fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection is already unusable; releasing it discards it.
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Transaction-scoped advisory lock.
 *
 * Used to serialise concurrent bookings that compete for the same exclusive
 * slot (spec §47). The lock lives in PostgreSQL, not in the Node process, so it
 * holds across multiple app containers, and it is released automatically when
 * the transaction ends.
 */
export async function advisoryXactLock(tx: Queryable, key: string): Promise<void> {
  // hashtextextended returns a stable bigint for a text key.
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
}

/** PostgreSQL error codes we branch on. */
export const PG_ERROR = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
  NOT_NULL_VIOLATION: '23502',
  SERIALIZATION_FAILURE: '40001',
} as const;

export function isPgError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === code;
}

export function pgConstraintName(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null) {
    return (error as { constraint?: string }).constraint;
  }
  return undefined;
}
