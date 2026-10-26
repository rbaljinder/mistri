import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAppSourceCatalog } from '../packages/mistri/src/server/app/appSourceCatalog.js';
import { typesForSchema } from '../packages/mistri/src/server/typegen.js';
import { tableNamed, type DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { resolveAggregate, resolvePath } from '../packages/engine/src/shared/view.js';

function schema(namespace = 'public', dialect: DatabaseSchema['dialect'] = 'postgres'): DatabaseSchema {
  const id = (name: string) => (namespace ? `${namespace}.${name}` : name);
  return {
    label: `${dialect} source`,
    dialect,
    readAt: '2026-09-06T00:00:00.000Z',
    tables: [
      {
        id: id('person'),
        name: 'person',
        schema: namespace,
        isView: false,
        columns: [
          { name: 'id', type: 'integer', primaryKey: true, nullable: false },
          { name: 'name', type: 'text', primaryKey: false, nullable: false },
        ],
      },
      {
        id: id('ticket'),
        name: 'ticket',
        schema: namespace,
        isView: false,
        columns: [
          { name: 'id', type: 'integer', primaryKey: true, nullable: false },
          { name: 'owner_id', type: 'integer', primaryKey: false, nullable: true, references: { table: id('person'), column: 'id' } },
        ],
      },
    ],
    foreignKeys: [
      {
        name: 'ticket_owner_fk',
        from: { table: id('ticket'), columns: ['owner_id'] },
        to: { table: id('person'), columns: ['id'] },
        onDelete: 'restrict',
      },
    ],
  };
}

test('default resources stay concise while same-named secondary resources remain distinct', () => {
  const catalog = createAppSourceCatalog({ operations: { schema: schema() }, archive: { schema: schema('history') } }, 'operations');
  assert.deepEqual(
    catalog.schema.tables.map((table) => [table.id, table.name, table.schema]),
    [
      ['person', 'person', ''],
      ['ticket', 'ticket', ''],
      ['archive.person', 'archive.person', ''],
      ['archive.ticket', 'archive.ticket', ''],
    ],
  );
  assert.deepEqual(catalog.resolve('ticket'), {
    source: 'operations',
    group: 'operations',
    table: 'ticket',
    physicalTable: 'public.ticket',
  });
  assert.deepEqual(catalog.resolve('archive.ticket'), {
    source: 'archive',
    group: 'archive',
    table: 'ticket',
    physicalTable: 'history.ticket',
  });
  assert.equal(tableNamed(catalog.schema, 'ticket')?.id, 'ticket');
  assert.equal(catalog.catalogs.get('archive')?.schema.tables[0].id, 'person');
  assert.throws(() => catalog.resolve('operations.ticket'), /Unknown app resource/);
  assert.throws(() => catalog.resolve('public.ticket'), /Unknown app resource/);
  assert.throws(() => catalog.resolve('missing.ticket'), /Unknown app resource/);
  assert.throws(() => catalog.resolve('missing'), /Unknown app resource/);
});

test('a resource present only in a secondary source is never inferred from a bare name', () => {
  const catalog = createAppSourceCatalog(
    { operations: { schema: { ...schema(), tables: [], foreignKeys: [] } }, archive: { schema: schema('history') } },
    'operations',
  );
  assert.equal(tableNamed(catalog.schema, 'ticket'), undefined);
  assert.throws(() => catalog.resolve('ticket'), /Unknown app resource/);
  assert.equal(catalog.resolve('archive.ticket').source, 'archive');
});

test('references, forward paths and reverse aggregates cannot cross source boundaries', () => {
  const catalog = createAppSourceCatalog({ operations: { schema: schema() }, archive: { schema: schema('history') } }, 'operations');
  assert.equal(catalog.schema.tables[3].columns[1].references?.table, 'archive.person');
  assert.deepEqual(
    catalog.schema.foreignKeys.map((fk) => [fk.from.table, fk.to.table]),
    [
      ['ticket', 'person'],
      ['archive.ticket', 'archive.person'],
    ],
  );
  assert.equal(resolvePath(catalog.schema, 'ticket', 'owner_id.name').table.id, 'person');
  assert.equal(resolvePath(catalog.schema, 'archive.ticket', 'owner_id.name').table.id, 'archive.person');
  assert.equal(
    resolveAggregate(catalog.schema, 'archive.person', { fn: 'count', via: 'archive.ticket.owner_id' }).child.id,
    'archive.ticket',
  );
  assert.throws(() => resolveAggregate(catalog.schema, 'person', { fn: 'count', via: 'archive.ticket.owner_id' }), /Nothing called/);
  assert.throws(() => resolveAggregate(catalog.schema, 'archive.person', { fn: 'count', via: 'ticket.owner_id' }), /Nothing called/);
});

test('resource aliases are source-local and the physical input catalogs remain unchanged', () => {
  const primary = schema();
  const secondary = schema('history');
  const original = structuredClone({ primary, secondary });
  const catalog = createAppSourceCatalog(
    {
      operations: { schema: primary, resources: { agents: 'public.person' } },
      archive: { schema: secondary, resources: { agents: 'history.person', cases: 'history.ticket' } },
    },
    'operations',
  );
  assert.deepEqual(catalog.resolve('agents'), {
    source: 'operations',
    group: 'operations',
    table: 'agents',
    physicalTable: 'public.person',
  });
  assert.deepEqual(catalog.resolve('archive.agents'), {
    source: 'archive',
    group: 'archive',
    table: 'agents',
    physicalTable: 'history.person',
  });
  assert.equal(resolvePath(catalog.schema, 'archive.cases', 'owner_id.name').table.id, 'archive.agents');
  assert.deepEqual({ primary, secondary }, original);
  const target = catalog.resolve('agents');
  target.source = 'corrupted';
  assert.equal(catalog.resolve('agents').source, 'operations');
});

test('mixed dialect metadata remains available per source and generated keys preserve identity', () => {
  const catalog = createAppSourceCatalog({ operations: { schema: schema() }, inventory: { schema: schema('', 'sqlite') } }, 'operations');
  assert.equal(catalog.schema.dialect, 'postgres', 'The combined metadata uses the default source, not a synthetic dialect');
  assert.equal(catalog.catalogs.get(catalog.resolve('inventory.ticket').source)?.schema.dialect, 'sqlite');
  assert.equal(catalog.catalogs.get(catalog.resolve('ticket').source)?.schema.dialect, 'postgres');
  const generated = typesForSchema(catalog.schema, 'Atlas');
  assert.match(generated, /\n  ticket:/);
  assert.match(generated, /\n  "inventory.ticket":/);
  assert.doesNotMatch(generated, /public\./);
});

test('invalid, inherited and prototype source identifiers are refused without accidental lookups', () => {
  for (const name of ['', 'source.name', 'source-name', '3source', '__proto__', 'constructor', 'prototype', 'toString']) {
    const sources = Object.fromEntries([[name, { schema: schema() }]]);
    assert.throws(() => createAppSourceCatalog(sources, name), /Invalid app source name/);
  }
  const inherited = Object.create({ operations: { schema: schema() } });
  assert.throws(() => createAppSourceCatalog(inherited, 'operations'), /plain record/);
  const nullPrototype = Object.assign(Object.create(null), { operations: { schema: schema() } });
  assert.equal(createAppSourceCatalog(nullPrototype, 'operations').resolve('person').source, 'operations');
  assert.throws(() => createAppSourceCatalog({ operations: { schema: schema() } }, 'constructor'), /Default app source.*not configured/);
  assert.throws(() => createAppSourceCatalog({}, 'operations'), /Default app source.*not configured/);
});

test('a table name two schemas share is named by its schema, unless the App names it', () => {
  const shared = schema();
  shared.tables.push({ ...shared.tables[0], id: 'archive.person', schema: 'archive' });
  const catalog = createAppSourceCatalog({ operations: { schema: shared } }, 'operations');
  assert.deepEqual(catalog.resolve('public_person'), {
    source: 'operations',
    group: 'operations',
    table: 'public_person',
    physicalTable: 'public.person',
  });
  assert.deepEqual(catalog.resolve('archive_person'), {
    source: 'operations',
    group: 'operations',
    table: 'archive_person',
    physicalTable: 'archive.person',
  });
  assert.throws(() => catalog.resolve('person'), /Unknown app resource "person"/);
  // Binding one copy leaves the other's name as it was.
  const bound = createAppSourceCatalog({ operations: { schema: shared, resources: { archived_people: 'archive.person' } } }, 'operations');
  assert.deepEqual(bound.resolve('archived_people'), {
    source: 'operations',
    group: 'operations',
    table: 'archived_people',
    physicalTable: 'archive.person',
  });
  assert.deepEqual(bound.resolve('public_person'), {
    source: 'operations',
    group: 'operations',
    table: 'public_person',
    physicalTable: 'public.person',
  });
});
