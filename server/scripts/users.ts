/**
 * User administration from the command line.
 *
 * The MVP has no user-administration screen (spec §7), and passwords are Argon2
 * hashes — so accounts cannot be added with SQL alone. This script is the
 * supported way to do it until the business asks for a screen.
 *
 * Every command is safe to re-run, and nothing here deletes a user: a booking's
 * history refers to whoever made it. Someone who has left is deactivated, which
 * stops them signing in and keeps the record readable.
 *
 *   npm run users -- list
 *   npm run users -- add "Ahmed Fathy" ahmed@example.com --engineer --can-configure
 *   npm run users -- add "Demo" demo@example.com --engineer --shared
 *   npm run users -- password ahmed@example.com
 *   npm run users -- role ahmed@example.com viewer
 *   npm run users -- configure ahmed@example.com on
 *   npm run users -- deactivate ahmed@example.com
 *
 * A password is read from the CFLOW_PASSWORD environment variable, or typed at
 * the prompt — never passed as an argument, where it would sit in the shell's
 * history.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { hashPassword, passwordPolicyIssues } from '../src/modules/auth/password.js';
import { queryOne, queryRows } from '../src/db/index.js';
import { closePool } from '../src/db/pool.js';
import * as users from '../src/modules/users/users.repository.js';

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case 'list':
      await list();
      break;
    case 'add':
      await add(args);
      break;
    case 'password':
      await setPassword(required(args[0], 'email'));
      break;
    case 'role':
      await setRole(required(args[0], 'email'), required(args[1], 'role'));
      break;
    case 'configure':
      await setConfigure(required(args[0], 'email'), required(args[1], 'on or off'));
      break;
    case 'rename':
      await rename(required(args[0], 'email'), required(args[1], 'new name'));
      break;
    case 'deactivate':
      await setActive(required(args[0], 'email'), false);
      break;
    case 'activate':
      await setActive(required(args[0], 'email'), true);
      break;
    default:
      usage();
      process.exitCode = command === undefined || command === '--help' ? 0 : 1;
  }

  await closePool();
}

function usage(): void {
  console.log(`CommitteeFlow users

  list                              every account and what it can do
  add <name> <email> [flags]        create an account
      --engineer                    can create and edit bookings (default: viewer)
      --can-configure               can change Plan Configuration
      --no-email                    opt out of booking notifications
      --shared                      a demo sign-in: password is not temporary,
                                    and it receives no notifications
  password <email>                  set a new password
  role <email> engineer|viewer      change what they can do with bookings
  configure <email> on|off          grant or revoke Plan Configuration
  rename <email> <name>             correct a name
  deactivate <email>                stop them signing in, keep their history
  activate <email>                  let them back in

Password comes from CFLOW_PASSWORD, or is typed at the prompt.`);
}

function required(value: string | undefined, what: string): string {
  if (!value || value.trim() === '') {
    console.error(`Missing ${what}.`);
    process.exit(1);
  }
  return value.trim();
}

async function list(): Promise<void> {
  const rows = await queryRows<{
    name: string;
    email: string;
    role: string;
    can_manage_plan_configuration: boolean;
    is_active: boolean;
    last_login_at: Date | null;
  }>(
    `SELECT name, email, role, can_manage_plan_configuration, is_active, last_login_at
       FROM users ORDER BY is_active DESC, name`,
  );

  if (rows.length === 0) {
    console.log('No accounts yet. Run: npm run users -- add "Your Name" you@example.com --engineer --can-configure');
    return;
  }

  for (const row of rows) {
    const marks = [
      row.role === 'PROJECT_ENGINEER' ? 'engineer' : 'viewer',
      row.can_manage_plan_configuration ? 'can configure' : null,
      row.is_active ? null : 'DEACTIVATED',
    ].filter(Boolean);
    const seen = row.last_login_at
      ? row.last_login_at.toISOString().slice(0, 10)
      : 'never signed in';
    console.log(`${row.name}  <${row.email}>  [${marks.join(', ')}]  ${seen}`);
  }
}

async function add(args: string[]): Promise<void> {
  const flags = args.filter((arg) => arg.startsWith('--'));
  const positional = args.filter((arg) => !arg.startsWith('--'));
  const name = required(positional[0], 'name');
  const email = required(positional[1], 'email').toLowerCase();

  if (await users.findByEmail(email)) {
    console.error(`${email} already exists. Use "password", "role" or "configure" to change it.`);
    process.exit(1);
  }

  /*
   * A shared account cannot be asked to rotate its password.
   *
   * Every account created here is handed a temporary password and told to
   * replace it, which is right for a person. A demo sign-in published on a
   * website is not a person: the first thing a visitor would meet is a dialog
   * they cannot dismiss, on an account they do not own, and the password they
   * were given would stop working for the next visitor.
   */
  const shared = flags.includes('--shared');

  const password = await readPassword();
  const user = await users.createUser({
    name,
    email,
    passwordHash: await hashPassword(password),
    role: flags.includes('--engineer') ? 'PROJECT_ENGINEER' : 'VIEWER',
    canManagePlanConfiguration: flags.includes('--can-configure'),
    notifyByEmail: !flags.includes('--no-email') && !shared,
    mustChangePassword: !shared,
  });

  const extra = user.canManagePlanConfiguration ? ', can configure the plan' : '';
  console.log(`Created ${user.email} — ${user.role}${extra}.`);
  console.log(
    shared
      ? 'Shared account: the password stays as set, and it receives no notifications.'
      : 'They must replace this temporary password at first sign-in.',
  );
}

async function setPassword(email: string): Promise<void> {
  const user = await mustFind(email);
  await users.setPasswordHash(user.id, await hashPassword(await readPassword()), true);
  console.log(`Temporary password updated for ${user.email}; replacement is required at next sign-in.`);
}

async function setRole(email: string, role: string): Promise<void> {
  const normalised = role.toLowerCase();
  if (normalised !== 'engineer' && normalised !== 'viewer') {
    console.error('Role must be "engineer" or "viewer".');
    process.exit(1);
  }
  const user = await mustFind(email);
  await queryOne('UPDATE users SET role = $2, updated_at = now() WHERE id = $1', [
    user.id,
    normalised === 'engineer' ? 'PROJECT_ENGINEER' : 'VIEWER',
  ]);
  console.log(`${user.email} is now a ${normalised}.`);
}

async function setConfigure(email: string, onOff: string): Promise<void> {
  const wanted = onOff.toLowerCase();
  const canManage = wanted === 'on' || wanted === 'true' || wanted === 'yes';
  const user = await mustFind(email);

  /*
   * The same guard the API applies: the last plan manager keeps their access,
   * because there is no screen that could give it back.
   */
  if (!canManage && user.canManagePlanConfiguration && (await users.countPlanManagers()) <= 1) {
    console.error(
      `${user.email} is the only person who can configure the plan. Give someone else access first.`,
    );
    process.exit(1);
  }

  await users.setPlanConfigurationAccess(user.id, canManage);
  console.log(`${user.email} ${canManage ? 'can' : 'can no longer'} configure the plan.`);
}

async function rename(email: string, name: string): Promise<void> {
  const user = await mustFind(email);
  await queryOne('UPDATE users SET name = $2, updated_at = now() WHERE id = $1', [user.id, name]);
  console.log(`${user.email} is now "${name}".`);
}

async function setActive(email: string, active: boolean): Promise<void> {
  const user = await mustFind(email);
  if (!active && user.canManagePlanConfiguration && (await users.countPlanManagers()) <= 1) {
    console.error(
      `${user.email} is the only person who can configure the plan. Give someone else access first.`,
    );
    process.exit(1);
  }
  await queryOne(
    `UPDATE users
        SET is_active = $2, failed_login_attempts = 0, locked_until = NULL, updated_at = now()
      WHERE id = $1`,
    [user.id, active],
  );
  console.log(`${user.email} is ${active ? 'active again' : 'deactivated'}. History unchanged.`);
}

async function mustFind(email: string) {
  const user = await users.findByEmail(email);
  if (!user) {
    console.error(`No account for ${email}. Run "npm run users -- list" to see the addresses.`);
    process.exit(1);
  }
  return user;
}

async function readPassword(): Promise<string> {
  const fromEnv = process.env['CFLOW_PASSWORD']?.trim();
  const password = fromEnv || (await prompt('Temporary password: '));
  const issues = passwordPolicyIssues(password);
  if (issues.length > 0) {
    console.error(`The password must contain ${issues.join(', ')}.`);
    process.exit(1);
  }
  return password;
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  await closePool().catch(() => undefined);
  process.exit(1);
});
