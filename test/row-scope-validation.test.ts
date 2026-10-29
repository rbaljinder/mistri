import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ANSI_STYLE, OPS, Refusal, type Filter } from '../packages/engine/src/adapters/adapter.js';
import { rowScopeCounters, ScopedRelations, snapshotRowScope, type RowScope } from '../packages/engine/src/shared/rowScope.js';
import { captureScopeCatalog } from '../packages/engine/src/shared/scopeCatalog.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

const schema: DatabaseSchema = {
  label: 'Row scope validation',
  dialect: 'sqlite',
  readAt: '2026-09-07T00:00:00Z',
  tables: [
    {
      id: 'private.records',
      schema: 'private',
      name: 'records',
      isView: false,
      columns: ['id', 'tenant', 'a.b'].map((name) => ({ name, type: 'text', nullable: true, primaryKey: name === 'id' })),
    },
  ],
  foreignKeys: [],
};
const filter = (value: unknown = 'north'): Filter => ({ groups: [[{ column: 'tenant', op: '=', value }]] }) as Filter;
const scope = (policy: unknown): RowScope => ({ 'private.records': policy }) as RowScope;
const rejects = (input: unknown) => assert.throws(() => snapshotRowScope(schema, input as RowScope), Refusal);

test('scope snapshots nested policy data and freezes every mutable boundary', () => {
  const policy: Filter = { groups: [[{ column: 'tenant', op: 'in', value: ['north', 'east'] }]] };
  const input = scope(policy);
  const snapshot = snapshotRowScope(schema, input);
  const relations = new ScopedRelations(schema, ANSI_STYLE, input);
  policy.groups[0][0].value = ['south'];
  policy.groups.push([{ column: 'id', op: '=', value: 'other' }]);
  (input as Record<string, unknown>)['private.records'] = true;
  assert.equal(Object.isFrozen(snapshot), true);
  const saved = snapshot['private.records'] as Filter;
  for (const value of [saved, saved.groups, saved.groups[0], saved.groups[0][0], saved.groups[0][0].value]) {
    assert.equal(Object.isFrozen(value), true);
  }
  relations.table('private.records');
  assert.deepEqual(relations.finish().params, ['north', 'east']);
  assert.throws(() => saved.groups.push([]), TypeError);
});

test('scope distinguishes absent, explicit allow, missing resource and explicit denial', () => {
  const absent = new ScopedRelations(schema, ANSI_STYLE);
  assert.equal(absent.table('private.records'), '"private"."records"');
  assert.deepEqual(absent.finish(), { text: '', params: [] });
  for (const input of [{}, scope(false)]) {
    const relations = new ScopedRelations(schema, ANSI_STYLE, input);
    relations.table('private.records');
    assert.match(relations.finish().text, /WHERE 1 = 0/);
  }
  const all = new ScopedRelations(schema, ANSI_STYLE, scope(true));
  all.table('private.records');
  assert.doesNotMatch(all.finish().text, /WHERE/);
});

test('resource identity is exact and local dotted column names are not relationship paths', () => {
  rejects({ records: true });
  rejects({ 'PRIVATE.records': true });
  rejects({ unknown: false });
  const policy: Filter = { groups: [[{ column: 'a.b', op: '=', value: 'local' }]] };
  const relations = new ScopedRelations(schema, ANSI_STYLE, scope(policy));
  relations.table('private.records');
  const compiled = relations.finish();
  assert.match(compiled.text, /WHERE "a\.b" = \?/);
  assert.deepEqual(compiled.params, ['local']);
  rejects(scope({ groups: [[{ column: 'tenant.name', op: '=', value: 'path' }]] }));
});

test('every supported operator has an explicit bounded policy value shape', () => {
  for (const op of OPS) {
    const condition = {
      column: 'tenant',
      op,
      ...(['isNull', 'isNotNull'].includes(op) ? {} : { value: op === 'in' ? ['one', 2] : 'one' }),
    };
    assert.doesNotThrow(() => snapshotRowScope(schema, scope({ groups: [[condition]] })));
  }
  for (const value of [true, false, 0, -1, 1.25, '']) {
    assert.doesNotThrow(() => snapshotRowScope(schema, scope(filter(value))));
  }
  assert.doesNotThrow(() => snapshotRowScope(schema, scope({ groups: [[{ column: 'tenant', op: 'in', value: [] }]] })));
});

test('malformed filters never collapse into unrestricted policies', () => {
  for (const policy of [
    null,
    undefined,
    '',
    [],
    {},
    { groups: [] },
    { groups: [[]] },
    { groups: [[], [{ column: 'tenant', op: '=', value: 'north' }]] },
    { groups: 'north' },
    { groups: [[{}]] },
    { groups: [[{ column: 'tenant', op: '=' }]] },
    { ...filter(), extra: true },
    { groups: [[{ column: 'tenant', op: '=', value: 'north', extra: true }]] },
    { groups: [[{ column: 'tenant', op: '= 1 OR 1 =', value: 'north' }]] },
    { groups: [[{ column: 'missing', op: 'isNull' }]] },
    { groups: [[{ column: 'tenant', op: 'isNull', value: 'ignored' }]] },
    { groups: [[{ column: 'tenant', op: 'contains', value: 0 }]] },
    { groups: [[{ column: 'tenant', op: 'in', value: 'north' }]] },
    { groups: [[{ column: 'tenant', op: 'in', value: [true] }]] },
  ])
    rejects(scope(policy));
  for (const value of [null, undefined, NaN, Infinity, -Infinity, {}, [], ['north'], 1n, () => 'north', Symbol('north')]) {
    rejects(scope({ groups: [[{ column: 'tenant', op: '=', value }]] }));
  }
});

test('scope rejects inherited state, accessors and exotic own properties without invoking getters', () => {
  let calls = 0;
  rejects(Object.create({ 'private.records': true }));
  rejects(scope(Object.create(filter())));
  const getter = () => {
    calls++;
    return true;
  };
  rejects(Object.defineProperty({}, 'private.records', { enumerable: true, get: getter }));
  rejects(scope({ groups: [[Object.defineProperty({ column: 'tenant', op: '=' }, 'value', { enumerable: true, get: getter })]] }));
  rejects(Object.defineProperty({}, 'private.records', { value: true, enumerable: false }));
  rejects({ ...scope(true), [Symbol('hidden')]: true });
  rejects(scope(new Date()));
  rejects(scope(new Map()));
  const nullPrototype = Object.assign(Object.create(null), scope(true));
  assert.doesNotThrow(() => snapshotRowScope(schema, nullPrototype));
  assert.equal(calls, 0);
});

test('scope rejects sparse, accessor, extended, subclassed and cyclic arrays', () => {
  const sparse: unknown[] = [];
  sparse.length = 1;
  rejects(scope({ groups: sparse }));
  const accessor: unknown[] = [null];
  Object.defineProperty(accessor, '0', {
    get() {
      throw new Error('must not run');
    },
  });
  rejects(scope({ groups: accessor }));
  rejects(scope({ groups: Object.assign(filter().groups, { extra: true }) }));
  class Groups extends Array {}
  rejects(scope({ groups: new Groups() }));
  const cyclic: unknown[] = [];
  cyclic.push(cyclic);
  rejects(scope({ groups: cyclic }));
  const objectCycle: Record<string, unknown> = {};
  objectCycle.groups = objectCycle;
  rejects(scope(objectCycle));
});

test('scope bounds resources, total conditions, arrays and individual/total strings', () => {
  const tables = Array.from({ length: 257 }, (_, i) => ({ ...schema.tables[0], id: `r${i}`, name: `r${i}` }));
  assert.throws(() => snapshotRowScope({ ...schema, tables }, Object.fromEntries(tables.map((table) => [table.id, true]))), Refusal);
  const condition = { column: 'tenant', op: '=', value: 'north' };
  rejects(scope({ groups: [Array.from({ length: 2049 }, () => condition)] }));
  rejects(scope({ groups: [[{ column: 'tenant', op: 'in', value: Array.from({ length: 4097 }, () => 'north') }]] }));
  rejects(scope(filter('x'.repeat(16_385))));
  rejects(scope({ groups: [Array.from({ length: 100 }, () => ({ ...condition, value: 'x'.repeat(3000) }))] }));
  const many: Filter = { groups: [[{ column: 'tenant', op: 'in', value: Array.from({ length: 4096 }, () => 1) }]] };
  const wideSchema = { ...schema, tables: Array.from({ length: 5 }, (_, i) => ({ ...schema.tables[0], id: `r${i}` })) };
  assert.throws(() => snapshotRowScope(wideSchema, Object.fromEntries(wideSchema.tables.map((table) => [table.id, many]))), Refusal);
});

test('scope validates unused resource policies and prevents late relation registration', () => {
  const other = { ...schema.tables[0], id: 'other', name: 'other' };
  const full = { ...schema, tables: [...schema.tables, other] };
  assert.throws(() => new ScopedRelations(full, ANSI_STYLE, { ...scope(true), other: { groups: [] } }), Refusal);
  const relations = new ScopedRelations(full, ANSI_STYLE, scope(true));
  const relation = relations.table('private.records');
  const prefix = relations.finish();
  assert.equal(relations.table('private.records'), relation);
  assert.throws(() => relations.table('other'), /must be planned/);
  prefix.params.push('not shared');
  assert.deepEqual(relations.finish().params, []);
});

test('a snapshot checked against a second fixed catalog is kept as itself, so the next request finds it checked', () => {
  /* A reloaded App's deployment holds a new catalog while the policy's constant scope is the same object. */
  const first = captureScopeCatalog(schema),
    second = captureScopeCatalog(structuredClone(schema));
  assert.notEqual(first, second);
  const snapshot = snapshotRowScope(first, scope(filter()));
  const before = rowScopeCounters.checked;
  assert.equal(snapshotRowScope(second, snapshot), snapshot, 'checked as it is, not copied');
  assert.equal(rowScopeCounters.checked - before, 1);
  assert.equal(snapshotRowScope(second, snapshot), snapshot);
  assert.equal(snapshotRowScope(first, snapshot), snapshot);
  assert.equal(rowScopeCounters.checked - before, 1, 'kept against both catalogs');
  // Still checked against the second: a snapshot that names a resource it lacks is refused there.
  const narrower = captureScopeCatalog({ ...structuredClone(schema), tables: [] });
  assert.throws(() => snapshotRowScope(narrower, snapshot), Refusal);
});

test('a scope built afresh with the same words is found by them against a fixed catalog, and copied first', () => {
  /* A policy naming its reader returns a new, equal object on every request. */
  const fixed = captureScopeCatalog(structuredClone(schema));
  const asked = () => scope({ groups: [[{ column: 'tenant', op: 'in', value: ['north', 'east'] }]] });
  const first = snapshotRowScope(fixed, asked());
  const before = rowScopeCounters.checked;
  assert.equal(snapshotRowScope(fixed, asked()), first, 'the equal scope is the one already checked');
  assert.equal(rowScopeCounters.checked - before, 0);
  // Other words are another scope, checked on their own.
  const other = snapshotRowScope(fixed, scope(filter('south')));
  assert.notEqual(other, first);
  assert.equal(JSON.stringify(other), JSON.stringify(scope(filter('south'))));
  assert.equal(rowScopeCounters.checked - before, 1);
  // A caller's object is copied before it is looked up: changing it afterwards changes nothing kept.
  const held = asked();
  const found = snapshotRowScope(fixed, held);
  ((held['private.records'] as Filter).groups[0][0] as { value: unknown }).value = ['west'];
  assert.equal(JSON.stringify(found), JSON.stringify(asked()));
  assert.notEqual(found, held);
  // An equal scope that a catalog refuses is still refused there: the words are kept per catalog.
  const narrower = captureScopeCatalog({ ...structuredClone(schema), tables: [] });
  assert.throws(() => snapshotRowScope(narrower, asked()), Refusal);
  // Against a catalog that can still change, nothing is kept: each is checked afresh.
  const open = structuredClone(schema);
  const counted = rowScopeCounters.checked;
  assert.notEqual(snapshotRowScope(open, asked()), snapshotRowScope(open, asked()));
  assert.equal(rowScopeCounters.checked - counted, 2);
});
