import { Router } from 'express';
import { z } from 'zod';
import type { PlanAccessResponse } from '@shared/api-types.js';
import { asyncHandler, parseBody, parseQuery, parseUuidParam } from '../../lib/http.js';
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
  const listQuerySchema = z.object({
    page: z.coerce.number().int().min(1).max(100_000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  });

  router.use(requireAuth, requirePlanManager);

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const { page, limit } = parseQuery(listQuerySchema, req.query);
      const body: PlanAccessResponse = await service.listAccounts(page, limit);
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
