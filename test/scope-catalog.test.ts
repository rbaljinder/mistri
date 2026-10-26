import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Refusal } from '../packages/engine/src/adapters/adapter.js';
import type { ColumnMeta, DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import {
  assertScopeCatalog,
  captureScopeCatalog,
  mapScopeCatalog,
  scopeCatalogDifference,
} from '../packages/engine/src/shared/scopeCatalog.js';
import { withDeclaredDates } from '../packages/mistri/src/shared/declaredDates.js';

const column = (name: string, extra: Partial<ColumnMeta> = {}): ColumnMeta => ({
  name,
  type: 'INTEGER',
  nullable: false,
  primaryKey: false,
  ...extra,
});
function schema(): DatabaseSchema {
  return {
    dialect: 'sqlite',
    label: 'Private label',
    readAt: '2026-09-07',
    tables: [
      {
        id: 'parent',
        name: 'Parent label',
        schema: 'main',
        isView: false,
        approxRows: 10,
        columns: [column('right', { primaryKey: true }), column('left', { primaryKey: true }), column('code', { type: 'TEXT' })],
      },
      {
        id: 'child',
        name: 'Child label',
        schema: 'main',
        isView: false,
        indexed: ['id'],
        columns: [
          column('id', { primaryKey: true, identity: 'by-default' }),
          column('parent_left', { references: { table: 'parent', column: 'left' } }),
          column('parent_right', { references: { table: 'parent', column: 'right' } }),
          column('tag', {
            type: 'TEXT',
            nullable: true,
            default: "'original'",
            references: { table: 'parent', column: 'code' },
            allowed: ['original'],
          }),
        ],
      },
    ],
    foreignKeys: [
      {
        name: 'pair',
        from: { table: 'child', columns: ['parent_left', 'parent_right'] },
        to: { table: 'parent', columns: ['left', 'right'] },
        onDelete: 'restrict',
      },
      { name: 'code', from: { table: 'child', columns: ['tag'] }, to: { table: 'parent', columns: ['code'] }, onDelete: 'set null' },
    ],
  };
}
function frozen(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) frozen(child);
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
const rejects = (value: unknown) => assert.throws(() => captureScopeCatalog(value as DatabaseSchema), Refusal);
const tag = (value: DatabaseSchema) => value.tables.find((table) => table.id === 'child')!.columns.find((column) => column.name === 'tag')!;

test('capture detaches and freezes all data while preserving catalog order', () => {
  const input = schema();
  const before = structuredClone(input);
  const captured = captureScopeCatalog(input);
  frozen(captured);
  assert.deepEqual(input, before);
  assert.deepEqual(
    captured.tables.map((table) => table.id),
    ['parent', 'child'],
  );
  assert.deepEqual(
    captured.tables[0].columns.map((column) => column.name),
    ['right', 'left', 'code'],
  );
  assert.deepEqual(
    captured.foreignKeys.map((fk) => fk.name),
    ['pair', 'code'],
  );
  input.tables[0].columns[0].nullable = true;
  input.foreignKeys[0].to.columns.reverse();
  tag(input).allowed!.push('another');
  assert.equal(captured.tables[0].columns[0].nullable, false);
  assert.deepEqual(captured.foreignKeys[0].to.columns, ['left', 'right']);
  assert.deepEqual(tag(captured).allowed, ['original']);
  assert.throws(() => captured.tables.push(input.tables[0]), TypeError);
  assert.doesNotThrow(() => assertScopeCatalog(before, captured));
});

test('a catalog this module captured is reused by identity, while a frozen lookalike is still checked', () => {
  const captured = captureScopeCatalog(schema());
  assert.equal(captureScopeCatalog(captured), captured);
  const impostor = structuredClone(captured);
  impostor.tables[0].id = '';
  deepFreeze(impostor);
  rejects(impostor);
});

test('cached authority fingerprints do not trust mutable boundary input', () => {
  const expected = captureScopeCatalog(schema());
  const actual = schema();
  assert.doesNotThrow(() => assertScopeCatalog(expected, actual));
  actual.tables[0].columns[0].nullable = true;
  assert.throws(() => assertScopeCatalog(expected, actual), Refusal);
});

test('comparison ignores presentation, namespaces and enumeration order', () => {
  const expected = schema();
  const actual = schema();
  actual.label = 'Changed';
  actual.readAt = 'Later';
  actual.tables.reverse();
  actual.foreignKeys.reverse();
  for (const table of actual.tables) {
    table.name = 'Unrelated display name';
    table.schema = 'elsewhere';
    table.approxRows = 999;
    table.indexed = [];
    table.comment = 'Description';
    table.deletable = true;
    table.insertable = false;
    table.columns.reverse();
    for (const column of table.columns) {
      column.allowed = ['new'];
      column.flag = true;
      column.writable = false;
      column.comment = 'Changed';
    }
  }
  assert.doesNotThrow(() => assertScopeCatalog(expected, actual));
  assert.doesNotThrow(() => assertScopeCatalog(captureScopeCatalog(expected), captureScopeCatalog(actual)));
});

const drifts: Array<[string, (actual: DatabaseSchema) => void]> = [
  [
    'dialect',
    (actual) => {
      actual.dialect = 'postgres';
    },
  ],
  [
    'table identity',
    (actual) => {
      actual.tables[1].id = 'renamed';
      for (const fk of actual.foreignKeys) fk.from.table = 'renamed';
    },
  ],
  [
    'table removed',
    (actual) => {
      actual.tables.splice(1, 1);
      actual.foreignKeys = [];
    },
  ],
  [
    'table added',
    (actual) => {
      actual.tables.push({ id: 'new', name: 'New', schema: '', isView: false, columns: [column('id')] });
    },
  ],
  [
    'view status',
    (actual) => {
      actual.tables[1].isView = true;
    },
  ],
  [
    'column name',
    (actual) => {
      actual.tables[1].columns[0].name = 'renamed_id';
    },
  ],
  [
    'column added',
    (actual) => {
      actual.tables[1].columns.push(column('private'));
    },
  ],
  [
    'column removed',
    (actual) => {
      actual.tables[1].columns.shift();
    },
  ],
  [
    'column type',
    (actual) => {
      tag(actual).type = 'text';
    },
  ],
  [
    'column nullability',
    (actual) => {
      tag(actual).nullable = false;
    },
  ],
  [
    'primary key',
    (actual) => {
      tag(actual).primaryKey = true;
    },
  ],
  [
    'default changed',
    (actual) => {
      tag(actual).default = "'new'";
    },
  ],
  [
    'default missing',
    (actual) => {
      delete tag(actual).default;
    },
  ],
  [
    'identity changed',
    (actual) => {
      actual.tables[1].columns[0].identity = 'always';
    },
  ],
  [
    'identity missing',
    (actual) => {
      delete actual.tables[1].columns[0].identity;
    },
  ],
  [
    'column reference changed',
    (actual) => {
      tag(actual).references!.column = 'left';
    },
  ],
  [
    'column reference missing',
    (actual) => {
      delete tag(actual).references;
    },
  ],
  [
    'FK name',
    (actual) => {
      actual.foreignKeys[0].name = 'renamed';
    },
  ],
  [
    'FK removed',
    (actual) => {
      actual.foreignKeys.pop();
    },
  ],
  [
    'FK source',
    (actual) => {
      actual.foreignKeys[1].from = { table: 'parent', columns: ['code'] };
    },
  ],
  [
    'FK destination',
    (actual) => {
      actual.foreignKeys[1].to = { table: 'child', columns: ['tag'] };
    },
  ],
  [
    'FK delete action',
    (actual) => {
      actual.foreignKeys[0].onDelete = 'cascade';
    },
  ],
  [
    'FK delete action missing',
    (actual) => {
      delete actual.foreignKeys[0].onDelete;
    },
  ],
];
for (const [name, change] of drifts)
  test(`comparison refuses ${name} drift with a safe message`, () => {
    const expected = schema();
    const actual = schema();
    change(actual);
    assert.throws(
      () => assertScopeCatalog(expected, actual),
      (error) => error instanceof Refusal && !error.message.includes('Private label') && /catalog/.test(error.message),
    );
  });

test('composite FK component order is preserved and never sorted to hide a change', () => {
  const expected = schema();
  expected.foreignKeys[0].from.columns.reverse();
  expected.foreignKeys[0].to.columns.reverse();
  const pair = captureScopeCatalog(expected).foreignKeys.find((fk) => fk.name === 'pair')!;
  assert.deepEqual(pair.from.columns, ['parent_right', 'parent_left']);
  assert.deepEqual(pair.to.columns, ['right', 'left']);
  assert.throws(() => assertScopeCatalog(expected, schema()), Refusal);
  const crossed = schema();
  crossed.foreignKeys[0].to.columns.reverse();
  assert.throws(() => assertScopeCatalog(schema(), crossed), Refusal);
});

test('undefined optional evidence matches absence, but empty defaults remain meaningful', () => {
  const expected = schema();
  const actual = schema();
  actual.tables[0].columns[0].default = undefined;
  actual.tables[0].columns[0].references = undefined;
  assert.doesNotThrow(() => assertScopeCatalog(expected, actual));
  actual.tables[0].columns[0].default = '';
  assert.throws(() => assertScopeCatalog(expected, actual), Refusal);
});

test('duplicate table, column and table-local FK identities refuse', () => {
  const tables = schema();
  tables.tables.push(structuredClone(tables.tables[0]));
  rejects(tables);
  const columns = schema();
  columns.tables[0].columns.push(structuredClone(columns.tables[0].columns[0]));
  rejects(columns);
  const fks = schema();
  fks.foreignKeys.push(structuredClone(fks.foreignKeys[0]));
  rejects(fks);
  const local = schema();
  local.foreignKeys.push({
    name: 'pair',
    from: { table: 'parent', columns: ['left', 'right'] },
    to: { table: 'parent', columns: ['left', 'right'] },
  });
  assert.doesNotThrow(() => captureScopeCatalog(local));
});

test('missing or malformed authoritative metadata never becomes empty evidence', () => {
  for (const input of [null, undefined, {}, [], { ...schema(), tables: undefined }, { ...schema(), foreignKeys: undefined }])
    rejects(input);
  const corruptions: Array<(input: any) => void> = [
    (input) => {
      input.tables[0].id = '';
    },
    (input) => {
      delete input.tables[0].isView;
    },
    (input) => {
      input.tables[0].columns = [];
    },
    (input) => {
      input.tables[0].columns[0].nullable = 1;
    },
    (input) => {
      delete input.tables[0].columns[0].type;
    },
    (input) => {
      delete input.tables[0].columns[0].primaryKey;
    },
    (input) => {
      input.tables[0].columns[0].default = null;
    },
    (input) => {
      input.tables[0].columns[0].identity = true;
    },
    (input) => {
      input.foreignKeys[0].onDelete = 'CASCADE';
    },
    (input) => {
      input.foreignKeys[0].from.columns = [];
    },
    (input) => {
      input.foreignKeys[0].to.columns.pop();
    },
    (input) => {
      input.foreignKeys[0].to.columns = ['left', 'left'];
    },
    (input) => {
      input.foreignKeys[0].from.columns = ['parent_left', 'parent_left'];
    },
    (input) => {
      input.foreignKeys[0].from.columns = ['missing', 'parent_right'];
    },
    (input) => {
      input.foreignKeys[0].to.table = 'missing';
    },
    (input) => {
      input.tables[0].columns[0].references = {};
    },
    (input) => {
      input.tables[0].columns[0].references = { table: 'parent', column: 'missing' };
    },
    (input) => {
      input.tables[0].columns[0].references = { table: 'missing', column: 'left' };
    },
    (input) => {
      input.tables[0].unexpected = true;
    },
    (input) => {
      input.tables[0].columns[0].flag = false;
    },
  ];
  for (const corrupt of corruptions) {
    const input = schema();
    corrupt(input);
    rejects(input);
  }
  assert.throws(() => assertScopeCatalog(undefined as unknown as DatabaseSchema, schema()), Refusal);
});

test('implicit cached rowid references refuse instead of guessing a primary-key target', () => {
  const input = schema();
  input.foreignKeys[0].to.columns[0] = 'rowid';
  rejects(input);
  const reference = schema();
  tag(reference).references!.column = 'rowid';
  rejects(reference);
});

test('structured evidence rejects accessors, prototypes, symbols, holes and cycles without invoking getters', () => {
  let reads = 0;
  for (const key of ['tables', 'label']) {
    const input = schema();
    Object.defineProperty(input, key, {
      enumerable: true,
      get: () => {
        reads++;
        return [];
      },
    });
    rejects(input);
  }
  const inherited = Object.assign(Object.create({ private: true }), schema());
  rejects(inherited);
  const symbol = schema();
  Object.defineProperty(symbol, Symbol('secret'), { enumerable: true, value: 1 });
  rejects(symbol);
  const hidden = schema();
  Object.defineProperty(hidden, 'label', { enumerable: false, value: 'hidden' });
  rejects(hidden);
  const holes = schema();
  delete holes.tables[0];
  rejects(holes);
  const extra = schema();
  Object.assign(extra.tables, { extra: true });
  rejects(extra);
  for (const value of [() => {}, new Date(), new Map(), 1n, Infinity, Symbol('private')]) {
    const input = schema();
    (input as any).label = value;
    rejects(input);
  }
  const cycle = schema();
  (cycle as any).label = cycle;
  rejects(cycle);
  assert.equal(reads, 0);
  const plain = Object.assign(Object.create(null), schema());
  assert.doesNotThrow(() => captureScopeCatalog(plain));
});

test('mapping rewrites exact identities and relationships, preserves pair order and freezes detached output', () => {
  const input = schema();
  const before = structuredClone(input);
  const ids = new Map([
    ['parent', 'archive.people'],
    ['child', 'archive.tickets'],
  ]);
  const mapped = mapScopeCatalog(input, ids);
  frozen(mapped);
  assert.deepEqual(
    mapped.tables.map((table) => table.id),
    ['archive.people', 'archive.tickets'],
  );
  const child = mapped.tables[1];
  assert.deepEqual(child.columns.find((column) => column.name === 'parent_left')!.references, { table: 'archive.people', column: 'left' });
  const pair = mapped.foreignKeys.find((fk) => fk.name === 'pair')!;
  assert.deepEqual(pair.from, { table: 'archive.tickets', columns: ['parent_left', 'parent_right'] });
  assert.deepEqual(pair.to, { table: 'archive.people', columns: ['left', 'right'] });
  assert.equal(child.name, 'Child label');
  assert.equal(child.schema, 'main');
  assert.deepEqual(input, before);
  ids.set('child', 'changed');
  assert.equal(mapped.tables[1].id, 'archive.tickets');
});

test('mapping ignores unknown unrelated graphs but refuses either direction of a crossing FK or column reference', () => {
  const input = schema();
  input.tables.push({
    id: 'unrelated',
    name: 'Unrelated',
    schema: '',
    isView: false,
    columns: [column('id', { references: { table: 'unrelated', column: 'id' } })],
  });
  input.foreignKeys.push({ name: 'self', from: { table: 'unrelated', columns: ['id'] }, to: { table: 'unrelated', columns: ['id'] } });
  const ids = new Map([
    ['parent', 'people'],
    ['child', 'tickets'],
  ]);
  assert.equal(mapScopeCatalog(input, ids).tables.length, 2);
  assert.equal(mapScopeCatalog(input, ids).foreignKeys.length, 2);
  assert.deepEqual(mapScopeCatalog(input, new Map()).tables, []);
  for (const table of ['child', 'parent']) assert.throws(() => mapScopeCatalog(input, new Map([[table, table]])), Refusal);
  for (const reverse of [false, true]) {
    const refsOnly = structuredClone(input);
    refsOnly.foreignKeys = [];
    if (reverse) refsOnly.tables[2].columns[0].references = { table: 'child', column: 'id' };
    else refsOnly.tables[1].columns[0].references = { table: 'unrelated', column: 'id' };
    assert.throws(() => mapScopeCatalog(refsOnly, ids), Refusal);
  }
});

test('mapping refuses missing sources, duplicate destinations, malformed IDs and non-map evidence', () => {
  for (const ids of [
    new Map([['missing', 'logical']]),
    new Map([
      ['parent', 'same'],
      ['child', 'same'],
    ]),
    new Map([['parent', '']]),
    new Map([['PARENT', 'parent']]),
    {} as ReadonlyMap<string, string>,
    new Map([['parent', 1]]) as unknown as ReadonlyMap<string, string>,
  ]) {
    assert.throws(() => mapScopeCatalog(schema(), ids), Refusal);
  }
});

/* Skill run: a SQLite TEXT column the App declares a date (`types: { created_at: 'datetime' }`, as choices.md
   recommends) reads `TEXT as datetime` in the App's catalog, and the database still says TEXT. Every row-policy App
   with a write path refused to start: "The scoped catalog could not be verified". The declaration is the App's word,
   as a declared edge is, and never the database's; any other difference is still refused, and startup names it. */
test("a declared date is the App's word, not the database's: the scoped catalog still verifies", () => {
  const text: DatabaseSchema = {
    dialect: 'sqlite',
    label: '',
    readAt: '',
    foreignKeys: [],
    tables: [
      {
        id: 'job',
        name: 'job',
        schema: 'main',
        isView: false,
        columns: [column('id', { primaryKey: true }), column('created_at', { type: 'TEXT' }), column('due_on', { type: 'TEXT' })],
      },
    ],
  };
  const declared = withDeclaredDates(text, [
    { table: 'job', column: 'created_at', as: 'datetime' },
    { table: 'job', column: 'due_on', as: 'date' },
  ]);
  assert.equal(declared.tables[0].columns[1].type, 'TEXT as datetime');
  assert.doesNotThrow(() => assertScopeCatalog(declared, text));
  assert.equal(scopeCatalogDifference(declared, text), undefined);
  const retyped: DatabaseSchema = {
    ...text,
    tables: [
      {
        ...text.tables[0],
        columns: [column('id', { primaryKey: true }), column('created_at', { type: 'INTEGER' }), column('due_on', { type: 'TEXT' })],
      },
    ],
  };
  assert.throws(() => assertScopeCatalog(declared, retyped), Refusal);
  assert.equal(
    scopeCatalogDifference(declared, retyped),
    `"job.created_at" has type "TEXT" in the App's catalog and "INTEGER" in the database's`,
  );
});
