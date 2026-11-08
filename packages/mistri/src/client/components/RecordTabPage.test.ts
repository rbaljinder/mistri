/**
 * A record's tab page is handed the key its record was opened with, which is text when the record was opened from an
 * address; `page.useRecordKey` promises the row's own values, so the key is given back as the row holds it.
 */
import { expect, test, vi } from 'vitest';

vi.mock('@mistriwork/kit/client/core.js', () => ({
  findTable: (id: string) =>
    id === 'account'
      ? { id, columns: [{ name: 'id', type: 'INTEGER', primaryKey: true }] }
      : id === 'membership'
        ? {
            id,
            columns: [
              { name: 'org', type: 'TEXT', primaryKey: true },
              { name: 'seat', type: 'bigint', primaryKey: true },
            ],
          }
        : undefined,
}));

const { storedKey } = await import('./RecordTabPage.js');

test("a whole-number key read from an address is the row's number", () => {
  expect(storedKey('account', { id: '13' })).toEqual({ id: 13 });
  expect(storedKey('account', { id: 13 })).toEqual({ id: 13 });
});

test('a key past 2^53 keeps its digits, and a text column stays text', () => {
  expect(storedKey('membership', { org: '0042', seat: '9007199254740993' })).toEqual({ org: '0042', seat: '9007199254740993' });
  expect(storedKey('membership', { org: '7', seat: '-4' })).toEqual({ org: '7', seat: -4 });
});

test('a table the schema does not hold leaves the key as it came', () => {
  expect(storedKey('unknown', { id: '13' })).toEqual({ id: '13' });
});
