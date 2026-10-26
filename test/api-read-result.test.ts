import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { createApiReadView } from '../packages/mistri/src/server/api/apiReadView.js';
import { materializeApiReadResult } from '../packages/mistri/src/server/api/apiReadResult.js';

const schema: DatabaseSchema = {
  label: 'Local',
  dialect: 'sqlite',
  readAt: '',
  foreignKeys: [],
  tables: [
    {
      id: 'person',
      name: 'person',
      schema: '',
      isView: false,
      columns: [
        { name: 'id', type: 'INTEGER', primaryKey: true, nullable: false },
        { name: 'rank', type: 'INTEGER', primaryKey: false, nullable: false },
        { name: 'name', type: 'TEXT', primaryKey: false, nullable: false },
      ],
    },
  ],
};
const app = parseAppConfig(
  {
    id: 'people',
    name: 'People',
    resources: { person: {} },
    auth: { roles: { reader: { read: true } } },
    home: 'people',
    views: { people: { kind: 'list', from: 'person' } },
    api: { version: 1, roles: ['reader'], resources: { person: { fields: ['id', 'rank', 'name'], sorts: ['rank'] } } },
  },
  'test',
);
const plan = (query = '', item = false) =>
  createApiReadView(
    app,
    schema,
    { operationId: item ? 'item:person' : 'list:person', query, ...(item ? { key: '1' } : {}) },
    { integers: 'decimal-string' },
    new Date('2026-09-13T00:00:00Z'),
  );
const row = { id: '9007199254740993', rank: 3, name: '雪' };
const result = (rows: unknown[]) => ({ columns: ['id', 'rank', 'name'], rows, sql: 'secret SQL', ms: 99, joins: ['secret'], resolved: [] });

test('read result retains typed continuation without leaking fetched-only fields or diagnostics', () => {
  const checked = plan('fields=name&sort=rank&limit=1');
  const raw = result([row, { ...row, id: '9007199254740994' }]);
  Object.defineProperty(raw, 'sql', {
    get() {
      throw new Error('must not inspect SQL');
    },
  });
  const value = materializeApiReadResult(checked, raw);
  assert.equal(value.stage, 'list-read-result');
  if (value.stage !== 'list-read-result') return assert.fail();
  assert.deepEqual(
    value.items.map((item) => ({ ...item })),
    [{ id: '9007199254740993', name: '雪' }],
  );
  assert.equal(value.more, true);
  assert.deepEqual({ ...value.boundary }, { rank: '3', id: '9007199254740993' });
  assert.equal(Object.hasOwn(value, 'next'), false);
  for (const key of ['sql', 'ms', 'joins', 'resolved']) assert.equal(Object.hasOwn(value, key), false);
  const last = materializeApiReadResult(checked, result([row]));
  assert.equal(last.stage === 'list-read-result' && last.more, false);
  assert.equal(Object.hasOwn(last, 'boundary'), false);
});

test('count is explicitly bounded and requires the requested count contract', () => {
  const checked = plan('limit=1&count=true');
  for (const [input, value, capped] of [
    [0, 0, false],
    [10000, 10000, false],
    [10001, 10000, true],
  ] as const) {
    const output = materializeApiReadResult(checked, result([]), input);
    assert.equal(output.stage, 'list-read-result');
    if (output.stage === 'list-read-result') assert.deepEqual(output.count, { value, exact: true, capped });
  }
  for (const count of [undefined, -1, 10002, 0.5, Infinity]) assert.throws(() => materializeApiReadResult(checked, result([]), count));
  assert.throws(() => materializeApiReadResult(plan(), result([]), 1));
  assert.throws(() => materializeApiReadResult(checked, result([row, row]), 1));
});

test('item zero/one/two rows have distinct absence/success/uniqueness behavior', () => {
  const checked = plan('', true);
  assert.deepEqual(materializeApiReadResult(checked, result([])), {
    stage: 'item-read-result',
    authorization: 'pending',
    status: 'not-found',
  });
  const output = materializeApiReadResult(checked, result([row]));
  assert.equal(output.stage === 'item-read-result' && output.status, 'found');
  assert.throws(() => materializeApiReadResult(checked, result([row, row])));
  assert.throws(() => materializeApiReadResult(checked, result([]), 0));
});

test('mismatched columns, missing/extra values, overfetch and getters fail closed', () => {
  const checked = plan('limit=1');
  for (const raw of [
    result([row, row, row]),
    { ...result([row]), columns: ['name', 'rank', 'id'] },
    result([{ ...row, secret: 'hidden' }]),
    result([{ id: row.id, name: row.name }]),
    result([{ ...row, id: 9007199254740992 }]),
  ])
    assert.throws(() => materializeApiReadResult(checked, raw));
  let calls = 0;
  assert.throws(() =>
    materializeApiReadResult(checked, {
      get columns() {
        calls++;
        return [];
      },
      rows: [],
    }),
  );
  assert.equal(calls, 0);
});
