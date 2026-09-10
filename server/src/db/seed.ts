/**
 * Bootstrap seed.
 *
 * Creates the first account so someone can sign in to a fresh deployment. It is
 * idempotent and never overwrites an existing user's password.
 *
 * Deliberately minimal: the MVP sitemap has no user-administration screen
 * (spec §7), so further accounts are created with this script or directly in
 * the database until the business asks for more.
 */
import { hashPassword } from '../modules/auth/password.js';
import { closePool } from './pool.js';
import * as usersRepository from '../modules/users/users.repository.js';
import { logger } from '../lib/logger.js';

const DEMO_FLAG = '--with-demo-users';

async function main(): Promise<void> {
  const name = process.env['SEED_ADMIN_NAME']?.trim() || 'Plan Administrator';
  const email = process.env['SEED_ADMIN_EMAIL']?.trim() || 'admin@committeeflow.local';
  const password = process.env['SEED_ADMIN_PASSWORD']?.trim();

  if (!password) {
    console.error(
      'SEED_ADMIN_PASSWORD is not set. Set it in your environment before seeding — ' +
        'this script will not invent a password.',
    );
    process.exit(1);
  }
  if (password.length < 10) {
    console.error('SEED_ADMIN_PASSWORD must be at least 10 characters.');
    process.exit(1);
  }

  const existing = await usersRepository.findByEmail(email);
  if (existing) {
    console.log(`User ${email} already exists (${existing.role}) — nothing to do.`);
  } else {
    const user = await usersRepository.createUser({
      name,
      email,
      passwordHash: await hashPassword(password),
      role: 'PROJECT_ENGINEER',
      canManagePlanConfiguration: true,
    });
    console.log(`Created ${user.email} — PROJECT_ENGINEER with plan configuration permission.`);
    console.log('Change this password after the first sign-in.');
  }

  if (process.argv.includes(DEMO_FLAG)) {
    await seedDemoUsers(password);
  }

  await closePool();
}

/**
 * Optional second and third accounts for exercising role behaviour during
 * internal testing. Never created unless explicitly requested.
 */
async function seedDemoUsers(password: string): Promise<void> {
  const demo = [
    {
      name: 'Demo Engineer',
      email: 'engineer@committeeflow.local',
      role: 'PROJECT_ENGINEER' as const,
      canManagePlanConfiguration: false,
    },
    {
      name: 'Demo Viewer',
      email: 'viewer@committeeflow.local',
      role: 'VIEWER' as const,
      canManagePlanConfiguration: false,
    },
  ];

  for (const candidate of demo) {
    if (await usersRepository.findByEmail(candidate.email)) {
      console.log(`${candidate.email} already exists — skipped.`);
      continue;
    }
    await usersRepository.createUser({
      ...candidate,
      passwordHash: await hashPassword(password),
    });
    console.log(`Created ${candidate.email} — ${candidate.role} (same password).`);
  }
}

main().catch(async (error) => {
  logger.error({ err: error }, 'seed failed');
  await closePool().catch(() => undefined);
  process.exit(1);
});
