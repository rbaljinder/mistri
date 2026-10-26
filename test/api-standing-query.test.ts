import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { parseViewQuery } from '../packages/engine/src/shared/view.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { parseApiStandingQuery } from '../packages/mistri/src/server/api/apiStandingQuery.js';
import { checkApiReadCatalog } from '../packages/mistri/src/server/api/apiReadCatalog.js';
import { planApiViewReadRequest } from '../packages/mistri/src/server/api/apiReadRequest.js';

const now = new Date('2026-09-13T12:00:00Z');
const schema: DatabaseSchema = {
  label: 'Standing',
  dialect: 'sqlite',
  readAt: '',
  foreignKeys: [],
  tables: [
    {
      id: 'item',
      name: 'item',
      schema: '',
      isView: false,
      columns: [
        { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
        { name: 'name', type: 'TEXT', nullable: false, primaryKey: false },
        { name: 'day', type: 'DATE', nullable: true, primaryKey: false },
      ],
    },
  ],
};
function app(query: string) {
  return parseAppConfig(
    {
      id: 'app',
      name: 'App',
      resources: { item: {} },
      auth: { roles: { reader: { read: true } } },
      views: { items: { kind: 'list', from: 'item', query } },
      home: 'items',
      api: { version: 1, roles: ['reader'], resources: { item: { fields: ['id', 'name', 'day'] } }, views: ['items'] },
    },
    'test',
  );
}

test('API integer standing predicates refuse rounded decimal/exponent spellings before catalog or request use', () => {
  for (const value of [
    '9007199254740993.0',
    '9.007199254740993e15',
    '1.0000000000000001',
    '1.0',
    '1e0',
    '01',
    '+1',
    '-0',
    '9223372036854775808',
  ]) {
    for (const query of [`id = ${value}`, `id in 1,${value}`, `id between 0 and ${value}`]) {
      assert.throws(() => parseApiStandingQuery(schema, 'item', query, now), /canonical signed 64-bit/, query);
      const definition = app(query);
      assert.throws(() => checkApiReadCatalog(definition.api!, definition, schema), /canonical signed 64-bit/, query);
      assert.throws(
        () => planApiViewReadRequest(definition, schema, 'view:items', '', { integers: 'decimal-string' }, now),
        /canonical signed 64-bit/,
        query,
      );
    }
  }
  // The browser remains deliberately unchanged; the API refuses this loss.
  assert.equal(parseViewQuery(schema, 'item', 'id = 9007199254740993.0', now).filter.groups[0][0].value, 9007199254740992);
});

test('canonical integer predicates preserve exact strings and the original condition structure', () => {
  for (const value of ['0', '1', '-1', '9007199254740993', '9223372036854775807', '-9223372036854775808']) {
    const query = `id = ${value}`;
    const parsed = parseApiStandingQuery(schema, 'item', query, now);
    assert.deepEqual(parsed, parseViewQuery(schema, 'item', query, now));
    const definition = app(query);
    const plan = planApiViewReadRequest(definition, schema, 'view:items', '', { integers: 'decimal-string' }, now);
    const condition = (plan.standingFilter as any).groups[0][0];
    assert.equal(String(condition.value), value);
    if (value.length > 16) assert.equal(typeof condition.value, 'string');
  }
  for (const query of [
    'id in 1,2,9007199254740993',
    'id between -1 and 9223372036854775807',
    'id = 1 or id = 2',
    'id is empty',
    'name = 1.0000000000000001',
    'day = today',
    'id = 1 and day = today',
    'id = "9007199254740993"',
  ]) {
    assert.deepEqual(parseApiStandingQuery(schema, 'item', query, now), parseViewQuery(schema, 'item', query, now), query);
  }
});

test('integer reference hops and inactive tabs cannot bypass literal validation', () => {
  const joined = structuredClone(schema);
  joined.tables[0].columns.push({ name: 'parent_id', type: 'INTEGER', nullable: true, primaryKey: false });
  joined.tables.push({
    id: 'parent',
    name: 'parent',
    schema: '',
    isView: false,
    columns: [{ name: 'id', type: 'INTEGER', nullable: false, primaryKey: true }],
  });
  joined.foreignKeys.push({
    name: 'parent_ref',
    from: { table: 'item', columns: ['parent_id'] },
    to: { table: 'parent', columns: ['id'] },
  });
  assert.throws(() => parseApiStandingQuery(joined, 'item', 'parent_id.id = 9007199254740993.0', now), /canonical signed 64-bit/);
  const query = 'parent_id.id = 9007199254740993';
  assert.deepEqual(parseApiStandingQuery(joined, 'item', query, now), parseViewQuery(joined, 'item', query, now));
  const definition = app('id > 0');
  Object.assign(definition.views.items, {
    tabs: [
      { label: 'Valid', query: 'id = 1' },
      { label: 'Rounded', query: 'id = 1.0000000000000001' },
    ],
  });
  assert.throws(() => checkApiReadCatalog(definition.api!, definition, schema), /canonical signed 64-bit/);
});
