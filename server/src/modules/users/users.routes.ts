import { Router } from 'express';
import type { PlanAccessResponse } from '@shared/api-types.js';
import { asyncHandler, parseBody, parseUuidParam } from '../../lib/http.js';
import { currentUser, requireAuth, requirePlanManager } from '../../middleware/authenticate.js';
import { writeRateLimiter } from '../../middleware/rate-limit.js';
import * as service from './users.service.js';

/**
 * Accounts, as far as the MVP needs them: reading who may configure the plan,
 * and changing it. Both are restricted to people who already hold that
 * permission — the list carries colleagues' names and email addresses, which is
 * not something every signed-in viewer needs.
 */
export function usersRouter(): Router {
  const router = Router();

  router.use(requireAuth, requirePlanManager);

  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      const body: PlanAccessResponse = { users: await service.listAccounts() };
      res.json(body);
    }),
  );

  router.patch(
    '/:id/plan-access',
    writeRateLimiter(),
    asyncHandler(async (req, res) => {
      const id = parseUuidParam(req.params.id, 'user id');
      const { canManagePlanConfiguration } = parseBody(service.planAccessSchema, req.body);
      res.json(await service.setPlanAccess(id, canManagePlanConfiguration, currentUser(req)));
    }),
  );

  return router;
}
