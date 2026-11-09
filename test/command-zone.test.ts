/**
 * A tenant command counts its day in the tenant's own zone (readerZone.ts
 * `commandZone`): the settings row's zone where it is an IANA name, the App's
 * own otherwise, and an unknown name says so outside production.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandZone } from '../packages/mistri/src/server/app/readerZone.js';

const ui = { timezone: { column: 'desk_setting.timezone', default: 'America/New_York' } } as never;
const reading =
  (value: unknown, seen: unknown[] = []) =>
  async () => ({
    async query(request: unknown) {
      seen.push(request);
      return { rows: value === undefined ? [] : [{ timezone: value }] } as never;
    },
  });

test('a tenant command reads the zone from the tenant settings row', async () => {
  const seen: unknown[] = [];
  assert.equal(await commandZone(ui, reading(' Pacific/Kiritimati ', seen)), 'Pacific/Kiritimati');
  assert.deepEqual(seen, [{ table: 'desk_setting', columns: ['timezone'], limit: 1, offset: 0 }]);
});

test('no column form, no row, or an unreadable column leaves the App zone', async () => {
  assert.equal(await commandZone({ timezone: 'America/Chicago' } as never, reading('Asia/Tokyo')), undefined);
  assert.equal(await commandZone(undefined, reading('Asia/Tokyo')), undefined);
  assert.equal(await commandZone(ui, reading(undefined)), undefined);
  assert.equal(
    await commandZone(ui, async () => {
      throw new Error('denied');
    }),
    undefined,
  );
});

test('a name that is not an IANA zone falls to the App zone and says so', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  assert.equal(await commandZone(ui, reading('Mars/Olympus')), undefined);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0]!.arguments[0]), /desk_setting\.timezone.*Mars\/Olympus/);
});
