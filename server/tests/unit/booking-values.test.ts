import { describe, expect, it } from 'vitest';
import type { PlanFieldRecord } from '../../src/modules/plan-config/plan-fields.repository.js';
import {
  ValueValidationError,
  diffValues,
  normalizeBookingValues,
} from '../../src/modules/bookings/booking-values.js';

/**
 * Spec §35, §43 — the dynamic value engine.
 *
 * Pure unit tests: this module is the single gate every booking write passes
 * through, so its rules are worth pinning down without a database round trip.
 */

let counter = 0;
function field(overrides: Partial<PlanFieldRecord> & Pick<PlanFieldRecord, 'fieldKey'>): PlanFieldRecord {
  counter += 1;
  return {
    id: `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`,
    label: overrides.fieldKey,
    helpText: null,
    fieldType: 'TEXT',
    fieldClass: 'CUSTOM',
    storageStrategy: 'CUSTOM_JSONB',
    isRequired: false,
    isVisible: true,
    displayOrder: counter * 10,
    options: [],
    isActive: true,
    archivedAt: null,
    ...overrides,
  };
}

const dateField = field({
  fieldKey: 'booking_date',
  label: 'Date',
  fieldType: 'DATE',
  fieldClass: 'SYSTEM',
  storageStrategy: 'COLUMN',
  isRequired: true,
});
const timeField = field({
  fieldKey: 'booking_time',
  label: 'Time',
  fieldType: 'TIME',
  fieldClass: 'SYSTEM',
  storageStrategy: 'COLUMN',
  isRequired: true,
});
const offNo = field({
  fieldKey: 'off_no',
  label: 'OFF No.',
  fieldClass: 'STANDARD',
  storageStrategy: 'COLUMN',
  isRequired: true,
});
const qty = field({
  fieldKey: 'qty',
  label: 'Qty',
  fieldType: 'NUMBER',
  fieldClass: 'STANDARD',
  storageStrategy: 'COLUMN',
});
const kva = field({
  fieldKey: 'kva',
  label: 'KVA',
  fieldType: 'NUMBER',
  fieldClass: 'STANDARD',
  storageStrategy: 'COLUMN',
});
const notes = field({
  fieldKey: 'notes',
  label: 'Notes',
  fieldType: 'LONG_TEXT',
  fieldClass: 'STANDARD',
  storageStrategy: 'COLUMN',
});

const base = [dateField, timeField, offNo, qty, kva, notes];

function issuesFrom(fn: () => unknown): Array<{ field: string; message: string }> {
  try {
    fn();
  } catch (error) {
    if (error instanceof ValueValidationError) return error.issues;
    throw error;
  }
  throw new Error('expected a ValueValidationError');
}

describe('normalizeBookingValues', () => {
  const valid = { booking_date: '2026-10-06', booking_time: '10:00', off_no: 'A1' };

  it('splits values between real columns and the JSONB bag', () => {
    const custom = field({ fieldKey: 'factory', label: 'Factory' });

    const result = normalizeBookingValues({ ...valid, factory: 'Plant 3' }, [...base, custom], {
      mode: 'create',
    });

    expect(result.columns).toEqual({
      booking_date: '2026-10-06',
      booking_time: '10:00',
      off_no: 'A1',
    });
    expect(result.customFields).toEqual({ factory: 'Plant 3' });
    expect(result.flat).toEqual({ ...valid, factory: 'Plant 3' });
  });

  it('reports every required field missing on create', () => {
    const issues = issuesFrom(() => normalizeBookingValues({}, base, { mode: 'create' }));
    expect(issues.map((i) => i.field).sort()).toEqual(['booking_date', 'booking_time', 'off_no']);
    expect(issues[0]?.message).toMatch(/is required/);
  });

  it('does not demand untouched required fields on update', () => {
    const result = normalizeBookingValues({ qty: 4 }, base, { mode: 'update' });
    expect(result.flat).toEqual({ qty: 4 });
  });

  it('still refuses to blank a required field on update', () => {
    const issues = issuesFrom(() => normalizeBookingValues({ off_no: '' }, base, { mode: 'update' }));
    expect(issues).toEqual([{ field: 'off_no', message: 'OFF No. is required.' }]);
  });

  it('treats whitespace as blank and clears an optional field', () => {
    const result = normalizeBookingValues({ notes: '   ' }, base, { mode: 'update' });
    expect(result.flat['notes']).toBeNull();
  });

  it('trims text values', () => {
    const result = normalizeBookingValues({ ...valid, off_no: '  A1  ' }, base, { mode: 'create' });
    expect(result.flat['off_no']).toBe('A1');
  });

  it('rejects a key that is not in the configuration', () => {
    const issues = issuesFrom(() =>
      normalizeBookingValues({ ...valid, made_up: 'x' }, base, { mode: 'create' }),
    );
    expect(issues).toEqual([
      { field: 'made_up', message: 'That field is not part of the current Committee Plan.' },
    ]);
  });

  it('rejects a key for an archived field', () => {
    const archived = field({ fieldKey: 'factory', label: 'Factory', isActive: false });
    // Only active fields are ever passed in.
    const issues = issuesFrom(() =>
      normalizeBookingValues({ ...valid, factory: 'Plant 3' }, base, { mode: 'create' }),
    );
    expect(issues[0]?.field).toBe('factory');
    expect(archived.isActive).toBe(false);
  });

  describe('numbers', () => {
    it('accepts a numeric string and coerces it', () => {
      const result = normalizeBookingValues({ ...valid, qty: '4' }, base, { mode: 'create' });
      expect(result.flat['qty']).toBe(4);
    });

    it('enforces qty > 0 and whole numbers', () => {
      expect(issuesFrom(() => normalizeBookingValues({ ...valid, qty: 0 }, base, { mode: 'create' }))[0])
        .toMatchObject({ field: 'qty', message: 'Qty must be greater than zero.' });
      expect(issuesFrom(() => normalizeBookingValues({ ...valid, qty: 2.5 }, base, { mode: 'create' }))[0])
        .toMatchObject({ message: 'Qty must be a whole number.' });
    });

    it('allows a decimal kva but not a negative one', () => {
      expect(
        normalizeBookingValues({ ...valid, kva: 1500.5 }, base, { mode: 'create' }).flat['kva'],
      ).toBe(1500.5);
      expect(issuesFrom(() => normalizeBookingValues({ ...valid, kva: -1 }, base, { mode: 'create' }))[0])
        .toMatchObject({ message: 'KVA cannot be negative.' });
    });

    it('rejects text where a number belongs', () => {
      expect(issuesFrom(() => normalizeBookingValues({ ...valid, qty: 'lots' }, base, { mode: 'create' }))[0])
        .toMatchObject({ message: 'Qty must be a number.' });
    });
  });

  describe('select', () => {
    const select = field({
      fieldKey: 'inspection_type',
      label: 'Inspection Type',
      fieldType: 'SELECT',
      options: ['Routine', 'Witness'],
    });

    it('accepts a configured option', () => {
      const result = normalizeBookingValues({ ...valid, inspection_type: 'Witness' }, [...base, select], {
        mode: 'create',
      });
      expect(result.customFields['inspection_type']).toBe('Witness');
    });

    it('names the allowed values when rejecting', () => {
      const issues = issuesFrom(() =>
        normalizeBookingValues({ ...valid, inspection_type: 'Other' }, [...base, select], {
          mode: 'create',
        }),
      );
      expect(issues[0]?.message).toBe('Inspection Type must be one of: Routine, Witness.');
    });
  });

  describe('checkbox', () => {
    const checkbox = field({ fieldKey: 'witnessed', label: 'Witnessed', fieldType: 'CHECKBOX' });

    it('accepts booleans and the usual string forms', () => {
      const fields = [...base, checkbox];
      for (const [input, expected] of [
        [true, true],
        [false, false],
        ['true', true],
        ['no', false],
        ['1', true],
        ['0', false],
      ] as const) {
        const result = normalizeBookingValues({ ...valid, witnessed: input }, fields, {
          mode: 'create',
        });
        expect(result.customFields['witnessed'], String(input)).toBe(expected);
      }
    });

    it('rejects anything else', () => {
      const issues = issuesFrom(() =>
        normalizeBookingValues({ ...valid, witnessed: 'maybe' }, [...base, checkbox], {
          mode: 'create',
        }),
      );
      expect(issues[0]?.message).toBe('Witnessed must be yes or no.');
    });
  });

  describe('dates and times', () => {
    it('rejects an impossible date', () => {
      expect(
        issuesFrom(() =>
          normalizeBookingValues({ ...valid, booking_date: '2026-02-30' }, base, { mode: 'create' }),
        )[0]?.message,
      ).toMatch(/valid date/);
    });

    it('normalises a time with seconds to HH:MM', () => {
      const result = normalizeBookingValues({ ...valid, booking_time: '14:30:00' }, base, {
        mode: 'create',
      });
      expect(result.flat['booking_time']).toBe('14:30');
    });
  });

  it('enforces the column length limit', () => {
    const issues = issuesFrom(() =>
      normalizeBookingValues({ ...valid, off_no: 'X'.repeat(100) }, base, { mode: 'create' }),
    );
    expect(issues[0]?.message).toBe('OFF No. must be 64 characters or fewer.');
  });

  it('collects several problems in one pass rather than stopping at the first', () => {
    const issues = issuesFrom(() =>
      normalizeBookingValues({ booking_date: 'nope', qty: -1, made_up: 'x' }, base, {
        mode: 'create',
      }),
    );
    expect(issues.map((i) => i.field).sort()).toEqual([
      'booking_date',
      'booking_time',
      'made_up',
      'off_no',
      'qty',
    ]);
  });
});

describe('diffValues', () => {
  it('returns only what changed', () => {
    const diff = diffValues(
      { off_no: 'A1', qty: 3, notes: 'same' },
      { off_no: 'A2', qty: 3, notes: 'same' },
    );
    expect(diff.changedKeys).toEqual(['off_no']);
    expect(diff.oldValues).toEqual({ off_no: 'A1' });
    expect(diff.newValues).toEqual({ off_no: 'A2' });
  });

  it('reports nothing when nothing moved', () => {
    expect(diffValues({ qty: 3 }, { qty: 3 }).changedKeys).toEqual([]);
  });

  it('treats a stored number and its string form as equal', () => {
    // The column returns 3; a form submits "3". That is not a change.
    expect(diffValues({ qty: 3 }, { qty: '3' }).changedKeys).toEqual([]);
  });

  it('detects clearing a value', () => {
    const diff = diffValues({ notes: 'something' }, { notes: null });
    expect(diff.changedKeys).toEqual(['notes']);
    expect(diff.newValues).toEqual({ notes: null });
  });

  it('detects setting a previously empty value', () => {
    const diff = diffValues({ notes: null }, { notes: 'something' });
    expect(diff.changedKeys).toEqual(['notes']);
    expect(diff.oldValues).toEqual({ notes: null });
  });

  it('ignores keys the update never mentioned', () => {
    expect(diffValues({ off_no: 'A1', qty: 3 }, { qty: 4 }).changedKeys).toEqual(['qty']);
  });
});
