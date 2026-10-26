import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePagesConfig, sectionConfig, validatePage, type PageDef, type PageList } from '../packages/engine/src/shared/page.js';
import { planPageSections } from '../packages/engine/src/shared/pagePlans.js';
import type { DatabaseSchema, TableMeta } from '../packages/engine/src/shared/schema.js';

/**
 * A related list's options past its rows: `empty: 'hide'` leaves it out
 * while it has none, `totals` sums a column over every row that points at the
 * record in one ruled footer, and `{ same, near }` lists the rows that share the
 * record's own values rather than point at it.
 */
const pageOf = (sections: unknown[]) =>
  parsePagesConfig({ pages: [{ id: 'balance', label: 'Balance', base: 'balance', sections }] }, 'pages')[0];
const requests = { kind: 'list', from: 'request', whose: 'person_id' };

test("empty: 'hide' and 'collapse' are kept and spelled back; false is refused with what replaces it", () => {
  const page = pageOf([
    { kind: 'fields', show: ['hours'] },
    { ...requests, empty: 'hide' },
    { ...requests, title: 'Later', empty: 'collapse' },
  ]);
  const [hidden, collapsed] = [page.sections[1] as PageList, page.sections[2] as PageList];
  assert.equal(hidden.emptyMode, 'hide');
  assert.equal(collapsed.emptyMode, 'collapse');
  assert.equal(hidden.empty, undefined);
  assert.equal((sectionConfig(hidden) as { empty?: unknown }).empty, 'hide');
  assert.deepEqual(pageOf(page.sections.map(sectionConfig)).sections, page.sections);
  assert.throws(
    () => pageOf([{ ...requests, empty: true }]),
    /has "empty: true"\. "empty" is guidance \(\{ title, description, action \}\), 'hide'/,
  );
  assert.throws(() => pageOf([{ ...requests, empty: false }]), /has "empty: false", which is now "empty: 'hide'"/);
  // A list that is all its tab holds is no longer refused: the page keeps one list in the tab where it draws (PageEmptyRun.tsx).
  assert.doesNotThrow(() =>
    pageOf([
      { kind: 'fields', show: ['hours'], tab: 'Balance' },
      { ...requests, title: 'Requests', empty: 'hide', tab: 'Requests' },
    ]),
  );
});

test("a page's empty is the default of every related list that says nothing, and a list's own wins", () => {
  const page = parsePagesConfig(
    {
      pages: [
        {
          id: 'balance',
          label: 'Balance',
          base: 'balance',
          empty: 'collapse',
          sections: [
            { kind: 'fields', show: ['hours'] },
            requests,
            { ...requests, title: 'Own', empty: 'hide' },
            { ...requests, title: 'Words', empty: { title: 'None yet' } },
            { kind: 'current', from: 'request', whose: 'person_id' },
          ],
        },
      ],
    },
    'pages',
  )[0];
  const [plain, own, words, current] = page.sections.slice(1) as PageList[];
  assert.equal(plain.emptyMode, 'collapse');
  assert.equal(own.emptyMode, 'hide');
  assert.equal(words.emptyMode, undefined);
  assert.deepEqual(words.empty, { title: 'None yet' });
  assert.equal(current.emptyMode, undefined);
  assert.equal(page.empty, 'collapse');
  assert.throws(
    () => parsePagesConfig({ pages: [{ id: 'b', label: 'B', base: 'balance', empty: 'gone', sections: [requests] }] }, 'pages'),
    /has "empty": "gone"\. A page's is 'hide'/,
  );
});

test('totals are read, spelled back, and refused where their sums cannot hold', () => {
  const page = pageOf([{ ...requests, totals: ['hours'], show: ['starts', 'hours'] }]);
  assert.deepEqual((page.sections[0] as PageList).totals, ['hours']);
  assert.deepEqual(pageOf(page.sections.map(sectionConfig)).sections, page.sections);
  assert.throws(
    () => pageOf([{ ...requests, totals: ['hours'], query: 'status = approved' }]),
    /has "totals" and "query"\. Totals sum every row that points at the record and cannot be narrowed/,
  );
  assert.throws(
    () => pageOf([{ kind: 'list', from: 'request', same: ['policy_id'], near: { hours: 0.2 }, totals: ['hours'] }]),
    /has "totals" and "near"\. Totals sum every row that points at the record and cannot be narrowed/,
  );
  assert.throws(() => pageOf([{ ...requests, totals: ['hours'], presentation: 'gallery' }]), /a footer of totals belongs to a table/);
  assert.throws(() => pageOf([{ ...requests, totals: ['hours', 'hours'] }]), /name one column twice/);
  assert.throws(() => pageOf([{ ...requests, totals: [] }]), /"totals" that are not a list of the rows' numeric columns/);
});

test("a list matched on the record's own values: { same, near } is read, spelled back, and refused beside whose and create", () => {
  const page = pageOf([
    { kind: 'list', from: 'balance', same: ['policy_id'], near: { hours: 0.25 }, query: 'hours > 0' },
    { kind: 'list', from: 'balance', same: ['policy_id'] },
  ]);
  const [near, plain] = page.sections as PageList[];
  assert.deepEqual(near.similar, { same: ['policy_id'], near: { hours: 0.25 } });
  assert.deepEqual(plain.similar, { same: ['policy_id'] });
  assert.equal(near.path, '');
  assert.equal((near as { same?: unknown }).same, undefined, 'the compiled list says the match as "similar"');
  assert.deepEqual(pageOf(page.sections.map(sectionConfig)).sections, page.sections);
  const refused = (extra: Record<string, unknown>, said: RegExp) =>
    assert.throws(() => pageOf([{ kind: 'list', from: 'balance', same: ['policy_id'], ...extra }]), said);
  refused({ whose: 'person_id' }, /has "whose" beside "same"/);
  refused({ create: 'Add' }, /has "create" beside "same"/);
  // What no match means is still the author's to say: guidance, or false to leave the list out.
  const said = pageOf([{ kind: 'list', from: 'balance', same: ['policy_id'], empty: { title: 'None yet' } }]).sections[0] as PageList;
  assert.deepEqual(said.empty, { title: 'None yet' });
  assert.equal((pageOf([{ kind: 'list', from: 'balance', same: ['policy_id'], empty: 'hide' }]).sections[0] as PageList).emptyMode, 'hide');
  refused({ near: { hours: 0 } }, /"near" on "hours" must be a fraction above 0 and at most 1/);
  refused({ near: { policy_id: 0.2 } }, /"policy_id" is in both "same" and "near"/);
  refused({ same: [] }, /"same" must be one to 4 columns/);
  refused({ same: ['a', 'a'] }, /"same" names a column twice/);
  assert.throws(() => pageOf([{ kind: 'list', from: 'balance', whose: 'person_id', near: { hours: 0.2 } }]), /has "near" without "same"/);
  // The spellings this replaces are refused by name.
  for (const [extra, said] of [
    [{ about: 'person_id' }, /has "about", which a related list no longer takes/],
    [{ similar: { same: ['policy_id'] } }, /has "similar", which is now the list's own match/],
    [{ editable: true }, /has "editable", which is gone/],
    [{ order: 'position' }, /has "order", which is gone/],
  ] as const) {
    assert.throws(() => pageOf([{ ...requests, ...extra }]), said);
  }
});

const table = (id: string, columns: Array<[string, string]>): TableMeta => ({
  id,
  name: id,
  schema: '',
  isView: false,
  columns: columns.map(([name, type]) => ({ name, type, primaryKey: name === 'id', nullable: name !== 'id' })),
});
const schema: DatabaseSchema = {
  dialect: 'sqlite',
  label: 'balances',
  readAt: '',
  tables: [
    table('person', [
      ['id', 'INTEGER'],
      ['team_id', 'INTEGER'],
      ['name', 'TEXT'],
    ]),
    table('team', [['id', 'INTEGER']]),
    table('balance', [
      ['id', 'INTEGER'],
      ['person_id', 'INTEGER'],
      ['policy_id', 'INTEGER'],
      ['hours', 'NUMERIC'],
    ]),
    table('request', [
      ['id', 'INTEGER'],
      ['person_id', 'INTEGER'],
      ['policy_id', 'INTEGER'],
      ['starts', 'DATE'],
      ['hours', 'NUMERIC'],
      ['status', 'TEXT'],
    ]),
  ],
  foreignKeys: [
    { name: 'balance_person', from: { table: 'balance', columns: ['person_id'] }, to: { table: 'person', columns: ['id'] } },
    { name: 'request_person', from: { table: 'request', columns: ['person_id'] }, to: { table: 'person', columns: ['id'] } },
    { name: 'person_team', from: { table: 'person', columns: ['team_id'] }, to: { table: 'team', columns: ['id'] } },
  ],
};
const at = new Date(2026, 8, 22);

test("a matched list has no reference to walk: it plans from the record's own values", () => {
  const page: PageDef = {
    id: 'balance',
    name: 'Balance',
    base: 'balance',
    sections: [{ kind: 'list', from: 'balance', path: '', similar: { same: ['policy_id'] }, columns: ['hours'] }],
  };
  assert.equal(validatePage(schema, page).error, undefined);
  const wrong: PageDef = { ...page, sections: [{ ...(page.sections[0] as PageList), similar: { same: ['status'] } }] };
  assert.notEqual(validatePage(schema, wrong).error, undefined);
});

test('totals are one measured row over every related row, through any reference, and sum rollups and computed numbers', () => {
  const person: PageDef = {
    id: 'person',
    name: 'Person',
    base: 'person',
    sections: [{ kind: 'list', from: 'request', path: 'person_id', totals: ['hours'], columns: ['starts', 'hours'], limit: 5 }],
  };
  assert.equal(validatePage(schema, person).error, undefined);
  const [plan] = planPageSections(schema, person, { id: 4 }, {}, at);
  assert.ok(plan.kind === 'list');
  assert.equal(plan.view?.limit, 5, 'the rows stay a page');
  assert.deepEqual(plan.totals, {
    base: 'request',
    by: [],
    measures: [{ fn: 'sum', path: 'hours', alias: 'total_0' }],
    filter: { groups: [[{ path: 'person_id', op: '=', value: 4 }]] },
    limit: 1,
  });
  const text: PageDef = { ...person, sections: [{ ...(person.sections[0] as PageList), totals: ['status'] }] };
  assert.match(validatePage(schema, text).error ?? '', /"totals" sums "status", so it must be a number; it is TEXT/);
  const unknown: PageDef = { ...person, sections: [{ ...(person.sections[0] as PageList), totals: ['nope'] }] };
  assert.match(
    validatePage(schema, unknown).error ?? '',
    /"totals" names "nope", which is not a column, rollup or computed column on request/,
  );
  // Two references away is the same filter the list reads, through the person.
  const far: PageDef = {
    id: 'team',
    name: 'Team',
    base: 'team',
    sections: [{ kind: 'list', from: 'request', path: 'person_id.team_id', totals: ['hours'] }],
  };
  assert.equal(validatePage(schema, far).error, undefined);
  const [farPlan] = planPageSections(schema, far, { id: 2 }, {}, at);
  assert.ok(farPlan.kind === 'list');
  assert.deepEqual(farPlan.totals?.filter, { groups: [[{ path: 'person_id.team_id', op: '=', value: 2 }]] });
  // A rollup of each row, and a computed number, sum as a column does: the measure names them.
  const summed: DatabaseSchema = {
    ...schema,
    tables: schema.tables.map((t) =>
      t.id === 'request'
        ? {
            ...t,
            rollups: { approvals: { fn: 'count' as const, via: 'approval.request_id', type: 'INTEGER' } },
            computed: { days: { type: 'number' as const, expr: { kind: 'column' as const, path: 'hours' }, reads: ['hours'] } },
          }
        : t,
    ),
  } as DatabaseSchema;
  const rolled: PageDef = { ...person, sections: [{ ...(person.sections[0] as PageList), totals: ['hours', 'approvals', 'days'] }] };
  assert.equal(validatePage(summed, rolled).error, undefined);
  const [rolledPlan] = planPageSections(summed, rolled, { id: 4 }, {}, at);
  assert.ok(rolledPlan.kind === 'list');
  assert.deepEqual(
    rolledPlan.totals?.measures.map((m) => m.path),
    ['hours', 'approvals', 'days'],
  );
});

test("rowActions is kept, spelled back, and refused beside a presentation, whose rows are not a table's", () => {
  const page = pageOf([{ ...requests, rowActions: true }]);
  const list = page.sections[0] as PageList;
  assert.equal(list.rowActions, true);
  assert.equal((sectionConfig(list) as { rowActions?: unknown }).rowActions, true);
  assert.deepEqual(pageOf(page.sections.map(sectionConfig)).sections, page.sections);
  assert.equal((pageOf([{ ...requests, rowActions: false }]).sections[0] as PageList).rowActions, undefined);
  assert.throws(() => pageOf([{ ...requests, rowActions: 'yes' }]), /"rowActions" must be true/);
  assert.throws(() => pageOf([{ ...requests, rowActions: true, presentation: 'gallery' }]), /has "rowActions" and a presentation/);
});

test('actions and create: false are kept, spelled back, and refused where the list would hide them', () => {
  const page = pageOf([
    { ...requests, actions: ['addRequest', ' approveAll '] },
    { ...requests, create: false },
  ]);
  const [placed, none] = page.sections as PageList[];
  assert.deepEqual(placed!.listActions, ['addRequest', 'approveAll']);
  assert.equal(none!.noCreate, true);
  assert.equal(none!.create, undefined);
  assert.deepEqual((sectionConfig(placed!) as { actions?: unknown }).actions, ['addRequest', 'approveAll']);
  assert.equal((sectionConfig(none!) as { create?: unknown }).create, false);
  assert.deepEqual(pageOf(page.sections.map(sectionConfig)).sections, page.sections);
  assert.throws(() => pageOf([{ ...requests, actions: [] }]), /"actions" is one to four of the record's own action ids/);
  assert.throws(() => pageOf([{ ...requests, actions: ['a', 'a'] }]), /naming one action twice/);
  // The verbs that add to a list are a door the page never hides (PageEmptyRun.tsx), so they may stand beside 'hide'.
  assert.equal((pageOf([{ ...requests, actions: ['a'], empty: 'hide' }]).sections[0] as PageList).emptyMode, 'hide');
  // current() draws one card, with no head of verbs.
  assert.throws(() => pageOf([{ kind: 'current', from: 'request', whose: 'person_id', actions: ['a'] }]), /has no "actions"/);
});
