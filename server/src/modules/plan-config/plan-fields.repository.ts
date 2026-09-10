import type {
  PlanField,
  PlanFieldClass,
  PlanFieldStorage,
  PlanFieldType,
} from '@shared/api-types.js';
import type { Queryable } from '../../db/index.js';
import { queryOne, queryRows } from '../../db/index.js';
import { assertColumnKey, columnFor } from './field-keys.js';

/**
 * Plan field definitions (spec §34).
 *
 * These rows are the single source of truth for the booking form, the plan
 * table, the detail view and both exports (spec §35, §77).
 */

export interface PlanFieldRecord {
  id: string;
  fieldKey: string;
  label: string;
  helpText: string | null;
  fieldType: PlanFieldType;
  fieldClass: PlanFieldClass;
  storageStrategy: PlanFieldStorage;
  isRequired: boolean;
  isVisible: boolean;
  displayOrder: number;
  options: string[];
  isActive: boolean;
  archivedAt: Date | null;
}

interface PlanFieldRow {
  id: string;
  field_key: string;
  label: string;
  help_text: string | null;
  field_type: PlanFieldType;
  field_class: PlanFieldClass;
  storage_strategy: PlanFieldStorage;
  is_required: boolean;
  is_visible: boolean;
  display_order: number;
  options: unknown;
  is_active: boolean;
  archived_at: Date | null;
}

const COLUMNS = `
  id, field_key, label, help_text, field_type, field_class, storage_strategy,
  is_required, is_visible, display_order, options, is_active, archived_at
`;

function toRecord(row: PlanFieldRow): PlanFieldRecord {
  return {
    id: row.id,
    fieldKey: row.field_key,
    label: row.label,
    helpText: row.help_text,
    fieldType: row.field_type,
    fieldClass: row.field_class,
    storageStrategy: row.storage_strategy,
    isRequired: row.is_required,
    isVisible: row.is_visible,
    displayOrder: row.display_order,
    options: Array.isArray(row.options) ? (row.options as string[]) : [],
    isActive: row.is_active,
    archivedAt: row.archived_at,
  };
}

export function toApi(
  record: PlanFieldRecord,
  editability: PlanField['editability'],
): PlanField {
  return {
    id: record.id,
    fieldKey: record.fieldKey,
    label: record.label,
    helpText: record.helpText,
    fieldType: record.fieldType,
    fieldClass: record.fieldClass,
    storageStrategy: record.storageStrategy,
    isRequired: record.isRequired,
    isVisible: record.isVisible,
    displayOrder: record.displayOrder,
    options: record.options,
    isActive: record.isActive,
    archivedAt: record.archivedAt?.toISOString() ?? null,
    editability,
  };
}

/**
 * All definitions, archived ones included.
 *
 * Archived fields are still needed when rendering an old booking's detail view
 * and its history — the values were never deleted (spec §23).
 */
export async function listAll(executor?: Queryable): Promise<PlanFieldRecord[]> {
  const rows = await queryRows<PlanFieldRow>(
    `SELECT ${COLUMNS} FROM plan_field_definitions ORDER BY display_order, field_key`,
    [],
    executor,
  );
  return rows.map(toRecord);
}

export async function listActive(executor?: Queryable): Promise<PlanFieldRecord[]> {
  const rows = await queryRows<PlanFieldRow>(
    `SELECT ${COLUMNS}
       FROM plan_field_definitions
      WHERE is_active
      ORDER BY display_order, field_key`,
    [],
    executor,
  );
  return rows.map(toRecord);
}

export async function findById(
  id: string,
  executor?: Queryable,
): Promise<PlanFieldRecord | undefined> {
  const row = await queryOne<PlanFieldRow>(
    `SELECT ${COLUMNS} FROM plan_field_definitions WHERE id = $1`,
    [id],
    executor,
  );
  return row ? toRecord(row) : undefined;
}

export async function findByKey(
  fieldKey: string,
  executor?: Queryable,
): Promise<PlanFieldRecord | undefined> {
  const row = await queryOne<PlanFieldRow>(
    `SELECT ${COLUMNS} FROM plan_field_definitions WHERE field_key = $1`,
    [fieldKey],
    executor,
  );
  return row ? toRecord(row) : undefined;
}

export async function maxDisplayOrder(executor?: Queryable): Promise<number> {
  const row = await queryOne<{ max: number | null }>(
    'SELECT max(display_order) AS max FROM plan_field_definitions',
    [],
    executor,
  );
  return row?.max ?? 0;
}

export interface InsertPlanFieldInput {
  fieldKey: string;
  label: string;
  helpText: string | null;
  fieldType: PlanFieldType;
  isRequired: boolean;
  isVisible: boolean;
  displayOrder: number;
  options: string[];
}

export async function insert(
  input: InsertPlanFieldInput,
  executor?: Queryable,
): Promise<PlanFieldRecord> {
  const row = await queryOne<PlanFieldRow>(
    `INSERT INTO plan_field_definitions
       (field_key, label, help_text, field_type, field_class, storage_strategy,
        is_required, is_visible, display_order, options)
     VALUES ($1, $2, $3, $4, 'CUSTOM', 'CUSTOM_JSONB', $5, $6, $7, $8::jsonb)
     RETURNING ${COLUMNS}`,
    [
      input.fieldKey,
      input.label,
      input.helpText,
      input.fieldType,
      input.isRequired,
      input.isVisible,
      input.displayOrder,
      JSON.stringify(input.options),
    ],
    executor,
  );
  if (!row) throw new Error('plan field insert returned no row');
  return toRecord(row);
}

export interface UpdatePlanFieldPatch {
  label?: string;
  helpText?: string | null;
  fieldType?: PlanFieldType;
  isRequired?: boolean;
  isVisible?: boolean;
  displayOrder?: number;
  options?: string[];
}

export async function update(
  id: string,
  patch: UpdatePlanFieldPatch,
  executor?: Queryable,
): Promise<PlanFieldRecord | undefined> {
  const assignments: string[] = [];
  const values: unknown[] = [id];

  const push = (column: string, value: unknown, cast = '') => {
    values.push(value);
    assignments.push(`${column} = $${values.length}${cast}`);
  };

  if (patch.label !== undefined) push('label', patch.label);
  if (patch.helpText !== undefined) push('help_text', patch.helpText);
  if (patch.fieldType !== undefined) push('field_type', patch.fieldType, '::plan_field_type');
  if (patch.isRequired !== undefined) push('is_required', patch.isRequired);
  if (patch.isVisible !== undefined) push('is_visible', patch.isVisible);
  if (patch.displayOrder !== undefined) push('display_order', patch.displayOrder);
  if (patch.options !== undefined) push('options', JSON.stringify(patch.options), '::jsonb');

  if (assignments.length === 0) {
    return findById(id, executor);
  }

  const row = await queryOne<PlanFieldRow>(
    `UPDATE plan_field_definitions
        SET ${assignments.join(', ')}
      WHERE id = $1
      RETURNING ${COLUMNS}`,
    values,
    executor,
  );
  return row ? toRecord(row) : undefined;
}

/** Archives rather than deletes, so historical values keep their meaning (§23). */
export async function archive(
  id: string,
  executor?: Queryable,
): Promise<PlanFieldRecord | undefined> {
  const row = await queryOne<PlanFieldRow>(
    `UPDATE plan_field_definitions
        SET is_active = false, archived_at = now(), is_required = false
      WHERE id = $1 AND is_active
      RETURNING ${COLUMNS}`,
    [id],
    executor,
  );
  return row ? toRecord(row) : undefined;
}

export async function restore(
  id: string,
  executor?: Queryable,
): Promise<PlanFieldRecord | undefined> {
  const row = await queryOne<PlanFieldRow>(
    `UPDATE plan_field_definitions
        SET is_active = true, archived_at = NULL
      WHERE id = $1 AND NOT is_active
      RETURNING ${COLUMNS}`,
    [id],
    executor,
  );
  return row ? toRecord(row) : undefined;
}

export async function setDisplayOrder(
  id: string,
  displayOrder: number,
  executor?: Queryable,
): Promise<void> {
  await queryOne(
    'UPDATE plan_field_definitions SET display_order = $2 WHERE id = $1',
    [id, displayOrder],
    executor,
  );
}

/**
 * How many bookings hold a non-empty value for a field.
 *
 * Drives the §24 locking rules: once data exists, the technical key and the
 * data type stop being freely editable.
 */
export async function countPopulatedBookings(
  record: PlanFieldRecord,
  executor?: Queryable,
): Promise<number> {
  if (record.storageStrategy === 'CUSTOM_JSONB') {
    const row = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM bookings
        WHERE custom_fields ? $1
          AND custom_fields -> $1 <> 'null'::jsonb
          AND custom_fields ->> $1 <> ''`,
      [record.fieldKey],
      executor,
    );
    return row?.count ?? 0;
  }

  // Column-backed fields. The key is checked against the closed allow-list
  // immediately before it becomes a SQL identifier.
  assertColumnKey(record.fieldKey);
  // Project Engineer is stored as a reference, so its column is not its key.
  const row = await queryOne<{ count: number }>(
    `SELECT count(*)::int AS count FROM bookings WHERE "${columnFor(record.fieldKey)}" IS NOT NULL`,
    [],
    executor,
  );
  return row?.count ?? 0;
}
