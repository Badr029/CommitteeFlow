import { Router } from 'express';
import { z } from 'zod';
import type { AppSettings, PlanFieldsResponse } from '@shared/api-types.js';
import { asyncHandler, parseBody, parseQuery, parseUuidParam } from '../../lib/http.js';
import { currentUser, requireAuth, requirePlanManager } from '../../middleware/authenticate.js';
import { writeRateLimiter } from '../../middleware/rate-limit.js';
import { listConfigurationHistory } from '../audit/configuration-history.repository.js';
import * as service from './plan-fields.service.js';
import { getSettings, settingsUpdateSchema, updateSettings } from './settings.service.js';

/**
 * Plan Configuration endpoints (spec §5, §34, §38).
 *
 * Reading the configuration is open to every signed-in user — the SPA cannot
 * render a booking form without it. Writing requires the restricted
 * `can_manage_plan_configuration` permission, enforced here on the server.
 */
export function planFieldsRouter(): Router {
  const router = Router();
  const limitWrites = writeRateLimiter();

  router.use(requireAuth);

  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      const body: PlanFieldsResponse = { fields: await service.listFields() };
      res.json(body);
    }),
  );

  router.post(
    '/',
    limitWrites,
    requirePlanManager,
    asyncHandler(async (req, res) => {
      const input = parseBody(service.createPlanFieldSchema, req.body);
      res.status(201).json(await service.createField(input, currentUser(req).id));
    }),
  );

  /**
   * Reordering is its own endpoint rather than a series of PATCHes so the whole
   * new order commits as one transaction and one audit entry (spec §25).
   */
  router.post(
    '/reorder',
    limitWrites,
    requirePlanManager,
    asyncHandler(async (req, res) => {
      const { order } = parseBody(service.reorderPlanFieldsSchema, req.body);
      const fields = await service.reorderFields(order, currentUser(req).id);
      const body: PlanFieldsResponse = { fields };
      res.json(body);
    }),
  );

  router.patch(
    '/:id',
    limitWrites,
    requirePlanManager,
    asyncHandler(async (req, res) => {
      const id = parseUuidParam(req.params.id, 'field id');
      const patch = parseBody(service.updatePlanFieldSchema, req.body);
      res.json(await service.updateField(id, patch, currentUser(req).id));
    }),
  );

  /** Archive, never delete — old bookings keep their values (spec §23). */
  router.post(
    '/:id/archive',
    limitWrites,
    requirePlanManager,
    asyncHandler(async (req, res) => {
      const id = parseUuidParam(req.params.id, 'field id');
      res.json(await service.archiveField(id, currentUser(req).id));
    }),
  );

  router.post(
    '/:id/restore',
    limitWrites,
    requirePlanManager,
    asyncHandler(async (req, res) => {
      const id = parseUuidParam(req.params.id, 'field id');
      res.json(await service.restoreField(id, currentUser(req).id));
    }),
  );

  const historyQuerySchema = z.object({
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  });

  router.get(
    '/history',
    requirePlanManager,
    asyncHandler(async (req, res) => {
      const { page, limit } = parseQuery(historyQuerySchema, req.query);
      const entries = await listConfigurationHistory(limit + 1, (page - 1) * limit);
      res.json({
        entries: entries.slice(0, limit),
        page,
        limit,
        hasMore: entries.length > limit,
      });
    }),
  );

  return router;
}

/**
 * Application settings, including the specification's open business rules.
 *
 * Everyone reads them (the SPA needs to know whether slot conflicts can occur);
 * only plan managers write them.
 */
export function settingsRouter(): Router {
  const router = Router();

  router.use(requireAuth);

  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      const body: AppSettings = await getSettings();
      res.json(body);
    }),
  );

  router.patch(
    '/',
    writeRateLimiter(),
    requirePlanManager,
    asyncHandler(async (req, res) => {
      const patch = parseBody(settingsUpdateSchema, req.body);
      res.json(await updateSettings(patch, currentUser(req).id));
    }),
  );

  return router;
}
