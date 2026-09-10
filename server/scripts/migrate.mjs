#!/usr/bin/env node
/**
 * node-pg-migrate wrapper.
 *
 * Keeps migration configuration in one place so `npm run migrate:up`, the test
 * harness and the Docker entrypoint all behave identically. Pass `--test` to
 * target TEST_DATABASE_URL instead of DATABASE_URL.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runner } from 'node-pg-migrate';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, '..', 'migrations');

const argv = process.argv.slice(2);
const useTestDb = argv.includes('--test');
const args = argv.filter((a) => a !== '--test');
const direction = args[0] === 'down' ? 'down' : 'up';
const countArg = args[1] !== undefined ? Number(args[1]) : undefined;

const databaseUrl = useTestDb ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error(`Missing ${useTestDb ? 'TEST_DATABASE_URL' : 'DATABASE_URL'}.`);
  process.exit(1);
}

const migrate = runner;

try {
  const applied = await migrate({
    databaseUrl,
    dir: migrationsDir,
    direction,
    count: Number.isFinite(countArg) ? countArg : direction === 'down' ? 1 : Infinity,
    migrationsTable: 'pgmigrations',
    verbose: true,
    singleTransaction: true,
  });
  if (applied.length === 0) {
    console.log('No migrations to run — database is up to date.');
  } else {
    console.log(`${direction === 'up' ? 'Applied' : 'Reverted'} ${applied.length} migration(s).`);
  }
  process.exit(0);
} catch (error) {
  console.error('Migration failed:', error instanceof Error ? error.message : error);
  process.exit(1);
}
