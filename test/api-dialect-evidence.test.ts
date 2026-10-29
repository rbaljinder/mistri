/**
 * Which engine encodes a table's values in the App API. A catalog merged from
 * several connections carries the default source's dialect, which is wrong
 * for every other source's tables; so each table of such a catalog says its
 * own (`sourceDialect`), and the API reads it through one function
 * (apiDialectOf). A read of the merged dialect anywhere else in the API would
 * mis-encode another engine's values without a word; the source check below
 * is what keeps that from coming back.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createAppSourceCatalog } from '../packages/mistri/src/server/app/appSourceCatalog.js';
import { apiCatalogOn, apiDialectOf, apiSingleDialect } from '../packages/mistri/src/server/api/apiValueCodec.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

const API = fileURLToPath(new URL('../packages/mistri/src/server/api/', import.meta.url));
/* Files that may name a dialect: the one reader, and what states an engine of its own
   (a refusing adapter carries its connection's catalog; a snapshot reader is PostgreSQL). */
const ALLOWED: Record<string, number> = { 'apiValueCodec.ts': Infinity, 'apiSourceLanes.ts': 1 };

test('the App API reads a dialect only through apiDialectOf', () => {
  const found: string[] = [];
  for (const file of readdirSync(API).filter((name) => name.endsWith('.ts'))) {
    const source = readFileSync(join(API, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    const reads = [...source.matchAll(/\.dialect\b|\{[^{}]*\bdialect\b[^{}]*\}\s*=/g)].length;
    if (reads > (ALLOWED[file] ?? 0)) found.push(`${file}: ${reads}`);
  }
  assert.deepEqual(found, [], 'use apiDialectOf(schema, table) or apiCatalogOn(schema, engine, tables) from apiValueCodec.ts');
});

function schema(dialect: DatabaseSchema['dialect'], namespace = ''): DatabaseSchema {
  return {
    label: dialect,
    dialect,
    readAt: '2026-10-09T00:00:00.000Z',
    tables: [
      {
        id: namespace ? `${namespace}.item` : 'item',
        name: 'item',
        schema: namespace,
        isView: false,
        columns: [{ name: 'id', type: 'integer', primaryKey: true, nullable: false }],
      },
    ],
    foreignKeys: [],
  };
}

test('a catalog of several connections stamps each table with its own engine; one connection stamps nothing', () => {
  const two = createAppSourceCatalog({ sales: { schema: schema('postgres') }, stock: { schema: schema('sqlite') } }, 'sales').schema;
  assert.deepEqual(
    two.tables.map((table) => [table.id, table.sourceDialect]),
    [
      ['item', 'postgres'],
      ['stock.item', 'sqlite'],
    ],
  );
  assert.equal(two.dialect, 'postgres', 'the merged dialect stays the default source’s');
  assert.equal(apiDialectOf(two, 'stock.item'), 'sqlite');
  assert.equal(apiSingleDialect(two), undefined);
  // It survives the copies the owners take of a catalog.
  assert.equal(structuredClone(two).tables[1].sourceDialect, 'sqlite');
  // Two sources on one connection (each its own schema) are one engine: nothing to say.
  const shared = createAppSourceCatalog(
    { sales: { schema: schema('postgres', 'public'), group: 'db' }, stock: { schema: schema('postgres', 'history'), group: 'db' } },
    'sales',
  ).schema;
  assert.ok(shared.tables.every((table) => table.sourceDialect === undefined));
  assert.equal(apiSingleDialect(shared), 'postgres');
  const one = createAppSourceCatalog({ sales: { schema: schema('sqlite') } }, 'sales').schema;
  assert.equal(one.tables[0].sourceDialect, undefined);
  assert.equal(apiDialectOf(one, 'item'), 'sqlite');
});

test('a table the catalog does not stamp, beside one it does, is refused rather than guessed', () => {
  const mixed = schema('postgres');
  mixed.tables = [...mixed.tables, { ...mixed.tables[0], id: 'other', name: 'other', sourceDialect: 'sqlite' }];
  assert.equal(apiDialectOf(mixed, 'other'), 'sqlite');
  assert.throws(() => apiDialectOf(mixed, 'item'));
  assert.throws(() => apiDialectOf(mixed, 'absent'));
});

test('an engine owner serves the tables its exposed operations reach, each on its engine', () => {
  const two = createAppSourceCatalog({ sales: { schema: schema('postgres') }, stock: { schema: schema('sqlite') } }, 'sales').schema;
  assert.equal(apiCatalogOn(two, 'postgres', ['item']), true);
  assert.equal(apiCatalogOn(two, 'postgres', ['item', 'stock.item']), false);
  assert.equal(apiCatalogOn(two, 'postgres'), false, 'with no tables named, the whole catalog is judged');
  assert.equal(apiCatalogOn(two, 'postgres', ['absent']), false);
  assert.equal(apiCatalogOn(schema('sqlite'), 'sqlite', ['anything']), true, 'a one-source catalog is judged by its dialect, as before');
  assert.equal(apiCatalogOn(schema('sqlite'), 'postgres'), false);
});
