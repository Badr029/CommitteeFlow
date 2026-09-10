/**
 * The closed set of column-backed plan field keys.
 *
 * Kept in its own module so both the repository and the service can guard
 * against it without importing each other. Nothing outside this list is ever
 * allowed to become a SQL identifier (spec §44) — plan managers can only create
 * CUSTOM fields, which are addressed as JSONB parameters, never as identifiers.
 */

export const COLUMN_FIELD_KEYS = [
  'booking_date',
  'booking_time',
  'off_no',
  'order_name',
  'committee',
  'qty',
  'kva',
  'kv',
  'status',
  'serial_no',
  'project_engineer',
  'notes',
  'customer_name',
] as const;

export type ColumnFieldKey = (typeof COLUMN_FIELD_KEYS)[number];

/**
 * The PostgreSQL storage kind behind each column-backed field.
 *
 * A STANDARD field's label, order, visibility and requiredness are all
 * configurable, but its column's data type is not — that is exactly the line
 * spec §20 draws between "configurable plan" and "editable schema". This map
 * lets the service allow the type changes the column can actually hold (e.g.
 * Status from free text to a Select list) and refuse the ones it cannot (Qty
 * from a number to text).
 */
export const COLUMN_FIELD_KINDS = {
  booking_date: 'DATE',
  booking_time: 'TIME',
  off_no: 'TEXT',
  order_name: 'TEXT',
  committee: 'TEXT',
  qty: 'INTEGER',
  kva: 'DECIMAL',
  // Text, because the plan records voltage as a ratio — 11/0.4, 6.6/0.42 —
  // at least as often as a single figure. Two numbers and the relationship
  // between them do not fit in one numeric column.
  kv: 'TEXT',
  // The booking lifecycle, and the only one there is. Two values, both the
  // application's — see LIFECYCLE_STATUSES.
  status: 'LIFECYCLE',
  serial_no: 'TEXT',
  // Stored as `project_engineer_id`, a reference to a user rather than a name.
  project_engineer: 'USER',
  notes: 'TEXT',
  customer_name: 'TEXT',
} as const satisfies Record<
  ColumnFieldKey,
  'TEXT' | 'INTEGER' | 'DECIMAL' | 'DATE' | 'TIME' | 'LIFECYCLE' | 'USER'
>;

export type ColumnKind = (typeof COLUMN_FIELD_KINDS)[ColumnFieldKey];

/** Plan field types a given column kind can store without losing meaning. */
export const COMPATIBLE_TYPES_BY_KIND = {
  TEXT: ['TEXT', 'LONG_TEXT', 'SELECT'],
  INTEGER: ['NUMBER'],
  DECIMAL: ['NUMBER'],
  DATE: ['DATE'],
  TIME: ['TIME'],
  /*
   * Neither of these may be retyped at all.
   *
   * Status drives cancellation, and a Status that had become free text could
   * hold `010662606B` again — which is the defect this field was corrected for.
   * Project Engineer is a foreign key to a user; as text it would be a name
   * that stops meaning anything the moment someone is renamed.
   */
  LIFECYCLE: [],
  USER: [],
} as const satisfies Record<ColumnKind, readonly string[]>;

/** The only two values Status may take. */
export const LIFECYCLE_STATUSES = ['PLANNED', 'CANCELLED'] as const;

export type LifecycleStatus = (typeof LIFECYCLE_STATUSES)[number];

/**
 * Fields the application writes, and a person never does.
 *
 * They appear on the plan, in the exports and in Plan Configuration — a manager
 * can rename, reorder and hide them — but they are absent from the booking form
 * and refused if a payload names them. Status moves through the explicit Cancel
 * action; Project Engineer is taken from whoever is signed in.
 *
 * Being read-only is separate from being SYSTEM: `booking_date` is SYSTEM and
 * very much typed by hand.
 */
export const READ_ONLY_FIELD_KEYS: ReadonlySet<string> = new Set<string>([
  'status',
  'project_engineer',
]);

export function isReadOnlyFieldKey(key: string): boolean {
  return READ_ONLY_FIELD_KEYS.has(key);
}

/** Field keys the application itself depends on; never archivable (spec §21). */
export const SYSTEM_FIELD_KEYS = ['booking_date', 'booking_time'] as const;

/** Keys a plan manager may not claim for a custom field. */
export const RESERVED_FIELD_KEYS: ReadonlySet<string> = new Set<string>([
  ...COLUMN_FIELD_KEYS,
  'id',
  'version',
  // Renamed to `status` in migration 5, but still reserved: a custom field
  // claiming the old name would be confusing rather than dangerous, and the
  // list costs nothing to keep.
  'booking_state',
  'project_engineer_id',
  'deleted_at',
  'deleted_by',
  'data_source',
  'external_reference',
  'created_by',
  'created_at',
  'updated_by',
  'updated_at',
  'cancelled_by',
  'cancelled_at',
  'cancellation_reason',
  'custom_fields',
  'display_day',
]);

/**
 * The database column a column-backed field is stored in.
 *
 * Identical to the field key everywhere except Project Engineer, which is a
 * reference to a user rather than a value of its own.
 */
export function columnFor(key: ColumnFieldKey): string {
  return key === 'project_engineer' ? 'project_engineer_id' : key;
}

export function isColumnFieldKey(key: string): key is ColumnFieldKey {
  return (COLUMN_FIELD_KEYS as readonly string[]).includes(key);
}

/**
 * Hard guard for every identifier that reaches SQL text.
 *
 * This is a programming-error assertion, not a user-facing validation: reaching
 * it means a code path tried to build SQL from a key it should never have had.
 */
export function assertColumnKey(key: string): asserts key is ColumnFieldKey {
  if (!isColumnFieldKey(key)) {
    throw new Error(`refusing to build SQL for non-column field key: ${key}`);
  }
}
