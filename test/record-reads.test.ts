/**
 * What a record page reads when it opens (shared/recordReads.ts): the one rule
 * the server composes a page by and the sections build their requests by.
 * A closed tab reads nothing until it is opened; the record's row is read
 * once for every section that reads it; each other read is built as its
 * section builds it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DatabaseSchema, TableMeta } from '../packages/engine/src/shared/schema.js';
import {
  definedThrough,
  drawnSections,
  fieldsColumns,
  recordPageReads,
  type ReadPlan,
  type ReadSection,
} from '../packages/engine/src/shared/recordReads.js';

const column = (name: string, extra: Record<string, unknown> = {}) => ({ name, type: 'TEXT', nullable: true, primaryKey: false, ...extra });
const account: TableMeta = {
  id: 'account',
  name: 'account',
  schema: '',
  isView: false,
  columns: [column('id', { type: 'INTEGER', primaryKey: true, nullable: false }), column('name'), column('status'), column('tier')],
};
const deal: TableMeta = {
  id: 'deal',
  name: 'deal',
  schema: '',
  isView: false,
  columns: [
    column('id', { type: 'INTEGER', primaryKey: true, nullable: false }),
    column('title'),
    column('account_id', { references: { table: 'account', column: 'id' } }),
  ],
};
const note: TableMeta = {
  id: 'note',
  name: 'note',
  schema: '',
  isView: false,
  columns: [
    column('id', { type: 'INTEGER', primaryKey: true, nullable: false }),
    column('body'),
    column('account_id', { references: { table: 'account', column: 'id' } }),
  ],
};
const schema: DatabaseSchema = {
  label: 'fixture',
  dialect: 'sqlite',
  readAt: '',
  tables: [account, deal, note],
  foreignKeys: [
    { name: 'deal.account_id', from: { table: 'deal', columns: ['account_id'] }, to: { table: 'account', columns: ['id'] } },
    { name: 'note.account_id', from: { table: 'note', columns: ['account_id'] }, to: { table: 'account', columns: ['id'] } },
  ],
} as unknown as DatabaseSchema;
const names = { schema, app: true, recordLabel: () => undefined };
const view = (base: string, columns: string[]) => ({
  id: `page:account:${base}`,
  name: base,
  base,
  columns: columns.map((path) => ({ path })),
  filter: { groups: [[{ path: 'account_id', op: '=' as const, value: 1 }]] },
  limit: 50,
});

test('headline checked links fetch their source bindings without adding displayed facts', () => {
  const section: ReadSection = {
    kind: 'fields',
    presentation: 'headline',
    paths: ['name'],
    actions: [
      {
        to: {
          app: 'target',
          kind: 'record',
          resource: 'account',
          key: { id: { column: 'tier' } },
          tenant: { kind: 'tenant', id: { column: 'status' } },
        },
      },
    ],
  };
  const { fetched } = fieldsColumns(names, account, section);
  assert.ok(fetched.includes('tier'));
  assert.ok(fetched.includes('status'));
  assert.deepEqual(section.paths, ['name']);
});

test('a row-defined column read through a reference is still its fields, and its per is read beside it', () => {
  /* A fulfillment task showing its request's answers got the JSON, keys and
     all: only the record's own page knew the column was row-defined. */
  const defined = (id: string) => (id === 'account' ? { status: { from: 'attribute', per: 'tier' } } : undefined);
  const through = definedThrough(schema, 'deal', 'account_id.status', defined);
  assert.equal(through?.table.id, 'account');
  assert.equal(through?.column, 'status');
  assert.equal(through?.prefix, 'account_id');
  assert.equal(definedThrough(schema, 'deal', 'account_id.name', defined), undefined);
  assert.equal(definedThrough(schema, 'account', 'status', defined)?.prefix, '');
  const read = { ...names, defined };
  assert.ok(fieldsColumns(read, deal, { kind: 'fields', paths: ['account_id.status'] }).fetched.includes('account_id.tier'));
  assert.ok(fieldsColumns(read, account, { kind: 'fields', paths: ['status'] }).fetched.includes('tier'));
});

test("a strip of named tabs draws the one asked for and every panel holding the record's fields; the rest reads nothing", () => {
  const sections: ReadSection[] = [
    { kind: 'fields', presentation: 'header', paths: ['status'] },
    { kind: 'fields', paths: ['name'], tab: 'Overview' },
    { kind: 'list', from: 'deal', tab: 'Deals' },
    { kind: 'list', from: 'note', tab: 'Notes' },
    { kind: 'metric', from: 'deal', hidden: true },
  ];
  assert.deepEqual([...drawnSections(schema, { sections }, undefined, true)].sort(), [0, 1]);
  assert.deepEqual([...drawnSections(schema, { sections }, 'tab:Notes', true)].sort(), [0, 1, 3]);
});

test('a run of lists made into tabs draws the one the address names, or the first', () => {
  const sections: ReadSection[] = [
    { kind: 'fields', paths: ['name'] },
    { kind: 'list', from: 'deal' },
    { kind: 'list', from: 'note' },
  ];
  // An App's page makes a strip only where it says so.
  assert.deepEqual([...drawnSections(schema, { sections }, undefined, true)].sort(), [0, 1, 2]);
  assert.deepEqual([...drawnSections(schema, { sections, listTabs: true }, undefined, true)].sort(), [0, 1]);
  assert.deepEqual([...drawnSections(schema, { sections, listTabs: true }, 'note', true)].sort(), [0, 2]);
  // A list that hides or collapses when empty is a tab like the others: inside a strip an empty list is neither.
  sections.push({ kind: 'list', from: 'account', emptyMode: 'hide' });
  assert.deepEqual([...drawnSections(schema, { sections, listTabs: true }, undefined, true)].sort(), [0, 1]);
  assert.deepEqual([...drawnSections(schema, { sections, listTabs: true }, 'account', true)].sort(), [0, 3]);
});

test("the record's row is read once for every section that reads it, and each other read as its section builds it", () => {
  const sections: ReadSection[] = [
    { kind: 'fields', presentation: 'header', status: 'status', paths: ['tier'] },
    { kind: 'fields', paths: ['name'] },
    { kind: 'metric', from: 'deal' },
    { kind: 'list', from: 'deal', when: 'status = active' },
    { kind: 'list', from: 'note', limit: 5 },
    { kind: 'history', limit: 8 },
  ];
  const plans: ReadPlan[] = [
    { index: 0 },
    { index: 1 },
    { index: 2, counts: true, view: view('deal', ['id']) },
    {
      index: 3,
      view: view('deal', ['title']),
      totals: { base: 'deal', by: [], measures: [{ fn: 'sum', path: 'amount', alias: 'total_0' }], limit: 1 },
    },
    { index: 4, view: view('note', ['body']) },
    { index: 5 },
  ];
  const { row, parts, reads } = recordPageReads(names, { id: 'account', sections }, account, plans, { id: 1 }, { rows: 10, history: true });
  assert.deepEqual(row.sort(), ['id', 'name', 'status', 'tier']);
  assert.deepEqual(
    parts.map((part) => part.part),
    ['root', 'header', 'fields'],
  );
  const said = reads.map((read) => [
    read.path,
    read.body.view ? (read.body.view as { base: string; limit?: number }).base : (read.body.q ?? read.body.table ?? 'def'),
  ]);
  assert.deepEqual(said, [
    ['/api/breakdown', 'def'],
    ['/api/run', 'account id = 1 and status = active'],
    ['/api/view/run', 'deal'],
    // The footer's sums: one row measured over every related row.
    ['/api/breakdown', 'def'],
    ['/api/view/run', 'note'],
    ['/api/record-history', 'account'],
  ]);
  // A list reads a page at the reader's size, unless it names its own; the names and keys a row needs come with it.
  const lists = reads
    .filter((read) => read.path === '/api/view/run')
    .map((read) => read.body.view as { limit: number; columns: Array<{ path: string }> });
  assert.equal(lists[0].limit, 10);
  assert.equal(lists[1].limit, 50);
  assert.ok(
    lists[0].columns.some((item) => item.path === 'id'),
    'a row carries its key',
  );
  // A reader who may not ask for history (a signed-out visitor) is not asked for it.
  assert.ok(
    !recordPageReads(names, { id: 'account', sections }, account, plans, { id: 1 }, { rows: 10, history: false }).reads.some(
      (read) => read.path === '/api/record-history',
    ),
  );
});
