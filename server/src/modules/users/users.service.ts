import { z } from 'zod';
import type { PlanAccessResponse, PlanAccessUser } from '@shared/api-types.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { recordConfigurationChange } from '../audit/configuration-history.repository.js';
import * as repository from './users.repository.js';

/**
 * Who may configure the plan (spec §5).
 *
 * The MVP has no user-administration screen, so this is deliberately narrow: it
 * grants and revokes one permission on accounts that already exist. Creating
 * people, renaming them and setting passwords stay with the seed script and the
 * database — see `docs/managing-users.md`.
 */

/** The audit trail keys this under a pseudo-field; it is plan configuration. */
export const PLAN_ACCESS_FIELD_KEY = 'plan_configuration_access';

export const planAccessSchema = z.object({
  canManagePlanConfiguration: z.boolean(),
});

export async function listAccounts(page: number, limit: number): Promise<PlanAccessResponse> {
  const offset = (page - 1) * limit;
  const [users, total, managerCount] = await Promise.all([
    repository.listAccountsForAccess(limit, offset),
    repository.countActiveUsers(),
    repository.countPlanManagers(),
  ]);
  return { users, page, limit, total, managerCount, hasMore: offset + users.length < total };
}

export async function setPlanAccess(
  id: string,
  canManage: boolean,
  actor: { id: string },
): Promise<PlanAccessUser> {
  const user = await repository.findById(id);
  if (!user || !user.isActive) throw notFound('That account does not exist.');

  if (user.canManagePlanConfiguration === canManage) {
    return toPlanAccessUser(user);
  }

  if (!canManage) {
    /*
     * Two ways to be locked out of Plan Configuration, both closed here.
     *
     * Removing the last plan manager would leave nobody able to grant it back,
     * and there is no screen that could — the permission would have to be
     * restored with SQL. Removing your own is the same accident one step away,
     * so it takes a second person: the one thing a colleague can always undo.
     */
    if (id === actor.id) {
      throw forbidden(
        'You cannot remove your own access. Ask another plan manager to do it for you.',
      );
    }
    if ((await repository.countPlanManagers()) <= 1) {
      throw conflict(
        'This is the only person who can configure the plan. Give someone else access first.',
      );
    }
  }

  const updated = await repository.setPlanConfigurationAccess(id, canManage);
  if (!updated) throw notFound('That account does not exist.');

  await recordConfigurationChange({
    fieldId: null,
    fieldKey: PLAN_ACCESS_FIELD_KEY,
    action: 'UPDATE',
    oldValue: { user: user.name, canManagePlanConfiguration: user.canManagePlanConfiguration },
    newValue: { user: updated.name, canManagePlanConfiguration: canManage },
    changedBy: actor.id,
  });

  logger.info(
    { actorId: actor.id, userId: id, canManagePlanConfiguration: canManage },
    'plan configuration access changed',
  );

  return toPlanAccessUser(updated);
}

function toPlanAccessUser(user: repository.UserRecord): PlanAccessUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    canManagePlanConfiguration: user.canManagePlanConfiguration,
  };
}
