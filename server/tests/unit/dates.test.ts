import { describe, expect, it } from 'vitest';
import {
  addMonths,
  daysInMonth,
  displayDayFor,
  endOfMonth,
  isValidDateString,
  isValidTimeString,
  normalizeTime,
  startOfMonth,
  today,
} from '../../src/lib/dates.js';

/** Spec §9, §11 — the plan is a calendar, not a set of timestamps. */
describe('calendar helpers', () => {
  describe('displayDayFor', () => {
    it('derives the weekday from the date', () => {
      expect(displayDayFor('2026-09-10')).toBe('Thursday');
      expect(displayDayFor('2026-10-06')).toBe('Tuesday');
      expect(displayDayFor('2026-01-01')).toBe('Thursday');
    });

    it('does not shift across a day boundary in any timezone', () => {
      // A naive `new Date('2026-10-06')` in a negative-offset zone reads as the
      // 5th. The plan must say the 6th everywhere.
      const original = process.env['TZ'];
      try {
        for (const tz of ['UTC', 'Pacific/Kiritimati', 'Pacific/Midway', 'Africa/Cairo']) {
          process.env['TZ'] = tz;
          expect(displayDayFor('2026-10-06'), tz).toBe('Tuesday');
        }
      } finally {
        process.env['TZ'] = original;
      }
    });

    it('returns empty for an invalid date rather than throwing', () => {
      expect(displayDayFor('not-a-date')).toBe('');
      expect(displayDayFor('2026-02-30')).toBe('');
    });
  });

  describe('isValidDateString', () => {
    it('accepts real calendar dates', () => {
      expect(isValidDateString('2026-01-31')).toBe(true);
      expect(isValidDateString('2024-02-29')).toBe(true);
    });

    it('rejects impossible ones', () => {
      expect(isValidDateString('2026-02-30')).toBe(false);
      expect(isValidDateString('2026-02-29')).toBe(false);
      expect(isValidDateString('2026-13-01')).toBe(false);
      expect(isValidDateString('2026-00-10')).toBe(false);
      expect(isValidDateString('2026-1-1')).toBe(false);
      expect(isValidDateString('')).toBe(false);
    });
  });

  describe('isValidTimeString / normalizeTime', () => {
    it('accepts HH:MM and HH:MM:SS', () => {
      expect(isValidTimeString('09:00')).toBe(true);
      expect(isValidTimeString('23:59:59')).toBe(true);
    });

    it('rejects out-of-range values', () => {
      expect(isValidTimeString('24:00')).toBe(false);
      expect(isValidTimeString('10:60')).toBe(false);
      expect(isValidTimeString('9:00')).toBe(false);
    });

    it('normalises PostgreSQL time output to HH:MM', () => {
      expect(normalizeTime('14:30:00')).toBe('14:30');
      expect(normalizeTime('14:30')).toBe('14:30');
    });
  });

  describe('month arithmetic', () => {
    it('finds the bounds of a month', () => {
      expect(startOfMonth('2026-09-17')).toBe('2026-09-01');
      expect(endOfMonth('2026-09-17')).toBe('2026-09-30');
      expect(endOfMonth('2026-02-05')).toBe('2026-02-28');
      expect(endOfMonth('2024-02-05')).toBe('2024-02-29');
    });

    it('adds months and clamps the day', () => {
      expect(addMonths('2026-09-09', 1)).toBe('2026-10-09');
      expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
      expect(addMonths('2026-12-15', 1)).toBe('2027-01-15');
      expect(addMonths('2026-01-15', -1)).toBe('2025-12-15');
      expect(addMonths('2026-09-09', 12)).toBe('2027-09-09');
    });

    it('knows month lengths', () => {
      expect(daysInMonth(2026, 2)).toBe(28);
      expect(daysInMonth(2024, 2)).toBe(29);
      expect(daysInMonth(2026, 12)).toBe(31);
    });
  });

  describe('today', () => {
    it('formats the local calendar date', () => {
      expect(today(new Date(2026, 8, 9, 23, 30))).toBe('2026-09-09');
      expect(today(new Date(2026, 0, 1, 0, 1))).toBe('2026-01-01');
    });
  });
});
