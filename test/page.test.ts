/**
 * Pages: the part that can be wrong without anyone noticing.
 *
 * A page is mostly arrangement, and arrangement announces its own mistakes —
 * a section in the wrong place is visible. What is not visible is a section
 * showing the *wrong rows*: a path that lands on a different table than the
 * page's root, a composite key compared on one of its two columns, a filter
 * built from the wrong end of a foreign key. Every one of those renders a
 * perfectly ordinary table of plausible data, and the reader has no way to
 * tell. So that is what these tests are about.
 *
 * The fixture is `customer ← invoice ← invoice_line`, which is the shape the
 * feature exists for: the customer, their invoices, and the lines of those
 * invoices — one, two and three hops from the same root.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PAGE_LIST_LIMIT,
  breakdownPlan,
  chartKeys,
  chartPlan,
  defaultColumns,
  listView,
  metricView,
  resolveOf,
  parsePagesConfig,
  pageConfig,
  sectionConfig,
  relationsTo,
  resolvePath,
  rootFilter,
  sectionQuery,
  suggestPage,
  validatePage,
  type PageDef,
} from '../packages/engine/src/shared/page.js';
import { parseQuery } from '../packages/engine/src/shared/query.js';
import { withComputed } from '../packages/mistri/src/shared/appComputed.js';
import { planPageSections } from '../packages/engine/src/shared/pagePlans.js';
import { pageAbouts } from '../packages/engine/src/shared/pageModel.js';
import { resolvePageEmbeds } from '../packages/mistri/src/shared/appPages.js';
import { compileBreakdown } from '../packages/engine/src/shared/breakdown.js';
import { ANSI_STYLE } from '../packages/engine/src/shared/filter.js';
import type { AppDef } from '../packages/mistri/src/shared/appModel.js';
import { hopName, resolvePath as resolveViewPath } from '../packages/engine/src/shared/view.js';
import type { ColumnMeta, DatabaseSchema, ForeignKey, TableMeta } from '../packages/engine/src/shared/schema.js';

describe('the shared page emitter', () => {
  test('every section and page option survives an authored round trip', () => {
    // The options only a mistri.json page takes (hidden, offsetLeft, names) are not in the App's authored types.
    const definition = {
      label: 'Customer desk',
      base: 'customer',
      connection: 'crm',
      listTabs: false,
      sections: [
        {
          kind: 'fields',
          title: 'Identity',
          show: ['name', 'country_code.label'],
          columns: 2,
          names: false,
          presentation: 'summary',
          width: 'half',
          offsetLeft: 'quarter',
          offsetRight: 'quarter',
          hidden: true,
          when: 'id > 0',
        },
        {
          kind: 'metric',
          title: 'Revenue',
          measure: 'sum total',
          from: 'invoice',
          whose: 'customer_id',
          about: 'country_code',
          query: 'status = paid',
          width: 'third',
          offsetLeft: 'third',
          offsetRight: 'third',
          hidden: true,
          when: 'id > 1',
        },
        {
          kind: 'list',
          title: 'Invoices',
          from: 'invoice',
          whose: 'customer_id',
          show: [],
          sort: 'issued_on desc, id',
          query: 'total > 0',
          limit: 23,
          width: 'half',
          offsetLeft: 'half',
          hidden: true,
          when: 'id > 2',
        },
        {
          kind: 'breakdown',
          title: 'By status',
          from: 'invoice',
          whose: 'customer_id',
          about: 'country_code',
          by: 'status',
          query: 'total > 10',
          limit: 7,
          width: 'third',
          offsetRight: 'two-thirds',
          hidden: true,
          when: 'id > 3',
        },
        {
          kind: 'chart',
          title: 'Billed',
          from: 'invoice',
          whose: 'customer_id',
          by: 'month issued_on',
          measure: 'sum total',
          shape: 'line',
          query: 'status = paid',
          height: 180,
          target: 500,
          width: 'half',
        },
        { kind: 'chart', title: 'Mix', from: 'invoice', whose: 'customer_id', by: 'status', shape: 'donut', limit: 4 },
        {
          kind: 'note',
          title: 'Credit',
          text: 'Call before extending credit.\n\nThe limit is on the record.',
          icon: 'info',
          width: 'half',
        },
        {
          kind: 'timeline',
          title: 'Activity',
          limit: 17,
          width: 'half',
          offsetLeft: 'quarter',
          offsetRight: 'quarter',
          hidden: true,
          when: 'id > 4',
          streams: [
            { from: 'invoice', whose: 'customer_id', at: 'issued_on', show: 'id', detail: 'status', query: 'total > 0' },
            { from: 'task', whose: 'customer_id', at: 'due_on', show: 'subject', detail: 'owner_id.name', query: 'status = open' },
          ],
        },
      ],
    };
    const [compiled] = parsePagesConfig({ pages: [definition] }, 'original');
    const snapshot = structuredClone(compiled);
    const exported = pageConfig({ ...compiled, id: 'saved:customer:123', source: 'saved', error: 'runtime-only' });
    assert.equal((exported as { id?: unknown }).id, undefined);
    assert.equal('source' in exported, false);
    assert.equal('error' in exported, false);
    const [restored] = parsePagesConfig(JSON.parse(JSON.stringify({ pages: [exported] })), 'exported');
    assert.deepEqual(restored, compiled);
    assert.deepEqual(compiled, snapshot);
  });

  test('defaults and empty projections keep their meaning', () => {
    const [compiled] = parsePagesConfig(
      {
        pages: [
          {
            label: 'Defaults',
            base: 'customer',
            listTabs: true,
            sections: [
              { kind: 'fields', show: [], columns: 1, names: false, hidden: false },
              { kind: 'list', from: 'invoice', whose: 'customer_id', show: [] },
            ],
          },
        ],
      },
      'original',
    );
    const exported = pageConfig(compiled);
    assert.equal(exported.listTabs, true);
    assert.deepEqual(parsePagesConfig({ pages: [exported] }, 'exported')[0], compiled);
  });
});

const col = (name: string, type = 'TEXT', extra: Partial<ColumnMeta> = {}): ColumnMeta => ({
  name,
  type,
  nullable: true,
  primaryKey: false,
  ...extra,
});
const key = (name: string, type = 'INTEGER'): ColumnMeta => ({
  name,
  type,
  nullable: false,
  primaryKey: true,
});
const meta = (id: string, columns: ColumnMeta[]): TableMeta => ({
  id,
  name: id,
  schema: 'main',
  columns,
  isView: false,
});

const TABLES: TableMeta[] = [
  meta('customer', [key('id'), col('name'), col('email'), col('country_code'), col('credit_limit', 'REAL')]),
  meta('invoice', [key('id'), col('customer_id', 'INTEGER'), col('total', 'REAL'), col('status'), col('issued_on', 'DATE')]),
  // A composite key, so a section built on it can be caught comparing half of one.
  meta('invoice_line', [key('invoice_id'), key('line_no'), col('sku'), col('quantity', 'INTEGER')]),
  meta('shipment', [key('id'), col('invoice_id', 'INTEGER'), col('line_no', 'INTEGER'), col('carrier')]),
  meta('note', [key('id'), col('body'), col('customer_id', 'INTEGER')]),
  meta('keyless', [col('a'), col('b')]),
];

const FOREIGN_KEYS: ForeignKey[] = [
  { name: 'invoice_customer_fk', from: { table: 'invoice', columns: ['customer_id'] }, to: { table: 'customer', columns: ['id'] } },
  { name: 'line_invoice_fk', from: { table: 'invoice_line', columns: ['invoice_id'] }, to: { table: 'invoice', columns: ['id'] } },
  { name: 'note_customer_fk', from: { table: 'note', columns: ['customer_id'] }, to: { table: 'customer', columns: ['id'] } },
  // Composite: a shipment names an invoice *line*, both columns of its key.
  {
    name: 'shipment_line_fk',
    from: { table: 'shipment', columns: ['invoice_id', 'line_no'] },
    to: { table: 'invoice_line', columns: ['invoice_id', 'line_no'] },
  },
];

const SCHEMA: DatabaseSchema = {
  label: 'fixtures',
  dialect: 'sqlite',
  tables: TABLES,
  foreignKeys: FOREIGN_KEYS,
  readAt: new Date(0).toISOString(),
};

const page = (sections: PageDef['sections'], base = 'customer'): PageDef => ({
  id: 'p',
  name: 'Customer',
  base,
  sections,
});

/* ---------- paths ---------- */

describe('following a path back to the root', () => {
  test('one hop', () => {
    const { path, error } = resolvePath(SCHEMA, 'invoice', 'customer_id');
    assert.equal(error, undefined);
    assert.equal(path!.endsAt, 'customer');
    assert.deepEqual(
      path!.hops.map((h) => h.name),
      ['invoice_customer_fk'],
    );
  });

  test('two hops — the case the whole feature is for', () => {
    const { path } = resolvePath(SCHEMA, 'invoice_line', 'invoice_id.customer_id');
    assert.equal(path!.endsAt, 'customer');
    assert.deepEqual(
      path!.hops.map((h) => h.name),
      ['line_invoice_fk', 'invoice_customer_fk'],
    );
  });

  test('three hops', () => {
    const { path } = resolvePath(SCHEMA, 'shipment', 'shipment_line_fk.invoice_id.customer_id');
    assert.equal(path!.endsAt, 'customer');
    assert.equal(path!.hops.length, 3);
  });

  test('a hop can be named by its constraint or by its column', () => {
    assert.equal(resolvePath(SCHEMA, 'invoice', 'invoice_customer_fk').path!.endsAt, 'customer');
    assert.equal(resolvePath(SCHEMA, 'invoice', 'customer_id').path!.endsAt, 'customer');
  });

  test('a composite hop has no single column, so it is named by its constraint', () => {
    /* `shipment` points at `invoice_line` with two columns. There is no one
       column to name the hop by, which is exactly why constraint names are
       tried first rather than as a fallback. */
    assert.equal(resolvePath(SCHEMA, 'shipment', 'shipment_line_fk').path!.endsAt, 'invoice_line');
    /* And half of it does not resolve. `invoice_id` is one of the two columns
       the constraint uses; letting it name the hop would build a filter that
       compared one column of a two-column key — a longer list of entirely
       plausible rows, and nothing on screen to say so. Both columns together
       do name it, since that is unambiguous. */
    assert.match(resolvePath(SCHEMA, 'shipment', 'invoice_id').error!, /no reference called "invoice_id"/);
    assert.equal(resolvePath(SCHEMA, 'shipment', 'invoice_id+line_no').path!.endsAt, 'invoice_line');
  });

  test('a comma-joined segment is refused, and the refusal names the canonical hop', () => {
    /* `a,b` was a second spelling of `a+b`. One spelling per hop: the
       refusal lists the hop names the table does have. */
    const { error } = resolvePath(SCHEMA, 'shipment', 'invoice_id,line_no');
    assert.match(error!, /no reference called "invoice_id,line_no"/);
    assert.match(error!, /It points at: .*invoice_id\+line_no/);
  });

  test('a segment that names nothing says what the table does point at', () => {
    const { error } = resolvePath(SCHEMA, 'invoice', 'nonesuch');
    assert.match(error!, /has no reference called "nonesuch"/);
    assert.match(error!, /It points at: customer_id/);
  });

  test('a column that is not a foreign key is said to be one, with where to read why', () => {
    // shipment.carrier is a column of shipment; nothing declares it a key.
    const { error } = resolvePath(SCHEMA, 'shipment', 'carrier');
    assert.match(error!, /"carrier" is a column of shipment, but not a foreign key/);
    assert.match(error!, /mistri docs relationships/);
    assert.doesNotMatch(resolvePath(SCHEMA, 'invoice', 'nonesuch').error!, /is a column/);
  });

  test('a table with no references says so', () => {
    assert.match(resolvePath(SCHEMA, 'customer', 'anything').error!, /It points at nothing/);
  });

  test('an empty path is refused rather than treated as "no hops"', () => {
    assert.match(resolvePath(SCHEMA, 'invoice', '').error!, /cannot be empty/);
    assert.match(resolvePath(SCHEMA, 'invoice', '  .  ').error!, /cannot be empty/);
  });

  test('a path longer than the cap is refused', () => {
    assert.match(resolvePath(SCHEMA, 'invoice', 'a.b.c.d.e').error!, /follows more than/);
  });
});

/* ---------- the filter that ties a section to one record ---------- */

describe('narrowing a section to one root', () => {
  test('one hop compares the child column to the root key', () => {
    const resolved = resolvePath(SCHEMA, 'invoice', 'customer_id').path!;
    assert.deepEqual(rootFilter('customer_id', { id: 42 }, resolved), {
      groups: [[{ path: 'customer_id', op: '=', value: 42 }]],
    });
  });

  test('two hops compare through the path, not on the far table', () => {
    /* The filter belongs to `invoice_line`, so it names
       `invoice_id.customer_id` — the compiler already knows how to join that.
       Naming `customer_id` alone would be a column invoice_line does not
       have; naming it on `customer` would filter the wrong table. */
    const resolved = resolvePath(SCHEMA, 'invoice_line', 'invoice_id.customer_id').path!;
    assert.deepEqual(rootFilter('invoice_id.customer_id', { id: 42 }, resolved), {
      groups: [[{ path: 'invoice_id.customer_id', op: '=', value: 42 }]],
    });
  });

  test('a composite root key is compared on every column', () => {
    /* The silent-wrong-answer case. `shipment` reaches `invoice_line` by two
       columns; comparing only `invoice_id` matches every line of that
       invoice, which is a longer list of entirely plausible rows. */
    const resolved = resolvePath(SCHEMA, 'shipment', 'shipment_line_fk').path!;
    assert.deepEqual(rootFilter('shipment_line_fk', { invoice_id: 7, line_no: 2 }, resolved), {
      groups: [
        [
          { path: 'invoice_id', op: '=', value: 7 },
          { path: 'line_no', op: '=', value: 2 },
        ],
      ],
    });
  });
});

/* ---------- sections as views ---------- */

describe('a list section', () => {
  test('aside placement keeps validation, root binding and original query indices unchanged', () => {
    const p = page([
      { kind: 'fields', paths: ['name'] },
      { kind: 'list', from: 'invoice', path: 'customer_id', columns: ['id', 'total'], region: 'aside' },
    ]);
    assert.equal(validatePage(SCHEMA, p).error, undefined);
    const section = p.sections[1];
    assert.equal(section.kind, 'list');
    if (section.kind !== 'list') throw new Error('Expected related list');
    const planned = listView(SCHEMA, p, section, { id: 42 }, 1);
    const main = listView(SCHEMA, p, { ...section, region: 'main' }, { id: 42 }, 1);
    assert.deepEqual(planned, main);
    assert.deepEqual(planned.view!.filter, { groups: [[{ path: 'customer_id', op: '=', value: 42 }]] });
    const invalid = page([{ ...section, path: 'missing_reference' }]);
    assert.ok(validatePage(SCHEMA, invalid).error, 'aside must not bypass relationship validation');
  });
  test('becomes a view over the listed table, filtered to the root', () => {
    const p = page([{ kind: 'list', from: 'invoice', path: 'customer_id', title: 'Invoices' }]);
    const { view, error } = listView(SCHEMA, p, p.sections[0] as never, { id: 42 }, 0);
    assert.equal(error, undefined);
    assert.equal(view!.base, 'invoice');
    assert.equal(view!.name, 'Invoices');
    assert.deepEqual(view!.filter, { groups: [[{ path: 'customer_id', op: '=', value: 42 }]] });
    assert.equal(view!.limit, DEFAULT_PAGE_LIST_LIMIT);
  });

  test("reaches two hops for the lines of this customer's invoices", () => {
    const p = page([{ kind: 'list', from: 'invoice_line', path: 'invoice_id.customer_id' }]);
    const { view } = listView(SCHEMA, p, p.sections[0] as never, { id: 42 }, 1);
    assert.equal(view!.base, 'invoice_line');
    assert.deepEqual(view!.filter!.groups[0][0].path, 'invoice_id.customer_id');
  });

  test('a path that lands somewhere else is refused, with both ends named', () => {
    /* The mistake that produces a full table of plausible rows: `line_invoice_fk`
       leads to `invoice`, and on a customer page that is every line of every
       invoice in the database. */
    const p = page([{ kind: 'list', from: 'invoice_line', path: 'invoice_id' }]);
    const { error, view } = listView(SCHEMA, p, p.sections[0] as never, { id: 42 }, 0);
    assert.equal(view, undefined);
    assert.match(error!, /leads from invoice_line to invoice, not to customer/);
  });

  test('an explicit column list is used as given', () => {
    const p = page([{ kind: 'list', from: 'invoice', path: 'customer_id', columns: ['total', 'status'] }]);
    const { view } = listView(SCHEMA, p, p.sections[0] as never, { id: 1 }, 0);
    assert.deepEqual(view!.columns, [{ path: 'total' }, { path: 'status' }]);
  });

  test("orderBy is carried across into the view's own vocabulary", () => {
    const p = page([
      {
        kind: 'list',
        from: 'invoice',
        path: 'customer_id',
        orderBy: [{ column: 'issued_on', direction: 'desc' as const }],
      },
    ]);
    const { view } = listView(SCHEMA, p, p.sections[0] as never, { id: 1 }, 0);
    assert.deepEqual(view!.orderBy, [{ path: 'issued_on', direction: 'desc' }]);
  });
});

describe('a section about a record the root points at', () => {
  /* An invoice page, with sections about its *customer*: the notes on that
     customer, and how many invoices the customer has in total. The root's
     own key is 7; the customer it points at is 42 — every assertion below is
     about which of those two numbers ends up in the filter. */
  const invoicePage = (sections: PageDef['sections']) => page(sections, 'invoice');
  const OF = { customer_id: { id: 42 } };

  test("lists through the referenced key, not the root's", () => {
    const p = invoicePage([{ kind: 'list', from: 'note', path: 'customer_id', of: 'customer_id' }]);
    const { view, error } = listView(SCHEMA, p, p.sections[0] as never, { id: 7 }, 0, undefined, OF);
    assert.equal(error, undefined);
    assert.equal(view!.base, 'note');
    assert.deepEqual(view!.filter, { groups: [[{ path: 'customer_id', op: '=', value: 42 }]] });
  });

  test("a count through the reference counts the referenced record's children", () => {
    const p = invoicePage([{ kind: 'metric', fn: 'count', from: 'invoice', path: 'customer_id', of: 'customer_id' }]);
    const { view, counts } = metricView(SCHEMA, p, p.sections[0] as never, { id: 7 }, 0, undefined, OF);
    assert.equal(counts, true);
    assert.deepEqual(view!.filter, { groups: [[{ path: 'customer_id', op: '=', value: 42 }]] });
  });

  test('an empty reference is an empty section, not a filter that cannot match', () => {
    const p = invoicePage([{ kind: 'list', from: 'note', path: 'customer_id', of: 'customer_id' }]);
    const built = listView(SCHEMA, p, p.sections[0] as never, { id: 7 }, 0, undefined, { customer_id: null });
    assert.equal(built.view, undefined);
    assert.equal(built.error, undefined);
    assert.equal(built.empty, true);
  });

  test("a key the planner never resolved is named as the caller's bug", () => {
    const p = invoicePage([{ kind: 'list', from: 'note', path: 'customer_id', of: 'customer_id' }]);
    const { error } = listView(SCHEMA, p, p.sections[0] as never, { id: 7 }, 0, undefined, {});
    assert.match(error!, /was not resolved/);
  });

  test('the path must land on the of-target, and the error names it', () => {
    const p = invoicePage([{ kind: 'list', from: 'invoice_line', path: 'invoice_id', of: 'customer_id' }]);
    const validated = validatePage(SCHEMA, p);
    assert.match(validated.error!, /leads from invoice_line to invoice, not to customer/);
  });

  test("a timeline stream about the reference reads the referenced record's rows, and its path must land there", () => {
    const stream = { from: 'invoice', path: 'customer_id', at: 'issued_on', show: 'status', of: 'customer_id' };
    const p = invoicePage([{ kind: 'timeline', streams: [stream], limit: 20 }] as never);
    assert.equal(validatePage(SCHEMA, p).error, undefined);
    assert.deepEqual(pageAbouts(p), ['customer_id']);
    const [plan] = planPageSections(SCHEMA, p, { id: 7 }, OF, new Date(0)) as Array<{ streams: Array<{ view?: { filter: unknown } }> }>;
    assert.deepEqual(plan.streams[0].view!.filter, { groups: [[{ path: 'customer_id', op: '=', value: 42 }]] });
    const wrong = invoicePage([
      { kind: 'timeline', streams: [{ ...stream, from: 'invoice_line', path: 'invoice_id', at: 'sku', show: 'sku' }], limit: 20 },
    ] as never);
    assert.match(validatePage(SCHEMA, wrong).error!, /leads from invoice_line to invoice, not to customer/);
  });

  test('of reaches exactly one reference', () => {
    /* Two forward hops is expressible in the type and refused with the limit
       said out loud, so a config that tries it learns the rule rather than a
       parse error. */
    const two = resolveOf(SCHEMA, 'invoice_line', 'invoice_id.customer_id');
    assert.match(two.error!, /one reference from invoice_line/);
    const one = resolveOf(SCHEMA, 'invoice', 'customer_id');
    assert.equal(one.table!.id, 'customer');
    assert.equal(one.error, undefined);
  });

  test('validatePage accepts the shape the builder writes', () => {
    const p = invoicePage([
      {
        kind: 'metric',
        fn: 'count',
        from: 'invoice',
        path: 'customer_id',
        of: 'customer_id',
        title: 'invoice \u00b7 of its customer',
      },
    ]);
    assert.equal(validatePage(SCHEMA, p).error, undefined);
  });
});

describe("a section's own filter", () => {
  /* `filter` was in the model and in the config parser from the start and was
     never applied: a page saying `"filter": "status = open"` listed every
     order, silently. Documented, accepted, ignored — the worst shape a bug
     can take, because the file says the behaviour is there. */
  const filtered = (filter: string) => {
    const p = page([{ kind: 'list', from: 'invoice', path: 'customer_id', filter }]);
    return listView(SCHEMA, p, p.sections[0] as never, { id: 42 }, 0);
  };

  test('narrows the section as well as the root', () => {
    const { view, error } = filtered('status = open');
    assert.equal(error, undefined);
    assert.deepEqual(view!.filter, {
      groups: [
        [
          { path: 'customer_id', op: '=', value: 42 },
          { path: 'status', op: '=', value: 'open' },
        ],
      ],
    });
  });

  test('is read against the child, not the root', () => {
    // "Recent open orders" is a condition about the order, not the customer.
    const { error } = filtered('nonesuch = 1');
    assert.match(error!, /nonesuch/);
  });

  test('an OR in the filter still keeps the root condition on every branch', () => {
    /* Groups are OR-ed, so appending the filter as another group would have
       *widened* the result — a filter that added rows, including rows
       belonging to other customers. */
    const { view } = filtered('status = open or status = sent');
    for (const group of view!.filter!.groups) {
      assert.ok(
        group.some((c) => c.path === 'customer_id' && c.value === 42),
        'a branch escaped the root filter',
      );
    }
    assert.equal(view!.filter!.groups.length, 2);
  });

  test('a filter that does not parse names its problem rather than blanking the page', () => {
    const { view, error } = filtered('total >');
    assert.equal(view, undefined);
    assert.ok(error);
  });

  test('no filter leaves the root filter exactly as it was', () => {
    const p = page([{ kind: 'list', from: 'invoice', path: 'customer_id' }]);
    const { view } = listView(SCHEMA, p, p.sections[0] as never, { id: 42 }, 0);
    assert.deepEqual(view!.filter, { groups: [[{ path: 'customer_id', op: '=', value: 42 }]] });
  });

  test('a count can be filtered too', () => {
    const p = page([{ kind: 'metric', fn: 'count', from: 'invoice', path: 'customer_id', filter: 'status = open' }]);
    const { view, error } = metricView(SCHEMA, p, p.sections[0] as never, { id: 42 }, 0);
    assert.equal(error, undefined);
    assert.equal(view!.filter!.groups[0].length, 2);
  });

  test('a sum can be too, measured over the rows the list beside it reads', () => {
    /* The aggregate compiler takes no filter of its own, so a narrowed sum is
       measured as a keyless breakdown of the child under the same filter the
       count and the list use — never answered with the filter dropped. */
    const p = page([
      { kind: 'metric', fn: 'sum', from: 'invoice', path: 'customer_id', column: 'total', filter: 'status = open' },
      { kind: 'list', from: 'invoice', path: 'customer_id', filter: 'status = open' },
    ]);
    const { breakdown, view, counts, error } = metricView(SCHEMA, p, p.sections[0] as never, { id: 42 }, 0);
    const listed = listView(SCHEMA, p, p.sections[1] as never, { id: 42 }, 1);
    assert.equal(error, undefined);
    assert.equal(counts, undefined);
    assert.deepEqual(breakdown, {
      base: 'invoice',
      by: [],
      measures: [{ fn: 'sum', path: 'total', alias: 'value' }],
      filter: listed.view!.filter,
      limit: 1,
    });
    // What it reopens as: the invoices it measured.
    assert.equal(view!.base, 'invoice');
    assert.deepEqual(view!.filter, listed.view!.filter);
  });
});

describe("the dashboard's words on a page section", () => {
  /* Two surfaces, one author: a metric on a page says `measure` ("sum
     amount"), as a dashboard's does, and every section says `query`. */
  const read = (section: Record<string, unknown>) =>
    parsePagesConfig({ pages: [{ label: 'P', base: 'customer', sections: [section] }] }, 'f')[0].sections[0] as unknown as Record<
      string,
      unknown
    >;

  test('measure reads into fn and column', () => {
    assert.deepEqual(
      [read({ kind: 'metric', from: 'invoice', whose: 'customer_id', measure: 'sum total as billed' })].map((m) => [m.fn, m.column]),
      [['sum', 'total']],
    );
    assert.equal(read({ kind: 'metric', from: 'invoice', whose: 'customer_id', measure: 'count' }).fn, 'count');
    assert.throws(
      () => read({ kind: 'metric', from: 'invoice', whose: 'customer_id', measure: 'total sum' }),
      /write it like "count", "sum amount"/,
    );
    assert.throws(
      () => read({ kind: 'metric', from: 'invoice', whose: 'customer_id', fn: 'sum', column: 'total' }),
      /has no "fn"\. It takes: .*measure/,
    );
    assert.throws(
      () => read({ kind: 'metric', from: 'invoice', whose: 'customer_id', measure: 'sum' }),
      /with no column to sum: write it like "sum amount"/,
    );
  });

  test('query is the internal filter; a section says query, never filter', () => {
    assert.equal(read({ kind: 'list', from: 'invoice', whose: 'customer_id', query: 'status = open' }).filter, 'status = open');
    assert.throws(
      () => read({ kind: 'list', from: 'invoice', whose: 'customer_id', filter: 'a = 1' }),
      /section 1 has no "filter"\. It takes: .*query/,
    );
    /* A timeline's streams take the one word every other section does. */
    const stream = { from: 'invoice', whose: 'customer_id', at: 'issued_on', show: 'total' };
    const timeline = read({ kind: 'timeline', streams: [{ ...stream, query: 'status = open' }] }) as {
      streams: Array<{ filter?: string }>;
    };
    assert.equal(timeline.streams[0].filter, 'status = open');
    assert.throws(
      () => read({ kind: 'timeline', streams: [{ ...stream, filter: 'a = 1' }] }),
      /stream 1 has no "filter"\. It takes: .*query/,
    );
  });

  test("a list show takes the nav grammar: a path, or { column, label } in the app's words", () => {
    const list = read({
      kind: 'list',
      from: 'invoice',
      whose: 'customer_id',
      show: ['total', { column: 'status', label: 'State' }, { column: 'issued_on' }],
    });
    assert.deepEqual(list.columns, ['total', 'status', 'issued_on']);
    assert.deepEqual(list.labels, { status: 'State' });
    assert.equal(read({ kind: 'list', from: 'invoice', whose: 'customer_id', show: ['total'] }).labels, undefined);
    assert.throws(
      () => read({ kind: 'list', from: 'invoice', whose: 'customer_id', show: [{ label: 'State' }] }),
      /"show" entry 1 has no "column"/,
    );
    assert.throws(
      () => read({ kind: 'list', from: 'invoice', whose: 'customer_id', show: [{ column: 'status', lable: 'State' }] }),
      /"show" entry 1 has no "lable"/,
    );
    /* The emitter spells a labelled column back the way it was written. */
    const p = parsePagesConfig(
      {
        pages: [
          {
            label: 'P',
            base: 'customer',
            sections: [{ kind: 'list', from: 'invoice', whose: 'customer_id', show: ['total', { column: 'status', label: 'State' }] }],
          },
        ],
      },
      'f',
    )[0];
    assert.deepEqual((sectionConfig(p.sections[0]) as { show: unknown }).show, ['total', { column: 'status', label: 'State' }]);
  });

  test('connection names the one connection a page is for', () => {
    const pages = (page: Record<string, unknown>) => parsePagesConfig({ pages: [{ label: 'P', base: 'customer', ...page }] }, 'f');
    assert.equal(pages({ connection: 'crm' })[0].connection, 'crm');
    assert.throws(() => pages({ onlyOn: 'crm' }), /has "onlyOn", which is now "connection"/);
    assert.throws(() => pages({ connection: 4 }), /has an? "connection" that is not a string/);
  });
});

describe('a section shown only when the record matches', () => {
  const read = (section: Record<string, unknown>) =>
    parsePagesConfig({ pages: [{ label: 'P', base: 'customer', sections: [section] }] }, 'f')[0];

  test('when rides every kind of section and is judged against the base at validation', () => {
    const p = read({ kind: 'fields', when: 'name = "Acme"' });
    assert.equal(p.sections[0].when, 'name = "Acme"');
    assert.equal(validatePage(SCHEMA, p).error, undefined);
    const bad = read({ kind: 'list', from: 'invoice', whose: 'customer_id', when: 'ghost = 1' });
    assert.match(validatePage(SCHEMA, bad).error ?? '', /section 1: "when":/);
    assert.throws(() => read({ kind: 'fields', when: '' }), /"when" that is not a condition/);
  });

  test('when reads a reference path and a computed column, as a list filter does', () => {
    const on = (when: string) =>
      parsePagesConfig({ pages: [{ label: 'P', base: 'invoice', sections: [{ kind: 'fields', when }] }] }, 'f')[0];
    assert.equal(validatePage(SCHEMA, on('customer_id.credit_limit > 1000')).error, undefined);
    assert.match(validatePage(SCHEMA, on('customer_id.ghost > 1')).error ?? '', /section 1: "when":/);
    assert.match(validatePage(SCHEMA, on('status = open show total')).error ?? '', /is a condition, with no "show" or "sort"/);
    const books = {
      id: 'books',
      name: 'Books',
      resources: { invoice: { computed: { large: { type: 'boolean', value: 'total > 1000' } } } },
    };
    const served = withComputed(books as unknown as AppDef, SCHEMA);
    assert.ok(served.tables.find((table) => table.id === 'invoice')?.computed?.large);
    assert.equal(validatePage(served, on('large = true and customer_id.country_code = US')).error, undefined);
  });
});

describe('columns chosen for a list nobody configured', () => {
  test('the key and the label come first', () => {
    const columns = defaultColumns(TABLES[1], 'customer_id');
    assert.equal(columns[0], 'id');
  });

  test('the path back to the root is left out', () => {
    /* Every row in the section has the same value for it — a column of forty
       identical numbers is the one column that cannot tell two rows apart. */
    assert.equal(defaultColumns(TABLES[1], 'customer_id').includes('customer_id'), false);
    assert.equal(defaultColumns(TABLES[1], 'customer_id.name').includes('customer_id'), false);
  });

  test('a path named by its constraint drops the right column', () => {
    /* The case the string split could not see, and the one a suggested page
       always produces: the segment is a constraint name, so looking for a
       column called `invoice_customer_fk` found nothing and left
       `customer_id` in a section that is *about* one customer. */
    const resolved = resolvePath(SCHEMA, 'invoice', 'invoice_customer_fk').path!;
    const columns = defaultColumns(TABLES[1], 'invoice_customer_fk', resolved);
    assert.equal(columns.includes('customer_id'), false, `kept the constant column: ${columns.join(', ')}`);
  });

  test('a composite hop drops both of its columns', () => {
    const resolved = resolvePath(SCHEMA, 'shipment', 'shipment_line_fk').path!;
    const columns = defaultColumns(TABLES[3], 'shipment_line_fk', resolved);
    assert.equal(columns.includes('invoice_id'), false);
    assert.equal(columns.includes('line_no'), false);
  });

  test('the section still shows the columns that do differ', () => {
    // A guard that drops everything is not a guard, it is an empty table.
    const resolved = resolvePath(SCHEMA, 'invoice', 'invoice_customer_fk').path!;
    const columns = defaultColumns(TABLES[1], 'invoice_customer_fk', resolved);
    assert.ok(columns.includes('total'));
    assert.ok(columns.includes('id'));
  });

  test('the list is capped', () => {
    assert.ok(defaultColumns(TABLES[0], 'x').length <= 6);
  });
});

describe('a metric section', () => {
  test('a count is a filtered count of the child, at any depth', () => {
    /* It used to be an aggregate on the root with `via` taken from the first
       hop — right when there is one hop and wrong for anything further out.
       On a customer page, `invoice_line via invoice_id.customer_id` handed
       the aggregate `line_invoice_fk`, which joins lines to invoices and
       knows nothing about customers: a number that was not the one asked for
       and looked like one. */
    const p = page([{ kind: 'metric', fn: 'count', from: 'invoice', path: 'customer_id', title: 'Invoices' }]);
    const { view, counts, error } = metricView(SCHEMA, p, p.sections[0] as never, { id: 42 }, 0);
    assert.equal(error, undefined);
    assert.equal(counts, true, 'a count should be read from the view total');
    assert.equal(view!.base, 'invoice', 'the count should be over the child');
    assert.equal(view!.aggregates, undefined);
    assert.deepEqual(view!.filter, { groups: [[{ path: 'customer_id', op: '=', value: 42 }]] });
    assert.equal(view!.limit, 1);
  });

  test('a count two hops out counts the right table', () => {
    const p = page([{ kind: 'metric', fn: 'count', from: 'invoice_line', path: 'invoice_id.customer_id' }]);
    const { view, counts, error } = metricView(SCHEMA, p, p.sections[0] as never, { id: 42 }, 0);
    assert.equal(error, undefined);
    assert.equal(counts, true);
    assert.equal(view!.base, 'invoice_line');
    assert.deepEqual(view!.filter!.groups[0][0].path, 'invoice_id.customer_id');
  });

  test('a count and the list beside it cannot disagree', () => {
    /* The same filter, built the same way, so a page cannot show "5 orders"
       above a list of six. */
    const p = page([
      { kind: 'metric', fn: 'count', from: 'invoice', path: 'customer_id' },
      { kind: 'list', from: 'invoice', path: 'customer_id' },
    ]);
    const counted = metricView(SCHEMA, p, p.sections[0] as never, { id: 42 }, 0);
    const listed = listView(SCHEMA, p, p.sections[1] as never, { id: 42 }, 1);
    assert.deepEqual(counted.view!.filter, listed.view!.filter);
  });

  test('a sum further than one hop measures the right table, as the count two hops out counts it', () => {
    /* The aggregate compiler reaches exactly one hop; the child's own rows,
       filtered by the path to the root, are right at any depth. */
    const p = page([
      {
        kind: 'metric',
        fn: 'sum',
        from: 'invoice_line',
        path: 'invoice_id.customer_id',
        column: 'quantity',
      },
    ]);
    const { breakdown, error } = metricView(SCHEMA, p, p.sections[0] as never, { id: 42 }, 0);
    assert.equal(error, undefined);
    assert.equal(breakdown!.base, 'invoice_line');
    assert.deepEqual(breakdown!.measures, [{ fn: 'sum', path: 'quantity', alias: 'value' }]);
    assert.deepEqual(breakdown!.filter!.groups[0][0].path, 'invoice_id.customer_id');
  });

  test('a sum names its column', () => {
    const p = page([{ kind: 'metric', fn: 'sum', from: 'invoice', path: 'customer_id', column: 'total' }]);
    const { view } = metricView(SCHEMA, p, p.sections[0] as never, { id: 1 }, 0);
    assert.equal(view!.aggregates![0].column, 'total');
  });

  test('a sum with no column is refused — "sum of invoice" is not a question', () => {
    const p = page([{ kind: 'metric', fn: 'sum', from: 'invoice', path: 'customer_id' }]);
    assert.match(metricView(SCHEMA, p, p.sections[0] as never, { id: 1 }, 0).error!, /needs a column to sum/);
  });

  test('a column the child does not have is refused', () => {
    const p = page([{ kind: 'metric', fn: 'avg', from: 'invoice', path: 'customer_id', column: 'nonesuch' }]);
    assert.match(metricView(SCHEMA, p, p.sections[0] as never, { id: 1 }, 0).error!, /no column called "nonesuch"/);
  });
});

/* ---------- validation ---------- */

describe('checking a page against a connection', () => {
  test('a good page has no error', () => {
    const checked = validatePage(
      SCHEMA,
      page([
        { kind: 'fields' },
        { kind: 'metric', fn: 'count', from: 'invoice', path: 'customer_id' },
        { kind: 'list', from: 'invoice_line', path: 'invoice_id.customer_id' },
      ]),
    );
    assert.equal(checked.error, undefined);
  });

  test('a base this connection does not have is reported, not thrown', () => {
    /* A shared config always describes some connection someone is not on. The
       page belongs in the list with its reason, not missing from it. */
    const checked = validatePage(SCHEMA, page([{ kind: 'fields' }], 'nonesuch'));
    assert.match(checked.error!, /"nonesuch" is not a table on this connection/);
  });

  test('related lists validate shown columns even when their relationship is valid', () => {
    const checked = validatePage(
      SCHEMA,
      page([{ kind: 'list', title: 'Invoices', from: 'invoice', path: 'customer_id', columns: ['id', 'private_owner'] }]),
    );
    assert.match(checked.error!, /^"Invoices":.*private_owner/);
  });

  test('related list ordering cannot name an unavailable column', () => {
    const checked = validatePage(
      SCHEMA,
      page([
        { kind: 'list', from: 'invoice', path: 'customer_id', columns: ['id'], orderBy: [{ column: 'private_owner', direction: 'asc' }] },
      ]),
    );
    assert.match(checked.error!, /section 1:.*private_owner/);
  });

  test('related list columns and ordering retain the existing reference path grammar', () => {
    const checked = validatePage(
      SCHEMA,
      page([
        {
          kind: 'list',
          from: 'invoice',
          path: 'customer_id',
          columns: ['id', 'customer_id.name'],
          orderBy: [{ column: 'customer_id.name', direction: 'asc' }],
        },
      ]),
    );
    assert.equal(checked.error, undefined);
  });

  test('related list references cannot end at an unavailable column', () => {
    const checked = validatePage(
      SCHEMA,
      page([{ kind: 'list', from: 'invoice', path: 'customer_id', columns: ['customer_id.private_owner'] }]),
    );
    assert.match(checked.error!, /section 1:.*private_owner/);
  });

  test('record fields validate explicit paths against the visible catalog', () => {
    for (const path of ['private_owner', 'country_code.private_owner']) {
      const checked = validatePage(SCHEMA, page([{ kind: 'fields', paths: [path] }]));
      assert.match(checked.error!, /section 1:/);
    }
    assert.equal(validatePage(SCHEMA, page([{ kind: 'fields', paths: ['name', 'email'] }])).error, undefined);
    assert.equal(validatePage(SCHEMA, page([{ kind: 'fields', paths: ['customer_id.name'] }], 'invoice')).error, undefined);
  });

  test('a base with no primary key cannot anchor a page', () => {
    const checked = validatePage(SCHEMA, page([{ kind: 'fields' }], 'keyless'));
    assert.match(checked.error!, /no primary key/);
  });

  test('the offending section is named', () => {
    const checked = validatePage(
      SCHEMA,
      page([{ kind: 'fields' }, { kind: 'list', from: 'invoice_line', path: 'invoice_id', title: 'Lines' }]),
    );
    assert.match(checked.error!, /^"Lines":/);
  });

  test('a section with no title is named by its position', () => {
    const checked = validatePage(SCHEMA, page([{ kind: 'fields' }, { kind: 'list', from: 'invoice_line', path: 'invoice_id' }]));
    assert.match(checked.error!, /^section 2:/);
  });

  test('an error is cleared when the page becomes valid again', () => {
    const broken = validatePage(SCHEMA, page([{ kind: 'fields' }], 'nonesuch'));
    const fixed = validatePage(SCHEMA, { ...broken, base: 'customer' });
    assert.equal(fixed.error, undefined);
  });
});

/* ---------- the page nobody wrote ---------- */

describe('the suggested page', () => {
  test('is a real page for a table with no page', () => {
    const suggested = suggestPage(SCHEMA, 'customer')!;
    assert.equal(suggested.base, 'customer');
    assert.equal(suggested.sections[0].kind, 'fields');
    assert.ok(suggested.sections.some((s) => s.kind === 'list'));
    assert.equal(validatePage(SCHEMA, suggested).error, undefined);
  });

  test('no relationship is both a count and a list', () => {
    /* A count above a list of the rows it counted says nothing the list does
       not: `ROOM 2` over a table of two rooms is a number and its own proof,
       taking a card to do it. A card earns its place only for a relationship
       you cannot otherwise see. */
    const many: DatabaseSchema = {
      ...SCHEMA,
      foreignKeys: [
        ...FOREIGN_KEYS,
        { name: 'a_fk', from: { table: 'shipment', columns: ['id'] }, to: { table: 'customer', columns: ['id'] } },
        { name: 'b_fk', from: { table: 'invoice_line', columns: ['invoice_id'] }, to: { table: 'customer', columns: ['id'] } },
        { name: 'c_fk', from: { table: 'keyless', columns: ['a'] }, to: { table: 'customer', columns: ['id'] } },
      ],
    };
    const sections = suggestPage(many, 'customer')!.sections;
    const counted = sections.filter((s) => s.kind === 'metric').map((s) => (s as { path: string }).path);
    const listed = sections.filter((s) => s.kind === 'list').map((s) => (s as { path: string }).path);

    assert.ok(counted.length, 'nothing was counted at all');
    assert.ok(listed.length, 'nothing was listed at all');
    for (const path of counted) {
      assert.equal(listed.includes(path), false, `"${path}" is both counted and listed`);
    }
  });

  test('counts sit in a row and are capped', () => {
    const many: DatabaseSchema = {
      ...SCHEMA,
      foreignKeys: [
        ...FOREIGN_KEYS,
        { name: 'a_fk', from: { table: 'shipment', columns: ['id'] }, to: { table: 'customer', columns: ['id'] } },
        { name: 'b_fk', from: { table: 'invoice_line', columns: ['invoice_id'] }, to: { table: 'customer', columns: ['id'] } },
        { name: 'c_fk', from: { table: 'keyless', columns: ['a'] }, to: { table: 'customer', columns: ['id'] } },
        { name: 'd_fk', from: { table: 'note', columns: ['body'] }, to: { table: 'customer', columns: ['id'] } },
      ],
    };
    const metrics = suggestPage(many, 'customer')!.sections.filter((s) => s.kind === 'metric');
    assert.ok(metrics.length <= 3, `${metrics.length} counts is a report, not a page`);
    assert.ok(metrics.every((m) => m.width === 'third'));
  });

  test('a self-referencing relationship is named by its key, not by the table', () => {
    /* On an employee page, a section labelled `employee` is about their
       reports and says nothing of the sort — it reads as being about the
       thing you are already looking at. */
    const selfRef: DatabaseSchema = {
      ...SCHEMA,
      tables: [...TABLES, meta('staff', [key('id'), col('manager_id', 'INTEGER')])],
      foreignKeys: [
        ...FOREIGN_KEYS,
        { name: 'staff_manager_fk', from: { table: 'staff', columns: ['manager_id'] }, to: { table: 'staff', columns: ['id'] } },
      ],
    };
    const section = suggestPage(selfRef, 'staff')!.sections.find((s) => s.kind !== 'fields');
    assert.equal(section!.title, 'staff via manager_id');
  });

  test('a table nothing points at still gets its fields', () => {
    const suggested = suggestPage(SCHEMA, 'shipment')!;
    assert.deepEqual(
      suggested.sections.map((s) => s.kind),
      ['fields'],
    );
  });

  test('a keyless table gets no page at all', () => {
    assert.equal(suggestPage(SCHEMA, 'keyless'), null);
    assert.equal(suggestPage(SCHEMA, 'nonesuch'), null);
  });
});

/* ---------- config ---------- */

describe('reading pages out of a config file', () => {
  const read = (pages: unknown) => parsePagesConfig({ pages }, 'mistri.json');

  test('a file with no pages section has no pages', () => {
    assert.deepEqual(parsePagesConfig({}, 'f'), []);
  });

  test('"names" says only false: a reference shows the record it names by default', () => {
    // An explicit raw-id choice must survive parse and export.
    const [q] = read([{ label: 'x', base: 'customer', sections: [{ kind: 'fields', names: false }] }]);
    assert.equal((q.sections[0] as { names?: boolean }).names, false);
    const sections = pageConfig(q).sections;
    assert.ok(sections);
    assert.equal((sections[0] as { names?: boolean }).names, false);
    for (const said of [true, 'false']) {
      assert.throws(
        () => read([{ label: 'x', base: 'customer', sections: [{ kind: 'fields', names: said }] }]),
        /by default; say false to keep the raw id, or leave it out/,
      );
    }
  });

  test('"hidden" is a boolean the file must spell as one', () => {
    assert.throws(
      () => read([{ label: 'x', base: 'customer', sections: [{ kind: 'fields', hidden: 'false' }] }]),
      /"hidden": "false"\. It must be true or false, without quotes/,
    );
  });

  test('a breakdown section parses, and refuses what it cannot honour', () => {
    const [p] = read([
      {
        label: 'Customer',
        base: 'customer',
        sections: [{ kind: 'breakdown', from: 'invoice', whose: 'customer_id', by: ' status ', limit: 5 }],
      },
    ]);
    assert.deepEqual(p.sections[0], {
      kind: 'breakdown',
      title: undefined,
      width: undefined,
      offsetLeft: undefined,
      offsetRight: undefined,
      hidden: undefined,
      from: 'invoice',
      path: 'customer_id',
      of: undefined,
      by: 'status',
      filter: undefined,
      limit: 5,
    });
    assert.throws(() => read([{ label: 'x', base: 'c', sections: [{ kind: 'breakdown', from: 'a', whose: 'p' }] }]), /has no "by"/);
    assert.throws(
      () => read([{ label: 'x', base: 'c', sections: [{ kind: 'breakdown', from: 'a', whose: 'p', by: 's', limit: 0 }] }]),
      /"limit" that is not a positive whole number/,
    );
  });

  test('a breakdown plan borrows the list filter and adds only the grouping', () => {
    const p = page([{ kind: 'breakdown', from: 'invoice', path: 'customer_id', by: 'status', filter: 'total > 0' }]);
    assert.equal(validatePage(SCHEMA, p).error, undefined);
    const built = breakdownPlan(SCHEMA, p, p.sections[0] as never, { id: 42 }, 0);
    assert.equal(built.error, undefined);
    assert.equal(built.def!.base, 'invoice');
    assert.deepEqual(built.def!.by, [{ path: 'status' }]);
    assert.deepEqual(built.def!.measures, [{ fn: 'count' }]);
    assert.deepEqual(built.def!.orderBy, [{ name: 'count', direction: 'desc' }]);
    assert.equal(built.def!.limit, 8);
    // The same "these rows belong to that record" filter a list would carry.
    const flat = JSON.stringify(built.def!.filter);
    assert.match(flat, /customer_id/);
    assert.match(flat, /42/);
    assert.match(flat, /total/);
  });

  test('a breakdown grouped by a column the table does not have is refused by name', () => {
    const p = page([{ kind: 'breakdown', from: 'invoice', path: 'customer_id', by: 'nonesuch' }]);
    assert.match(validatePage(SCHEMA, p).error!, /"nonesuch" is not a column on invoice/);
    // A dotted `by` is the compiler's to judge, so it passes validation.
    const dotted = page([{ kind: 'breakdown', from: 'invoice', path: 'customer_id', by: 'customer_id.country_code' }]);
    assert.equal(validatePage(SCHEMA, dotted).error, undefined);
  });

  test('a section about the record the root points at keeps its "about"', () => {
    const [p] = read([
      {
        label: 'Work order',
        base: 'work_order',
        sections: [{ kind: 'metric', about: ' customer_id ', from: 'invoice', whose: 'customer_id' }],
      },
    ]);
    // Trimmed like every other key.
    assert.equal((p.sections[0] as { of?: string }).of, 'customer_id');
    assert.throws(
      () =>
        read([
          {
            label: 'x',
            base: 'b',
            sections: [{ kind: 'metric', about: 7, from: 'a', whose: 'p' }],
          },
        ]),
      /an "about" that is not a non-empty string/,
    );
    // A related list no longer takes it: the rows that share a column are found by { same }.
    assert.throws(
      () => read([{ label: 'x', base: 'b', sections: [{ kind: 'list', about: 'customer_id', from: 'invoice', whose: 'customer_id' }] }]),
      /has "about", which a related list no longer takes/,
    );
  });

  test('a full page round-trips', () => {
    const [p] = read([
      {
        label: 'Customer 360',
        base: 'customer',
        sections: [
          { kind: 'fields', width: 'full' },
          { kind: 'metric', from: 'invoice', whose: 'customer_id', title: 'Invoices', width: 'third' },
          {
            kind: 'list',
            from: 'invoice',
            whose: 'customer_id',
            query: 'status = open',
            limit: 5,
            width: 'half',
            offsetLeft: 'quarter',
            offsetRight: 'quarter',
            sort: 'issued_on desc',
          },
        ],
      },
    ]);
    assert.equal(p.id, 'config-customer-360');
    assert.equal(p.source, 'config');
    assert.equal(p.sections.length, 3);
    assert.equal((p.sections[2] as never as { filter: string }).filter, 'status = open');
    // A centred half: the offsets survive the file, both sides independently.
    assert.equal((p.sections[2] as never as { offsetLeft: string }).offsetLeft, 'quarter');
    assert.equal((p.sections[2] as never as { offsetRight: string }).offsetRight, 'quarter');
    assert.equal(validatePage(SCHEMA, p).error, undefined);
  });

  test('a page with no sections lays out the record', () => {
    // The least a page can be, and a useful one: it is the record page.
    assert.deepEqual(read([{ label: 'Bare', base: 'customer' }])[0].sections, [{ kind: 'fields', width: 'full' }]);
  });

  test('what a config file can get wrong is named with the page it is in', () => {
    assert.throws(() => read('nope'), /"pages" must be an array/);
    assert.throws(() => read([{}]), /page 1 has no "base" table/);
    assert.throws(() => read([{ label: 'x' }]), /\("x"\) has no "base" table/);
    assert.throws(() => read([{ label: ' ', base: 'y' }]), /Invalid caption at .*page 1\.label/);
    // A page that says no label is called what its table is.
    assert.equal(read([{ base: 'work_order' }])[0].name, 'Work order');
    assert.throws(
      () =>
        read([
          { label: 'a', base: 'b' },
          { label: 'a', base: 'b' },
        ]),
      /repeats the id/,
    );
    assert.throws(() => read([{ label: 'x', base: 'y', sections: {} }]), /"sections" that are not an array/);
    assert.throws(() => read([{ label: 'x', base: 'y', sections: [{ kind: 'nope' }] }]), /unknown kind "nope"/);
    assert.throws(() => read([{ label: 'x', base: 'y', sections: [{ kind: 'list' }] }]), /has no "from" table/);
    assert.throws(() => read([{ label: 'x', base: 'y', sections: [{ kind: 'list', from: 'z' }] }]), /has no "whose"/);
    assert.throws(
      () => read([{ label: 'x', base: 'y', sections: [{ kind: 'metric', from: 'z', whose: 'p', measure: 'nope' }] }]),
      /write it like "count"/,
    );
    assert.throws(
      () => read([{ label: 'x', base: 'y', sections: [{ kind: 'metric', from: 'z', whose: 'p', measure: 'sum' }] }]),
      /no column to sum/,
    );
    assert.throws(
      () => read([{ label: 'x', base: 'y', sections: [{ kind: 'list', from: 'z', whose: 'p', width: 'huge' }] }]),
      /Use full, half, third/,
    );
    assert.throws(
      () => read([{ label: 'x', base: 'y', sections: [{ kind: 'list', from: 'z', whose: 'p', offsetLeft: 'oodles' }] }]),
      /Use quarter, third, half, two-thirds/,
    );
    assert.throws(
      () => read([{ label: 'x', base: 'y', sections: [{ kind: 'list', from: 'z', whose: 'p', limit: 0 }] }]),
      /positive whole number/,
    );
    assert.throws(
      () => read([{ label: 'x', base: 'y', sections: [{ kind: 'list', from: 'z', whose: 'p', sort: 'c sideways' }] }]),
      /Write it like the query bar/,
    );
  });

  test('the pre-rename spellings are refused with the word that replaced them', () => {
    /* The rename shipped days after 0.1.0; anyone who wrote the old words
       gets the fix named at startup, not a page that half-works. */
    assert.throws(
      () => read([{ label: 'x', base: 'y', sections: [{ kind: 'list', from: 'z', path: 'p' }] }]),
      /"path", which is now "whose"/,
    );
    assert.throws(
      () => read([{ label: 'x', base: 'y', sections: [{ kind: 'list', from: 'z', whose: 'p', of: 'q' }] }]),
      /"of", which is now "about"/,
    );
    assert.throws(() => read([{ label: 'x', base: 'y', sections: [{ kind: 'fields', paths: ['a'] }] }]), /"paths", which is now "show"/);
    assert.throws(
      () => read([{ label: 'x', base: 'y', sections: [{ kind: 'list', from: 'z', whose: 'p', orderBy: [] }] }]),
      /"orderBy", which is now "sort"/,
    );
    assert.throws(
      () => read([{ label: 'x', base: 'y', sections: [{ kind: 'list', from: 'z', whose: 'p', columns: ['a'] }] }]),
      /"columns", which is now "show"/,
    );
  });

  test('the missing-path message says what a path looks like', () => {
    /* The one field nobody guesses on a first read, and the one that decides
       whether a section shows the right rows. The error is the documentation
       most people will meet first. */
    try {
      read([{ label: 'x', base: 'customer', sections: [{ kind: 'list', from: 'invoice_line' }] }]);
      assert.fail('expected a throw');
    } catch (err) {
      assert.match((err as Error).message, /invoice_id\.customer_id/);
    }
  });

  test('too many sections is refused — a page is a screen, not a report', () => {
    const many = Array.from({ length: 25 }, () => ({ kind: 'fields' }));
    assert.throws(() => read([{ label: 'x', base: 'y', sections: many }]), /more than 24 sections on one screen \(25\)/);
  });

  /* G85: a record's tabs are more screens of it. A ticket of twenty-two sections takes a major incident's five in
     tabs; what is counted is the fullest screen, per region, and a ceiling over the whole page. */
  test("tabs hold more: one screen's sections are counted, the untabbed and the largest tab's in each region", () => {
    const fields = (extra: Record<string, unknown> = {}) => ({ kind: 'fields', ...extra });
    const ticket = [
      ...Array.from({ length: 16 }, () => fields()),
      ...Array.from({ length: 6 }, () => fields({ tab: 'Work' })),
      ...Array.from({ length: 5 }, () => fields({ tab: 'Major incident' })),
      ...Array.from({ length: 2 }, () => fields({ region: 'aside' })),
    ];
    assert.equal(read([{ label: 'x', base: 'y', sections: ticket }])[0].sections.length, 29);
    // The aside is on the same screen: two more there tip the fullest screen past the ceiling.
    const crowded = [...ticket, fields({ region: 'aside' })];
    assert.throws(() => read([{ label: 'x', base: 'y', sections: crowded }]), /more than 24 sections on one screen \(25\)/);
    // However they are tabbed, a page holds at most 96.
    const tabs = Array.from({ length: 97 }, (_, i) => fields({ tab: `Tab ${i % 8}` }));
    assert.throws(() => read([{ label: 'x', base: 'y', sections: tabs }]), /more than 96 sections, its tabs' included/);
  });
});

describe('pages on a schema-qualified connection', () => {
  test('bare names resolve to qualified ids, like the nav', () => {
    /* Found the first time the app layer ran on live Postgres: the nav
       resolved "opportunity" to "public.opportunity" but every page said
       "not a table on this connection" — validatePage matched ids alone.
       The resolved copy is the return, so the planner and the client key
       on real ids. */
    const qualified = {
      ...SCHEMA,
      tables: SCHEMA.tables.map((tb) => ({ ...tb, schema: 'public', id: `public.${tb.name}` })),
      foreignKeys: SCHEMA.foreignKeys.map((fk) => ({
        ...fk,
        from: { ...fk.from, table: `public.${fk.from.table}` },
        to: { ...fk.to, table: `public.${fk.to.table}` },
      })),
    };
    const checked = validatePage(qualified, page([{ kind: 'fields' }, { kind: 'list', from: 'invoice', path: 'customer_id' }]));
    assert.equal(checked.error, undefined);
    assert.equal(checked.base, 'public.customer');
    assert.equal((checked.sections[1] as { from: string }).from, 'public.invoice');
  });
});

describe('what a page could show', () => {
  /* The list a builder offers. The path is the one field nobody guesses, so
     it is never typed — the schema is asked what points here and the answers
     arrive with their paths already written. */
  const relations = () => relationsTo(SCHEMA, 'customer');

  test('finds what points straight at the root, and what points at that', () => {
    const found = relations();
    assert.ok(found.some((r) => r.from === 'invoice' && r.hops === 1));
    assert.ok(found.some((r) => r.from === 'invoice_line' && r.hops === 2));
  });

  test('a relationship is offered under every spelling that resolves to it', () => {
    /* A hop can be named by its constraint or by its column, and both are
       legal — so a hand-written config saying `customer_id` and this list
       saying `invoice_customer_fk` describe one relationship under two
       strings. Anything matching on the string alone calls them two, which is
       how the builder came to show a list's columns as unset when the page
       plainly had some. */
    const invoice = relations().find((r) => r.from === 'invoice' && r.hops === 1)!;
    assert.ok(invoice.aliases.includes('invoice_customer_fk'));
    assert.ok(invoice.aliases.includes('customer_id'));
    // And every alias really does resolve to the same place.
    for (const alias of invoice.aliases) {
      assert.equal(resolvePath(SCHEMA, 'invoice', alias).path?.endsAt, 'customer', alias);
    }
  });

  test('a two-hop path is spelled every way its hops can be', () => {
    const lines = relations().find((r) => r.from === 'invoice_line' && r.hops === 2)!;
    assert.ok(lines.aliases.includes('invoice_id.customer_id'), lines.aliases.join(', '));
    for (const alias of lines.aliases) {
      assert.equal(resolvePath(SCHEMA, 'invoice_line', alias).path?.endsAt, 'customer', alias);
    }
  });

  test('a composite hop offers all its columns and its constraint name', () => {
    const shipments = relationsTo(SCHEMA, 'invoice_line').find((r) => r.from === 'shipment')!;
    assert.equal(shipments.path, 'invoice_id+line_no');
    assert.deepEqual(shipments.aliases, ['invoice_id+line_no', 'shipment_line_fk']);
    for (const alias of shipments.aliases) assert.equal(resolvePath(SCHEMA, 'shipment', alias).path?.endsAt, 'invoice_line');
  });

  test('the route is described in table names, not constraint names', () => {
    const invoice = relations().find((r) => r.from === 'invoice' && r.hops === 1)!;
    assert.match(invoice.via[0], /invoice\.customer_id → customer/);
  });

  test('it does not walk back through the root, or for ever through itself', () => {
    /* `work_order.parent_id → work_order` is a real relationship at one hop
       and an infinite regress past it. */
    const found = relationsTo(SCHEMA, 'customer', 3);
    assert.ok(found.length < 200, `${found.length} relations is a menu nobody opens`);
    assert.ok(found.every((r) => r.from !== 'customer' || r.hops === 1));
  });
});

describe('canonical page paths on projected logical catalogs', () => {
  const projected: DatabaseSchema = {
    ...SCHEMA,
    foreignKeys: SCHEMA.foreignKeys.map((fk) => ({ ...fk, name: `${fk.from.table}.${hopName(fk)}` })),
  };

  test('suggested lists and count metrics plan despite dotted logical constraint names', () => {
    const three: DatabaseSchema = {
      ...projected,
      foreignKeys: [
        ...projected.foreignKeys,
        { name: 'keyless.a', from: { table: 'keyless', columns: ['a'] }, to: { table: 'customer', columns: ['id'] } },
      ],
    };
    const suggested = suggestPage(three, 'customer')!;
    assert.equal(validatePage(three, suggested).error, undefined);
    assert.ok(suggested.sections.some((s) => s.kind === 'metric'));
    assert.ok(suggested.sections.some((s) => s.kind === 'list'));
    for (const section of suggested.sections) {
      if (section.kind !== 'list' && section.kind !== 'metric') continue;
      assert.equal(section.path.includes('.'), false);
      assert.equal(resolvePath(three, section.from, section.path).path?.endsAt, 'customer');
    }
    for (const plan of planPageSections(three, suggested, { id: 7 }, {}, new Date(0))) {
      if (plan.kind !== 'list' && plan.kind !== 'metric') continue;
      assert.equal(plan.error, undefined);
      assert.ok(plan.view);
      assert.deepEqual(
        plan.view.filter?.groups.flatMap((g) => g.map((c) => c.value)),
        [7],
      );
    }
  });

  test('suggested composite references use every key column in the shared planner', () => {
    const suggested = suggestPage(projected, 'invoice_line')!;
    assert.equal(validatePage(projected, suggested).error, undefined);
    const section = suggested.sections.find((s) => s.kind === 'list');
    assert.ok(section && section.kind === 'list');
    assert.equal(section.path, 'invoice_id+line_no');
    const plan = planPageSections(projected, suggested, { invoice_id: 42, line_no: 3 }, {}, new Date(0)).find((p) => p.kind === 'list');
    assert.ok(plan && plan.kind === 'list');
    assert.deepEqual(plan.view?.filter?.groups, [
      [
        { path: 'invoice_id', op: '=', value: 42 },
        { path: 'line_no', op: '=', value: 3 },
      ],
    ]);
  });

  test('relation menus generate canonical paths and only aliases resolving to the same hops', () => {
    for (const relation of relationsTo(projected, 'customer', 3)) {
      const resolved = resolvePath(projected, relation.from, relation.path).path!;
      assert.equal(resolved.endsAt, 'customer');
      assert.equal(relation.path, resolved.hops.map(hopName).join('.'));
      for (const alias of relation.aliases) {
        assert.deepEqual(resolvePath(projected, relation.from, alias).path?.hops, resolved.hops);
      }
    }
    const shipment = relationsTo(projected, 'customer', 3).find((r) => r.from === 'shipment')!;
    assert.equal(shipment.path, 'invoice_id+line_no.invoice_id.customer_id');
  });

  test('composite prefixes, by columns or by constraint, are executable view paths', () => {
    for (const path of ['shipment_line_fk.invoice_id.customer_id', 'invoice_id+line_no.invoice_id.customer_id']) {
      const built = listView(SCHEMA, page([]), { kind: 'list', from: 'shipment', path }, { id: 7 }, 0);
      assert.equal(built.error, undefined);
      const condition = built.view!.filter!.groups[0][0];
      assert.equal(condition.path, path);
      assert.equal(resolveViewPath(SCHEMA, 'shipment', condition.path).column.name, 'customer_id');
    }
  });

  test('duplicate columns, duplicate constraints and column/constraint collisions refuse rather than choose first', () => {
    const original = FOREIGN_KEYS[0];
    for (const extra of [
      { ...original, name: 'other_constraint', to: { table: 'note', columns: ['id'] } },
      { ...original, from: { table: 'invoice', columns: ['id'] } },
      { ...original, name: 'customer_id', from: { table: 'invoice', columns: ['id'] } },
    ]) {
      const ambiguous = { ...SCHEMA, foreignKeys: [...FOREIGN_KEYS, extra] };
      const path = extra.name === original.name ? original.name : 'customer_id';
      assert.match(resolvePath(ambiguous, 'invoice', path).error!, /ambiguous/);
      assert.match(resolvePath({ ...ambiguous, foreignKeys: [...ambiguous.foreignKeys].reverse() }, 'invoice', path).error!, /ambiguous/);
      assert.ok(!relationsTo(ambiguous, 'customer').some((r) => r.from === 'invoice' && r.path === path));
    }
  });
});

describe('explicit page hops when canonical columns are ambiguous', () => {
  const schema: DatabaseSchema = {
    ...SCHEMA,
    tables: [
      meta('root', [key('id')]),
      meta('a', [key('id'), col('root_id', 'INTEGER')]),
      meta('b', [key('id'), col('root_id', 'INTEGER')]),
      meta('child', [key('id'), col('ref', 'INTEGER')]),
    ],
    foreignKeys: [
      { name: 'to_a', from: { table: 'child', columns: ['ref'] }, to: { table: 'a', columns: ['id'] } },
      { name: 'to_b', from: { table: 'child', columns: ['ref'] }, to: { table: 'b', columns: ['id'] } },
      { name: 'a_root', from: { table: 'a', columns: ['root_id'] }, to: { table: 'root', columns: ['id'] } },
      { name: 'b_root', from: { table: 'b', columns: ['root_id'] }, to: { table: 'root', columns: ['id'] } },
    ],
  };

  test('explicit multihop prefixes survive planning and resolve to the chosen parent', () => {
    assert.match(resolvePath(schema, 'child', 'ref.root_id').error!, /ambiguous/);
    for (const prefix of ['to_a', 'to_b']) {
      const definition = page(
        [
          { kind: 'list', from: 'child', path: `${prefix}.root_id` },
          { kind: 'metric', fn: 'count', from: 'child', path: `${prefix}.root_id` },
          { kind: 'breakdown', from: 'child', path: `${prefix}.root_id`, by: 'id' },
        ],
        'root',
      );
      assert.equal(validatePage(schema, definition).error, undefined);
      for (const plan of planPageSections(schema, definition, { id: 7 }, {}, new Date(0))) {
        assert.ok(plan.kind === 'list' || plan.kind === 'metric' || plan.kind === 'breakdown');
        assert.equal(plan.error, undefined);
        const filter = plan.kind === 'breakdown' ? plan.breakdown?.filter : plan.view?.filter;
        const condition = filter!.groups[0][0];
        assert.equal(condition.path, `${prefix}.root_id`);
        assert.equal(condition.value, 7);
        assert.equal(resolveViewPath(schema, 'child', condition.path).hops[0].name, prefix);
      }
    }
  });

  test('suggested pages keep an edge available through its unique constraint', () => {
    for (const base of ['a', 'b']) {
      const suggested = suggestPage(schema, base)!;
      assert.equal(validatePage(schema, suggested).error, undefined);
      const section = suggested.sections.find((s) => s.kind === 'list');
      assert.ok(section && section.kind === 'list');
      assert.equal(section.path, `to_${base}`);
      assert.equal(resolvePath(schema, section.from, section.path).path?.endsAt, base);
    }
  });

  test('relation menus retain both explicit routes and never advertise ambiguous aliases', () => {
    const relations = relationsTo(schema, 'root').filter((r) => r.from === 'child');
    assert.deepEqual(relations.map((r) => r.path).sort(), ['to_a.root_id', 'to_b.root_id']);
    for (const relation of relations) {
      const chosen = resolvePath(schema, 'child', relation.path).path!;
      for (const alias of relation.aliases) {
        assert.ok(!alias.startsWith('ref.'));
        assert.deepEqual(resolvePath(schema, 'child', alias).path?.hops, chosen.hops);
      }
    }
  });

  test('no uniquely usable canonical or constraint name means no generated edge', () => {
    const duplicate = { ...schema, foreignKeys: schema.foreignKeys.map((fk) => (fk.name === 'to_b' ? { ...fk, name: 'to_a' } : fk)) };
    assert.match(resolvePath(duplicate, 'child', 'ref').error!, /ambiguous/);
    assert.match(resolvePath(duplicate, 'child', 'to_a').error!, /ambiguous/);
    assert.equal(
      suggestPage(duplicate, 'a')!.sections.some((s) => s.kind === 'list' || s.kind === 'metric'),
      false,
    );
    assert.equal(
      relationsTo(duplicate, 'root').some((r) => r.from === 'child'),
      false,
    );
  });

  test('a comma-containing constraint name is preserved rather than treated as a column alias', () => {
    const named = { ...schema, foreignKeys: schema.foreignKeys.map((fk) => (fk.name === 'to_a' ? { ...fk, name: 'explicit,a' } : fk)) };
    const built = listView(named, page([], 'root'), { kind: 'list', from: 'child', path: 'explicit,a.root_id' }, { id: 7 }, 0);
    const condition = built.view!.filter!.groups[0][0];
    assert.equal(condition.path, 'explicit,a.root_id');
    assert.equal(resolveViewPath(named, 'child', condition.path).hops[0].name, 'explicit,a');
  });
});

/* ---------- opening what a section counted ---------- */

describe('the query a section can be reopened as', () => {
  test('a one-hop count becomes a filter on the child table', () => {
    /* The failure this exists for: the plan carried no query at all, the
       client fell back to the child table's own name, and clicking a count of
       3 opened a grid of 20. The number and the thing it opened disagreed,
       and nothing on screen said so. */
    const built = metricView(
      SCHEMA,
      page([]),
      {
        kind: 'metric',
        fn: 'count',
        from: 'invoice',
        path: 'customer_id',
      },
      { id: 4 },
      0,
    );
    assert.equal(sectionQuery(built.view), 'invoice customer_id = 4');
  });

  test('a value that needs quoting gets it', () => {
    const built = metricView(
      SCHEMA,
      page([], 'invoice_line'),
      {
        kind: 'metric',
        fn: 'count',
        from: 'shipment',
        path: 'shipment_line_fk',
      },
      { invoice_id: 7, line_no: 2 },
      0,
    );
    assert.equal(sectionQuery(built.view), 'shipment invoice_id = 7 and line_no = 2');
  });

  test('a two-hop count says it cannot be written, rather than writing it wrong', () => {
    /* The query language has no dotted paths, so there is no honest text for
       this — and `invoice_line` on its own is the whole table, which is the
       lie the fallback used to tell. `undefined` is what sends the caller to
       the composer instead. */
    const built = metricView(
      SCHEMA,
      page([]),
      {
        kind: 'metric',
        fn: 'count',
        from: 'invoice_line',
        path: 'invoice_id.customer_id',
      },
      { id: 4 },
      0,
    );
    assert.ok(built.view, 'the metric did not compile at all');
    assert.equal(sectionQuery(built.view), undefined);
  });

  test('no filter at all is the table itself', () => {
    assert.equal(sectionQuery({ id: 'v', name: 'v', base: 'invoice', columns: [] }), 'invoice');
  });

  test('an operator the grammar spells differently is refused', () => {
    /* `in` takes a list, and the parser reads a form this would not write.
       Refusing is the only answer that cannot produce a query which runs and
       means something else. */
    assert.equal(
      sectionQuery({
        id: 'v',
        name: 'v',
        base: 'invoice',
        columns: [],
        filter: { groups: [[{ path: 'status', op: 'in', value: ['open', 'paid'] }]] },
      }),
      undefined,
    );
  });

  test('a null test is written the way the grammar reads it', () => {
    assert.equal(
      sectionQuery({
        id: 'v',
        name: 'v',
        base: 'invoice',
        columns: [],
        filter: { groups: [[{ path: 'status', op: 'isNull' }]] },
      }),
      'invoice status is empty',
    );
  });

  test('the query it writes is one the parser accepts', () => {
    /* The assertion that makes the rest of them mean anything: a string that
       looks like the grammar and is not would fail in the query bar, where
       the reader lands, having been told this is where their number came
       from. */
    const built = metricView(
      SCHEMA,
      page([]),
      {
        kind: 'metric',
        fn: 'count',
        from: 'invoice',
        path: 'customer_id',
      },
      { id: 4 },
      0,
    );
    const parsed = parseQuery(sectionQuery(built.view)!, { schema: SCHEMA });
    assert.deepEqual(parsed.errors, []);
    assert.deepEqual(parsed.query?.filter, { groups: [[{ column: 'customer_id', op: '=', value: 4 }]] });
  });
});

/* ---------- telling two relationships apart ---------- */

describe('naming a relationship so it can be picked', () => {
  test('a name nothing else shares is left alone', () => {
    const found = relationsTo(SCHEMA, 'customer');
    assert.ok(
      found.some((r) => r.label === 'note'),
      JSON.stringify(found.map((r) => r.label)),
    );
  });

  test('no two relationships are offered under the same name', () => {
    /* The bug in the picker: `work_log through ticket` was three entries with
       the same words and the same detail line — work_log reaches employee
       through ticket by three different columns. Three identical rows in a
       menu is a menu nobody can use, because whichever is chosen, nobody can
       say which was chosen. Asserted over every table, since which schema
       produces the collision is exactly what nobody predicted. */
    for (const table of SCHEMA.tables) {
      const labels = relationsTo(SCHEMA, table.id, 3).map((r) => r.label);
      assert.equal(new Set(labels).size, labels.length, `${table.id}: ${labels.filter((l, i) => labels.indexOf(l) !== i).join(', ')}`);
    }
  });

  test('a name is qualified only as far as it takes', () => {
    /* Every relationship spelled out in full would be correct and unreadable.
       The point is that qualification is paid for only where it buys
       something. */
    const found = relationsTo(SCHEMA, 'customer', 3);
    const plain = found.filter((r) => !r.label.includes(' via ') && !r.label.includes(' through '));
    assert.ok(plain.length, 'every single relationship was qualified');
  });
});

/* ---------- groups of fields ---------- */

describe('a group of fields', () => {
  test('a column count outside what the layout can do is refused, not clamped', () => {
    /* Clamping would render a layout nobody asked for and say nothing about
       it. The file is the thing being edited, so the file is where the
       mistake belongs. */
    assert.throws(
      () => parsePagesConfig({ pages: [{ label: 'p', base: 'customer', sections: [{ kind: 'fields', columns: 7 }] }] }, 'mistri.json'),
      /"columns" of 7/,
    );
    const ok = parsePagesConfig({ pages: [{ label: 'p', base: 'customer', sections: [{ kind: 'fields', columns: 2 }] }] }, 'mistri.json');
    assert.equal((ok[0].sections[0] as { columns?: number }).columns, 2);
  });

  test('hidden survives the parser on every kind of section', () => {
    /* Hiding is how a page gets a short form without anyone rebuilding the
       long one, so it has to be a thing the file can hold — on a list and a
       metric as much as on a group of fields. */
    const [parsed] = parsePagesConfig(
      {
        pages: [
          {
            label: 'p',
            base: 'customer',
            sections: [
              { kind: 'fields', hidden: true },
              { kind: 'metric', from: 'invoice', whose: 'customer_id', hidden: true },
              { kind: 'list', from: 'invoice', whose: 'customer_id', hidden: true },
              { kind: 'list', from: 'note', whose: 'customer_id' },
            ],
          },
        ],
      },
      'mistri.json',
    );
    assert.deepEqual(
      parsed.sections.map((s) => s.hidden),
      [true, true, true, undefined],
    );
  });

  test('a hidden section is still checked against the connection', () => {
    /* It is out of sight, not out of the file. A page whose hidden section
       names a table that is gone is a page with a mistake in it, and the
       moment it is shown again is the worst moment to find out. */
    const checked = validatePage(SCHEMA, page([{ kind: 'fields' }, { kind: 'list', from: 'invoice', path: 'nonesuch', hidden: true }]));
    assert.match(checked.error ?? '', /nonesuch/);
  });

  test('"collapsed" is refused, even as false: a group of fields is always open', () => {
    for (const collapsed of [true, false]) {
      assert.throws(
        () => parsePagesConfig({ pages: [{ label: 'p', base: 'customer', sections: [{ kind: 'fields', collapsed }] }] }, 'mistri.json'),
        /has "collapsed", which is gone with the accordion/,
      );
    }
  });
});

describe('timeline sections', () => {
  const SCHEMA = {
    label: 'x',
    dialect: 'sqlite',
    readAt: '',
    tables: [
      {
        name: 'deal',
        schema: '',
        id: 'deal',
        isView: false,
        columns: [
          { name: 'id', type: 'integer', nullable: false, primaryKey: true },
          { name: 'name', type: 'text', nullable: true, primaryKey: false },
        ],
      },
      {
        name: 'call',
        schema: '',
        id: 'call',
        isView: false,
        columns: [
          { name: 'id', type: 'integer', nullable: false, primaryKey: true },
          { name: 'deal_id', type: 'integer', nullable: true, primaryKey: false, references: { table: 'deal', column: 'id' } },
          { name: 'happened_on', type: 'date', nullable: true, primaryKey: false },
          { name: 'subject', type: 'text', nullable: true, primaryKey: false },
        ],
      },
    ],
    foreignKeys: [{ name: 'fk_call_deal', from: { table: 'call', columns: ['deal_id'] }, to: { table: 'deal', columns: ['id'] } }],
  } as import('../packages/engine/src/shared/schema.js').DatabaseSchema;

  const page = (sections: unknown[]) =>
    parsePagesConfig(
      {
        pages: [{ label: 'Deal', base: 'deal', sections }],
      },
      'test',
    )[0];

  test('parses in the authored spelling and round-trips through the emitter', () => {
    const p = page([
      {
        kind: 'timeline',
        title: 'Activity',
        streams: [{ from: 'call', whose: 'deal_id', at: 'happened_on', show: 'subject', detail: 'subject' }],
        limit: 12,
      },
    ]);
    const section = p.sections[0] as import('../packages/engine/src/shared/page.js').PageTimeline;
    assert.equal(section.kind, 'timeline');
    assert.equal(section.streams[0].path, 'deal_id');
    const emitted = sectionConfig(section) as { streams: Array<{ whose: string }> };
    assert.equal(emitted.streams[0].whose, 'deal_id');

    assert.equal(validatePage(SCHEMA, p).error, undefined);
  });

  test('refusals name the missing piece', () => {
    assert.throws(() => page([{ kind: 'timeline' }]), /needs "streams"/);
    assert.throws(() => page([{ kind: 'timeline', streams: [{ from: 'call', whose: 'deal_id', at: 'happened_on' }] }]), /has no "show"/);
    assert.throws(
      () => page([{ kind: 'timeline', streams: [{ from: 'call', path: 'deal_id', at: 'happened_on', show: 'subject' }] }]),
      /"path"/,
    );
  });

  test('validation: the date must be a date, the words must exist, the path must lead home', () => {
    const notDate = page([{ kind: 'timeline', streams: [{ from: 'call', whose: 'deal_id', at: 'subject', show: 'subject' }] }]);
    assert.match(validatePage(SCHEMA, notDate).error ?? '', /a timeline orders by a date column/);

    const ghost = page([{ kind: 'timeline', streams: [{ from: 'call', whose: 'deal_id', at: 'happened_on', show: 'ghost' }] }]);
    assert.match(validatePage(SCHEMA, ghost).error ?? '', /"ghost" is not a column/);

    const lost = page([{ kind: 'timeline', streams: [{ from: 'deal', whose: 'name', at: 'happened_on', show: 'name' }] }]);
    assert.ok(validatePage(SCHEMA, lost).error, 'a path that does not lead home is refused');
  });

  test('a stream says who wrote each row, and a dotted path is judged as a list column is', () => {
    const withRep = {
      ...SCHEMA,
      tables: [
        ...SCHEMA.tables.map((table) =>
          table.name === 'call'
            ? {
                ...table,
                columns: [
                  ...table.columns,
                  { name: 'rep_id', type: 'integer', nullable: true, primaryKey: false, references: { table: 'rep', column: 'id' } },
                ],
              }
            : table,
        ),
        {
          name: 'rep',
          schema: '',
          id: 'rep',
          isView: false,
          columns: [
            { name: 'id', type: 'integer', nullable: false, primaryKey: true },
            { name: 'name', type: 'text', nullable: true, primaryKey: false },
          ],
        },
      ],
      foreignKeys: [
        ...SCHEMA.foreignKeys,
        { name: 'fk_call_rep', from: { table: 'call', columns: ['rep_id'] }, to: { table: 'rep', columns: ['id'] } },
      ],
    } as typeof SCHEMA;
    const stream = { from: 'call', whose: 'deal_id', at: 'happened_on', show: 'subject', author: 'rep_id.name' };
    const p = page([{ kind: 'timeline', streams: [stream] }]);
    const section = p.sections[0] as import('../packages/engine/src/shared/page.js').PageTimeline;
    assert.equal(section.streams[0].by, 'rep_id.name');
    assert.equal((sectionConfig(section) as { streams: Array<{ author?: string }> }).streams[0].author, 'rep_id.name');
    // A reference then a column of the table it reaches: not a chain of references.
    assert.equal(validatePage(withRep, p).error, undefined);
    const ghost = page([{ kind: 'timeline', streams: [{ ...stream, author: 'rep_id.ghost' }] }]);
    assert.ok(validatePage(withRep, ghost).error, 'a dotted path to a missing column is refused');
  });

  test('a composer adds to the first stream through its direct reference, and refuses what it could hide', () => {
    // The database assigns the call's key, as a SQLite INTEGER PRIMARY KEY does, so the form need not ask for it.
    const keyed = {
      ...SCHEMA,
      tables: SCHEMA.tables.map((table) =>
        table.name === 'call'
          ? { ...table, columns: table.columns.map((column) => (column.primaryKey ? { ...column, identity: true } : column)) }
          : table,
      ),
    } as typeof SCHEMA;
    const stream = { from: 'call', whose: 'deal_id', at: 'happened_on', show: 'subject' };
    const create = { label: 'Log call', show: ['subject', 'happened_on'] };
    const p = page([{ kind: 'timeline', streams: [stream], create }]);
    const section = p.sections[0] as import('../packages/engine/src/shared/page.js').PageTimeline;
    assert.deepEqual(section.create, create);
    assert.deepEqual((sectionConfig(section) as { create?: unknown }).create, create);
    assert.equal(validatePage(keyed, p).error, undefined);

    const narrowed = page([{ kind: 'timeline', streams: [{ ...stream, query: 'subject = x' }], create: 'Log call' }]);
    assert.match(validatePage(keyed, narrowed).error ?? '', /cannot add to a stream narrowed by a query/);
    const unknown = page([{ kind: 'timeline', streams: [stream], create: { label: 'Log call', show: ['ghost'] } }]);
    assert.match(validatePage(keyed, unknown).error ?? '', /unknown form column/);
  });
});

describe('a page chart, note and embed', () => {
  const read = (pages: unknown) => parsePagesConfig({ pages }, 'mistri.json');

  test('a chart parses its measure and shape, and refuses what it cannot draw', () => {
    const [p] = read([
      {
        label: 'c',
        base: 'customer',
        sections: [{ kind: 'chart', from: 'invoice', whose: 'customer_id', by: 'month issued_on', measure: 'sum total' }],
      },
    ]);
    assert.deepEqual(p.sections[0], {
      kind: 'chart',
      title: undefined,
      width: undefined,
      offsetLeft: undefined,
      offsetRight: undefined,
      hidden: undefined,
      from: 'invoice',
      path: 'customer_id',
      of: undefined,
      by: 'month issued_on',
      fn: 'sum',
      column: 'total',
      filter: undefined,
    });
    const refused = (section: Record<string, unknown>, pattern: RegExp) =>
      assert.throws(
        () =>
          read([
            {
              label: 'c',
              base: 'customer',
              sections: [{ kind: 'chart', from: 'invoice', whose: 'customer_id', by: 'status', ...section }],
            },
          ]),
        pattern,
      );
    refused({ by: undefined }, /has no "by"/);
    refused({ shape: 'pie' }, /"shape" of "pie"\. Use "line", "bar", "donut" or "stacked"/);
    refused({ shape: 'stacked' }, /needs a two-key "by"/);
    refused({ shape: 'donut', target: 3 }, /donut, which has no scale/);
    refused({ measure: 'sum' }, /with no column to sum/);
    refused({ height: 40 }, /"height" that is not a number of pixels/);
    refused({ whose: undefined }, /has no "whose"/);
  });

  test('a chart plan is the breakdown plan with its keys, measure and order', () => {
    const p = page([
      { kind: 'chart', from: 'invoice', path: 'customer_id', by: 'month issued_on', fn: 'sum', column: 'total', filter: 'status = paid' },
    ]);
    assert.equal(validatePage(SCHEMA, p).error, undefined);
    const built = chartPlan(SCHEMA, p, p.sections[0] as never, { id: 42 }, 0);
    assert.equal(built.error, undefined);
    assert.deepEqual(built.def!.by, [{ path: 'issued_on', bucket: 'month', alias: 'key_1' }]);
    assert.deepEqual(built.def!.measures, [{ fn: 'sum', path: 'total', alias: 'value' }]);
    // A line reads along time; a donut largest first.
    assert.deepEqual(built.def!.orderBy, [{ name: 'key_1', direction: 'asc' }]);
    assert.match(JSON.stringify(built.def!.filter), /customer_id.*42/);
    assert.match(compileBreakdown(SCHEMA, built.def!, ANSI_STYLE).text, /SUM/);
    const donut = page([{ kind: 'chart', from: 'invoice', path: 'customer_id', by: 'status', fn: 'count', shape: 'donut' }]);
    assert.deepEqual(chartPlan(SCHEMA, donut, donut.sections[0] as never, { id: 1 }, 0).def!.orderBy, [
      { name: 'value', direction: 'desc' },
    ]);
    const planned = planPageSections(SCHEMA, p, { id: 42 }, {}, new Date(0));
    assert.equal(planned[0].kind, 'chart');
  });

  test('a chart key that cannot be cut or found is refused by name', () => {
    assert.match(
      validatePage(SCHEMA, page([{ kind: 'chart', from: 'invoice', path: 'customer_id', by: 'month status', fn: 'count' }])).error!,
      /cuts status into months, and it is TEXT/,
    );
    assert.match(
      validatePage(SCHEMA, page([{ kind: 'chart', from: 'invoice', path: 'customer_id', by: 'nonesuch', fn: 'count' }])).error!,
      /nonesuch/,
    );
    assert.match(
      validatePage(SCHEMA, page([{ kind: 'chart', from: 'invoice', path: 'customer_id', by: 'status', fn: 'sum', column: 'nope' }])).error!,
      /"nope" is not a column on invoice/,
    );
    assert.match((chartKeys('fortnight issued_on') as { error: string }).error, /"fortnight issued_on" is not a key/);
  });

  test('a note reads nothing, and a mistri.json note opens no view', () => {
    const [p] = read([{ label: 'c', base: 'customer', sections: [{ kind: 'note', text: '  Mind the limit. ' }] }]);
    assert.equal((p.sections[0] as { text: string }).text, 'Mind the limit.');
    assert.equal(validatePage(SCHEMA, p).error, undefined);
    assert.deepEqual(planPageSections(SCHEMA, validatePage(SCHEMA, p), { id: 1 }, {}), [{ index: 0, kind: 'note' }]);
    assert.throws(() => read([{ label: 'c', base: 'customer', sections: [{ kind: 'note' }] }]), /is a note and has no "text"/);
    assert.throws(
      () => read([{ label: 'c', base: 'customer', sections: [{ kind: 'note', text: 'x', action: { label: 'Go', to: 'v' } }] }]),
      /a config file has no views to open/,
    );
  });

  test('an embed needs an App: mistri.json refuses it, and an App draws it as the related list of its view', () => {
    assert.throws(
      () => read([{ label: 'c', base: 'customer', sections: [{ kind: 'view', view: 'invoices', whose: 'customer_id' }] }]),
      /a config file has no views/,
    );
    const app = {
      views: {
        invoices: {
          table: 'invoice',
          label: 'Invoices',
          query: 'total > 0',
          show: ['id', 'status', 'total'],
          sort: 'issued_on desc',
          tabs: [{ label: 'Open', query: 'status = open sort total desc' }],
        },
        board: { label: 'Board', sections: [] },
      },
    } as unknown as AppDef;
    const authored: PageDef = {
      id: 'c',
      name: 'Customer',
      base: 'customer',
      sections: [{ kind: 'list', view: 'invoices', from: '', path: 'customer_id', limit: 5 }],
    };
    assert.match(validatePage(SCHEMA, authored).error!, /embeds the view "invoices", which is not one of this App's list views/);
    const [resolved] = resolvePageEmbeds(app, [authored], 'app.ts');
    assert.deepEqual(resolved.sections[0], {
      kind: 'list',
      view: 'invoices',
      from: 'invoice',
      path: 'customer_id',
      limit: 5,
      title: 'Invoices',
      columns: ['id', 'status', 'total'],
      filter: 'total > 0 and status = open',
      orderBy: [{ column: 'total', direction: 'desc' }],
    });
    assert.equal(validatePage(SCHEMA, resolved).error, undefined);
    // Said back the way it was written.
    assert.deepEqual(sectionConfig(resolved.sections[0]), {
      title: 'Invoices',
      kind: 'view',
      view: 'invoices',
      whose: 'customer_id',
      limit: 5,
    });
    assert.throws(
      () => resolvePageEmbeds(app, [{ ...authored, sections: [{ kind: 'list', view: 'board', from: '', path: 'customer_id' }] }], 'app.ts'),
      /embeds "board", which is not a list view this App declares\. Its list views: invoices/,
    );
    assert.throws(
      () =>
        resolvePageEmbeds(app, [{ ...authored, sections: [{ kind: 'note', text: 'x', action: { label: 'Go', view: 'nope' } }] }], 'app.ts'),
      /note whose action opens "nope", which is not a list or dashboard view/,
    );
  });
});
