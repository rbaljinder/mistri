import { describe, expect, test } from 'vitest';
import {
  addDateDays,
  addDateMonths,
  clampDate,
  dateBounds,
  dateParts,
  dateTimeWithinBounds,
  dateWithinBounds,
  daysInMonth,
  FIRST_DATE,
  isPickerDate,
  isPickerDateTime,
  isPickerTime,
  LAST_DATE,
  monthGrid,
  monthLabel,
  splitDateTime,
  todayInZone,
  weekdayLabels,
  withDate,
} from './datePickerModel.js';

describe('date-only picker model', () => {
  test('strict dates share command validation, excluding year zero and non-ISO input', () => {
    for (const value of [FIRST_DATE, LAST_DATE, '0099-02-28', '2000-02-29', '2024-02-29']) expect(isPickerDate(value)).toBe(true);
    for (const value of [
      '',
      null,
      20260101,
      '0000-01-01',
      '10000-01-01',
      '1900-02-29',
      '2025-02-29',
      '2026-04-31',
      '2026-1-01',
      '2026-01-01T00:00:00Z',
      ' 2026-01-01',
    ])
      expect(isPickerDate(value)).toBe(false);
    expect(dateParts('0099-02-28')).toEqual({ year: 99, month: 2, day: 28 });
    expect(() => dateParts('2025-02-29')).toThrow(RangeError);
  });

  test('day arithmetic crosses months and leap years without timezone shifts', () => {
    expect(addDateDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDateDays('1900-02-28', 1)).toBe('1900-03-01');
    expect(addDateDays('2000-03-01', -1)).toBe('2000-02-29');
    expect(addDateDays('2026-03-08', 1)).toBe('2026-03-09');
    expect(addDateDays('2026-11-01', 1)).toBe('2026-11-02');
    expect(addDateDays('0099-12-31', 1)).toBe('0100-01-01');
    expect(addDateDays(FIRST_DATE, -1)).toBe(FIRST_DATE);
    expect(addDateDays(LAST_DATE, 1)).toBe(LAST_DATE);
    expect(addDateDays('2026-01-01', Number.MAX_SAFE_INTEGER)).toBe(LAST_DATE);
    expect(() => addDateDays(FIRST_DATE, NaN)).toThrow(RangeError);
    expect(() => addDateDays(FIRST_DATE, 0.5)).toThrow(RangeError);
  });

  test('month steps clamp the day and remain within the supported year range', () => {
    expect(addDateMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addDateMonths('2025-01-31', 1)).toBe('2025-02-28');
    expect(addDateMonths('2024-02-29', 12)).toBe('2025-02-28');
    expect(addDateMonths('2026-01-31', -1)).toBe('2025-12-31');
    expect(addDateMonths(FIRST_DATE, -12)).toBe(FIRST_DATE);
    expect(addDateMonths(LAST_DATE, 12)).toBe(LAST_DATE);
    expect(daysInMonth(2000, 2)).toBe(29);
    expect(daysInMonth(1900, 2)).toBe(28);
    expect(() => daysInMonth(2026, 13)).toThrow(RangeError);
    expect(() => addDateMonths(FIRST_DATE, Infinity)).toThrow(RangeError);
  });

  test('bounds are inclusive and invalid or reversed bounds never widen silently', () => {
    expect(dateBounds('', '')).toEqual({ min: FIRST_DATE, max: LAST_DATE });
    expect(dateBounds('0000-01-01')).toEqual({ min: FIRST_DATE, max: LAST_DATE });
    const bounds = dateBounds('2026-02-01', '2026-02-28');
    expect(dateWithinBounds('2026-02-01', bounds)).toBe(true);
    expect(dateWithinBounds('2026-02-28', bounds)).toBe(true);
    expect(dateWithinBounds('2026-02-29', bounds)).toBe(false);
    expect(clampDate('2026-01-31', bounds)).toBe(bounds.min);
    expect(clampDate('2026-03-01', bounds)).toBe(bounds.max);
    expect(clampDate('2026-02-14', bounds)).toBe('2026-02-14');
    expect(() => dateBounds('2026-03-01', '2026-02-01')).toThrow(RangeError);
    expect(() => dateBounds('bad')).toThrow(RangeError);
  });

  test('six-week grids honor first weekday and mark bounds and outside-month dates', () => {
    const monday = monthGrid('2026-09-13');
    expect(monday).toHaveLength(42);
    expect(monday[0]).toEqual({ date: '2026-08-31', inMonth: false, disabled: false });
    expect(monday[1]).toEqual({ date: '2026-09-01', inMonth: true, disabled: false });
    expect(monday.at(-1)?.date).toBe('2026-10-11');
    expect(monthGrid('2026-09-13', 0)[0]?.date).toBe('2026-08-30');
    expect(monthGrid('2026-09-13', 6)[0]?.date).toBe('2026-08-29');
    const bounded = monthGrid('2026-09-13', 1, dateBounds('2026-09-10', '2026-09-20'));
    expect(bounded.filter((day) => !day.disabled)).toHaveLength(11);
    expect(monthGrid(FIRST_DATE, 0)[0]).toEqual({ date: null, inMonth: false, disabled: true });
    expect(monthGrid(LAST_DATE).at(-1)).toEqual({ date: null, inMonth: false, disabled: true });
    expect(() => monthGrid(FIRST_DATE, 7)).toThrow(RangeError);
  });

  test('labels localize a Gregorian calendar while data stays ISO', () => {
    expect(monthLabel('2026-09-13', 'en-US')).toBe('September 2026');
    expect(monthLabel('2026-09-13', 'fr-FR')).toBe('septembre 2026');
    expect(monthLabel('0099-09-13', 'en-US')).toBe('September 99');
    expect(weekdayLabels('en-US').map((day) => day.long)).toEqual([
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
      'Friday',
      'Saturday',
      'Sunday',
    ]);
    expect(weekdayLabels('en-US', 0)[0]).toEqual({ short: 'Sun', long: 'Sunday' });
    expect(() => weekdayLabels('en-US', -1)).toThrow(RangeError);
  });

  test('a wall time is a date and a clock time with no zone; an instant is refused', () => {
    for (const value of [
      '2026-09-14T09:30',
      '2026-09-14 09:30',
      '2026-09-14T23:59:59',
      '2026-09-14T00:00:00.1',
      '2026-09-14T18:36:15.123',
    ]) {
      expect(isPickerDateTime(value)).toBe(true);
    }
    for (const value of [
      '2026-09-14',
      '2026-09-14T24:00',
      '2026-09-14T9:30',
      '2026-09-14T09:30Z',
      '2026-09-14T09:30:00+02:00',
      '2026-02-30T09:30',
      '2026-09-14T09:30:00.1234',
      ' 2026-09-14T09:30',
      null,
    ])
      expect(isPickerDateTime(value)).toBe(false);
    expect(isPickerTime('07:05')).toBe(true);
    expect(isPickerTime('07:05:60')).toBe(false);
    expect(splitDateTime('2026-09-14 09:30')).toEqual({ date: '2026-09-14', time: '09:30' });
    expect(splitDateTime('2026-9-14T09:30')).toBeNull();
  });

  test('a picked day keeps the time already typed, and bounds compare whatever the precision', () => {
    expect(withDate('2026-09-14T09:30', '2026-10-01')).toBe('2026-10-01 09:30');
    expect(withDate('2026-09-14 18:36:15.123', '2026-10-01')).toBe('2026-10-01 18:36:15.123');
    expect(withDate('', '2026-10-01')).toBe('2026-10-01 00:00');
    expect(withDate('2026-09-14T9', '2026-10-01')).toBe('2026-10-01 00:00');
    expect(dateTimeWithinBounds('2026-09-14T09:30', '2026-09-14T09:30:00.000', '2026-09-14T09:30:00.001')).toBe(true);
    expect(dateTimeWithinBounds('2026-09-14T09:30:00.002', undefined, '2026-09-14T09:30:00.001')).toBe(false);
    expect(dateTimeWithinBounds('2026-09-14T09:29:59.999', '2026-09-14T09:30')).toBe(false);
    expect(dateTimeWithinBounds('2026-09-14T09:30', 'not a bound', '')).toBe(true);
    expect(dateTimeWithinBounds('2026-09-14', undefined, undefined)).toBe(false);
  });

  test('today follows the configured zone, independent of the calendar value domain', () => {
    const now = new Date(Date.UTC(2026, 8, 13, 1));
    expect(todayInZone(now, 'America/Los_Angeles')).toBe('2026-09-12');
    expect(todayInZone(now, 'Asia/Tokyo')).toBe('2026-09-13');
    expect(todayInZone(now, 'UTC')).toBe('2026-09-13');
    expect(() => todayInZone(new Date(NaN), 'UTC')).toThrow(RangeError);
    expect(() => todayInZone(now, 'not-a-zone')).toThrow(RangeError);
  });
});
