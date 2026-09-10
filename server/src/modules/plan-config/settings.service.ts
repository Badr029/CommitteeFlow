import { z } from 'zod';
import type {
  AppSettings,
  BookingEditPolicy,
  NotificationAudience,
  SlotUniqueness,
} from '@shared/api-types.js';
import type { Queryable } from '../../db/index.js';
import { queryRows, withTransaction } from '../../db/index.js';
import { logger } from '../../lib/logger.js';

/**
 * Runtime application settings.
 *
 * This module exists because the specification marks three business rules as
 * OPEN and forbids the implementation from inventing them (§46, §78, §79).
 * Rather than hardcoding a guess or blocking the MVP, each rule lives in
 * `app_settings` where an authorised plan manager can set it once the business
 * confirms it — no migration, no redeploy, no code change.
 *
 * The defaults below are the least presumptuous reading of the spec, not policy
 * choices. See migration 1700000000001 for the reasoning behind each one.
 */

export const SLOT_UNIQUENESS_VALUES = [
  'NONE',
  'DATE',
  'DATE_TIME',
  'DATE_TIME_COMMITTEE',
] as const satisfies readonly SlotUniqueness[];

export const BOOKING_EDIT_POLICY_VALUES = [
  'ANY_ENGINEER',
  'CREATOR_ONLY',
  'CREATOR_OR_PLAN_MANAGER',
] as const satisfies readonly BookingEditPolicy[];

export const NOTIFICATION_AUDIENCE_VALUES = [
  'ALL_ACTIVE_USERS',
  'ENGINEERS_ONLY',
] as const satisfies readonly NotificationAudience[];

/** Maps a settings key in the database to its parser and its API property. */
const SETTING_DEFINITIONS = {
  booking_slot_uniqueness: {
    property: 'bookingSlotUniqueness',
    schema: z.enum(SLOT_UNIQUENESS_VALUES),
    fallback: 'NONE',
  },
  booking_edit_policy: {
    property: 'bookingEditPolicy',
    schema: z.enum(BOOKING_EDIT_POLICY_VALUES),
    fallback: 'ANY_ENGINEER',
  },
  booking_future_horizon_months: {
    property: 'bookingFutureHorizonMonths',
    schema: z.number().int().min(1).max(120).nullable(),
    fallback: null,
  },
  notification_audience: {
    property: 'notificationAudience',
    schema: z.enum(NOTIFICATION_AUDIENCE_VALUES),
    fallback: 'ALL_ACTIVE_USERS',
  },
} as const;

type SettingKey = keyof typeof SETTING_DEFINITIONS;

const PROPERTY_TO_KEY = Object.fromEntries(
  Object.entries(SETTING_DEFINITIONS).map(([key, def]) => [def.property, key as SettingKey]),
) as Record<keyof AppSettings, SettingKey>;

export const DEFAULT_SETTINGS: AppSettings = {
  bookingSlotUniqueness: 'NONE',
  bookingEditPolicy: 'ANY_ENGINEER',
  bookingFutureHorizonMonths: null,
  notificationAudience: 'ALL_ACTIVE_USERS',
};

export const settingsUpdateSchema = z
  .object({
    bookingSlotUniqueness: z.enum(SLOT_UNIQUENESS_VALUES).optional(),
    bookingEditPolicy: z.enum(BOOKING_EDIT_POLICY_VALUES).optional(),
    bookingFutureHorizonMonths: z.number().int().min(1).max(120).nullable().optional(),
    notificationAudience: z.enum(NOTIFICATION_AUDIENCE_VALUES).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one setting to update.',
  });

/**
 * Settings are read on nearly every request, change rarely, and are edited only
 * by plan managers — so they are cached in-process with a short TTL and the
 * cache is cleared eagerly on write.
 *
 * The TTL matters for multi-container deployments: a change made through one
 * container reaches the others within `CACHE_TTL_MS` without any coordination
 * infrastructure (spec §74 rules out Redis for the MVP).
 */
const CACHE_TTL_MS = 30_000;
let cache: { value: AppSettings; expiresAt: number } | undefined;

export function invalidateSettingsCache(): void {
  cache = undefined;
}

export async function getSettings(executor?: Queryable): Promise<AppSettings> {
  if (cache && cache.expiresAt > Date.now()) {
    return cache.value;
  }

  const rows = await queryRows<{ key: string; value: unknown }>(
    'SELECT key, value FROM app_settings',
    [],
    executor,
  );

  const stored = new Map(rows.map((row) => [row.key, row.value]));
  const resolved = { ...DEFAULT_SETTINGS };

  for (const [key, definition] of Object.entries(SETTING_DEFINITIONS) as Array<
    [SettingKey, (typeof SETTING_DEFINITIONS)[SettingKey]]
  >) {
    if (!stored.has(key)) continue;
    const parsed = definition.schema.safeParse(stored.get(key));
    if (parsed.success) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- key/property pairing is proven by SETTING_DEFINITIONS
      (resolved as any)[definition.property] = parsed.data;
    } else {
      // A malformed row must not take the API down; fall back and shout.
      logger.error(
        { settingKey: key, issues: parsed.error.issues },
        'invalid app_settings row, using default',
      );
    }
  }

  cache = { value: resolved, expiresAt: Date.now() + CACHE_TTL_MS };
  return resolved;
}

/** Applies a partial settings change and records who made it. */
export async function updateSettings(
  patch: z.infer<typeof settingsUpdateSchema>,
  actorId: string,
): Promise<AppSettings> {
  const entries = Object.entries(patch) as Array<[keyof AppSettings, unknown]>;

  await withTransaction(async (tx) => {
    for (const [property, value] of entries) {
      if (value === undefined) continue;
      const key = PROPERTY_TO_KEY[property];
      await tx.query(
        `INSERT INTO app_settings (key, value, updated_by, updated_at)
         VALUES ($1, $2::jsonb, $3, now())
         ON CONFLICT (key) DO UPDATE
            SET value = EXCLUDED.value,
                updated_by = EXCLUDED.updated_by,
                updated_at = now()`,
        [key, JSON.stringify(value ?? null), actorId],
      );
    }
  });

  invalidateSettingsCache();
  const next = await getSettings();
  logger.info({ actorId, changed: entries.map(([p]) => p) }, 'application settings updated');
  return next;
}
