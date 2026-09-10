import type { FieldIssue, PlanFieldValue } from '@shared/api-types.js';
import { isValidDateString, isValidTimeString, normalizeTime } from '../../lib/dates.js';
import type { PlanFieldRecord } from '../plan-config/plan-fields.repository.js';
import {
  COLUMN_FIELD_KINDS,
  assertColumnKey,
  isReadOnlyFieldKey,
} from '../plan-config/field-keys.js';

/**
 * The one place a booking payload is turned into storable values.
 *
 * The booking form, the plan table, the detail view and both exports are all
 * driven by the same field definitions (spec §35, §77) — so validation must be
 * too. Nothing here knows which specific business fields exist; it reads the
 * configuration and applies the rules that configuration implies (§43).
 */

/** Per-column length ceilings, mirroring the CHECK constraints in migration 1. */
const COLUMN_MAX_LENGTH: Partial<Record<string, number>> = {
  off_no: 64,
  order_name: 300,
  committee: 120,
  kv: 40,
  serial_no: 200,
  status: 80,
  notes: 4000,
  customer_name: 300,
};

const CUSTOM_TEXT_MAX_LENGTH = 500;
const CUSTOM_LONG_TEXT_MAX_LENGTH = 4000;

export interface NormalizedBookingValues {
  /** Column-backed values keyed by column name. */
  columns: Record<string, PlanFieldValue>;
  /** Custom field values keyed by field key. */
  customFields: Record<string, PlanFieldValue>;
  /** Every submitted value keyed by field key, for the audit snapshot. */
  flat: Record<string, PlanFieldValue>;
}

export interface NormalizeOptions {
  /**
   * `create` requires every configured required field.
   * `update` validates only the keys present, but still refuses to blank out a
   * required field.
   */
  mode: 'create' | 'update';
}

export class ValueValidationError extends Error {
  constructor(readonly issues: FieldIssue[]) {
    super('Booking values failed validation');
    this.name = 'ValueValidationError';
  }
}

/** Treats empty strings as "not provided", the way a cleared input behaves. */
function isBlank(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

export function normalizeBookingValues(
  submitted: Record<string, unknown>,
  activeFields: readonly PlanFieldRecord[],
  options: NormalizeOptions,
): NormalizedBookingValues {
  const issues: FieldIssue[] = [];
  const byKey = new Map(activeFields.map((field) => [field.fieldKey, field]));

  // A key we do not recognise is a real signal — a stale client, a typo, or an
  // attempt to write a column the plan does not expose. Never silently dropped.
  for (const key of Object.keys(submitted)) {
    if (!byKey.has(key)) {
      issues.push({
        field: key,
        message: 'That field is not part of the current Committee Plan.',
      });
      continue;
    }

    /*
     * Some fields are the application's to write, not a person's. Status moves
     * through the explicit Cancel action, and Project Engineer is taken from
     * whoever is signed in — so a payload naming either of them is refused
     * rather than quietly ignored. Silently dropping it would let a client
     * believe it had set a status it had not.
     */
    if (isReadOnlyFieldKey(key)) {
      issues.push({
        field: key,
        message:
          key === 'status'
            ? 'Status is set by cancelling a booking, not by editing it.'
            : 'Project Engineer is assigned automatically and cannot be set here.',
      });
    }
  }

  const columns: Record<string, PlanFieldValue> = {};
  const customFields: Record<string, PlanFieldValue> = {};
  const flat: Record<string, PlanFieldValue> = {};

  for (const field of activeFields) {
    // Written by the application, so never required of a caller and never read
    // from one.
    if (isReadOnlyFieldKey(field.fieldKey)) continue;

    const provided = Object.prototype.hasOwnProperty.call(submitted, field.fieldKey);

    if (!provided) {
      if (options.mode === 'create' && field.isRequired) {
        issues.push({ field: field.fieldKey, message: `${field.label} is required.` });
      }
      continue;
    }

    const raw = submitted[field.fieldKey];

    if (isBlank(raw)) {
      if (field.isRequired) {
        issues.push({ field: field.fieldKey, message: `${field.label} is required.` });
        continue;
      }
      assign(field, null, columns, customFields, flat);
      continue;
    }

    const coerced = coerce(field, raw);
    if ('error' in coerced) {
      issues.push({ field: field.fieldKey, message: coerced.error });
      continue;
    }

    assign(field, coerced.value, columns, customFields, flat);
  }

  if (issues.length > 0) {
    throw new ValueValidationError(issues);
  }

  return { columns, customFields, flat };
}

function assign(
  field: PlanFieldRecord,
  value: PlanFieldValue,
  columns: Record<string, PlanFieldValue>,
  customFields: Record<string, PlanFieldValue>,
  flat: Record<string, PlanFieldValue>,
): void {
  flat[field.fieldKey] = value;
  if (field.storageStrategy === 'COLUMN') {
    assertColumnKey(field.fieldKey);
    columns[field.fieldKey] = value;
  } else {
    customFields[field.fieldKey] = value;
  }
}

type CoerceResult = { value: PlanFieldValue } | { error: string };

function coerce(field: PlanFieldRecord, raw: unknown): CoerceResult {
  switch (field.fieldType) {
    case 'TEXT':
    case 'LONG_TEXT': {
      if (typeof raw !== 'string' && typeof raw !== 'number') {
        return { error: `${field.label} must be text.` };
      }
      const text = String(raw).trim();
      const max = maxLengthFor(field);
      if (text.length > max) {
        return { error: `${field.label} must be ${max} characters or fewer.` };
      }
      return { value: text };
    }

    case 'NUMBER': {
      const numeric = typeof raw === 'number' ? raw : Number(String(raw).trim());
      if (!Number.isFinite(numeric)) {
        return { error: `${field.label} must be a number.` };
      }
      if (field.storageStrategy === 'COLUMN') {
        assertColumnKey(field.fieldKey);
        const kind = COLUMN_FIELD_KINDS[field.fieldKey];
        if (kind === 'INTEGER') {
          if (!Number.isInteger(numeric)) {
            return { error: `${field.label} must be a whole number.` };
          }
          // Matches the bookings_qty_positive CHECK constraint.
          if (numeric <= 0) {
            return { error: `${field.label} must be greater than zero.` };
          }
          if (numeric > 2_147_483_647) {
            return { error: `${field.label} is too large.` };
          }
        }
        if (kind === 'DECIMAL' && numeric < 0) {
          return { error: `${field.label} cannot be negative.` };
        }
      }
      return { value: numeric };
    }

    case 'SELECT': {
      const text = String(raw).trim();
      if (!field.options.includes(text)) {
        return {
          error: `${field.label} must be one of: ${field.options.join(', ')}.`,
        };
      }
      return { value: text };
    }

    case 'DATE': {
      const text = String(raw).trim();
      if (!isValidDateString(text)) {
        return { error: `${field.label} must be a valid date (YYYY-MM-DD).` };
      }
      return { value: text };
    }

    case 'TIME': {
      const text = String(raw).trim();
      if (!isValidTimeString(text)) {
        return { error: `${field.label} must be a valid time (HH:MM).` };
      }
      return { value: normalizeTime(text) };
    }

    case 'CHECKBOX': {
      if (typeof raw === 'boolean') return { value: raw };
      const text = String(raw).trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(text)) return { value: true };
      if (['false', '0', 'no', 'off'].includes(text)) return { value: false };
      return { error: `${field.label} must be yes or no.` };
    }

    default: {
      // Exhaustive by construction; a new field type must be handled above.
      const never: never = field.fieldType;
      return { error: `Unsupported field type: ${String(never)}` };
    }
  }
}

function maxLengthFor(field: PlanFieldRecord): number {
  if (field.storageStrategy === 'COLUMN') {
    return COLUMN_MAX_LENGTH[field.fieldKey] ?? 300;
  }
  return field.fieldType === 'LONG_TEXT' ? CUSTOM_LONG_TEXT_MAX_LENGTH : CUSTOM_TEXT_MAX_LENGTH;
}

/**
 * Compares two value snapshots, returning only what actually changed.
 *
 * Drives the audit entry (§13) and the "Time: 10:00 → 11:00" line in Activity
 * (§14): an update that changes nothing must not manufacture history.
 */
export function diffValues(
  before: Record<string, PlanFieldValue>,
  after: Record<string, PlanFieldValue>,
): { changedKeys: string[]; oldValues: Record<string, PlanFieldValue>; newValues: Record<string, PlanFieldValue> } {
  const changedKeys: string[] = [];
  const oldValues: Record<string, PlanFieldValue> = {};
  const newValues: Record<string, PlanFieldValue> = {};

  for (const key of Object.keys(after)) {
    const from = before[key] ?? null;
    const to = after[key] ?? null;
    if (!valuesEqual(from, to)) {
      changedKeys.push(key);
      oldValues[key] = from;
      newValues[key] = to;
    }
  }

  return { changedKeys, oldValues, newValues };
}

function valuesEqual(a: PlanFieldValue, b: PlanFieldValue): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  // 10 and "10" are the same value once stored; compare on the string form.
  return String(a) === String(b);
}
