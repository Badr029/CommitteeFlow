/**
 * Seed the public demo: two sign-ins and a month of plan to look at.
 *
 *   npm run demo              fill an empty demo database
 *   npm run demo -- --reset   wipe the demo plan first, then fill it again
 *   npm run demo -- --dry-run say what it would do, write nothing
 *
 * Written for the deployed review environment, where a stranger has one click
 * and no context. Three things follow from that:
 *
 *   - **The credentials are public.** They are printed below and published on the
 *     portfolio, which is the whole point of a demo account. They must never be
 *     reused anywhere else, and this script refuses to run unless the database it
 *     is pointed at says it is the demo one.
 *   - **Neither account is asked to change its password.** A forced password
 *     change is correct for a real account and fatal for a demo: the first thing
 *     a reviewer would meet is a dialog they cannot dismiss, on an account they
 *     do not own.
 *   - **The plan is written straight to the tables**, not through the booking
 *     service. The service refuses past dates and queues a notification for every
 *     recipient; a demo needs a month with history behind it and no outbox at all.
 *
 * Every name, customer, transformer and order number below is invented.
 */
import { hashPassword } from '../src/modules/auth/password.js';
import { queryOne, queryRows, withTransaction } from '../src/db/index.js';
import { closePool, getPool } from '../src/db/pool.js';
import type { Queryable } from '../src/db/index.js';

/* ────────────────────────────────────────────────────────────────────────────
   The two accounts
   ──────────────────────────────────────────────────────────────────────────── */

const DEMO_ENGINEER = {
  name: 'Karim Adel',
  email: 'engineer@demo.committeeflow.app',
  password: 'DemoEngineer#2026',
  role: 'PROJECT_ENGINEER' as const,
  canManagePlanConfiguration: true,
};

const DEMO_VIEWER = {
  name: 'Salma Nabil',
  email: 'viewer@demo.committeeflow.app',
  password: 'DemoViewer#2026',
  role: 'VIEWER' as const,
  canManagePlanConfiguration: false,
};

/* ────────────────────────────────────────────────────────────────────────────
   The plan
   ──────────────────────────────────────────────────────────────────────────── */

type Row = {
  /** Day of the month. Negative counts back from today, so the month always
   *  has a past worth looking at and a future worth booking into. */
  day: number;
  time: string;
  offNo: string;
  orderName: string;
  committee: string;
  qty: number;
  kva: string;
  kv: string;
  serialNo?: string;
  customer: string;
  notes?: string;
  /** Cancelled bookings stay on the plan, struck through. */
  cancelled?: string;
  /** Owned by the viewer's colleague rather than the demo engineer. */
  otherEngineer?: boolean;
};

/*
 * Shaped like the sheet this replaced: several projects share one committee
 * sitting, mornings are busier than afternoons, and the awkward real-world data
 * is in here on purpose — a voltage ratio, a serial with leading zeros, several
 * references in one cell, and Arabic in a customer name so the PDF export has
 * something to prove.
 */
const PLAN: Row[] = [
  { day: 2, time: '09:00', offNo: '202601021', orderName: 'Transformer 1A', committee: 'North Committee', qty: 3, kva: '1000', kv: '11/0.4', serialNo: '010662606B-020662606B', customer: 'Dubai Municipality' },
  { day: 2, time: '09:00', offNo: '202601022', orderName: 'Transformer 1B', committee: 'North Committee', qty: 1, kva: '1500', kv: '11/0.4', serialNo: '030662606B', customer: 'Aweer Maintenance' },
  { day: 2, time: '09:00', offNo: '202601023', orderName: 'Auxiliary Transformer', committee: 'North Committee', qty: 2, kva: '25', kv: '11/0.4', customer: 'Dubai Municipality', notes: 'Cable route confirmed' },
  { day: 2, time: '13:00', offNo: '202601024', orderName: 'Package Substation 4', committee: 'South Committee', qty: 4, kva: '1600', kv: '22/0.4', serialNo: 'DD-001600-022000-S289', customer: 'ADNOC Onshore', otherEngineer: true },

  { day: 5, time: '10:00', offNo: '202601051', orderName: 'GIS Bay Extension', committee: 'HV Committee', qty: 1, kva: '4000', kv: '132', serialNo: '0041520', customer: 'DEWA', notes: 'Drawings received' },
  { day: 5, time: '10:00', offNo: '202601052', orderName: 'Aweer Feeder Pillar', committee: 'HV Committee', qty: 2, kva: '2000', kv: '33/11', customer: 'Emirates Steel' },

  { day: 9, time: '09:00', offNo: '202601091', orderName: 'PUM-CMD-2025-00155 HV Cable', committee: 'North Committee', qty: 1, kva: '1000', kv: '11/0.4', serialNo: 'invoice-010182515B-010442610B', customer: 'شركة جنوب القاهرة لتوزيع الكهرباء' },
  { day: 9, time: '09:00', offNo: '202601092', orderName: 'Meal Backend Mobile Booking', committee: 'North Committee', qty: 1, kva: '630', kv: '11/0.4', customer: 'وطنية', otherEngineer: true },
  { day: 9, time: '11:30', offNo: '202601093', orderName: 'Ring Main Unit', committee: 'Epcover Committee', qty: 6, kva: '800', kv: '11', serialNo: '0100415-0100416', customer: 'Aweer Maintenance', cancelled: 'Customer moved the factory acceptance test to next month.' },

  { day: 13, time: '09:00', offNo: '202601131', orderName: 'Transformer 2B', committee: 'South Committee', qty: 2, kva: '1500', kv: '22/0.4', serialNo: '0206626-0206627', customer: 'ADNOC Onshore' },
  { day: 13, time: '14:00', offNo: '202601132', orderName: 'Compact Substation', committee: 'South Committee', qty: 1, kva: '1250', kv: '11/0.4', customer: 'Dubai Municipality', notes: 'Site access before 14:00 only' },

  { day: 16, time: '10:00', offNo: '202601161', orderName: 'Distribution Board Set', committee: 'LV Committee', qty: 12, kva: '100', kv: '0.4', serialNo: '0000451', customer: 'Emirates Steel' },
  { day: 16, time: '10:00', offNo: '202601162', orderName: 'Feeder Pillar Batch 3', committee: 'LV Committee', qty: 8, kva: '160', kv: '0.4', customer: 'Dubai Municipality', otherEngineer: true },

  { day: 20, time: '09:00', offNo: '202601201', orderName: 'Power Transformer 40MVA', committee: 'HV Committee', qty: 1, kva: '40000', kv: '132/11', serialNo: 'DD-004000-132000-S104', customer: 'DEWA', notes: 'Witness test, two inspectors' },
  { day: 20, time: '13:30', offNo: '202601202', orderName: 'Neutral Earthing Resistor', committee: 'HV Committee', qty: 2, kva: '—', kv: '11', customer: 'Emirates Steel' },

  { day: 23, time: '09:30', offNo: '202601231', orderName: 'Transformer 3A', committee: 'North Committee', qty: 3, kva: '1000', kv: '11/0.4', serialNo: '040662606B', customer: 'Aweer Maintenance' },
  { day: 23, time: '09:30', offNo: '202601232', orderName: 'Cast Resin Transformer', committee: 'North Committee', qty: 1, kva: '2500', kv: '22/0.4', customer: 'ADNOC Onshore', otherEngineer: true },

  { day: 27, time: '11:00', offNo: '202601271', orderName: 'Switchgear Panel Line', committee: 'Epcover Committee', qty: 5, kva: '—', kv: '11', serialNo: '0500221-0500225', customer: 'شركة جنوب القاهرة لتوزيع الكهرباء' },
  { day: 27, time: '11:00', offNo: '202601272', orderName: 'Outdoor Kiosk', committee: 'Epcover Committee', qty: 2, kva: '500', kv: '11/0.4', customer: 'Dubai Municipality' },
];

/** The colleague some projects belong to, so ownership is visibly not uniform. */
const COLLEAGUE = {
  name: 'Omar Fathy',
  email: 'omar.fathy@demo.committeeflow.app',
  role: 'PROJECT_ENGINEER' as const,
};

/* ────────────────────────────────────────────────────────────────────────────
   Guards
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * Refuses to touch anything that does not look like the demo database.
 *
 * This script publishes credentials and deletes bookings. Pointing it at a real
 * plan by leaving the wrong DATABASE_URL in the shell is the one mistake that
 * matters, so it is checked rather than trusted.
 */
/**
 * Print the database this is actually connected to.
 *
 * Pointed at Supabase, the difference between the demo project and a real one is
 * a few characters in an environment variable. Naming the target out loud costs
 * one query and turns a silent mistake into an obvious one.
 */
async function describeTarget(): Promise<void> {
  const url = process.env['DATABASE_URL'] ?? '';
  const hostFromUrl = /@([^/:]+)/.exec(url)?.[1] ?? 'unknown host';

  /*
   * Introspection is a convenience, not the job. A managed host that restricts
   * one of these views must not be able to stop the seed from running.
   */
  let encrypted: boolean | undefined;
  let row: { database: string; backendSsl: string; users: number } | undefined;

  try {
    const client = await getPool().connect();
    try {
      /*
       * Ask the socket, not the server.
       *
       * `pg_stat_ssl` describes the backend's own connection, and behind a
       * connection pooler that is the pooler-to-PostgreSQL hop — not yours. It
       * reports "off" on a perfectly encrypted client link, which is worse than
       * saying nothing. The client stream knows what it actually negotiated.
       */
      const stream = (client as unknown as {
        connection?: { stream?: { encrypted?: boolean; constructor?: { name?: string } } };
      }).connection?.stream;
      /*
       * A plain net.Socket has no `encrypted` at all — it is undefined, not
       * false — so "no flag" must not be read as "cannot tell". The stream's own
       * type is the reliable signal: pg replaces the socket with a TLSSocket
       * when it negotiates TLS.
       */
      encrypted = stream === undefined
        ? undefined
        : stream.encrypted === true || stream.constructor?.name === 'TLSSocket';

      const result = await client.query<{ database: string; backendSsl: string; users: number }>(
        `SELECT current_database() AS database,
                coalesce((SELECT ssl::text FROM pg_stat_ssl WHERE pid = pg_backend_pid()), 'unknown')
                  AS "backendSsl",
                (SELECT count(*)::int FROM users) AS users`,
      );
      row = result.rows[0];
    } finally {
      client.release();
    }
  } catch (error) {
    console.log(`Target
  host       ${hostFromUrl}`);
    console.log(`  (could not read server details: ${error instanceof Error ? error.message : error})
`);
    return;
  }

  const tls = encrypted === undefined ? 'unknown' : encrypted ? 'on' : 'OFF — sent in the clear';

  console.log('Target');
  console.log(`  host       ${hostFromUrl}`);
  console.log(`  database   ${row?.database ?? '?'}`);
  console.log(`  tls        ${tls}`);
  if (encrypted && row?.backendSsl === 'false') {
    console.log('             (the server reports its own hop as unencrypted, which is normal');
    console.log('              behind a pooler — your connection to the pooler is encrypted)');
  }
  console.log(`  users      ${row?.users ?? 0} already there
`);
}


async function assertDemoDatabase(): Promise<void> {
  if (process.env['DEMO_SEED_ALLOW'] === 'yes') return;

  const row = await queryOne<{ database: string }>('SELECT current_database() AS database');
  const name = row?.database ?? '';
  const url = process.env['DATABASE_URL'] ?? '';
  const looksLikeDemo = /demo/i.test(name) || /demo/i.test(url);

  const real = await queryRows<{ count: number }>(
    `SELECT count(*)::int AS count FROM users
      WHERE email NOT LIKE '%@demo.committeeflow.app'`,
  );
  const strangers = real[0]?.count ?? 0;

  if (looksLikeDemo || strangers === 0) return;

  console.error(
    `Refusing to seed: ${name} holds ${strangers} account(s) that are not demo accounts, ` +
      'and neither the database name nor DATABASE_URL mentions "demo".\n' +
      'If this really is the demo environment, re-run with DEMO_SEED_ALLOW=yes.',
  );
  process.exit(1);
}

/* ────────────────────────────────────────────────────────────────────────────
   Seeding
   ──────────────────────────────────────────────────────────────────────────── */

async function upsertUser(
  person: { name: string; email: string; role: 'PROJECT_ENGINEER' | 'VIEWER';
            password?: string; canManagePlanConfiguration?: boolean },
  tx: Queryable,
): Promise<string> {
  const hash = person.password ? await hashPassword(person.password) : null;

  const existing = await queryOne<{ id: string }>(
    'SELECT id FROM users WHERE lower(email) = lower($1)',
    [person.email],
    tx,
  );

  if (existing) {
    await queryOne(
      `UPDATE users
          SET name = $2,
              role = $3,
              can_manage_plan_configuration = $4,
              password_hash = COALESCE($5, password_hash),
              must_change_password = false,
              is_active = true,
              failed_login_attempts = 0,
              locked_until = NULL,
              updated_at = now()
        WHERE id = $1`,
      [existing.id, person.name, person.role, person.canManagePlanConfiguration ?? false, hash],
      tx,
    );
    return existing.id;
  }

  const created = await queryOne<{ id: string }>(
    `INSERT INTO users (name, email, password_hash, role, can_manage_plan_configuration,
                        notify_by_email, must_change_password)
     VALUES ($1, $2, $3, $4, $5, false, false)
     RETURNING id`,
    [person.name, person.email, hash, person.role, person.canManagePlanConfiguration ?? false],
    tx,
  );
  if (!created) throw new Error(`could not create ${person.email}`);
  return created.id;
}

/**
 * The business rules the company confirmed.
 *
 * `TRUNCATE users CASCADE` takes app_settings with it, and the code defaults are
 * deliberately the least presumptuous reading of the spec rather than the
 * confirmed answers — so a wiped demo would quietly lose the six-month horizon.
 */
async function restoreSettings(actorId: string, tx: Queryable): Promise<void> {
  const confirmed: Array<[string, string]> = [
    ['booking_slot_uniqueness', '"NONE"'],
    ['booking_edit_policy', '"ANY_ENGINEER"'],
    ['booking_future_horizon_months', '6'],
    ['notification_audience', '"ALL_ACTIVE_USERS"'],
  ];
  for (const [key, value] of confirmed) {
    await queryOne(
      `INSERT INTO app_settings (key, value, updated_by, updated_at)
       VALUES ($1, $2::jsonb, $3, now())
       ON CONFLICT (key) DO UPDATE
          SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [key, value, actorId],
      tx,
    );
  }
}

/** The month the demo shows: the current one, so "today" always sits inside it. */
function dateFor(day: number): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), day));
  return d.toISOString().slice(0, 10);
}

async function seedPlan(engineerId: string, colleagueId: string, tx: Queryable): Promise<number> {
  let written = 0;

  for (const row of PLAN) {
    const owner = row.otherEngineer ? colleagueId : engineerId;
    const bookingDate = dateFor(row.day);

    const inserted = await queryOne<{ id: string; version: number }>(
      `INSERT INTO bookings
         (booking_date, booking_time, off_no, order_name, committee, qty, kva, kv,
          serial_no, notes, customer_name, status, project_engineer_id,
          created_by, updated_by, cancelled_by, cancelled_at, cancellation_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14,
               $15, $16, $17)
       RETURNING id, version`,
      [
        bookingDate,
        row.time,
        row.offNo,
        row.orderName,
        row.committee,
        row.qty,
        row.kva === '—' ? null : row.kva,
        row.kv,
        row.serialNo ?? null,
        row.notes ?? null,
        row.customer,
        row.cancelled ? 'CANCELLED' : 'PLANNED',
        owner,
        owner,
        row.cancelled ? engineerId : null,
        row.cancelled ? new Date() : null,
        row.cancelled ?? null,
      ],
      tx,
    );
    if (!inserted) throw new Error(`booking ${row.offNo} was not written`);

    // A booking with no history looks untouched; the demo should show the trail.
    await queryOne(
      `INSERT INTO booking_history
         (booking_id, action, actor_id, old_values, new_values, changed_keys, booking_version)
       VALUES ($1, 'CREATE', $2, NULL, $3::jsonb, NULL, 1)`,
      [
        inserted.id,
        owner,
        JSON.stringify({
          booking_date: bookingDate,
          booking_time: row.time,
          off_no: row.offNo,
          order_name: row.orderName,
          committee: row.committee,
          customer_name: row.customer,
        }),
      ],
      tx,
    );

    if (row.cancelled) {
      await queryOne(
        `INSERT INTO booking_history
           (booking_id, action, actor_id, old_values, new_values, changed_keys, booking_version)
         VALUES ($1, 'CANCEL', $2, $3::jsonb, $4::jsonb, ARRAY['status']::text[], $5)`,
        [
          inserted.id,
          engineerId,
          JSON.stringify({ status: 'PLANNED' }),
          JSON.stringify({ status: 'CANCELLED', cancellation_reason: row.cancelled }),
          inserted.version,
        ],
        tx,
      );
    }

    written += 1;
  }

  return written;
}

/* ────────────────────────────────────────────────────────────────────────────
   Entry point
   ──────────────────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  const reset = process.argv.includes('--reset');
  const dryRun = process.argv.includes('--dry-run');

  await describeTarget();
  await assertDemoDatabase();

  if (dryRun) {
    const existing = await queryRows<{ email: string }>(
      `SELECT email FROM users WHERE email LIKE '%@demo.committeeflow.app' ORDER BY email`,
    );
    const bookings = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM bookings
        WHERE created_by IN (SELECT id FROM users WHERE email LIKE '%@demo.committeeflow.app')`,
    );
    console.log('Dry run. Nothing was written.\n');
    console.log(`  would upsert       ${DEMO_ENGINEER.email}`);
    console.log(`                     ${DEMO_VIEWER.email}`);
    console.log(`                     ${COLLEAGUE.email}`);
    console.log(`  already present    ${existing.length ? existing.map((r) => r.email).join(', ') : 'none'}`);
    console.log(`  demo bookings      ${bookings?.count ?? 0} in the database now`);
    console.log(`  would write        ${reset ? `${PLAN.length} (replacing the above)` : `${PLAN.length} if there are none`}`);
    console.log('  would restore      booking rules: slot NONE, edit ANY_ENGINEER, horizon 6 months, notify ALL_ACTIVE_USERS');
    await closePool();
    return;
  }

  const summary = await withTransaction(async (tx) => {
    const engineerId = await upsertUser(DEMO_ENGINEER, tx);
    const viewerId = await upsertUser(DEMO_VIEWER, tx);
    const colleagueId = await upsertUser(COLLEAGUE, tx);
    await restoreSettings(engineerId, tx);

    if (reset) {
      // Only the demo's own rows, and history before the bookings it points at.
      await tx.query(
        `DELETE FROM booking_history
          WHERE booking_id IN (SELECT id FROM bookings WHERE created_by = ANY($1::uuid[]))`,
        [[engineerId, colleagueId]],
      );
      await tx.query('DELETE FROM bookings WHERE created_by = ANY($1::uuid[])', [
        [engineerId, colleagueId],
      ]);
    }

    const already = await queryOne<{ count: number }>(
      'SELECT count(*)::int AS count FROM bookings WHERE created_by = ANY($1::uuid[])',
      [[engineerId, colleagueId]],
      tx,
    );

    const written = (already?.count ?? 0) > 0 ? 0 : await seedPlan(engineerId, colleagueId, tx);
    return { written, kept: already?.count ?? 0, viewerId };
  });

  console.log('Demo ready.\n');
  console.log(`  Project Engineer   ${DEMO_ENGINEER.email}`);
  console.log(`                     ${DEMO_ENGINEER.password}`);
  console.log(`  Viewer             ${DEMO_VIEWER.email}`);
  console.log(`                     ${DEMO_VIEWER.password}\n`);

  if (summary.written) {
    console.log(`  Plan               ${summary.written} bookings across the current month`);
  } else {
    console.log(`  Plan               left alone, ${summary.kept} bookings already there`);
    console.log('                     re-run with --reset to rebuild it');
  }
  const check = await queryOne<{ users: number; bookings: number; cancelled: number; days: number }>(
    `SELECT (SELECT count(*)::int FROM users WHERE email LIKE '%@demo.committeeflow.app')        AS users,
            (SELECT count(*)::int FROM bookings WHERE deleted_at IS NULL)                        AS bookings,
            (SELECT count(*)::int FROM bookings WHERE status = 'CANCELLED')                      AS cancelled,
            (SELECT count(DISTINCT booking_date)::int FROM bookings WHERE deleted_at IS NULL)    AS days`,
  );
  console.log(`\n  In the database    ${check?.users ?? 0} demo accounts, ${check?.bookings ?? 0} bookings ` +
              `across ${check?.days ?? 0} days, ${check?.cancelled ?? 0} cancelled`);

  console.log('\nThese credentials are public. Never reuse them anywhere else.');

  await closePool();
}

/**
 * Connection failures are the likely ones here, and node-postgres reports some of
 * them with an empty message. Print whatever the driver actually carries, and
 * name the two settings that cause this against a managed host.
 */
function explain(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const detail = error as Error & { code?: string; address?: string; port?: number };
  const parts = [error.message, detail.code, detail.address && `${detail.address}:${detail.port ?? ''}`]
    .filter((part) => part !== undefined && part !== '');
  const line = parts.length ? parts.join(' ') : 'the database refused the connection';

  /*
   * node-postgres reads `sslmode=require` as verify-full, so a managed host
   * whose chain is not in Node's trust store fails here rather than at connect
   * time. The fix is not to turn TLS off — it is to ask for libpq's meaning of
   * "require", which encrypts without demanding a verifiable chain.
   */
  if (/self-signed|SELF_SIGNED|unable to verify|certificate/i.test(line)) {
    return `${line}

TLS reached the server; the certificate chain did not verify. Either ask for
libpq's meaning of sslmode=require, which encrypts without verifying the chain:

    ...pooler.supabase.com:5432/postgres?uselibpqcompat=true&sslmode=require

or verify properly against the provider's CA, downloaded from its dashboard:

    ...?sslmode=verify-full&sslrootcert=C:\path\to\prod-ca-2021.crt

Do not answer this by removing sslmode. That falls back to PGSSLMODE, and the
development .env sets it to disable — which sends the password in the clear.`;
  }

  const connectionish = /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|terminated/i.test(line)
    || parts.length === 0;
  if (!connectionish) return line;

  return `${line}

Could not reach the database. Two things cause this against a managed host:
  - PGSSLMODE=disable is inherited from the development .env. Clear it:
      DATABASE_URL="...?sslmode=require" PGSSLMODE= npm run demo
  - the connection string points at the transaction pooler (port 6543).
    Use the direct connection on 5432.`;
}

main().catch(async (error) => {
  console.error(explain(error));
  await closePool().catch(() => undefined);
  process.exit(1);
});
