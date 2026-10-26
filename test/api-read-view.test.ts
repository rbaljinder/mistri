import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { ANSI_STYLE } from '../packages/engine/src/shared/filter.js';
import { compileView } from '../packages/engine/src/shared/view.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { createApiReadView } from '../packages/mistri/src/server/api/apiReadView.js';

function fixture() {
  const schema: DatabaseSchema = {
    label: 'Logical',
    dialect: 'postgres',
    readAt: '',
    foreignKeys: [],
    tables: [
      {
        id: 'person',
        name: 'person',
        schema: '',
        isView: false,
        columns: ['id', 'rank', 'name', 'active', 'secret'].map((name) => ({
          name,
          primaryKey: name === 'id',
          nullable: false,
          type: name === 'active' ? 'BOOLEAN' : ['id', 'rank'].includes(name) ? 'BIGINT' : 'TEXT',
        })),
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
      views: { people: { kind: 'list', from: 'person', query: 'rank < 3 or rank > 8' } },
      api: {
        version: 1,
        roles: ['reader'],
        views: ['people'],
        resources: {
          person: {
            fields: ['id', 'rank', 'name', 'active'],
            filters: ['id', 'rank', 'name', 'active'],
            sorts: ['rank'],
          },
        },
      },
    },
    'test',
  );
  const run = (operationId: string, query = '', key?: string) =>
    createApiReadView(
      app,
      schema,
      { operationId, query, ...(key === undefined ? {} : { key }) },
      { integers: 'decimal-string' },
      new Date('2026-09-13T12:00:00Z'),
    );
  return { app, schema, run };
}

test('checked list uses fetch projection, exact values and limit plus one in existing SQL compiler', () => {
  const f = fixture(),
    result = f.run('list:person', 'fields=name&sort=-rank&id=9007199254740993&limit=5');
  assert.deepEqual(
    result.view.columns.map((column) => column.path),
    ['id', 'rank', 'name'],
  );
  assert.deepEqual(result.plan.responseFields, ['id', 'name']);
  assert.equal(result.view.limit, 6);
  const sql = compileView(f.schema, result.view, ANSI_STYLE);
  assert.equal(sql.limit, 6);
  assert.ok(sql.params.includes('9007199254740993'));
  assert.ok(!sql.text.includes('9007199254740993') && !sql.text.includes('secret'));
  assert.match(sql.text, /ORDER BY/);
  assert.deepEqual(result.view.orderBy, [
    { path: 'rank', direction: 'desc' },
    { path: 'id', direction: 'asc' },
  ]);
  assert.ok(Object.isFrozen(result.view.filter!.groups[0]));
  assert.equal(result.authorization, 'pending');
});

test('standing OR groups retain every typed refinement rather than replacing authored constraints', () => {
  const f = fixture(),
    result = f.run('view:people', 'rank=1..10&name=a%27b&active=false');
  const groups = result.view.filter!.groups;
  assert.equal(groups.length, 2);
  for (const group of groups) {
    assert.equal(group.length, 5);
    assert.deepEqual(group.slice(1), [
      { path: 'rank', op: '>=', value: '1' },
      { path: 'rank', op: '<=', value: '10' },
      { path: 'name', op: '=', value: "a'b" },
      { path: 'active', op: '=', value: false },
    ]);
  }
  const sql = compileView(f.schema, result.view, ANSI_STYLE);
  assert.match(sql.text, / OR /);
  assert.ok(!sql.text.includes("a'b"));
  // Held by every group, the refinement is said once before the OR (buildWhere), still bound.
  assert.equal(sql.params.filter((value) => value === "a'b").length, 1);
});

test('item lookup is exact and bounded to two, never a caller supplied purported plan', () => {
  const f = fixture(),
    result = f.run('item:person', '', '9223372036854775807');
  assert.equal(result.view.limit, 2);
  assert.deepEqual(result.view.filter!.groups, [[{ path: 'id', op: '=', value: '9223372036854775807' }]]);
  assert.ok(compileView(f.schema, result.view, ANSI_STYLE).params.includes('9223372036854775807'));
  for (const [operation, query, key] of [
    ['list:secret', '', undefined],
    ['list:person', 'cursor=unverified', undefined],
    ['item:person', 'fields=id', '1'],
    ['list:person', '', '1'],
  ]) {
    assert.throws(() => f.run(operation!, query, key));
  }
  assert.throws(() =>
    createApiReadView(
      f.app,
      f.schema,
      { operationId: 'list:person', query: '', plan: {} } as never,
      { integers: 'decimal-string' },
      new Date(),
    ),
  );
});

test('boolean IN expands exact equalities through standing AND without losing false or null semantics', () => {
  const f = fixture(),
    result = f.run('view:people', 'active=false,true&rank=1,2');
  const groups = result.view.filter!.groups;
  assert.equal(groups.length, 4);
  for (const [index, group] of groups.entries()) {
    assert.deepEqual(group[1], { path: 'rank', op: 'in', value: ['1', '2'] });
    assert.deepEqual(group[2], { path: 'active', op: '=', value: index % 2 === 0 ? false : true });
  }
  const sql = compileView(f.schema, result.view, ANSI_STYLE);
  assert.match(sql.text, / OR /);
  assert.doesNotMatch(sql.text, /IS NOT NULL/);
  assert.equal(sql.params.filter((value) => value === false).length, 2);
  assert.equal(sql.params.filter((value) => value === true).length, 2);
});

test('multiple boolean memberships form a bounded Cartesian conjunction', () => {
  const f = fixture(),
    exposure = f.app.api!.resources.person;
  for (let i = 0; i < 8; i++) {
    const name = `flag${i}`;
    f.schema.tables[0].columns.push({ name, type: 'BOOLEAN', primaryKey: false, nullable: true });
    Object.assign(exposure, { fields: [...exposure.fields, name], filters: [...exposure.filters, name] });
  }
  const result = f.run('list:person', 'flag0=true,false&flag1=false,true');
  assert.equal(result.view.filter!.groups.length, 4);
  assert.deepEqual(
    new Set(result.view.filter!.groups.map((group) => JSON.stringify(group.map((condition) => condition.value)))),
    new Set(['[true,false]', '[true,true]', '[false,false]', '[false,true]']),
  );
  const sql = compileView(f.schema, result.view, ANSI_STYLE);
  assert.doesNotMatch(sql.text, /IS NOT NULL/);
  const query = Array.from({ length: 8 }, (_, i) => `flag${i}=true,false`).join('&');
  assert.throws(() => f.run('list:person', query), /conversion is unsupported or exceeds/);
  Object.assign(f.app.views.people, { query: Array.from({ length: 10 }, (_, i) => `rank > ${i}`).join(' and ') });
  // Exactly 128 branches, but 17 conditions per branch exceeds the total cap.
  assert.throws(() => f.run('view:people', query.split('&').slice(0, 7).join('&')), /conversion is unsupported or exceeds/);
});

test('default tab order and explicit clock reach SQL without changing standing semantics', () => {
  const f = fixture();
  Object.assign(f.app.views.people, {
    query: 'name = today',
    tabs: [
      { label: 'High rank', query: 'rank >= 5 sort rank desc' },
      { label: 'Others', query: 'rank < 5' },
    ],
  });
  const result = f.run('view:people', 'rank=6..8');
  assert.deepEqual(result.view.orderBy, [
    { path: 'rank', direction: 'desc' },
    { path: 'id', direction: 'asc' },
  ]);
  const sql = compileView(f.schema, result.view, ANSI_STYLE);
  assert.ok(sql.params.includes('2026-09-13'));
  assert.ok(sql.params.includes(5));
  assert.ok(sql.params.includes('6') && sql.params.includes('8'));
  const next = createApiReadView(
    f.app,
    f.schema,
    { operationId: 'view:people', query: '' },
    { integers: 'decimal-string' },
    new Date('2026-09-14T12:00:00Z'),
  );
  assert.ok(compileView(f.schema, next.view, ANSI_STYLE).params.includes('2026-09-14'));
  Object.assign(f.app.views.people, { tabs: [], query: Array.from({ length: 129 }, (_, i) => `rank = ${i}`).join(' or ') });
  assert.throws(() => f.run('view:people'));
});
