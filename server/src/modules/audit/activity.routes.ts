import { Router } from 'express';
import { z } from 'zod';
import type { ActivityResponse } from '@shared/api-types.js';
import { asyncHandler, parseQuery } from '../../lib/http.js';
import { requireAuth } from '../../middleware/authenticate.js';
import * as planFields from '../plan-config/plan-fields.repository.js';
import { listActivity } from './booking-history.repository.js';

/**
 * Activity feed (spec §14, §56).
 *
 * Always paginated — the endpoint has no "return everything" mode. Read-only by
 * design: there is no route here that writes, updates or deletes audit data
 * (spec §67).
 */
const activityQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  bookingId: z.uuid().optional(),
  actorId: z.uuid().optional(),
});

export function activityRouter(): Router {
  const router = Router();

  router.use(requireAuth);

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const { page, limit, bookingId, actorId } = parseQuery(activityQuerySchema, req.query);

      // Archived definitions included so a change to a since-archived field
      // still renders with its label rather than its raw key.
      const fields = await planFields.listAll();
      const labels = new Map(fields.map((field) => [field.fieldKey, field.label]));

      const { entries, hasMore } = await listActivity(
        {
          limit,
          offset: (page - 1) * limit,
          ...(bookingId ? { bookingId } : {}),
          ...(actorId ? { actorId } : {}),
        },
        labels,
      );

      const body: ActivityResponse = { entries, page, limit, hasMore };
      res.json(body);
    }),
  );

  return router;
}
