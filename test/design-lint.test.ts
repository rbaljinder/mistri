/**
 * `mistri check --design`: each composition smell a design audit of
 * agent-built Apps found is said where it was made, with its fix, and a page
 * composed the way the samples compose one says nothing.
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { inferredDisplay } from '../packages/engine/src/shared/displayDefaults.js';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { designLint, sayDesignFinding } from '../packages/mistri/src/server/app/designLint.js';
import type { AppDef } from '../packages/mistri/src/shared/appModel.js';
import type { PageDef, PageSection } from '../packages/engine/src/shared/pageModel.js';
import type { ColumnMeta, DatabaseSchema } from '../packages/engine/src/shared/schema.js';

const column = (name: string, type: string, more: Partial<ColumnMeta> = {}): ColumnMeta => ({
  name,
  type,
  nullable: true,
  primaryKey: false,
  ...more,
});
const id = column('id', 'INTEGER', { primaryKey: true, nullable: false });
const schema: DatabaseSchema = {
  label: 'shop',
  dialect: 'sqlite',
  readAt: '2026-09-25T00:00:00Z',
  tables: [
    {
      id: 'customer',
      name: 'customer',
      schema: 'main',
      columns: [
        id,
        column('name', 'TEXT'),
        column('city', 'TEXT'),
        column('phone', 'TEXT'),
        column('auto_tradelines', 'INTEGER'),
        column('auto_renew', 'INTEGER'),
      ],
    },
    {
      id: 'sales_order',
      name: 'sales_order',
      schema: 'main',
      columns: [
        id,
        column('customer_id', 'INTEGER', { nullable: false, references: { table: 'customer', column: 'id' } }),
        column('status', 'TEXT', { nullable: false, allowed: ['new', 'packed', 'shipped', 'cancelled', 'returned', 'lost'] }),
        column('total', 'REAL'),
        column('is_rush', 'INTEGER'),
        column('ordered_on', 'DATE'),
        column('boxes', 'INTEGER'),
        column('carrier', 'TEXT'),
      ],
    },
    {
      id: 'line',
      name: 'line',
      schema: 'main',
      columns: [
        id,
        column('order_id', 'INTEGER', { nullable: false, references: { table: 'sales_order', column: 'id' } }),
        column('sku', 'TEXT', { nullable: false }),
        column('qty', 'INTEGER'),
        column('price', 'REAL'),
        column('bin', 'TEXT'),
        column('note', 'TEXT'),
        column('packed_at', 'TIMESTAMP'),
      ],
    },
  ],
  foreignKeys: [
    { name: 'order_customer', from: { table: 'sales_order', columns: ['customer_id'] }, to: { table: 'customer', columns: ['id'] } },
    { name: 'line_order', from: { table: 'line', columns: ['order_id'] }, to: { table: 'sales_order', columns: ['id'] } },
  ],
} as DatabaseSchema;

const tones = { tone: { new: 'info', shipped: 'good', '*': 'neutral' } } as const;
const lines = (title: string, show: string[], more: object = {}) => ({
  kind: 'list',
  title,
  from: 'line',
  path: 'order_id',
  columns: show,
  ...more,
});

/** An App composed as the samples compose one: a look, a grouped menu, dressed values, a page with an opening and an aside. */
const composed: AppDef = {
  id: 'shop',
  name: 'Shop',
  nav: [{ group: 'work', label: 'Work', children: [{ view: 'orders' }] }],
  home: [{ view: 'orders' }],
  ui: { logo: 'package', theme: { preset: 'lumen' }, shell: { placement: 'top' } } as AppDef['ui'],
  resources: {
    customer: {},
    line: { display: { price: { format: 'money' } } },
    sales_order: {
      display: { status: tones, total: { format: 'money' } },
      recordLabel: 'PO-{id}',
      form: { show: ['customer_id', 'status'], defaults: { status: 'new' } },
      actions: [
        { id: 'ship', label: 'Ship', set: { status: 'shipped' } },
        { id: 'cancel', label: 'Cancel', set: { status: 'cancelled' }, confirm: true },
      ],
    },
  },
  views: { orders: { table: 'sales_order', icon: 'cart', show: ['id', 'customer_id', 'status', 'total'] } } as unknown as AppDef['views'],
};
const composedPage: PageDef = {
  id: 'order',
  name: 'Order',
  base: 'sales_order',
  listTabs: true,
  sections: [
    { kind: 'fields', presentation: 'facts', paths: ['customer_id', 'ordered_on', 'status'] },
    {
      kind: 'fields',
      paths: ['total', 'carrier'],
      workflow: {
        field: 'status',
        steps: ['new', 'packed', 'shipped', 'returned'].map((value) => ({ value, label: value })),
        ordered: true,
      },
    },
    lines('Lines', ['sku', 'qty', 'price', 'bin'], { create: { label: 'Add line', show: ['sku', 'qty'] } }),
    lines('Notes', ['note', 'sku']),
    { kind: 'fields', presentation: 'card', region: 'aside', paths: ['customer_id', 'customer_id.city', 'customer_id.phone'] },
    { kind: 'fields', region: 'aside', paths: ['boxes', 'carrier'] },
    { kind: 'history', region: 'aside' },
  ],
} as PageDef;

describe('mistri check --design', () => {
  test('a page composed as the samples compose one says nothing', () => {
    assert.deepEqual(designLint(composed, [composedPage], schema).map(sayDesignFinding), []);
  });

  test('beside an aside a list keeps four columns: a fifth is left out at a desk, so it is said', () => {
    const at = (show: string[]) =>
      designLint(
        composed,
        [
          {
            ...composedPage,
            sections: composedPage.sections.map((section) =>
              section.kind === 'list' && section.title === 'Lines' ? { ...section, columns: show } : section,
            ),
          } as PageDef,
        ],
        schema,
      ).filter((finding) => finding.code === 'aside-columns');
    assert.equal(at(['sku', 'qty', 'price', 'bin']).length, 0);
    const [said] = at(['sku', 'qty', 'price', 'bin', 'note']);
    assert.ok(said, 'a five-column list beside the aside is one too many');
    assert.match(said.text, /show: \['sku', 'qty', 'price', 'bin'\]/);
  });

  test('each smell is said where it was made, as the smell and then its fix', () => {
    const plain: AppDef = {
      ...composed,
      ui: {} as AppDef['ui'],
      nav: ['a', 'b', 'c', 'd', 'e', 'f', 'orders'].map((view) => ({ view })),
      resources: {
        customer: {},
        line: {},
        sales_order: {
          recordLabel: 'Order of {ordered_on}',
          view: undefined,
          form: { show: ['status', 'total'] },
          actions: [
            { id: 'cancel', label: 'Cancel', set: { status: 'cancelled' } },
            { id: 'ship', label: 'Ship', set: { status: 'shipped' } },
          ],
        },
      },
      views: {
        ...Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f'].map((key) => [key, { table: 'customer' }])),
        calendar: { table: 'sales_order', presentation: { kind: 'calendar', date: 'ordered_on', primary: 'id' } },
        orders: { table: 'sales_order', show: ['id', 'status', 'total', 'is_rush'] },
        today: {
          label: 'Today',
          sections: [
            ...[1, 2, 3, 4].map((n) => ({ kind: 'metric', title: `M${n}`, table: 'sales_order' })),
            {
              kind: 'rows',
              title: 'Coming up',
              table: 'sales_order',
              show: ['ordered_on', 'customer_id', 'carrier', 'status'],
              width: 'half',
            },
            { kind: 'rows', title: 'Fits', table: 'sales_order', show: ['ordered_on', 'customer_id', 'carrier'], width: 'half' },
            { kind: 'rows', title: 'Wide', table: 'sales_order', show: ['ordered_on', 'customer_id', 'carrier', 'status', 'total'] },
          ],
        },
      } as unknown as AppDef['views'],
    };
    plain.nav.unshift({ view: 'calendar' });
    const page: PageDef = {
      id: 'order',
      name: 'Order',
      base: 'sales_order',
      sections: [
        { kind: 'fields', title: 'Details', paths: ['status', 'total'] },
        { kind: 'fields', title: 'Dates', paths: ['ordered_on'] },
        { kind: 'fields', presentation: 'facts', paths: ['boxes'] },
        {
          kind: 'fields',
          presentation: 'headline',
          paths: ['total', 'boxes'],
          subfigure: 'boxes',
          workflow: {
            field: 'status',
            steps: [
              { value: 'new', label: 'New' },
              { value: 'shipped', label: 'Shipped' },
            ],
          },
        },
        ...[1, 2, 3].map((n) => ({ kind: 'metric', title: `M${n}`, fn: 'count', from: 'line', path: 'order_id' })),
        lines('Lines', ['sku', 'qty', 'price', 'bin', 'note', 'id'], { create: { label: 'Add line', show: ['qty'] } }),
        lines('More lines', ['sku', 'qty']),
        { kind: 'fields', presentation: 'card', region: 'aside', paths: ['customer_id'] },
        lines('Recent', ['sku', 'qty', 'bin'], { region: 'aside' }),
      ],
    } as PageDef;
    const found = designLint(plain, [page], schema);
    assert.deepEqual([...new Set(found.map((finding) => finding.code))].sort(), [
      'aside-columns',
      'aside-metrics',
      'aside-table',
      'bare-title',
      'calendar-address',
      'dashboard-columns',
      'default-shell',
      'destructive-first',
      'fields-by-type',
      'lone-metric',
      'raw-label',
      'required-unfilled',
      'shown-twice',
      'stacked-lists',
      'thin-card',
      'thin-workflow',
      'unitless-fact',
      'vague-heading',
    ]);
    for (const finding of found) {
      const said = sayDesignFinding(finding);
      assert.match(said, / → /, `${said}: a smell, then its fix`);
      assert.match(said, /See `mistri docs design`\.$/);
    }
    const saying = (code: string) =>
      found
        .filter((finding) => finding.code === code)
        .map((finding) => finding.text)
        .join('\n');
    // The fix is the DSL to write, where one line says it.
    assert.match(saying('required-unfilled'), /does not ask for \['customer_id'\]/);
    assert.match(saying('required-unfilled'), /"Add line" asks for \['qty'\] but not \['sku'\]/);
    assert.match(saying('calendar-address'), /view: 'orders'/);
    assert.match(saying('destructive-first'), /"Cancel"/);
    // Only the half-width rows with four columns: three fit, and a full row has the room.
    assert.match(
      saying('dashboard-columns'),
      /^"Coming up" \(4 columns at half width, 3 drawn\).*show: \['ordered_on', 'customer_id', 'status'\]/,
      'the status stays, as the grid keeps it',
    );
    assert.doesNotMatch(saying('dashboard-columns'), /Fits|Wide/);
    // Where: the page, the resource, the view, the shell.
    assert.deepEqual([...new Set(found.map((finding) => finding.at))].sort(), [
      'page "order"',
      'resource "sales_order"',
      'the shell',
      'view "today"',
    ]);
  });

  test('a header opens the page and puts destructive verbs last; its bare numbers and a one-row list are still said', () => {
    const app: AppDef = {
      ...composed,
      resources: {
        ...composed.resources,
        sales_order: {
          ...composed.resources!.sales_order,
          actions: [
            { id: 'cancel', label: 'Cancel', set: { status: 'cancelled' } },
            { id: 'ship', label: 'Ship', set: { status: 'shipped' } },
          ],
        },
      },
    };
    const page = (header: object) =>
      ({
        id: 'order',
        name: 'Order',
        base: 'sales_order',
        sections: [
          { kind: 'fields', paths: ['carrier', 'boxes'] },
          header,
          lines('Current line', ['sku', 'qty']),
          lines('Lines', ['sku', 'qty']),
          { kind: 'history' },
        ],
      }) as PageDef;
    const codes = (header: object) =>
      designLint(app, [page(header)], schema)
        .map((finding) => finding.code)
        .sort();
    assert.deepEqual(codes({ kind: 'fields', presentation: 'header', status: 'status', paths: ['customer_id'], destructive: ['cancel'] }), [
      'stacked-lists',
    ]);
    // Without naming it, a verb the header cannot tell is destructive stays first; a bare number in its facts is a code.
    assert.deepEqual(codes({ kind: 'fields', presentation: 'header', paths: ['boxes'] }), [
      'destructive-first',
      'stacked-lists',
      'unitless-fact',
    ]);
    assert.deepEqual(
      codes({
        kind: 'fields',
        presentation: 'header',
        paths: ['boxes'],
        factLabels: { boxes: { one: 'box', many: 'boxes' } },
        destructive: ['cancel'],
      }),
      ['stacked-lists'],
    );
    const said = designLint(app, [page({ kind: 'note', text: 'x' })], schema);
    assert.match(said.find((finding) => finding.code === 'stacked-lists')!.text, /current\('Current line', 'line', 'order_id'/);
    assert.match(
      said.find((finding) => finding.code === 'bare-title')!.text,
      /header\(\{ status: 'status', facts: \['customer_id', 'ordered_on'\] \}\)/,
    );
  });

  test("a header's primary is an id the validation step checks, not a design warning", () => {
    const withHeader = (primary: string) =>
      ({
        ...composedPage,
        sections: [...composedPage.sections, { kind: 'fields', presentation: 'header', status: 'status', paths: ['customer_id'], primary }],
      }) as PageDef;
    assert.deepEqual(designLint(composed, [withHeader('ship')], schema), []);
    assert.deepEqual(designLint(composed, [withHeader('renew')], schema), []);
  });

  /* Shot at 1280 beside a 330px aside: in the top menu's shell a related
     list drew four columns and a summary four figures in a row; beside the
     side menu as well, a list lost its fourth column and three figures wrapped. */
  /* These pages say 'summary' on purpose, to judge its width; that it is the default is `default-presentation`'s to say. */
  const codes = (app: AppDef, page: PageDef) =>
    designLint(app, [page], schema)
      .map((finding) => finding.code)
      .filter((code) => code !== 'default-presentation');
  test('beside the side menu and an aside, a page has room for four short columns and three figures, and is told past that', () => {
    const side: AppDef = { ...composed, ui: { ...composed.ui, shell: { rail: true } } as AppDef['ui'] };
    const pageWith = (paths: string[], columns: string[]) =>
      ({
        ...composedPage,
        sections: composedPage.sections.map((section) =>
          section.kind === 'fields' && !section.presentation && section.region !== 'aside' && section.workflow
            ? { ...section, paths, presentation: 'summary' as const }
            : section.kind === 'list' && section.title === 'Lines'
              ? { ...section, columns }
              : section,
        ),
      }) as PageDef;
    // A sku, a note, a moment and a quantity: 504px of columns, in 715 beside the aside and 538 beside the side menu too.
    const short = ['sku', 'note', 'packed_at', 'qty'];
    assert.deepEqual(codes(side, pageWith(['total', 'carrier', 'boxes'], short)), []);
    assert.deepEqual(codes(composed, pageWith(['total', 'carrier', 'boxes', 'ordered_on'], short)), []);
    // The order's status chip for the quantity: 544px, past the side menu's column but not the top menu's.
    const wide = ['sku', 'note', 'packed_at', 'order_id.status'];
    assert.deepEqual(codes(composed, pageWith(['total', 'carrier'], wide)), []);
    const said = designLint(side, [pageWith(['total', 'carrier', 'boxes', 'ordered_on'], wide)], schema).filter(
      (finding) => finding.code !== 'default-presentation',
    );
    assert.deepEqual(
      said.map((finding) => finding.code),
      ['aside-columns', 'aside-summary'],
    );
    for (const finding of said) assert.match(finding.text, /side menu[\s\S]*placement: 'top'/);
    assert.match(said[0].text, /"Lines" \(4 columns, 3 drawn\)[\s\S]*show: \['sku', 'note', 'packed_at'\]/);
    assert.match(said[1].text, /fields\(\['total', 'carrier', 'boxes'\]\)/);
    assert.deepEqual(codes(composed, pageWith(['total', 'carrier', 'boxes', 'ordered_on', 'customer_id'], short)), ['aside-summary']);
  });

  test("a dashboard's rows at half or a third of the page keep what fits there", () => {
    const at = (width: string, show: string[]) =>
      designLint(
        {
          ...composed,
          views: {
            ...composed.views,
            today: { label: 'Today', sections: [{ kind: 'rows', title: 'Newest', table: 'sales_order', width, show }] },
          } as unknown as AppDef['views'],
        },
        [composedPage],
        schema,
      ).filter((finding) => finding.code === 'dashboard-columns');
    const four = ['customer_id.name', 'carrier', 'status', 'ordered_on'];
    assert.equal(at('half', four).length, 0);
    assert.match(
      at('half', [...four, 'total'])[0].text,
      /5 columns at half width, 4 drawn\)[\s\S]*show: \['customer_id\.name', 'carrier', 'status', 'ordered_on'\]/,
    );
    assert.equal(at('third', four.slice(0, 3)).length, 1);
    assert.equal(at('full', [...four, 'total', 'boxes']).length, 0);
  });

  test("beside a dashboard's aside metrics sit as many to a row as its main column holds, and each strip wraps on its own", () => {
    const lone = (sections: object[], aside?: object[]) =>
      designLint(
        {
          ...composed,
          ui: { ...composed.ui, shell: { placement: 'side' } },
          views: { ...composed.views, today: { label: 'Today', sections, ...(aside ? { aside } : {}) } } as unknown as AppDef['views'],
        },
        [composedPage],
        schema,
      ).filter((finding) => finding.code === 'lone-metric');
    const metrics = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: 'metric', title: `M${i}`, table: 'sales_order' }));
    const note = { kind: 'note', text: 'Read me.' };
    // The lender's Home: four beside the aside are two rows of two.
    assert.deepEqual(lone(metrics(4), [note]), []);
    assert.match(
      lone(metrics(3), [note])[0].text,
      /its 3 metrics sit two to a row beside the aside, so the last one wraps alone[\s\S]*make it 2 or 4/,
    );
    // Without an aside, three to a row.
    assert.match(lone(metrics(4))[0].text, /sit three to a row/);
    // Two strips of three, a note between them, are two full rows.
    assert.deepEqual(lone([...metrics(3), note, ...metrics(3)]), []);
  });

  test("third-width metrics beside a dashboard's aside in the side menu's shell are told they wrap", () => {
    const said = designLint(
      {
        ...composed,
        ui: { ...composed.ui, shell: { placement: 'side' } },
        views: {
          ...composed.views,
          today: {
            label: 'Today',
            sections: [0, 1, 2].map((i) => ({ kind: 'metric', title: `M${i}`, table: 'sales_order', width: 'third' })),
            aside: [{ kind: 'note', text: 'Read me.' }],
          },
        } as unknown as AppDef['views'],
      },
      [composedPage],
      schema,
    ).filter((finding) => finding.code === 'lone-metric');
    assert.match(said[0].text, /its 3 metrics at width 'third' sit two to a row beside the aside[\s\S]*leave the aside out/);
  });

  test("on a layout each section is judged at its area's width: columns it spans, a table in one column, a strip in its area", () => {
    const four = ['customer_id.name', 'carrier', 'status', 'ordered_on', 'total'];
    const lint = (layout: string[], sections: object[]) =>
      designLint(
        { ...composed, views: { ...composed.views, today: { label: 'Today', sections, areas: layout } } as unknown as AppDef['views'] },
        [composedPage],
        schema,
      );
    const rows = (area: string, show = four.slice(0, 3)) => ({ kind: 'rows', title: 'Newest', table: 'sales_order', show, area });
    const metrics = (area: string, n: number) =>
      Array.from({ length: n }, (_, i) => ({ kind: 'metric', title: `M${area}${i}`, table: 'sales_order', area }));
    // One column of three holds a name and a status, not five columns; two columns hold more; the whole row holds them all.
    const crowded = lint(['a b c'], [rows('a', four), rows('b', four), rows('c', four)]).filter((f) => f.code === 'dashboard-columns');
    assert.match(crowded[0].text, /"Newest" \(5 columns at 1 of 3 columns wide, \d drawn\)[\s\S]*or give it an area of more columns/);
    assert.equal(lint(['a a a'], [rows('a', four)]).filter((f) => f.code === 'dashboard-columns').length, 0);
    // A table-shaped section alone in a column of a three-column template is names, not a table.
    const narrow = lint(
      ['a a b', 'c c b'],
      [rows('a'), rows('b'), { kind: 'matrix', title: 'Grid', table: 'sales_order', by: 'status, carrier', area: 'c' }],
    );
    // Only "b" is one column wide: "c" spans two.
    assert.equal(narrow.filter((f) => f.code === 'area-too-narrow').length, 1);
    assert.match(narrow.find((f) => f.code === 'area-too-narrow')!.text, /stands in "b", one column of 3/);
    assert.match(narrow.find((f) => f.code === 'area-too-narrow')!.text, /two columns of the template/);
    // Two columns is a half, which a list can bear.
    assert.equal(lint(['a b'], [rows('a'), rows('b')]).filter((f) => f.code === 'area-too-narrow').length, 0);
    // The metrics stacked in an area are a strip at that area's width: four in the whole row wrap; four in one column stack.
    assert.match(
      lint(['a a a'], [...metrics('a', 4)]).find((f) => f.code === 'lone-metric')!.text,
      /its 4 metrics in "a" sit three to a row/,
    );
    assert.equal(lint(['a b c'], [...metrics('a', 4), rows('b'), rows('c')]).filter((f) => f.code === 'lone-metric').length, 0);
  });

  test("a list board's category naming a reference is told the tag draws its key; its lines say the name", () => {
    const board = (presentation: object) =>
      designLint(
        {
          ...composed,
          views: {
            ...composed.views,
            lanes: { table: 'sales_order', presentation: { kind: 'board', by: 'status', primary: 'id', ...presentation } },
          } as unknown as AppDef['views'],
        },
        [composedPage],
        schema,
      ).filter((finding) => finding.code === 'board-reference');
    assert.match(board({ category: 'customer_id' })[0].text, /its cards' category is customer_id, a reference/);
    assert.deepEqual(board({ lines: ['customer_id'], footer: [{ column: 'customer_id' }] }), [], 'a line and a footer say the name');
    assert.deepEqual(board({ category: 'carrier' }), []);
  });

  test('a count named auto_ reads as a number; a switch named auto_ is said as yes or no, by convention', () => {
    const customer = schema.tables.find((table) => table.id === 'customer')!;
    const inferred = inferredDisplay(customer);
    assert.equal(inferred.auto_tradelines, undefined);
    assert.deepEqual(inferred.auto_renew.rule, { values: { 0: 'No', 1: 'Yes' } });
    // So the design check has nothing to say about either: the convention dressed what it would have asked for.
    assert.equal(
      designLint(composed, [composedPage], schema).some((finding) => /auto_/.test(finding.text)),
      false,
    );
  });

  test('a list beside its filter rail keeps the columns a desk has room for, and is told past that', () => {
    const railed = (show: string[], shell: 'side' | 'top', more: object = {}) =>
      designLint(
        {
          ...composed,
          ui: { ...composed.ui, shell: { placement: shell } },
          views: {
            ...composed.views,
            lot: { table: 'sales_order', filterBar: 'rail', filters: ['status'], show, ...more },
          } as unknown as AppDef['views'],
        },
        [composedPage],
        schema,
      ).filter((finding) => finding.code === 'rail-columns');
    const eight = ['id', 'customer_id', 'ordered_on', 'carrier', 'boxes', 'total', 'is_rush', 'status'];
    const [said] = railed(eight, 'side', { rowActions: true });
    assert.equal(
      said.text,
      'its 8 columns stand beside the filter rail and the side menu, where a desk has room for about 583px of columns: ' +
        "5 are drawn and ['boxes', 'total', 'is_rush'] are left out, keeping the first, the name and the status → show the ones that matter most, first: " +
        "show: ['id', 'customer_id', 'ordered_on', 'carrier', 'status']; or put the filters above the rows: drop filterBar: 'rail'.",
    );
    assert.match(sayDesignFinding(said), /^view "lot" \[rail-columns\]: .* → .*drop filterBar: 'rail'\. See `mistri docs design`\.$/);
    // Under the top menu the rows have the room; four columns fit either way; cards are not a grid.
    assert.deepEqual(railed(eight, 'top'), []);
    assert.deepEqual(railed(eight.slice(0, 4), 'side'), []);
    assert.deepEqual(railed(eight, 'side', { presentation: { kind: 'cards', primary: 'id' } }), []);
  });

  test('a page whose only verb ends the record is told to add the forward one', () => {
    const only = (actions: object[]) =>
      designLint(
        { ...composed, resources: { ...composed.resources, sales_order: { ...composed.resources!.sales_order, actions } } } as AppDef,
        [composedPage],
        schema,
      ).filter((finding) => finding.code === 'no-forward-verb');
    const said = only([{ id: 'deactivate', label: 'Mark order inactive', set: { status: 'cancelled' }, confirm: true }])[0].text;
    assert.match(said, /"Mark order inactive"[\s\S]*actions: \{ start: action\('…'[\s\S]*header\(\{ destructive: \['deactivate'\] \}\)/);
    assert.equal(only([{ id: 'end', label: 'End order', set: { carrier: 'none' } }]).length, 1, 'an ending said by its verb');
    assert.equal(
      only([
        { id: 'ship', label: 'Ship', set: { status: 'shipped' } },
        { id: 'cancel', label: 'Cancel', set: { status: 'cancelled' }, confirm: true },
      ]).length,
      0,
    );
  });

  test('a header that already names the only verb as the ending has said so on purpose', () => {
    const ending = [{ id: 'withdraw', label: 'Withdraw order', set: { status: 'cancelled' }, confirm: true }];
    const app = {
      ...composed,
      resources: { ...composed.resources, sales_order: { ...composed.resources!.sales_order, actions: ending } },
    } as AppDef;
    const headed = (header: object) =>
      ({
        ...composedPage,
        sections: [...composedPage.sections, { kind: 'fields', presentation: 'header', paths: ['customer_id'], ...header }],
      }) as PageDef;
    const forward = (header: object) => designLint(app, [headed(header)], schema).filter((finding) => finding.code === 'no-forward-verb');
    assert.equal(forward({ status: 'status' }).length, 1);
    assert.equal(forward({ destructive: ['withdraw'] }).length, 0);
  });

  test('a day beside the parent it tells apart is a name; a day alone is not', () => {
    const label = (recordLabel: string) =>
      designLint(
        { ...composed, resources: { ...composed.resources, sales_order: { ...composed.resources!.sales_order, recordLabel } } } as AppDef,
        [composedPage],
        schema,
      ).filter((finding) => finding.code === 'raw-label');
    assert.equal(label('{customer_id.name} · ordered {ordered_on}').length, 0, 'a periodic record by its parent and its day');
    assert.equal(label('Order of {ordered_on}').length, 1);
  });

  test('a heading that names no content is said, on a page and in a New form', () => {
    const page = {
      ...composedPage,
      sections: composedPage.sections.map((section) =>
        section.kind === 'fields' && section.region === 'aside' && !section.presentation ? { ...section, title: 'Details' } : section,
      ),
    } as PageDef;
    const app = {
      ...composed,
      resources: {
        ...composed.resources,
        sales_order: {
          ...composed.resources!.sales_order,
          form: {
            ...composed.resources!.sales_order.form!,
            groups: [
              { label: 'Order', fields: ['customer_id'] },
              { label: 'Details', fields: ['status'] },
            ],
          },
        },
      },
    } as AppDef;
    const found = designLint(app, [page], schema).filter((finding) => finding.code === 'vague-heading');
    assert.deepEqual(
      found.map((finding) => finding.at),
      ['page "order"', 'resource "sales_order"'],
    );
  });

  test("a page's archetype: a showcase's body is at full width, an article's column is its measure", () => {
    const codes = (page: PageDef) => designLint(composed, [page], schema).map((finding) => finding.code);
    // Five columns beside the aside lose one; under a showcase the body has the page's width.
    const five = {
      ...composedPage,
      sections: composedPage.sections.map((section) =>
        section.kind === 'list' && section.title === 'Lines'
          ? (lines('Lines', ['sku', 'qty', 'price', 'bin', 'note']) as PageSection)
          : section,
      ),
    };
    assert.ok(codes(five).includes('aside-columns'));
    assert.ok(!codes({ ...five, layout: 'showcase' }).includes('aside-columns'));
    // An article has no aside, and its column is the reading measure: the same five are judged there.
    const article: PageDef = { ...five, layout: 'article', sections: five.sections.filter((section) => section.region !== 'aside') };
    const said = designLint(composed, [article], schema).find((finding) => finding.code === 'aside-columns');
    assert.match(
      said?.text ?? '',
      /"Lines" \(5 columns, 4 drawn\) stands in the article's reading column, where a desk has room for about 640px/,
    );
    assert.ok(!codes({ ...article, layout: undefined }).includes('aside-columns'));
  });

  test("a presentation that is the region's default is said: properties in the aside, summary in the main column", () => {
    const page = (sections: object[]) => ({ ...composedPage, sections: [...composedPage.sections, ...sections] }) as PageDef;
    const said = (sections: object[]) =>
      designLint(composed, [page(sections)], schema).filter((finding) => finding.code === 'default-presentation');
    const [rail, summary] = said([
      { kind: 'fields', title: 'Shipping', presentation: 'properties', region: 'aside', paths: ['boxes'] },
      { kind: 'fields', presentation: 'summary', paths: ['boxes', 'carrier'] },
    ]);
    assert.match(
      rail.text,
      /^"Shipping" says presentation: 'properties', which is what fields\(\) in the aside already draws → leave it out\.$/,
    );
    assert.match(
      summary.text,
      /^a fields section says presentation: 'summary', which is what fields\(\) in the main column already draws → leave it out\.$/,
    );
    assert.equal(rail.at, 'page "order"');
    // The other region's default is a choice, and so is any other word.
    assert.deepEqual(
      said([
        { kind: 'fields', presentation: 'summary', region: 'aside', paths: ['boxes'] },
        { kind: 'fields', presentation: 'properties', paths: ['boxes'] },
        { kind: 'fields', presentation: 'table', region: 'aside', paths: ['boxes'] },
        { kind: 'fields', paths: ['boxes'] },
      ]),
      [],
    );
  });

  test('an explicit listTabs: false keeps a stack of lists without a word', () => {
    const page = { ...composedPage, listTabs: false } as PageDef;
    assert.deepEqual(designLint(composed, [page], schema), []);
  });

  /* Paper has no tabs (appDocuments.ts refuses a section's tab), so a document's lists are every line, one under
     another, by design: the warning asked for the one thing a document cannot do (UI5). */
  test('a document stacks its lists without a word, since paper has no tabs', () => {
    const { listTabs: _, ...stacked } = composedPage;
    assert.ok(designLint(composed, [stacked], schema).some((finding) => finding.code === 'stacked-lists'));
    const page = { ...stacked, document: { label: 'Packing slip' } } as PageDef;
    assert.deepEqual(
      designLint(composed, [page], schema).filter((finding) => finding.code === 'stacked-lists'),
      [],
    );
  });
});

/* The step itself: read over Tick, as an agent runs it. */
const work = mkdtempSync(join(tmpdir(), 'tablewalk-design-'));
after(() => rmSync(work, { recursive: true, force: true }));

describe('the design step of mistri check', () => {
  test('runs with --design, warns without failing, and says so for a small App with nothing to fix', async () => {
    const db = join(work, 'tick.db');
    spawnSync(process.execPath, [resolve('examples/databases/tick/seed.mjs'), db], { encoding: 'utf8' });
    const ran = await new Promise<{ code: number; out: string }>((done, reject) =>
      execFile(
        process.execPath,
        [
          '--import',
          'tsx',
          resolve('packages/mistri/src/server/index.ts'),
          'check',
          '--app',
          'examples/apps/tick',
          '--config',
          `${db}.json`,
          '--design',
        ],
        { timeout: 120_000, env: { ...process.env, XDG_CONFIG_HOME: join(work, 'config') } },
        (error, out) => {
          if (error && (error as { killed?: boolean }).killed) reject(error);
          else done({ code: (error as { code?: number } | null)?.code ?? 0, out });
        },
      ),
    );
    assert.equal(ran.code, 0, ran.out);
    assert.match(ran.out, /^\s+design\s+passed\s+nothing to say$/m);
  });
});
