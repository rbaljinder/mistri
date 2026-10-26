import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePagesConfig, sectionConfig, validatePage, type PageDef, type PageList } from '../packages/engine/src/shared/page.js';
import { planPageSections } from '../packages/engine/src/shared/pagePlans.js';
import {
  groupsBody,
  recordPageReads,
  type ReadPlan,
  type ReadSection,
  type RecordReadNames,
} from '../packages/engine/src/shared/recordReads.js';
import type { DatabaseSchema, TableMeta } from '../packages/engine/src/shared/schema.js';

/**
 * A related list read as groups (`group`): the options past the rows that sort, count and bound the groups, and the
 * refusals for a chain that is not one — the page's own record, a plain column asked for facts, a presentation.
 */
const table = (id: string, columns: Array<[string, string]>): TableMeta => ({
  id,
  name: id,
  schema: '',
  isView: false,
  columns: columns.map(([name, type]) => ({ name, type, primaryKey: name === 'id', nullable: name !== 'id' })),
});
// A lead has estimates, an estimate has options: the options under their estimate, listed from the lead's page.
const schema: DatabaseSchema = {
  dialect: 'sqlite',
  label: 'leasing',
  readAt: '',
  tables: [
    table('lead', [
      ['id', 'INTEGER'],
      ['name', 'TEXT'],
    ]),
    table('estimate', [
      ['id', 'INTEGER'],
      ['lead_id', 'INTEGER'],
      ['title', 'TEXT'],
      ['total', 'NUMERIC'],
      ['created_on', 'DATE'],
    ]),
    table('option', [
      ['id', 'INTEGER'],
      ['estimate_id', 'INTEGER'],
      ['lender', 'TEXT'],
      ['payment', 'NUMERIC'],
      ['status', 'TEXT'],
    ]),
  ],
  foreignKeys: [
    { name: 'estimate_lead', from: { table: 'estimate', columns: ['lead_id'] }, to: { table: 'lead', columns: ['id'] } },
    { name: 'option_estimate', from: { table: 'option', columns: ['estimate_id'] }, to: { table: 'estimate', columns: ['id'] } },
  ],
};
const at = new Date(2026, 8, 22);
const options = {
  kind: 'list',
  title: 'Options',
  from: 'option',
  whose: 'estimate_id.lead_id',
  show: ['lender', 'payment'],
  group: { by: 'estimate_id', show: ['title', 'total'], sort: 'created_on desc', limit: 3 },
  limit: 4,
  totals: ['payment'],
};
const pageOf = (sections: unknown[]) => parsePagesConfig({ pages: [{ id: 'lead', label: 'Lead', base: 'lead', sections }] }, 'pages')[0];

test('group is read, spelled back, and holds the list to a table with the rows to a group', () => {
  const page = pageOf([options]);
  const list = page.sections[0] as PageList;
  assert.deepEqual(list.group, {
    by: 'estimate_id',
    show: ['title', 'total'],
    sort: { column: 'created_on', direction: 'desc' },
    limit: 3,
  });
  assert.equal(list.limit, 4);
  assert.deepEqual((sectionConfig(list) as { group?: unknown }).group, options.group);
  assert.deepEqual(pageOf(page.sections.map(sectionConfig)).sections, page.sections);
  const refused = (extra: Record<string, unknown>, said: RegExp) => assert.throws(() => pageOf([{ ...options, ...extra }]), said);
  refused({ group: 'estimate_id' }, /"group" that is not an object/);
  refused({ group: { show: ['title'] } }, /group has no "by"/);
  refused({ group: { by: 'estimate_id', show: [] } }, /not one to four columns/);
  refused({ group: { by: 'estimate_id', sort: 'created_on desc, title' } }, /more than one column/);
  refused({ group: { by: 'estimate_id', limit: 11 } }, /whole number of groups from 1 to 10/);
  refused({ group: { by: 'estimate_id', depth: 2 } }, /group/);
  refused({ limit: 51 }, /where it is the rows to a group: at most 50/);
  refused({ group: { by: 'estimate_id', sum: [] } }, /not one or two numeric columns/);
  refused({ group: { by: 'estimate_id', sum: ['payment', 'payment'] } }, /names one column twice/);
  refused({ group: { by: 'estimate_id', sum: ['a', 'b', 'c'] } }, /not one or two numeric columns/);
  refused({ group: { by: 'estimate_id', empty: ' ' } }, /"empty" that is not a short name/);
  refused({ presentation: 'gallery', totals: undefined }, /"group" and a gallery presentation/);
  refused({ same: ['status'], whose: undefined, totals: undefined }, /"group" and "same"/);
});

test('a chain that is not one is refused where the page is validated, in the words of the cause', () => {
  const planned = (group: Record<string, unknown>) => validatePage(schema, pageOf([{ ...options, group }]) as PageDef).error ?? '';
  assert.equal(planned({ by: 'estimate_id', show: ['title'], sort: 'total' }), '');
  assert.match(planned({ by: 'nope' }), /"group.by" names "nope"/);
  assert.match(planned({ by: 'estimate_id.lead_id' }), /the record this page is on, so every row would fall in one group/);
  assert.match(
    planned({ by: 'status', show: ['title'] }),
    /"group.show" says facts of the record a group is, and "status" is a plain column/,
  );
  assert.match(planned({ by: 'status', sort: 'status' }), /"group.sort" orders by a column of the record a group is/);
  assert.equal(planned({ by: 'status' }), '');
  assert.match(planned({ by: 'estimate_id', show: ['colour'] }), /"group.show" names "colour", which is not a column of estimate/);
  assert.match(planned({ by: 'estimate_id', sort: 'colour' }), /"group.sort" names "colour", which is not a column of estimate/);
});

test('the groups are one breakdown of the same rows, with the largest of the sort column and each subtotal', () => {
  const page = pageOf([options]) as PageDef;
  assert.equal(validatePage(schema, page).error, undefined);
  const [plan] = planPageSections(schema, page, { id: 7 }, {}, at);
  assert.ok(plan.kind === 'list');
  assert.deepEqual(plan.groups, {
    base: 'option',
    by: [{ path: 'estimate_id' }],
    measures: [
      { fn: 'count', alias: 'group_rows' },
      { fn: 'max', path: 'estimate_id.created_on', alias: 'group_order' },
      { fn: 'sum', path: 'payment', alias: 'total_0' },
    ],
    filter: { groups: [[{ path: 'estimate_id.lead_id', op: '=', value: 7 }]] },
    orderBy: [
      { name: 'estimate_id', direction: 'asc', emptyLast: true },
      { name: 'group_order', direction: 'desc' },
    ],
    limit: 3,
  });
  // The header's facts ride on the rows, read through the reference, so a header costs no read of its own.
  assert.deepEqual(
    plan.view?.columns?.map((c) => c.path),
    ['lender', 'payment', 'estimate_id.title', 'estimate_id.total'],
  );
  // With no order of its own the largest group comes first, and a plain column's groups are its values.
  const largest = pageOf([{ ...options, group: { by: 'status' }, totals: undefined }]) as PageDef;
  const [plain] = planPageSections(schema, largest, { id: 7 }, {}, at);
  assert.ok(plain.kind === 'list');
  assert.deepEqual(plain.groups?.orderBy, [
    { name: 'status', direction: 'asc', emptyLast: true },
    { name: 'group_rows', direction: 'desc' },
  ]);
  assert.equal(plain.groups?.limit, 5);
  assert.equal(plain.view?.columns?.length, 2);
});

test("a grouped list's compose asks its groups and not a flat first page", () => {
  const page = pageOf([options]) as PageDef;
  const [plan] = planPageSections(schema, page, { id: 7 }, {}, at);
  const names: RecordReadNames = { schema, app: false, recordLabel: () => undefined };
  const base = schema.tables[0];
  const reads = recordPageReads(
    names,
    { id: 'lead', sections: page.sections as unknown as ReadSection[] },
    base,
    [{ ...(plan as object), index: 0 }] as ReadPlan[],
    { id: 7 },
    { rows: 5, history: false },
  ).reads;
  const asked = reads.filter(
    (read) => read.path !== '/api/view/run' || (read.body as { view?: { id: string } }).view?.id !== 'page:lead:root',
  );
  const paths = asked.map((read) => read.path);
  assert.ok(paths.includes('/api/breakdown'));
  assert.ok(!reads.some((read) => (read.body as { view?: { base?: string } }).view?.base === 'option'), 'no flat list of the options');
  const groups = reads.find((read) => read.path === '/api/breakdown' && (read.body as { def: { by: unknown[] } }).def.by.length)!;
  assert.deepEqual(groups.body, groupsBody((plan as unknown as { groups: never }).groups, 0));
});

test('a grouped list takes a row menu, names its empty group, and sums a column in each header', () => {
  const page = pageOf([
    { ...options, rowActions: true, totals: undefined, group: { by: 'estimate_id', empty: ' Unquoted ', sum: 'payment' } },
  ]);
  const list = page.sections[0] as PageList;
  assert.equal(list.rowActions, true);
  assert.deepEqual(list.group, { by: 'estimate_id', empty: 'Unquoted', sum: ['payment'] });
  assert.deepEqual((sectionConfig(list) as { group?: unknown }).group, { by: 'estimate_id', empty: 'Unquoted', sum: ['payment'] });
  assert.equal(validatePage(schema, page as PageDef).error, undefined);
  const [plan] = planPageSections(schema, page as PageDef, { id: 7 }, {}, at);
  assert.ok(plan.kind === 'list');
  assert.deepEqual(plan.groups?.measures.at(-1), { fn: 'sum', path: 'payment', alias: 'group_sum_0' });
  // Unlike totals, a sum works beside a query: the breakdown already carries the section's filter.
  const queried = pageOf([{ ...options, totals: undefined, query: "status = 'open'", group: { by: 'estimate_id', sum: ['payment'] } }]);
  assert.equal(validatePage(schema, queried as PageDef).error, undefined);
  const planned = (sum: string[]) =>
    validatePage(schema, pageOf([{ ...options, totals: undefined, group: { by: 'estimate_id', sum } }]) as PageDef).error ?? '';
  assert.match(planned(['nope']), /"group.sum" names "nope", which is not a column/);
  assert.match(planned(['lender']), /"group.sum" sums "lender", so it must be a number/);
});
