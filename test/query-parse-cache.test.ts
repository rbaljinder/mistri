/**
 * A parse is kept (shared/query.ts), so what it was parsed against has to
 * be in its key: the day a date word means, the person `me` means, the schema.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseQuery } from '../packages/engine/src/shared/query.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

const schema = (label: string): DatabaseSchema => ({
  label,
  dialect: 'sqlite',
  foreignKeys: [],
  readAt: '',
  tables: [
    {
      name: 'job',
      schema: '',
      id: 'job',
      isView: false,
      columns: [
        { name: 'owner', type: 'text', nullable: true, primaryKey: false },
        { name: 'due', type: 'date', nullable: true, primaryKey: false },
      ],
    },
  ],
});
const first = (text: string, options: Parameters<typeof parseQuery>[1]) => parseQuery(text, options).query!.filter.groups[0][0];

test('the same text is the same frozen answer, and a day word follows the calendar', () => {
  const s = schema('a');
  const monday = new Date(2026, 9, 5, 9, 0),
    later = new Date(2026, 9, 5, 23, 59),
    tuesday = new Date(2026, 9, 6, 0, 1);
  const a = parseQuery('job due = today', { schema: s, now: monday });
  assert.equal(parseQuery('job due = today', { schema: s, now: later }), a, 'one day, one answer');
  assert.ok(Object.isFrozen(a.query!.filter.groups[0]));
  const next = first('job due = today', { schema: s, now: tuesday });
  assert.notDeepEqual(next, first('job due = today', { schema: s, now: monday }), 'midnight moves it');
  assert.equal(String(next.value), '2026-10-06', 'resolved to the new day');
});

test('an hour window is never kept; text with no date is kept whatever now says', () => {
  const s = schema('b');
  const one = parseQuery('job due >= last 2 hours', { schema: s, now: new Date(2026, 9, 5, 9, 0) });
  const two = parseQuery('job due >= last 2 hours', { schema: s, now: new Date(2026, 9, 5, 9, 30) });
  assert.notEqual(one, two);
  assert.notDeepEqual(one.query!.filter, two.query!.filter);
  const x = parseQuery('job owner = ada', { schema: s, now: new Date(2020, 1, 1) });
  assert.equal(parseQuery('job owner = ada', { schema: s, now: new Date(2026, 1, 1) }), x);
});

test('me and the schema are part of the key', () => {
  const s = schema('c');
  assert.equal(first('job owner = me', { schema: s, me: { email: 'ada@example.test' } }).value, 'ada@example.test');
  assert.equal(first('job owner = me', { schema: s, me: { email: 'bob@example.test' } }).value, 'bob@example.test');
  const other = schema('d');
  assert.notEqual(parseQuery('job owner = ada', { schema: s }), parseQuery('job owner = ada', { schema: other }));
});
