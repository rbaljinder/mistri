/**
 * A handler's or loader's `db.<t>.where({…})` says a range or a match as the page-side `where` does
 * (`{ day: { gte, lte } }`, `{ name: { contains } }`): one vocabulary, compiled by the one compiler, with the same
 * refusals. Equality and lists are unchanged.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandCatalog, compileWhere } from '../packages/mistri/src/server/commands/commandDb.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

const schema: DatabaseSchema = {
  label: 'slots',
  dialect: 'sqlite',
  readAt: '2026-11-09',
  foreignKeys: [],
  tables: [
    {
      id: 'slot',
      schema: 'main',
      name: 'slot',
      isView: false,
      columns: [
        { name: 'id', type: 'integer', nullable: false, primaryKey: true },
        { name: 'day', type: 'date', nullable: false, primaryKey: false },
        { name: 'room', type: 'text', nullable: true, primaryKey: false },
        { name: 'seats', type: 'integer', nullable: false, primaryKey: false },
      ],
    },
  ],
};
const slot = commandCatalog(schema, ['slot'], (name) => name)!.slot!;
const now = new Date('2026-11-09T12:00:00Z');
const filter = (where: unknown) => JSON.stringify(compileWhere(slot, where, now).filter);

test('a range and a match in the object form read as the query language says them', () => {
  assert.equal(
    filter({ day: { gte: '2026-11-01', lte: '2026-11-08' } }),
    JSON.stringify(compileWhere(slot, 'day >= 2026-11-01 and day <= 2026-11-08', now).filter),
  );
  assert.equal(
    filter({ room: { contains: 'north' }, seats: { gt: 2 } }),
    JSON.stringify(compileWhere(slot, 'room contains "north" and seats > 2', now).filter),
  );
  assert.equal(filter({ room: { not: null } }), JSON.stringify(compileWhere(slot, 'room is not empty', now).filter));
});

test('equality and lists are as they were, and a bad operator or column is refused by name', () => {
  assert.equal(
    filter({ room: 'north', seats: [1, 2] }),
    '{"groups":[[{"column":"room","op":"=","value":"north"},{"column":"seats","op":"in","value":[1,2]}]]}',
  );
  assert.throws(() => filter({ seats: { near: 3 } }), /slot: seats has no operator "near"/);
  assert.throws(() => filter({ nope: { gt: 1 } }), /slot: slot has no column "nope"/);
  assert.throws(() => filter({ seats: { contains: 'x' } }), /does not hold text/);
});

test('an empty list beside an operator matches nothing, and the rest is still checked', () => {
  assert.deepEqual(compileWhere(slot, { seats: { gt: 2 }, room: [] }, now), { filter: { groups: [] }, none: true, orderBy: [] });
  assert.throws(() => filter({ seats: { near: 3 }, room: [] }), /slot: seats has no operator "near"/);
  assert.throws(() => filter({ seats: { gt: 2 }, nope: [] }), /slot: "nope" is not one of its columns/);
});
