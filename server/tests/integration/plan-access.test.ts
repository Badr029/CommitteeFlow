import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PlanAccessUser } from '@shared/api-types.js';
import { queryRows } from '../../src/db/index.js';
import { closePool } from '../../src/db/pool.js';
import * as service from '../../src/modules/users/users.service.js';
import { createUser, resetDatabase, signIn } from '../helpers/harness.js';

/**
 * Who can configure the plan (spec §5).
 *
 * The permission is granted from the Plan Configuration screen, so the endpoint
 * behind it has to be at least as careful as the screen: only plan managers can
 * see the list, and nobody can lock the configuration away — from themselves or
 * from the company.
 */
describe('plan configuration access', () => {
  beforeEach(resetDatabase);
  afterAll(async () => {
    await closePool();
  });

  const manager = () => signIn({ role: 'PROJECT_ENGINEER', canManagePlanConfiguration: true });

  describe('who can read the list', () => {
    it('refuses everyone without the permission — the list carries colleagues’ addresses', async () => {
      const { session: engineer } = await signIn({ role: 'PROJECT_ENGINEER' });
      const { session: viewer } = await signIn({ role: 'VIEWER' });

      expect((await engineer.get('/api/users')).status).toBe(403);
      expect((await viewer.get('/api/users')).status).toBe(403);
    });

    it('lists active accounts, plan managers first', async () => {
      const { session } = await manager();
      await createUser({ role: 'VIEWER', name: 'Aaa Viewer' });
      await createUser({ role: 'PROJECT_ENGINEER', name: 'Zzz Gone', isActive: false });

      const res = await session.get('/api/users');
      expect(res.status).toBe(200);

      const users = res.body.users as PlanAccessUser[];
      expect(users.map((user) => user.name)).not.toContain('Zzz Gone');
      expect(users[0]?.canManagePlanConfiguration).toBe(true);
      expect(users.every((user) => !('passwordHash' in user))).toBe(true);
    });
  });

  describe('granting', () => {
    it('gives an engineer access and records who did it', async () => {
      const { session, user: actor } = await manager();
      const colleague = await createUser({ role: 'PROJECT_ENGINEER' });

      const res = await session.patch(`/api/users/${colleague.id}/plan-access`, {
        canManagePlanConfiguration: true,
      });
      expect(res.status).toBe(200);
      expect(res.body.canManagePlanConfiguration).toBe(true);

      const history = await queryRows<{ field_key: string; changed_by: string; new_value: unknown }>(
        `SELECT field_key, changed_by, new_value FROM configuration_history
          WHERE field_key = 'plan_configuration_access'`,
      );
      expect(history).toHaveLength(1);
      expect(history[0]?.changed_by).toBe(actor.id);
      expect(history[0]?.new_value).toMatchObject({ canManagePlanConfiguration: true });
    });

    it('is a no-op when the account already has it, and writes no history', async () => {
      const { session, user: actor } = await manager();

      const res = await session.patch(`/api/users/${actor.id}/plan-access`, {
        canManagePlanConfiguration: true,
      });
      expect(res.status).toBe(200);

      const history = await queryRows(
        `SELECT 1 FROM configuration_history WHERE field_key = 'plan_configuration_access'`,
      );
      expect(history).toHaveLength(0);
    });
  });

  describe('revoking', () => {
    it('refuses to remove your own access — that is the mistake nobody can undo alone', async () => {
      const { session, user } = await manager();
      await createUser({ role: 'PROJECT_ENGINEER', canManagePlanConfiguration: true });

      const res = await session.patch(`/api/users/${user.id}/plan-access`, {
        canManagePlanConfiguration: false,
      });
      expect(res.status).toBe(403);
      expect(res.body.error.message).toMatch(/another plan manager/i);
    });

    it('removes a colleague once someone else still holds it', async () => {
      const { session } = await manager();
      const other = await createUser({
        role: 'PROJECT_ENGINEER',
        canManagePlanConfiguration: true,
      });

      const res = await session.patch(`/api/users/${other.id}/plan-access`, {
        canManagePlanConfiguration: false,
      });
      expect(res.status).toBe(200);
      expect(res.body.canManagePlanConfiguration).toBe(false);
    });

    /*
     * Through the API the two guards overlap: the actor is always a manager, so
     * a colleague being revoked is never the last one. The count guard exists
     * for the command-line tool, which has no such actor — so it is exercised
     * where it actually bites.
     */
    it('refuses to remove the last plan manager', async () => {
      const only = await createUser({
        role: 'PROJECT_ENGINEER',
        canManagePlanConfiguration: true,
      });
      const someoneElse = await createUser({ role: 'PROJECT_ENGINEER' });

      await expect(
        service.setPlanAccess(only.id, false, { id: someoneElse.id }),
      ).rejects.toMatchObject({ status: 409 });
    });

    it('refuses an account that does not exist', async () => {
      const { session } = await manager();
      const res = await session.patch(
        '/api/users/00000000-0000-4000-8000-000000000000/plan-access',
        { canManagePlanConfiguration: true },
      );
      expect(res.status).toBe(404);
    });
  });
});
