import { z } from 'zod';
import type { PlanField, PlanFieldType } from '@shared/api-types.js';
import { badRequest, conflict, notFound, validationFailed } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { PG_ERROR, isPgError, withTransaction } from '../../db/index.js';
import type { Queryable } from '../../db/index.js';
import * as repository from './plan-fields.repository.js';
import type { PlanFieldRecord } from './plan-fields.repository.js';
import { recordConfigurationChange } from '../audit/configuration-history.repository.js';
import {
  COLUMN_FIELD_KINDS,
  COMPATIBLE_TYPES_BY_KIND,
  RESERVED_FIELD_KEYS,
  assertColumnKey,
  isColumnFieldKey,
  isReadOnlyFieldKey,
} from './field-keys.js';

/**
 * Plan Configuration rules (spec §19–§25).
 *
 * The business-facing structure of the Committee Plan is configurable. The
 * database schema is not (§20) — which is exactly why CUSTOM fields go to JSONB
 * and STANDARD/SYSTEM fields stay columns.
 */

const FIELD_TYPES = [
  'TEXT',
  'LONG_TEXT',
  'NUMBER',
  'SELECT',
  'DATE',
  'TIME',
  'CHECKBOX',
] as const satisfies readonly PlanFieldType[];

const optionsSchema = z
  .array(z.string().trim().min(1, 'An option cannot be empty.').max(120))
  .max(100, 'A field can have at most 100 options.')
  .refine((options) => new Set(options).size === options.length, {
    message: 'Options must be unique.',
  });

export const createPlanFieldSchema = z
  .object({
    fieldKey: z
      .string()
      .trim()
      .regex(
        /^[a-z][a-z0-9_]{0,62}$/,
        'Use lowercase letters, numbers and underscores, starting with a letter.',
      )
      .refine((key) => !RESERVED_FIELD_KEYS.has(key), {
        message: 'That key is reserved by the system.',
      }),
    label: z.string().trim().min(1, 'A label is required.').max(120),
    helpText: z.string().trim().max(300).nullish(),
    fieldType: z.enum(FIELD_TYPES),
    isRequired: z.boolean().optional(),
    isVisible: z.boolean().optional(),
    options: optionsSchema.optional(),
    displayOrder: z.number().int().min(0).max(100_000).optional(),
  })
  .refine((value) => value.fieldType !== 'SELECT' || (value.options?.length ?? 0) > 0, {
    message: 'A Select field needs at least one option.',
    path: ['options'],
  });

export const updatePlanFieldSchema = z
  .object({
    label: z.string().trim().min(1, 'A label is required.').max(120).optional(),
    helpText: z.string().trim().max(300).nullish(),
    fieldType: z.enum(FIELD_TYPES).optional(),
    isRequired: z.boolean().optional(),
    isVisible: z.boolean().optional(),
    options: optionsSchema.optional(),
    displayOrder: z.number().int().min(0).max(100_000).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one change.',
  });

export const reorderPlanFieldsSchema = z.object({
  order: z.array(z.uuid()).min(1).max(200),
});

/**
 * What a plan manager may change about a field right now (spec §24).
 *
 * Label / order / visibility are always editable. The technical key never is.
 * Type becomes locked once bookings hold data — with one deliberate exception,
 * documented on `canChangeType` below.
 */
/** The storage kind behind a field, or null for a custom (JSONB) one. */
function kindOf(record: PlanFieldRecord): string | null {
  return isColumnFieldKey(record.fieldKey) ? COLUMN_FIELD_KINDS[record.fieldKey] : null;
}

export function computeEditability(
  record: PlanFieldRecord,
  populatedBookingCount: number,
): PlanField['editability'] {
  const isSystem = record.fieldClass === 'SYSTEM';
  const hasData = populatedBookingCount > 0;

  const lockedReason = isSystem
    ? 'This field is required by the application and cannot be archived or retyped.'
    : hasData
      ? `${populatedBookingCount} booking${populatedBookingCount === 1 ? '' : 's'} already hold a value for this field.`
      : null;

  return {
    canRename: true,
    canReorder: true,
    // Hiding a system field would leave the plan without a date or a time.
    canToggleVisibility: !isSystem,
    // A system field is required by definition; a standard/custom field's
    // requiredness is configurable "where valid" (§21).
    /*
     * A field nobody can fill in must not be markable as required, or every
     * booking form would fail validation on a value the user is not allowed to
     * provide. Status is set by cancelling; Project Engineer by signing in.
     */
    canToggleRequired: !isSystem && !isReadOnlyFieldKey(record.fieldKey),
    /*
     * Status is a Select whose options are the application's, not a
     * preference. Letting a plan manager add a third one would put the field
     * straight back where it started — holding `010662606B` and driving nothing.
     */
    canEditOptions: record.fieldType === 'SELECT' && kindOf(record) !== 'LIFECYCLE',
    /**
     * Two independent gates on a type change (§20, §24):
     *
     *   1. Storage. A column-backed field can only take a type its column can
     *      actually hold — Status may become a Select list because both live in
     *      a text column; Qty may not become text because its column is an
     *      integer. Custom fields are JSONB, so storage never blocks them.
     *   2. Data. Once bookings hold values the type is locked, with the single
     *      exception handled in `assertTypeChangeAllowed`: TEXT → SELECT where
     *      every stored value is already one of the new options, which cannot
     *      lose or reinterpret anything.
     */
    canChangeType: !isSystem && compatibleTypesFor(record).length > 1 && (!hasData || record.fieldType === 'TEXT'),
    canArchive: !isSystem && record.fieldClass === 'CUSTOM' && record.isActive,
    lockedReason,
    populatedBookingCount,
  };
}

async function decorate(records: PlanFieldRecord[], executor?: Queryable): Promise<PlanField[]> {
  const counts = await Promise.all(
    records.map((record) => repository.countPopulatedBookings(record, executor)),
  );
  return records.map((record, index) =>
    repository.toApi(record, computeEditability(record, counts[index] ?? 0)),
  );
}

/** Every definition, archived included — needed to render historical values. */
export async function listFields(executor?: Queryable): Promise<PlanField[]> {
  return decorate(await repository.listAll(executor), executor);
}

/** Active definitions only; the set that drives forms and new bookings. */
export async function listActiveFieldRecords(executor?: Queryable): Promise<PlanFieldRecord[]> {
  return repository.listActive(executor);
}

export async function listAllFieldRecords(executor?: Queryable): Promise<PlanFieldRecord[]> {
  return repository.listAll(executor);
}

export async function createField(
  input: z.infer<typeof createPlanFieldSchema>,
  actorId: string,
): Promise<PlanField> {
  const created = await withTransaction(async (tx) => {
    const displayOrder =
      input.displayOrder ?? (await repository.maxDisplayOrder(tx)) + 10;

    let record: PlanFieldRecord;
    try {
      record = await repository.insert(
        {
          fieldKey: input.fieldKey,
          label: input.label,
          helpText: input.helpText ?? null,
          fieldType: input.fieldType,
          isRequired: input.isRequired ?? false,
          isVisible: input.isVisible ?? true,
          displayOrder,
          options: input.options ?? [],
        },
        tx,
      );
    } catch (error) {
      if (isPgError(error, PG_ERROR.UNIQUE_VIOLATION)) {
        throw conflict(`A field with the key "${input.fieldKey}" already exists.`);
      }
      throw error;
    }

    await recordConfigurationChange(
      {
        fieldId: record.id,
        fieldKey: record.fieldKey,
        action: 'CREATE',
        oldValue: null,
        newValue: auditSnapshot(record),
        changedBy: actorId,
      },
      tx,
    );

    return record;
  });

  logger.info({ actorId, fieldKey: created.fieldKey }, 'plan field created');
  return repository.toApi(created, computeEditability(created, 0));
}

export async function updateField(
  id: string,
  patch: z.infer<typeof updatePlanFieldSchema>,
  actorId: string,
): Promise<PlanField> {
  const result = await withTransaction(async (tx) => {
    const existing = await repository.findById(id, tx);
    if (!existing) throw notFound('That plan field does not exist.');

    const populated = await repository.countPopulatedBookings(existing, tx);
    const editability = computeEditability(existing, populated);

    if (patch.isVisible !== undefined && !editability.canToggleVisibility) {
      throw badRequest(`"${existing.label}" must stay visible on the plan.`);
    }
    if (patch.isRequired !== undefined && !editability.canToggleRequired) {
      throw badRequest(
        isReadOnlyFieldKey(existing.fieldKey)
          ? `"${existing.label}" is set by the application, so it cannot be made required.`
          : `"${existing.label}" is always required.`,
      );
    }
    /*
     * Status is a Select whose two options the application depends on. Adding a
     * third would leave the plan holding a state nothing knows how to render,
     * cancel or export — which is how this field came to hold serial numbers in
     * the first place.
     *
     * Scoped to the lifecycle rather than to `canEditOptions`, because that
     * flag is also false for a field on its way from TEXT to SELECT, which is
     * an ordinary thing for a plan manager to do.
     */
    if (patch.options !== undefined && kindOf(existing) === 'LIFECYCLE') {
      throw badRequest(`The options for "${existing.label}" are set by the application.`);
    }

    const nextType = patch.fieldType ?? existing.fieldType;
    const nextOptions = patch.options ?? existing.options;

    if (patch.fieldType !== undefined && patch.fieldType !== existing.fieldType) {
      await assertTypeChangeAllowed(existing, patch.fieldType, nextOptions, populated, tx);
    }

    if (nextType === 'SELECT' && nextOptions.length === 0) {
      throw validationFailed([{ field: 'options', message: 'A Select field needs at least one option.' }]);
    }
    if (nextType !== 'SELECT' && patch.options !== undefined && patch.options.length > 0) {
      throw validationFailed([
        { field: 'options', message: 'Only Select fields can have options.' },
      ]);
    }

    // Removing an option that bookings already use would silently invalidate
    // them; it is blocked rather than allowed to corrupt existing rows.
    if (patch.options !== undefined && existing.fieldType === 'SELECT') {
      const removed = existing.options.filter((option) => !patch.options?.includes(option));
      if (removed.length > 0) {
        const inUse = await findOptionsInUse(existing, removed, tx);
        if (inUse.length > 0) {
          throw conflict(
            `Cannot remove option${inUse.length === 1 ? '' : 's'} ${inUse
              .map((option) => `"${option}"`)
              .join(', ')} — existing bookings still use ${inUse.length === 1 ? 'it' : 'them'}.`,
          );
        }
      }
    }

    const updated = await repository.update(id, patch, tx);
    if (!updated) throw notFound('That plan field does not exist.');

    await recordConfigurationChange(
      {
        fieldId: updated.id,
        fieldKey: updated.fieldKey,
        action: 'UPDATE',
        oldValue: auditSnapshot(existing),
        newValue: auditSnapshot(updated),
        changedBy: actorId,
      },
      tx,
    );

    return { updated, populated };
  });

  logger.info({ actorId, fieldKey: result.updated.fieldKey }, 'plan field updated');
  return repository.toApi(
    result.updated,
    computeEditability(result.updated, result.populated),
  );
}

/** Plan field types this field's storage can hold (see COLUMN_FIELD_KINDS). */
export function compatibleTypesFor(record: PlanFieldRecord): readonly PlanFieldType[] {
  if (record.storageStrategy === 'CUSTOM_JSONB') {
    return FIELD_TYPES;
  }
  assertColumnKey(record.fieldKey);
  return COMPATIBLE_TYPES_BY_KIND[COLUMN_FIELD_KINDS[record.fieldKey]];
}

/**
 * Guards a type change on an existing field.
 *
 * TEXT → SELECT is safe precisely when the new option list is a superset of
 * every value already stored: nothing is lost and nothing is reinterpreted.
 * Every other transition on a populated field is refused (§24).
 */
async function assertTypeChangeAllowed(
  existing: PlanFieldRecord,
  nextType: PlanFieldType,
  nextOptions: string[],
  populated: number,
  tx: Queryable,
): Promise<void> {
  if (existing.fieldClass === 'SYSTEM') {
    throw badRequest('System fields cannot change type.');
  }

  const compatible = compatibleTypesFor(existing);
  if (!compatible.includes(nextType)) {
    throw badRequest(
      `"${existing.label}" is stored in a fixed column, so it can only be ${compatible.join(
        ' or ',
      )}. Hide it and add a custom field if you need a different type.`,
    );
  }

  if (populated === 0) return;

  if (existing.fieldType === 'TEXT' && nextType === 'SELECT') {
    const distinct = await distinctStoredValues(existing, tx);
    const missing = distinct.filter((value) => !nextOptions.includes(value));
    if (missing.length > 0) {
      throw conflict(
        `Cannot convert "${existing.label}" to a Select field: ${missing.length} existing value${
          missing.length === 1 ? '' : 's'
        } (${missing.slice(0, 5).map((v) => `"${v}"`).join(', ')}${
          missing.length > 5 ? ', …' : ''
        }) ${missing.length === 1 ? 'is' : 'are'} not in the new option list.`,
      );
    }
    return;
  }

  throw conflict(
    `"${existing.label}" already holds data in ${populated} booking${
      populated === 1 ? '' : 's'
    }, so its type is locked.`,
  );
}

async function distinctStoredValues(record: PlanFieldRecord, tx: Queryable): Promise<string[]> {
  if (record.storageStrategy === 'CUSTOM_JSONB') {
    const result = await tx.query<{ value: string }>(
      `SELECT DISTINCT custom_fields ->> $1 AS value
         FROM bookings
        WHERE custom_fields ? $1 AND custom_fields ->> $1 <> ''`,
      [record.fieldKey],
    );
    return result.rows.map((row) => row.value).filter((value): value is string => value !== null);
  }

  assertColumnKey(record.fieldKey);
  const result = await tx.query<{ value: string }>(
    `SELECT DISTINCT "${record.fieldKey}"::text AS value
       FROM bookings
      WHERE "${record.fieldKey}" IS NOT NULL`,
  );
  return result.rows.map((row) => row.value).filter((value): value is string => value !== null);
}

async function findOptionsInUse(
  record: PlanFieldRecord,
  candidates: string[],
  tx: Queryable,
): Promise<string[]> {
  const stored = await distinctStoredValues(record, tx);
  return candidates.filter((candidate) => stored.includes(candidate));
}

export async function archiveField(id: string, actorId: string): Promise<PlanField> {
  const record = await withTransaction(async (tx) => {
    const existing = await repository.findById(id, tx);
    if (!existing) throw notFound('That plan field does not exist.');
    if (existing.fieldClass !== 'CUSTOM') {
      throw badRequest(
        'Only custom fields can be archived. Standard fields can be hidden from the plan instead.',
      );
    }
    if (!existing.isActive) {
      throw conflict('That field is already archived.');
    }

    const archived = await repository.archive(id, tx);
    if (!archived) throw conflict('That field is already archived.');

    await recordConfigurationChange(
      {
        fieldId: archived.id,
        fieldKey: archived.fieldKey,
        action: 'ARCHIVE',
        oldValue: auditSnapshot(existing),
        newValue: auditSnapshot(archived),
        changedBy: actorId,
      },
      tx,
    );
    return archived;
  });

  // Values stay on every existing booking; only new forms stop offering it (§23).
  logger.info({ actorId, fieldKey: record.fieldKey }, 'plan field archived');
  const populated = await repository.countPopulatedBookings(record);
  return repository.toApi(record, computeEditability(record, populated));
}

export async function restoreField(id: string, actorId: string): Promise<PlanField> {
  const record = await withTransaction(async (tx) => {
    const existing = await repository.findById(id, tx);
    if (!existing) throw notFound('That plan field does not exist.');
    if (existing.isActive) throw conflict('That field is not archived.');

    const restored = await repository.restore(id, tx);
    if (!restored) throw conflict('That field is not archived.');

    await recordConfigurationChange(
      {
        fieldId: restored.id,
        fieldKey: restored.fieldKey,
        action: 'RESTORE',
        oldValue: auditSnapshot(existing),
        newValue: auditSnapshot(restored),
        changedBy: actorId,
      },
      tx,
    );
    return restored;
  });

  logger.info({ actorId, fieldKey: record.fieldKey }, 'plan field restored');
  const populated = await repository.countPopulatedBookings(record);
  return repository.toApi(record, computeEditability(record, populated));
}

export async function reorderFields(order: string[], actorId: string): Promise<PlanField[]> {
  await withTransaction(async (tx) => {
    const all = await repository.listAll(tx);
    const known = new Set(all.map((field) => field.id));
    const unknown = order.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw badRequest('The reorder request references fields that do not exist.');
    }
    if (new Set(order).size !== order.length) {
      throw badRequest('The reorder request lists the same field more than once.');
    }

    // Fields omitted from the request keep their relative position after the
    // listed ones, so a partial reorder can never drop a field off the plan.
    const listed = new Map(order.map((id, index) => [id, (index + 1) * 10]));
    let trailing = order.length * 10;
    for (const field of all) {
      const next = listed.get(field.id) ?? (trailing += 10);
      if (next !== field.displayOrder) {
        await repository.setDisplayOrder(field.id, next, tx);
      }
    }

    await recordConfigurationChange(
      {
        fieldId: null,
        fieldKey: '(plan)',
        action: 'REORDER',
        oldValue: { order: all.map((field) => field.fieldKey) },
        newValue: {
          order: [...all]
            .sort(
              (a, b) =>
                (listed.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
                (listed.get(b.id) ?? Number.MAX_SAFE_INTEGER),
            )
            .map((field) => field.fieldKey),
        },
        changedBy: actorId,
      },
      tx,
    );
  });

  logger.info({ actorId, count: order.length }, 'plan fields reordered');
  return listFields();
}

function auditSnapshot(record: PlanFieldRecord): Record<string, unknown> {
  return {
    fieldKey: record.fieldKey,
    label: record.label,
    helpText: record.helpText,
    fieldType: record.fieldType,
    isRequired: record.isRequired,
    isVisible: record.isVisible,
    displayOrder: record.displayOrder,
    options: record.options,
    isActive: record.isActive,
  };
}
