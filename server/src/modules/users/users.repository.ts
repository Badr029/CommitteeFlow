import type { UserRef, UserRole } from '@shared/api-types.js';
import type { Queryable } from '../../db/index.js';
import { queryOne, queryRows } from '../../db/index.js';

/** A user row as stored. `passwordHash` never leaves this module's callers. */
export interface UserRecord {
  id: string;
  name: string;
  email: string;
  passwordHash: string | null;
  role: UserRole;
  canManagePlanConfiguration: boolean;
  isActive: boolean;
  notifyByEmail: boolean;
  mustChangePassword: boolean;
  externalIdentityId: string | null;
  failedLoginAttempts: number;
  lockedUntil: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface UserRow {
  id: string;
  name: string;
  email: string;
  password_hash: string | null;
  role: UserRole;
  can_manage_plan_configuration: boolean;
  is_active: boolean;
  notify_by_email: boolean;
  must_change_password: boolean;
  external_identity_id: string | null;
  failed_login_attempts: number;
  locked_until: Date | null;
  last_login_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const USER_COLUMNS = `
  id, name, email, password_hash, role, can_manage_plan_configuration,
  is_active, notify_by_email, must_change_password, external_identity_id, failed_login_attempts,
  locked_until, last_login_at, created_at, updated_at
`;

function toRecord(row: UserRow): UserRecord {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    passwordHash: row.password_hash,
    role: row.role,
    canManagePlanConfiguration: row.can_manage_plan_configuration,
    isActive: row.is_active,
    notifyByEmail: row.notify_by_email,
    mustChangePassword: row.must_change_password,
    externalIdentityId: row.external_identity_id,
    failedLoginAttempts: row.failed_login_attempts,
    lockedUntil: row.locked_until,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function findByEmail(email: string, executor?: Queryable): Promise<UserRecord | undefined> {
  const row = await queryOne<UserRow>(
    `SELECT ${USER_COLUMNS} FROM users WHERE lower(email) = lower($1)`,
    [email],
    executor,
  );
  return row ? toRecord(row) : undefined;
}

export async function findById(id: string, executor?: Queryable): Promise<UserRecord | undefined> {
  const row = await queryOne<UserRow>(
    `SELECT ${USER_COLUMNS} FROM users WHERE id = $1`,
    [id],
    executor,
  );
  return row ? toRecord(row) : undefined;
}

export async function listActiveUserRefs(executor?: Queryable): Promise<UserRef[]> {
  return queryRows<UserRef>(
    `SELECT id, name, email FROM users WHERE is_active ORDER BY name`,
    [],
    executor,
  );
}

/** Recipients for booking notifications, honouring each user's opt-out (§16). */
export async function listNotificationRecipients(
  audience: 'ALL_ACTIVE_USERS' | 'ENGINEERS_ONLY',
  executor?: Queryable,
): Promise<string[]> {
  const rows = await queryRows<{ email: string }>(
    `SELECT email
       FROM users
      WHERE is_active
        AND notify_by_email
        AND ($1::boolean IS FALSE OR role = 'PROJECT_ENGINEER')
      ORDER BY email`,
    [audience === 'ENGINEERS_ONLY'],
    executor,
  );
  return rows.map((row) => row.email);
}

export async function recordSuccessfulLogin(id: string, executor?: Queryable): Promise<void> {
  await queryOne(
    `UPDATE users
        SET failed_login_attempts = 0,
            locked_until = NULL,
            last_login_at = now()
      WHERE id = $1`,
    [id],
    executor,
  );
}

/**
 * Records a failed attempt and locks the account once the threshold is passed.
 *
 * This complements the IP-based rate limiter (spec §62): the limiter stops one
 * host hammering the endpoint, this stops a distributed attempt against a
 * single known account.
 */
export async function recordFailedLogin(
  id: string,
  maxAttempts: number,
  lockMinutes: number,
  executor?: Queryable,
): Promise<void> {
  await queryOne(
    `UPDATE users
        SET failed_login_attempts = failed_login_attempts + 1,
            locked_until = CASE
              WHEN failed_login_attempts + 1 >= $2 THEN now() + make_interval(mins => $3)
              ELSE locked_until
            END
      WHERE id = $1`,
    [id, maxAttempts, lockMinutes],
    executor,
  );
}

export interface CreateUserInput {
  name: string;
  email: string;
  passwordHash: string | null;
  role: UserRole;
  canManagePlanConfiguration?: boolean;
  notifyByEmail?: boolean;
  mustChangePassword?: boolean;
}

export async function createUser(
  input: CreateUserInput,
  executor?: Queryable,
): Promise<UserRecord> {
  const row = await queryOne<UserRow>(
    `INSERT INTO users (name, email, password_hash, role, can_manage_plan_configuration, notify_by_email, must_change_password)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${USER_COLUMNS}`,
    [
      input.name,
      input.email,
      input.passwordHash,
      input.role,
      input.canManagePlanConfiguration ?? false,
      input.notifyByEmail ?? true,
      input.mustChangePassword ?? false,
    ],
    executor,
  );
  if (!row) throw new Error('user insert returned no row');
  return toRecord(row);
}

export async function setPasswordHash(
  id: string,
  passwordHash: string,
  mustChangePassword = false,
  executor?: Queryable,
): Promise<void> {
  await queryOne(
    `UPDATE users
        SET password_hash = $2,
            must_change_password = $3,
            failed_login_attempts = 0,
            locked_until = NULL
      WHERE id = $1`,
    [id, passwordHash, mustChangePassword],
    executor,
  );
}

export async function countUsers(executor?: Queryable): Promise<number> {
  const row = await queryOne<{ count: number }>('SELECT count(*)::int AS count FROM users', [], executor);
  return row?.count ?? 0;
}

/**
 * Everyone who could hold plan-configuration access.
 *
 * Deactivated accounts are left out: they cannot sign in, so listing them would
 * only invite someone to grant access that does nothing.
 */
export async function listAccountsForAccess(executor?: Queryable): Promise<
  Array<{
    id: string;
    name: string;
    email: string;
    role: UserRole;
    canManagePlanConfiguration: boolean;
  }>
> {
  return queryRows(
    `SELECT id, name, email, role,
            can_manage_plan_configuration AS "canManagePlanConfiguration"
       FROM users
      WHERE is_active
      ORDER BY can_manage_plan_configuration DESC, name`,
    [],
    executor,
  );
}

/** How many people can still reach Plan Configuration. Guards the last one. */
export async function countPlanManagers(executor?: Queryable): Promise<number> {
  const row = await queryOne<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM users
      WHERE is_active AND can_manage_plan_configuration`,
    [],
    executor,
  );
  return row?.count ?? 0;
}

export async function setPlanConfigurationAccess(
  id: string,
  canManage: boolean,
  executor?: Queryable,
): Promise<UserRecord | undefined> {
  const row = await queryOne<UserRow>(
    `UPDATE users
        SET can_manage_plan_configuration = $2,
            updated_at = now()
      WHERE id = $1
      RETURNING ${USER_COLUMNS}`,
    [id, canManage],
    executor,
  );
  return row ? toRecord(row) : undefined;
}
