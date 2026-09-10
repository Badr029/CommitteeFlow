import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

/**
 * Prepares the integration-test database once per run.
 *
 * Applies every migration from scratch, which doubles as a migration test: if a
 * migration is broken, the whole suite fails at setup with the SQL error rather
 * than in a confusing way later.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, '..', '..');

const DEFAULT_TEST_URL = 'postgres://committeeflow:committeeflow@localhost:5433/committeeflow_test';

export default async function setup(): Promise<void> {
  const url = process.env['TEST_DATABASE_URL'] ?? DEFAULT_TEST_URL;
  process.env['TEST_DATABASE_URL'] = url;

  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
  } catch (error) {
    throw new Error(
      `Cannot reach the test database at ${redact(url)}.\n` +
        `Start it with:  npm run db:up\n` +
        `Original error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Drop and recreate the schema so every run starts from a known state.
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await client.end();

  execFileSync(process.execPath, [path.join(serverDir, 'scripts', 'migrate.mjs'), 'up', '--test'], {
    cwd: serverDir,
    env: { ...process.env, TEST_DATABASE_URL: url },
    stdio: 'pipe',
  });
}

function redact(url: string): string {
  return url.replace(/\/\/[^@]*@/, '//***@');
}
