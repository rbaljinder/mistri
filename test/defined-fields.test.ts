/**
 * Row-defined fields (definedFields.ts): a JSON column whose keys are defined
 * by rows an admin edits. The block as written, the catalog's checks, a
 * definition row read and a value judged, a key read and asked in a list, and
 * the server holding every write to the definitions in the write's own scope.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { WriteTransaction } from '../packages/engine/src/adapters/adapter.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { apiFieldCodec } from '../packages/mistri/src/server/api/apiValueCodec.js';
import { authorizeTransaction } from '../packages/mistri/src/server/app/appAccess.js';
import { appError } from '../packages/mistri/src/server/app/appErrors.js';
import { compileAppDefinitionValidation } from '../packages/mistri/src/server/app/appValidation.js';
import { AppValidationDenied } from '../packages/mistri/src/server/app/appValidationDenied.js';
import { commandCatalog, createCommandDb } from '../packages/mistri/src/server/commands/commandDb.js';
import { parseAppConfig, resolveResources } from '../packages/mistri/src/shared/app.js';
import { parseDefined } from '../packages/engine/src/shared/definedFields.js';
import {
  DEFINED_REASONS,
  definedBreaks,
  definedObject,
  definitionFilter,
  readDefinitions,
  withDefined,
} from '../packages/engine/src/shared/definedValues.js';
import { textToView } from '../packages/engine/src/shared/viewtext.js';

test('the block as written: a JSON column bound to the resource whose rows define its keys', () => {
  assert.deepEqual(parseDefined({ specs: { from: 'attribute', per: 'category_id' } }, 'r'), {
    specs: { from: 'attribute', per: 'category_id' },
  });
  assert.deepEqual(parseDefined({ answers: { from: 'question' } }, 'r'), { answers: { from: 'question' } });
  assert.throws(() => parseDefined([], 'r'), /./);
  assert.throws(() => parseDefined({ specs: { per: 'x' } }, 'r'), /from/);
  assert.throws(() => parseDefined({ specs: { from: 'a', by: 'x' } }, 'r'), /by/);
  assert.throws(() => parseDefined({ 'a.b': { from: 'a' } }, 'r'), /./);
});

test('definition rows read as fields in their order; a row that cannot be read is left out', () => {
  const fields = readDefinitions(
    [
      {
        key: 'season',
        label: 'Season',
        type: 'choice',
        options: '3-season\n4-season\n\n3-season',
        required: 0,
        position: 2,
        category_id: 1,
      },
      { key: 'capacity', label: 'Sleeps', type: 'number', options: null, required: 1, position: 1, category_id: 1, help: ' People. ' },
      { key: 'origin', label: 'Made in', type: 'text', position: null, category_id: null },
      { key: 'season', label: 'Any season', type: 'text', position: 0, category_id: null },
      { key: 'bad key', label: 'No', type: 'text' },
      { key: 'odd', label: 'No', type: 'colour' },
    ],
    'category_id',
  );
  assert.deepEqual(
    fields.map((field) => [field.key, field.label, field.type]),
    [
      ['capacity', 'Sleeps', 'number'],
      ['season', 'Season', 'choice'],
      ['origin', 'Made in', 'text'],
    ],
  );
  assert.deepEqual(fields[0], { key: 'capacity', label: 'Sleeps', type: 'number', options: [], required: true, help: 'People.' });
  assert.deepEqual(fields[1].options, ['3-season', '4-season']);
  assert.deepEqual(definitionFilter('category_id', 3), {
    groups: [[{ column: 'category_id', op: '=', value: 3 }], [{ column: 'category_id', op: 'isNull' }]],
  });
  assert.deepEqual(definitionFilter('category_id', null), { groups: [[{ column: 'category_id', op: 'isNull' }]] });
  assert.equal(definitionFilter(undefined, 3), undefined);
});

test('a value is judged against its field: kind, required, the list, and keys no field names', () => {
  const fields = readDefinitions([
    { key: 'n', label: 'N', type: 'number', required: true },
    { key: 'd', label: 'D', type: 'date' },
    { key: 't', label: 'T', type: 'datetime' },
    { key: 'b', label: 'B', type: 'bool' },
    { key: 'c', label: 'C', type: 'choice', options: 'a\nb' },
    { key: 'cs', label: 'Cs', type: 'choices', options: 'a\nb' },
    { key: 'm', label: 'M', type: 'money' },
  ]);
  assert.deepEqual(
    definedBreaks(fields, { n: 2, d: '2026-02-28', t: '2026-02-28T10:30', b: false, c: 'a', cs: ['b', 'a'], m: 9.5 }, { extras: true }),
    [],
  );
  assert.deepEqual(
    definedBreaks(fields, { n: '2', d: '2026-02-30', t: 'soon', b: 'yes', c: 'z', cs: ['a', 'a'], m: 'x', other: 1 }, { extras: true }).map(
      (item) => `${item.key}:${item.reason}`,
    ),
    ['b:bool', 'c:choice', 'cs:choice', 'd:date', 'm:number', 'n:number', 't:datetime', 'other:unknown'],
  );
  assert.deepEqual(definedBreaks(fields, { other: 1 }, { extras: false }), [{ key: 'n', reason: 'required' }]);
  assert.deepEqual(definedObject('{"a":1}'), { a: 1 });
  assert.deepEqual(definedObject(null), {});
  assert.equal(definedObject('[1]'), undefined);
  assert.equal(definedObject('nope'), undefined);
  const [b, , cs, , , n] = fields;
  assert.deepEqual(withDefined({ n: 1 }, n, ' 1,200 '), { n: 1200 });
  assert.deepEqual(withDefined({ n: 1 }, n, ''), {});
  assert.deepEqual(withDefined({}, b, false), { b: false });
  assert.deepEqual(withDefined({}, cs, ['a']), { cs: ['a'] });
  assert.deepEqual(withDefined({}, cs, ' b, a ,, b'), { cs: ['b', 'a'] }, 'a box says a list with commas');
  assert.deepEqual(withDefined({ cs: ['a'] }, cs, ' , '), {});
  assert.deepEqual(withDefined({}, b, '1'), { b: true }, 'a yes/no list says 1 and 0');
  assert.deepEqual(withDefined({}, b, '0'), { b: false });
  assert.deepEqual(withDefined({}, n, 'many'), { n: 'many' }, 'kept as typed, for the server to refuse by name');
});

function shop() {
  const dir = mkdtempSync(join(tmpdir(), 'tw-defined-'));
  const file = join(dir, 'shop.db');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE category (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE attribute (id INTEGER PRIMARY KEY, category_id INTEGER REFERENCES category(id), key TEXT NOT NULL, label TEXT NOT NULL,
      type TEXT NOT NULL, options TEXT, required INTEGER NOT NULL DEFAULT 0, help TEXT, position INTEGER, tenant TEXT NOT NULL DEFAULT 'a');
    CREATE TABLE product (id INTEGER PRIMARY KEY, name TEXT NOT NULL, category_id INTEGER REFERENCES category(id), specs JSON NOT NULL DEFAULT '{}');
    INSERT INTO category VALUES (1, 'Tents'), (2, 'Bikes');
    INSERT INTO attribute (category_id, key, label, type, options, required, position) VALUES
      (1, 'capacity', 'Sleeps', 'number', NULL, 1, 1),
      (1, 'season', 'Season', 'choice', '3-season' || char(10) || '4-season', 0, 2),
      (2, 'frame', 'Frame', 'choices', 'S' || char(10) || 'M' || char(10) || 'L', 0, 1),
      (NULL, 'origin', 'Made in', 'text', NULL, 0, 9),
      (NULL, 'recycled', 'Recycled', 'bool', NULL, 0, 10);
    INSERT INTO product (name, category_id, specs) VALUES
      ('Ridge 2', 1, '{"capacity":2,"season":"3-season","recycled":true}'),
      ('Summit 4', 1, '{"capacity":4,"season":"4-season","origin":"Norway"}'),
      ('Ridge 10', 1, '{"capacity":10}'),
      ('Trail', 2, '{"frame":["M","L"],"recycled":false}');
  `);
  db.close();
  return { dir, file };
}

test('a key of a JSON column is a path a list filters, asks and sorts by (SQLite json1)', async () => {
  const { dir, file } = shop();
  const adapter = new SqliteAdapter(file, 'shop');
  try {
    const schema = await adapter.introspect();
    const names = async (text: string) => {
      const parsed = textToView(schema, text);
      assert.deepEqual(parsed.errors, [], text);
      const result = await adapter.runView(parsed.view!);
      return result.rows.map((row) => row.name);
    };
    assert.deepEqual(await names('product show name where specs.capacity >= 4 sort name'), ['Ridge 10', 'Summit 4']);
    assert.deepEqual(await names('product show name where specs.capacity = 2'), ['Ridge 2']);
    assert.deepEqual(await names('product show name where specs.season = "4-season"'), ['Summit 4']);
    assert.deepEqual(await names('product show name where specs.recycled = true'), ['Ridge 2']);
    assert.deepEqual(await names('product show name where specs.recycled = false'), ['Trail']);
    assert.deepEqual(await names('product show name where specs.frame has (S, L)'), ['Trail']);
    assert.deepEqual(await names('product show name where specs.season has 3-season'), ['Ridge 2']);
    assert.deepEqual(await names('product show name where specs.origin is empty and category_id = 1 sort name'), ['Ridge 10', 'Ridge 2']);
    assert.deepEqual(await names('product show name where category_id = 1 sort specs.capacity desc'), ['Ridge 10', 'Summit 4', 'Ridge 2']);
    assert.deepEqual(await names('product show name where specs.origin contains orw'), ['Summit 4']);
    assert.match(textToView(schema, 'product where specs.bad-key = 1').errors[0]?.message ?? '', /./);
    assert.match(textToView(schema, 'product where name.size = 1').errors[0]?.message ?? '', /./);
  } finally {
    adapter.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every write is held to the definitions its own transaction reads: forms, commands and the refusal shape', async (t) => {
  const { dir, file } = shop();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const adapter = new SqliteAdapter(file, 'shop');
  t.after(() => adapter.close());
  const schema = await adapter.introspect();
  const app = (defined: unknown, attribute = true) =>
    parseAppConfig(
      {
        id: 'shop',
        name: 'Shop',
        resources: { product: { access: 'write', defined }, category: {}, ...(attribute ? { attribute: { access: 'write' } } : {}) },
        views: { products: { kind: 'list', from: 'product' } },
        home: 'products',
        nav: ['products'],
      },
      'shop',
    );
  const problems = (defined: unknown, attribute = true) => resolveResources(app(defined, attribute), schema).problems.join('\n');
  assert.equal(problems({ specs: { from: 'attribute', per: 'category_id' } }), '');
  assert.match(problems({ name: { from: 'attribute' } }), /JSON/);
  assert.match(problems({ specs: { from: 'attribute', per: 'nope' } }), /nope/);
  assert.match(problems({ specs: { from: 'category' } }), /key/);
  assert.match(problems({ specs: { from: 'attribute' } }, false), /attribute/);
  const served = app({ specs: { from: 'attribute', per: 'category_id' } });
  assert.deepEqual(resolveResources(served, schema).resources.product?.defined, { specs: { from: 'attribute', per: 'category_id' } });

  const validation = compileAppDefinitionValidation(schema, served);
  const access = { readable: new Set(['product', 'attribute', 'category']), writable: new Set(['product']), validation };
  const write = <T>(work: (tx: ReturnType<typeof authorizeTransaction>) => Promise<T>) =>
    adapter.transaction!((tx) => work(authorizeTransaction(schema, access, tx)));
  const refused = async (work: (tx: ReturnType<typeof authorizeTransaction>) => Promise<unknown>) => {
    try {
      await write(work);
    } catch (error) {
      assert.ok(error instanceof AppValidationDenied, String(error));
      return Object.fromEntries(appError(error, 'write').fields!.map((item) => [item.field, item.message]));
    }
    assert.fail('the write was not refused');
  };

  // An object is written as its JSON text, and judged against category 1's definitions and the shared ones.
  const made = await write((tx) =>
    tx.insert({ table: 'product', values: { name: 'Dome', category_id: 1, specs: { capacity: 3, recycled: true } as never } }),
  );
  assert.ok(made.key.id);
  assert.deepEqual(
    await refused((tx) =>
      tx.insert({ table: 'product', values: { name: 'Bad', category_id: 1, specs: { season: 'winter', frame: ['S'] } as never } }),
    ),
    { 'specs.capacity': DEFINED_REASONS.required, 'specs.season': DEFINED_REASONS.choice, 'specs.frame': DEFINED_REASONS.unknown },
  );
  assert.deepEqual(await refused((tx) => tx.insert({ table: 'product', values: { name: 'Bad', category_id: 2, specs: '[1]' } })), {
    specs: 'This value does not meet the application rules.',
  });
  /* Moving a record to another category judges it against that category's
     fields; a key the old one defined is refused only once the column itself
     is written. */
  assert.deepEqual(await refused((tx) => tx.update({ table: 'product', key: { id: 4 }, values: { category_id: 1 } })), {
    'specs.capacity': DEFINED_REASONS.required,
  });
  // An edit of something else never trips on a key a removed definition left behind.
  new DatabaseSync(file).exec(`UPDATE product SET specs = '{"capacity":2,"gone":1}' WHERE id = 1`);
  await write((tx) => tx.update({ table: 'product', key: { id: 1 }, values: { name: 'Ridge 2+' }, expected: { name: 'Ridge 2' } }));
  // The column written as text, its original left out of `expected` (no engine compares it).
  await write((tx) =>
    tx.update({ table: 'product', key: { id: 1 }, values: { name: 'Ridge 2', specs: '{"capacity":2}' }, expected: { name: 'Ridge 2+' } }),
  );

  // A command's handle reads the object and writes one, held to the same rules.
  const catalog = commandCatalog(schema, ['product'], (name) => name)!;
  const viaCommand = <T>(work: (db: Record<string, any>) => Promise<T>) =>
    write((tx) =>
      work(createCommandDb({ tx, catalog, read: ['product'], write: ['product'], now: () => new Date() }) as Record<string, any>),
    );
  const tent: Record<string, unknown> = await viaCommand((db) => db.product.get({ id: 1 }));
  assert.deepEqual(tent.specs, { capacity: 2 });
  const updated = await viaCommand(async (db) =>
    db.product.update(await db.product.get({ id: 1 }), { specs: { capacity: 3, season: '4-season' } }),
  );
  assert.deepEqual(updated.specs, { capacity: 3, season: '4-season' });
  const inserted: Record<string, unknown> = await viaCommand((db) =>
    db.product.insert({ name: 'Bivvy', category_id: 1, specs: { capacity: 1 } }),
  );
  assert.deepEqual(inserted.specs, { capacity: 1 });
  await assert.rejects(
    () => viaCommand(async (db) => db.product.update(await db.product.get({ id: 1 }), { specs: { capacity: 'two' } })),
    (error) => error instanceof AppValidationDenied && error.fields[0] === 'specs.capacity',
  );
  const check = new DatabaseSync(file);
  t.after(() => check.close());
  assert.equal(
    (check.prepare('SELECT specs FROM product WHERE id = 1').get() as { specs: string }).specs,
    '{"capacity":3,"season":"4-season"}',
  );

  /* The definitions are read through the write's own handle: in a tenant App
     that is the tenant's scoped transaction, so another tenant's definition
     neither demands a key nor admits one. A handle that reads only tenant a's
     definitions stands in for it here. */
  check.exec(`INSERT INTO attribute (category_id, key, label, type, required, tenant) VALUES (1, 'warranty', 'Warranty', 'text', 1, 'b')`);
  const tenantA = (tx: WriteTransaction): WriteTransaction => ({
    ...tx,
    query: (request) =>
      tx.query(
        request.table !== 'attribute'
          ? request
          : {
              ...request,
              filter: {
                groups: (request.filter?.groups.length ? request.filter.groups : [[]]).map((group) => [
                  ...group,
                  { column: 'tenant', op: '=' as const, value: 'a' },
                ]),
              },
            },
      ),
  });
  const insert = (values: Record<string, unknown>) => ({ table: 'product', values: { name: 'Pod', category_id: 1, ...values } as never });
  await adapter.transaction!((tx) => authorizeTransaction(schema, access, tenantA(tx)).insert(insert({ specs: { capacity: 2 } })));
  await assert.rejects(
    () =>
      adapter.transaction!((tx) =>
        authorizeTransaction(schema, access, tenantA(tx)).insert(insert({ specs: { capacity: 2, warranty: '2y' } })),
      ),
    (error) => error instanceof AppValidationDenied && error.fields.join() === 'specs.warranty',
  );
  assert.deepEqual(await refused((tx) => tx.insert(insert({ specs: { capacity: 2 } }))), { 'specs.warranty': DEFINED_REASONS.required });
});

test('an App API read says a JSON column as an object, whatever text the engine kept it as', () => {
  const codec = apiFieldCodec({ type: 'JSON' }, 'sqlite', 'number');
  assert.equal(codec.kind, 'json');
  assert.deepEqual(codec.schema, { type: 'object' });
  assert.deepEqual(codec.encode('{"capacity":2,"features":["Rain cover"]}'), { capacity: 2, features: ['Rain cover'] });
  assert.deepEqual(apiFieldCodec({ type: 'jsonb' }, 'postgres', 'number').encode({ season: '3-season' }), { season: '3-season' });
  // A scalar column keeps its own codec.
  assert.notEqual(apiFieldCodec({ type: 'integer' }, 'sqlite', 'number').kind, 'json');
});
