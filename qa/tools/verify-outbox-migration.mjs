// BUG-016: exercise the real forward migration with pre-existing rows.
// Runs entirely in a rolled-back schema on the disposable local test database.
import { readFileSync, readdirSync } from 'node:fs';
import { Client } from 'pg';
const url = new URL(process.env.TEST_DATABASE_URL ?? '');
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port !== '55416' || url.pathname !== '/committeeflow_test') {
  throw new Error('Use only the BUG-016 disposable loopback test database');
}
const client = new Client({ connectionString: url.toString() });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query('CREATE SCHEMA bug016_migration_check');
  await client.query('SET LOCAL search_path = bug016_migration_check, public');
  const directory = new URL('../../server/migrations/', import.meta.url);
  const files = readdirSync(directory).filter((name) => name.endsWith('.sql')).sort();
  for (const file of files.slice(0, -1)) {
    await client.query(readFileSync(new URL(file, directory), 'utf8').split('-- Down Migration')[0]);
  }
  await client.query(`INSERT INTO email_outbox (event_type, recipients, subject, status, sent_at, attempt_count)
    VALUES ('BOOKING_CREATED', ARRAY['synthetic@example.test'], 'fixture', 'SENT', now(), 5),
      ('BOOKING_UPDATED', ARRAY['synthetic@example.test'], 'fixture', 'PENDING', NULL, 0)`);
  const migration = readFileSync(new URL(files.at(-1), directory), 'utf8').split('-- Down Migration');
  await client.query(migration[0]);
  const rows = (await client.query(`SELECT id, status, attempt_count, sent_at IS NOT NULL AS has_sent_time,
    delivery_key IS NOT NULL AS has_delivery_key, claim_token IS NULL AS unclaimed FROM email_outbox ORDER BY id`)).rows;
  if (rows.length !== 2 || rows[0].status !== 'SENT' || rows[0].attempt_count !== 5 ||
      !rows.every((row) => row.has_delivery_key && row.unclaimed) || rows[1].status !== 'PENDING') {
    throw new Error('Legacy state changed unexpectedly');
  }
  await client.query('SAVEPOINT before_down');
  let rejected = false;
  try { await client.query(migration[1]); }
  catch (error) { rejected = String(error.message).includes('forward-only'); }
  await client.query('ROLLBACK TO SAVEPOINT before_down');
  if (!rejected) throw new Error('Unsafe down migration did not refuse');
  console.log(JSON.stringify({ result: 'PASS', legacyRows: rows, downMigration: 'refused as designed', cleanup: 'transaction rolled back' }, null, 2));
} finally {
  await client.query('ROLLBACK');
  await client.end();
}
