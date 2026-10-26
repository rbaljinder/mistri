/**
 * A page, drawn and driven: the sections landing as they arrive, a `when`
 * gate, a run of metrics as one strip, a run of lists as tabs fetched when
 * opened, and a broken section named in place.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { bridgeShell } from '../../../../../test/shellBridge.js';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, useState } from 'react';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';
import { columnKind, labelColumn, primaryKey } from '../../../../engine/src/shared/schema.js';
import type { PageDef, SectionPlan } from './pageModel.js';
import type {
  HttpViewDefinition,
  HttpBreakdownDefinition,
  ResourceClientReply,
  ResourceHttpSuccess,
} from '../../../../engine/src/shared/resourceHttp.js';
import { configureAppTargetLinks } from '../../../../mistri/src/client/appTargetLinks.js';
import { establishSessionIdentity, lockSessionIdentity } from '../sessionIdentity.js';

const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
const gone: unknown[] = [];
let matches: Record<string, boolean> = {};
let contextLabel: string | undefined;
let appMode = false;
/* Whether the reader may add a row of a related list's table (insert.js canInsert). */
let insertable = false;
let editing = false;
/** The label column labelPath names; undefined unless a test is about the record's name. */
let labelled: string | undefined;
let appResource: unknown = null;
let viewOverride: ResourceClientReply<'/api/view/run'> | undefined;
let viewRows: Record<string, unknown>[] | undefined;
/** Rows by the view's table, where one test's page reads two tables differently. */
let rowsByBase: Record<string, Record<string, unknown>[]> | undefined;
/** How many rows the question matched, when more than the page a test answers. */
let viewTotal: number | undefined;
let breakdownOverride: ResourceClientReply<'/api/breakdown'> | undefined;
let moneyDisplay = false;
/** Display rules by column, beside the money one `moneyDisplay` turns on. */
let displays: Record<string, Record<string, unknown>> = {};

/* A counted metric is asked as a keyless count (PageMetrics.tsx): it answers
   what the view it counts would have — the same failure, or its total. */
function breakdownReply(def: HttpBreakdownDefinition | undefined) {
  if (breakdownOverride) return breakdownOverride;
  if (!def) throw new Error('Test request has no breakdown.');
  // A related list's footer: one row measured over every related row.
  if (!def.by.length && def.measures[0]?.alias === 'total_0')
    return {
      breakdown: { ...def },
      resolved: [],
      ms: 1,
      offset: 0,
      columns: ['total_0'],
      rows: [{ total_0: 4812.5 }],
      total: 1,
    } as ResourceHttpSuccess<'/api/breakdown', 'app'>;
  if (!def.by.length && def.measures.length === 1 && def.measures[0].fn === 'count' && def.measures[0].alias === 'value') {
    if (viewOverride && 'errors' in viewOverride && viewOverride.errors?.length !== undefined && !('view' in viewOverride))
      return viewOverride;
    const total = viewOverride && 'view' in viewOverride ? viewOverride.total : def.base === 'invoice' ? 7 : 0;
    return {
      breakdown: { ...def },
      resolved: [],
      ms: 1,
      offset: 0,
      columns: ['value'],
      rows: [{ value: total }],
      total: 1,
    } as ResourceHttpSuccess<'/api/breakdown', 'app'>;
  }
  return {
    breakdown: { ...def, limit: def.limit ?? 10 },
    resolved: [],
    ms: 1,
    offset: 0,
    columns: ['status', 'count'],
    rows: [
      { status: 'paid', count: 5 },
      { status: 'open', count: 2 },
    ],
    total: 2,
  } satisfies ResourceHttpSuccess<'/api/breakdown', 'app'>;
}
function viewDefinition(id: string, base: string, columns: string[]): HttpViewDefinition {
  return { id, name: id, base, columns: columns.map((path) => ({ path })) };
}
function viewResponse(
  view: HttpViewDefinition,
  over: Partial<ResourceHttpSuccess<'/api/view/run', 'app'>> = {},
): ResourceHttpSuccess<'/api/view/run', 'app'> {
  return {
    view,
    columns: view.columns.map((column) => column.alias ?? column.path),
    rows: [],
    resolved: [],
    joinCount: 0,
    errors: [],
    text: '',
    ms: 1,
    more: false,
    limit: view.limit ?? 10,
    offset: 0,
    ...over,
  };
}

const col = (name: string, type: string, extra = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
const customer: TableMeta = {
  id: 'customer',
  name: 'customer',
  schema: '',
  isView: false,
  indexed: ['id'],
  columns: [
    col('id', 'INTEGER', { primaryKey: true, nullable: false }),
    col('name', 'TEXT'),
    col('status', 'TEXT'),
  ] as TableMeta['columns'],
};
const invoice: TableMeta = {
  id: 'invoice',
  name: 'invoice',
  schema: '',
  isView: false,
  indexed: ['id'],
  columns: [
    col('id', 'INTEGER', { primaryKey: true, nullable: false }),
    col('customer_id', 'INTEGER'),
    col('total', 'NUMERIC'),
  ] as TableMeta['columns'],
};
const note: TableMeta = {
  id: 'note',
  name: 'note',
  schema: '',
  isView: false,
  indexed: ['id'],
  columns: [
    col('id', 'INTEGER', { primaryKey: true, nullable: false }),
    col('customer_id', 'INTEGER'),
    col('body', 'TEXT'),
  ] as TableMeta['columns'],
};
const unit: TableMeta = {
  id: 'unit',
  name: 'unit',
  schema: '',
  isView: false,
  indexed: ['id'],
  columns: [
    col('id', 'INTEGER', { primaryKey: true, nullable: false }),
    col('name', 'TEXT'),
    col('status', 'TEXT'),
    col('beds', 'INTEGER'),
    col('rent', 'NUMERIC'),
    col('balance', 'NUMERIC'),
    col('mileage', 'INTEGER'),
  ] as TableMeta['columns'],
};
const lease: TableMeta = {
  id: 'lease',
  name: 'lease',
  schema: '',
  isView: false,
  indexed: ['id'],
  columns: [
    col('id', 'INTEGER', { primaryKey: true, nullable: false }),
    col('unit_id', 'INTEGER'),
    col('name', 'TEXT'),
    col('rent', 'NUMERIC'),
    col('ends_on', 'DATE'),
  ] as TableMeta['columns'],
};
const tables: Record<string, TableMeta> = { customer, invoice, note, unit, lease };

vi.mock('../core.js', () => ({
  state: { activeConnection: 'demo', schema: { tables: Object.values(tables), foreignKeys: [] }, stack: [] },
  subscribeWalk: () => () => {},
  walkVersion: () => 0,
  api: async (
    path: string,
    body: { q?: string; view?: HttpViewDefinition; def?: HttpBreakdownDefinition; conn?: string; limit?: number; offset?: number },
  ) => {
    calls.push({ path, body });
    if (path === '/api/run') return { rows: matches[String(body.q)] ? [{ id: 4 }] : [] };
    if (path === '/api/view/run') {
      if (viewOverride) return viewOverride;
      const view = body.view;
      if (!view) throw new Error('Test request has no view.');
      const pick = rowsByBase?.[view.base] ?? viewRows;
      if (pick)
        return viewResponse(view, {
          rows: pick.map((row) =>
            Object.fromEntries(
              view.columns
                .filter((column) => Object.hasOwn(row, column.path))
                .map((column) => [column.alias ?? column.path, row[column.path]]),
            ),
          ),
          ...(viewTotal === undefined ? {} : { total: viewTotal, more: viewTotal > pick.length }),
        });
      if (view.id.endsWith(':fields'))
        return viewResponse(view, {
          rows: [
            {
              id: 4,
              name: contextLabel && view.columns.some((column) => column.path === 'status') ? contextLabel : 'Harbour Freight',
              status: 'active',
            },
          ],
        });
      if (view.id === 'count-invoices') return viewResponse(view, { rows: [{ id: 1 }], total: 7 });
      if (view.id.endsWith('-invoices'))
        return viewResponse(view, { columns: ['id', 'total'], rows: [{ id: 1001, total: 627.95 }], total: 1 });
      if (view.id.endsWith('-notes'))
        return viewResponse(view, { columns: ['id', 'body'], rows: [{ id: 9, body: 'Called back' }], total: 1 });
      return viewResponse(view);
    }
    if (path === '/api/breakdown') return breakdownReply(body.def);
    // The page's figures together (breakdownBatch.ts): each item answered as it would be alone.
    if (path === '/api/breakdowns') {
      return {
        results: (body as { items: Array<{ def?: HttpBreakdownDefinition }> }).items.map((item) => ({
          status: 200,
          body: breakdownReply(item.def),
        })),
      };
    }
    return {};
  },
  findTable: (id: string) => tables[id],
  writeAllowed: () => false,
  keyOf: (_t: TableMeta, row: Record<string, unknown>) => (row.id === undefined ? null : { id: row.id }),
  rowLabel: (_t: TableMeta, row: Record<string, unknown>) => String(row.name ?? row.id),
  labelPath: () => labelled,
  recordLabel: () => undefined,
  refsFrom: () => [],
  labelColumn,
  primaryKey,
  columnKind,
  columnDisplay: (_table: string, column: string) =>
    displays[column] ?? (moneyDisplay && column === 'total' ? { format: 'money', currency: 'USD' } : null),
  columnLabel: () => null,
  emptyWord: () => 'null',
  prefersPages: () => false,
  currentEntry: () => ({ kind: 'page' }),
  openRecord: (...a: unknown[]) => gone.push(['open', ...a]),
  go: (e: unknown, mode?: string) => gone.push(['go', e, mode]),
  tableView: (table: string, query: string, tab?: string) => ({ kind: 'table', table, query, tab }),
  quote: (v: unknown) => String(v),
  disclosure: (d: HTMLElement) => d,
  toast: () => {},
  loadJson: () => ({}),
  saveJson: () => {},
  el: (tag: string) => document.createElement(tag),
  viewportBox: (n: Element) => n.getBoundingClientRect(),
  viewportSize: () => ({ width: 1000, height: 800 }),
}));
vi.mock('../../../../mistri/src/client/appState.js', () => ({
  inAppMode: () => appMode,
  activeApp: () => appResource,
  appSaveMode: () => 'explicit',
}));
vi.mock('../insert.js', () => ({ canInsert: () => insertable, openRelatedRecord: vi.fn() }));
vi.mock('../write.js', () => ({
  canEditRow: () => editing,
  applyingStaged: () => false,
  whyNotEditable: () => null,
  subscribeStaged: () => () => {},
  stagedVersion: () => 0,
  sameRow: () => false,
  pendingCount: () => 0,
  stagedAttempt: () => undefined,
  stagedFeedback: () => undefined,
  stagedEditErrors: () => ({}),
  stagedDiscardVersion: () => 0,
  refreshEditValidation: () => {},
  cancelRecordAutosave: () => {},
  captureRecordAutosaveGuard: () => () => false,
  activateDraft: () => {},
  suspendDraft: () => {},
  draftNeedsReview: () => false,
  pendingColumns: () => [],
  stagedValue: () => undefined,
  registerInput: () => {},
  stage: () => {},
  booleanChoices: () => null,
  applyStaged: async () => {},
  discardStaged: () => {},
}));
vi.mock('../delete.js', () => ({ canDelete: () => false }));
vi.mock('../prefs.js', () => ({ relatedRows: () => 10 }));
vi.mock('../pagemarks.js', () => ({ isPinned: () => false, togglePinned: () => true }));
vi.mock('../thmenu.js', () => ({ openFilterMenu: () => {}, sortBy: () => {} }));
vi.mock('../nested.js', () => ({ hasChildren: () => false, resetNested: () => {} }));
vi.mock('../pins.js', () => ({ pinnedFor: () => [], pinsVersion: () => 0, subscribePins: () => () => {} }));

const { PageView } = await import('./Page.js');
const { defaultFieldPaths } = await import('../../../../engine/src/shared/recordReads.js');
const { isDestructive } = await import('./PageHead.js');

const page = {
  id: 'config-customer',
  name: 'Customer desk',
  base: 'customer',
  source: 'config' as const,
  sections: [
    { kind: 'fields' as const, paths: ['id', 'name'] },
    { kind: 'metric' as const, from: 'invoice', title: 'Invoices' },
    { kind: 'metric' as const, from: 'invoice', title: 'Broken' },
    { kind: 'breakdown' as const, from: 'invoice', by: 'status', path: 'customer_id', title: 'By status' },
    { kind: 'fields' as const, title: 'Converted to', paths: ['status'], when: 'status = converted' },
    { kind: 'list' as const, from: 'invoice', columns: ['id', 'total'] },
    { kind: 'list' as const, from: 'note', columns: ['id', 'body'] },
  ],
};
const plans: SectionPlan[] = [
  { index: 1, view: viewDefinition('count-invoices', 'invoice', ['id']), counts: true, query: 'invoice customer_id = 4' },
  { index: 2, error: 'invoice has no column called amount' },
  {
    index: 3,
    breakdown: {
      base: 'invoice',
      by: [{ path: 'status' }],
      measures: [{ fn: 'count' }],
      filter: { groups: [[{ path: 'customer_id', op: '=', value: 4 }]] },
    },
  },
  {
    index: 5,
    view: {
      ...viewDefinition('list-invoices', 'invoice', ['id', 'total']),
      filter: { groups: [[{ path: 'customer_id', op: '=', value: 4 }]] },
    },
  },
  { index: 6, view: viewDefinition('list-notes', 'note', ['id', 'body']) },
];

beforeEach(bridgeShell);

test('preview pins section reads to its connection and leaves only layout tabs interactive', async () => {
  const user = userEvent.setup();
  draw({ preview: { connection: 'preview-db' } });
  await screen.findByText('Harbour Freight');
  await user.click(screen.getByRole('tab', { name: 'note' }));
  await screen.findByText('Called back');
  expect(screen.queryByRole('button', { name: 'Copy layout' })).toBeNull();
  expect(document.querySelector('.page-field-grid')?.parentElement).toHaveAttribute('inert');
  expect(document.querySelector('.page-list-body')?.parentElement).toHaveAttribute('inert');
  expect(calls.length).toBeGreaterThan(3);
  expect(calls.every((call) => call.body.conn === 'preview-db')).toBe(true);
  expect(gone).toEqual([]);
});

function draw(over: Partial<Parameters<typeof PageView>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onLabel = vi.fn();
  const onTab = vi.fn();
  render(
    createElement(
      QueryClientProvider,
      { client },
      <PageView
        entry={{ kind: 'page', pageId: page.id, table: 'customer', key: { id: 4 }, label: '4' }}
        page={page}
        base={customer}
        plans={plans}
        others={[]}
        onLabel={onLabel}
        onTab={onTab}
        onLayout={() => {}}
        {...over}
      />,
    ),
  );
  return { client, onLabel, onTab };
}

beforeEach(() => {
  insertable = false;
  calls.length = 0;
  gone.length = 0;
  matches = {};
  contextLabel = undefined;
  appMode = false;
  editing = false;
  labelled = undefined;
  appResource = null;
  viewOverride = undefined;
  viewRows = undefined;
  rowsByBase = undefined;
  viewTotal = undefined;
  breakdownOverride = undefined;
  moneyDisplay = false;
  displays = {};
});
afterEach(() => {
  cleanup();
  configureAppTargetLinks(null);
  vi.unstubAllGlobals();
});

test('checked cross-App page note reads and binds the explicitly served source field', async () => {
  lockSessionIdentity();
  establishSessionIdentity({ signedIn: true, accountId: 'reader', appId: 'demo' });
  configureAppTargetLinks({ basePath: '/suite', appId: 'demo' });
  appMode = true;
  viewRows = [{ id: 4, name: '9007199254740993' }];
  const resolve = vi
    .fn()
    .mockResolvedValue({ ok: true, json: async () => ({ accountId: 'reader', href: '/suite/work/9007199254740993' }) });
  vi.stubGlobal('fetch', resolve);
  draw({
    plans: [],
    page: {
      ...page,
      sections: [
        {
          kind: 'note',
          text: 'Continue in Lender',
          action: {
            label: 'Open in Lender',
            to: { app: 'lender', kind: 'record', resource: 'application', key: { id: { column: 'name' } } },
          },
        },
      ],
    },
  });
  expect(await screen.findByRole('link', { name: 'Open in Lender' })).toHaveAttribute('href', '/suite/work/9007199254740993');
  expect(
    calls.some(
      (call) => call.path === '/api/view/run' && (call.body.view as HttpViewDefinition)?.columns.some((column) => column.path === 'name'),
    ),
  ).toBe(true);
  expect(JSON.parse(resolve.mock.calls[0][1].body).target.key).toEqual({ id: '9007199254740993' });
  expect(gone).toEqual([]);
});

test.each(['hidden', 'missing'] as const)('checked cross-App page note hides a %s source value', async (field) => {
  lockSessionIdentity();
  establishSessionIdentity({ signedIn: true, accountId: 'reader', appId: 'demo' });
  configureAppTargetLinks({ basePath: '/suite', appId: 'demo' });
  appMode = true;
  viewRows = [{ id: 4 }];
  const resolve = vi.fn();
  vi.stubGlobal('fetch', resolve);
  draw({
    plans: [],
    page: {
      ...page,
      sections: [
        {
          kind: 'note',
          text: 'Continue in Lender',
          action: {
            label: 'Open in Lender',
            to: { app: 'lender', kind: 'record', resource: 'application', key: { id: { column: field === 'hidden' ? 'secret' : 'name' } } },
          },
        },
      ],
    },
  });
  await act(async () => {});
  expect(screen.queryByRole('link', { name: 'Open in Lender' })).toBeNull();
  expect(resolve).not.toHaveBeenCalled();
  expect(
    calls.some(
      (call) => call.path === '/api/view/run' && (call.body.view as HttpViewDefinition)?.columns.some((column) => column.path === 'secret'),
    ),
  ).toBe(false);
});

test.each(['config', 'saved'] as const)(
  'App records keep their layout label, fields and business tabs without authoring controls (%s)',
  async (source) => {
    appMode = true;
    const onLayout = vi.fn();
    draw({ page: { ...page, source, listTabs: true }, others: [{ id: 'alternate', name: 'Alternate layout', source: 'saved' }], onLayout });
    await screen.findByText('Harbour Freight');
    expect(screen.getByText('Customer desk')).toHaveClass('page-title');
    const fieldRead = calls.find(
      (call) => call.path === '/api/view/run' && String((call.body.view as HttpViewDefinition)?.id).endsWith(':fields'),
    );
    expect(fieldRead?.body.count).toBe('none');
    expect(screen.queryByRole('button', { name: /^Page$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^(Copy layout|Layout)$/ })).toBeNull();
    expect(screen.queryByText('Alternate layout')).toBeNull();
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Note' }));
    await screen.findByText('Called back', { selector: 'td' });
    expect(onLayout).not.toHaveBeenCalled();
    expect(gone).toEqual([]);
  },
);

test('an App page lays its lists out as written: no tab strip unless it says listTabs, and a width is kept', async () => {
  appMode = true;
  const sections = page.sections.map((section) =>
    section.kind === 'list' && section.from === 'note' ? { ...section, width: 'half' as const } : section,
  );
  draw({ page: { ...page, sections: [...sections, { kind: 'list' as const, from: 'invoice', columns: ['id'], width: 'half' as const }] } });
  await screen.findByText('Harbour Freight');
  expect(screen.queryByRole('tablist')).toBeNull();
  expect(document.querySelectorAll('.page-list.width-half')).toHaveLength(2);
});

test('a list with a width never joins a strip, even where the page asks for tabs', async () => {
  appMode = true;
  draw({
    page: { ...page, listTabs: true, sections: [...page.sections.slice(0, -1), { ...page.sections.at(-1)!, width: 'half' as const }] },
  });
  await screen.findByText('Harbour Freight');
  expect(screen.queryByRole('tab', { name: 'Note' })).toBeNull();
  expect(document.querySelector('.page-list.width-half')).not.toBeNull();
});

/* Inside a strip an empty list is neither hidden nor collapsed: its tab shows it, and the strip already folds it. */
test('a list that hides when empty is still a tab of a strip, which is where an empty list stays', async () => {
  appMode = true;
  draw({
    page: {
      ...page,
      listTabs: true,
      sections: [
        ...page.sections,
        { kind: 'list' as const, from: 'invoice', title: 'Payoff quotes', columns: ['id'], emptyMode: 'hide' as const },
      ],
    },
  });
  await screen.findByText('Harbour Freight');
  expect(await screen.findByRole('tab', { name: 'Payoff quotes' })).not.toBeNull();
});

test('a Workbench page keeps its strip for lists the builder gave a width', async () => {
  const sections = page.sections.map((section) => (section.kind === 'list' ? { ...section, width: 'half' as const } : section));
  draw({ page: { ...page, sections: [...sections, { kind: 'list' as const, from: 'invoice', columns: ['id'], width: 'half' as const }] } });
  await screen.findByText('Harbour Freight');
  expect(await screen.findByRole('tablist')).not.toBeNull();
});

test.each(['config', 'saved'] as const)('Workbench retains the layout picker and authoring action (%s)', async (source) => {
  const user = userEvent.setup();
  const onLayout = vi.fn();
  draw({ page: { ...page, source }, others: [{ id: 'alternate', name: 'Alternate layout', source: 'saved' }], onLayout });
  await user.click(screen.getByRole('button', { name: source === 'saved' ? 'Layout' : 'Copy layout' }));
  expect(onLayout).toHaveBeenCalledOnce();
  await user.click(screen.getByRole('button', { name: /^Page$/ }));
  await user.click(screen.getByRole('option', { name: /Alternate layout/ }));
  expect(gone.at(-1)).toEqual(['go', expect.objectContaining({ pageId: 'alternate', key: { id: 4 } }), 'replace']);
});

test('App rootless chooser keeps its heading and business content without layout tools', () => {
  appMode = true;
  draw({ entry: { kind: 'page', pageId: page.id, table: 'customer' }, chooser: <button type="button">Choose customer</button> });
  expect(screen.getByRole('heading', { name: 'Customer desk' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Choose customer' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^Page$/ })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Copy layout' })).toBeNull();
});

test('a section that names no fields shows, in an App, what a reader reads: not a lone surrogate key, not a row version', () => {
  const lead = {
    ...customer,
    columns: [col('id', 'INTEGER', { primaryKey: true, nullable: false }), col('name', 'TEXT'), col('lock_version', 'INTEGER')],
  } as TableMeta;
  expect(defaultFieldPaths(lead, true)).toEqual(['name']);
  expect(defaultFieldPaths(lead, false)).toEqual(['id', 'name', 'lock_version']);
  const coded = { ...customer, columns: [col('code', 'TEXT', { primaryKey: true, nullable: false }), col('name', 'TEXT')] } as TableMeta;
  expect(defaultFieldPaths(coded, true)).toEqual(['code', 'name']);
});

describe('similar lists', () => {
  const like = { kind: 'list' as const, from: 'customer', path: '', title: 'Similar customers', similar: { same: ['status'] } };

  test('a record with nothing to match on says there are none, without a read and without blaming a reference', () => {
    draw({ page: { ...page, sections: [like] }, plans: [{ index: 0, empty: true }] });
    expect(screen.getByText('No similar customers yet.').closest('.page-group-empty')).toBeInTheDocument();
    expect(screen.queryByText(/to list through/)).toBeNull();
    expect(calls).toEqual([]);
  });

  test("a record with nothing to match on shows the list's own guidance when it has one", () => {
    const guided = { ...like, empty: { title: 'No peers on this account', description: 'Other deals appear here.' } };
    draw({ page: { ...page, sections: [guided] }, plans: [{ index: 0, empty: true }] });
    expect(screen.getByText('No peers on this account')).toBeInTheDocument();
    expect(screen.queryByText('No similar customers yet.')).toBeNull();
    expect(calls).toEqual([]);
  });

  test('the planned view is read as planned, its closest-first order included', async () => {
    viewRows = [{ id: 5, name: 'Harbour Supply' }];
    const view = {
      ...viewDefinition('page:similar', 'customer', ['id', 'name']),
      orderBy: [{ path: 'id', direction: 'asc' as const, near: 4 }],
    };
    draw({ page: { ...page, sections: [like] }, plans: [{ index: 0, view }] });
    expect(await screen.findByText('Harbour Supply')).toBeVisible();
    expect(calls.find((call) => call.path === '/api/view/run')?.body.view).toMatchObject({
      orderBy: [{ path: 'id', direction: 'asc', near: 4 }],
    });
  });
});

describe('related list options', () => {
  const invoices = { kind: 'list' as const, from: 'invoice', path: 'customer_id', title: 'Invoices', columns: ['id', 'total'] };
  const view = viewDefinition('page:customer:1', 'invoice', ['id', 'total']);

  /* The record itself is there; the lists beside it have no rows. */
  const allEmpty = () => {
    viewRows = undefined;
    rowsByBase = { customer: [{ id: 4, name: 'Harbour Freight', status: 'active' }], invoice: [], note: [] };
  };

  test("rowActions puts each row's own verbs in a ⋯ at its end, where the reader may run one", async () => {
    appMode = true;
    viewRows = [{ id: 1001, total: 627.95 }];
    const voidInvoice = { id: 'void', label: 'Void', command: { id: 'voidInvoice', version: 1, target: 'invoice', input: [] } };
    appResource = { resources: { invoice: { actions: [voidInvoice] } }, grantedCommands: ['voidInvoice'] };
    draw({ page: { ...page, sections: [{ ...invoices, rowActions: true }] }, plans: [{ index: 0, view }] });
    await waitFor(() => expect(document.querySelectorAll('.row-actions-trigger')).toHaveLength(1));
    expect(document.querySelector('.row-actions-trigger')).toHaveAttribute('aria-haspopup', 'menu');
    cleanup();
    // A reader granted none of them is offered no menu, as on the list view.
    appResource = { resources: { invoice: { actions: [voidInvoice] } }, grantedCommands: [] };
    draw({ page: { ...page, sections: [{ ...invoices, rowActions: true }] }, plans: [{ index: 0, view }] });
    await waitFor(() => expect(screen.getAllByText('627.95').length).toBeGreaterThan(0));
    expect(document.querySelector('.row-actions-trigger')).toBeNull();
  });

  test("a grouped list's tables draw the ⋯ row menu too, one on each group's rows", async () => {
    appMode = true;
    viewRows = [{ id: 1001, total: 627.95 }];
    const voidInvoice = { id: 'void', label: 'Void', command: { id: 'voidInvoice', version: 1, target: 'invoice', input: [] } };
    appResource = { resources: { invoice: { actions: [voidInvoice] } }, grantedCommands: ['voidInvoice'] };
    const groups = { base: 'invoice', by: [{ path: 'customer_id' }], measures: [{ fn: 'count', alias: 'group_rows' }], limit: 5 };
    breakdownOverride = {
      breakdown: { ...groups },
      resolved: [],
      ms: 1,
      offset: 0,
      columns: ['customer_id', 'group_rows'],
      rows: [{ customer_id: 4, group_rows: 1 }],
      total: 1,
    } as never;
    draw({
      page: { ...page, sections: [{ ...invoices, rowActions: true, group: { by: 'customer_id' } }] },
      plans: [{ index: 0, view, groups } as never],
    });
    await waitFor(() => expect(document.querySelectorAll('.row-actions-trigger')).toHaveLength(1));
  });

  test("a list of the record's children offers its Add, and the record's verbs it places in its head", async () => {
    appMode = true;
    insertable = true;
    viewRows = [{ id: 1001, total: 627.95 }];
    const fk = { name: 'customer_id', from: { table: 'invoice', columns: ['customer_id'] }, to: { table: 'customer', columns: ['id'] } };
    const { state } = (await import('../core.js')) as unknown as { state: { schema: { foreignKeys: unknown[] } } };
    const foreignKeys = state.schema.foreignKeys;
    foreignKeys.push(fk);
    try {
      // As a list view offers New: where the reader may add a row, through the child's own form, bound to the record.
      draw({ page: { ...page, sections: [invoices] }, plans: [{ index: 0, view }] });
      expect(await screen.findByRole('button', { name: '+ Add invoice' })).toBeVisible();
      cleanup();
      draw({ page: { ...page, sections: [{ ...invoices, noCreate: true }] }, plans: [{ index: 0, view }] });
      await waitFor(() => expect(screen.getAllByText('627.95').length).toBeGreaterThan(0));
      expect(screen.queryByRole('button', { name: '+ Add invoice' })).toBeNull();
      cleanup();
      // A verb the list places is in its head, quiet, and not in the record's; the list's own Add gives way to it.
      draw({
        page: { ...page, sections: [{ ...invoices, listActions: ['bill'] }] },
        plans: [{ index: 0, view }],
        actions: {
          list: [
            { id: 'bill', label: 'Bill now', set: { status: 'billed' } },
            { id: 'closeAccount', label: 'Close account', set: { status: 'closed' } },
          ] as never,
          matches: async () => true,
          canUpdate: true,
        },
      });
      const bill = await screen.findByRole('button', { name: 'Bill now' });
      expect(bill.closest('.page-related-create')).not.toBeNull();
      // The list's verbs stand in its heading's row, not on a row of their own under it.
      expect(bill.closest('.page-section-bar')?.querySelector(':scope > .page-section-head')).not.toBeNull();
      expect(bill).not.toHaveClass('primary');
      const close = await screen.findByRole('button', { name: 'Close account' });
      expect(close.closest('.page-head-actions')).not.toBeNull();
      expect(screen.getAllByRole('button', { name: 'Bill now' })).toHaveLength(1);
      expect(screen.queryByRole('button', { name: '+ Add invoice' })).toBeNull();
    } finally {
      foreignKeys.splice(foreignKeys.indexOf(fk), 1);
    }
  });

  test("empty: 'hide' leaves an empty list out of the page, and a list with rows in it", async () => {
    allEmpty();
    draw({
      page: {
        ...page,
        sections: [
          { kind: 'fields', paths: ['id', 'name'] },
          { ...invoices, emptyMode: 'hide' },
        ],
      },
      plans: [{ index: 1, view }],
    });
    await waitFor(() =>
      expect(
        calls.some((call) => call.path === '/api/view/run' && (call.body.view as HttpViewDefinition | undefined)?.id === view.id),
      ).toBe(true),
    );
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Invoices' })).toBeNull());
    expect(screen.queryByText('No invoices yet.')).toBeNull();
    expect(document.querySelector('.page-empty-run')).toBeNull();
    cleanup();
    viewRows = [{ id: 1001, total: 627.95 }];
    draw({
      page: {
        ...page,
        sections: [
          { kind: 'fields', paths: ['id', 'name'] },
          { ...invoices, emptyMode: 'hide' },
        ],
      },
      plans: [{ index: 1, view }],
    });
    expect(await screen.findByRole('heading', { name: 'Invoices' })).toBeVisible();
  });

  test("a grouped list composes with empty: 'hide' by its groups: no groups leaves it out, and a group brings it back", async () => {
    allEmpty();
    const groups = { base: 'invoice', by: [{ path: 'customer_id' }], measures: [{ fn: 'count', alias: 'group_rows' }], limit: 5 };
    const grouped = { ...invoices, emptyMode: 'hide' as const, group: { by: 'customer_id' } };
    const sections = [{ kind: 'fields' as const, paths: ['id', 'name'] }, grouped];
    const reply = (rows: unknown[]) =>
      ({
        breakdown: { ...groups },
        resolved: [],
        ms: 1,
        offset: 0,
        columns: ['customer_id', 'group_rows'],
        rows,
        total: rows.length,
      }) as never;
    breakdownOverride = reply([]);
    draw({ page: { ...page, sections }, plans: [{ index: 1, view, groups } as never] });
    await waitFor(() => expect(calls.some((call) => call.path === '/api/breakdown')).toBe(true));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Invoices' })).toBeNull());
    // The flat first page is never asked: the groups are the question.
    expect(calls.some((call) => call.path === '/api/view/run' && (call.body.view as HttpViewDefinition | undefined)?.id === view.id)).toBe(
      false,
    );
    cleanup();
    breakdownOverride = reply([{ customer_id: 4, group_rows: 2 }]);
    viewRows = [{ id: 1001, total: 627.95 }];
    draw({ page: { ...page, sections }, plans: [{ index: 1, view, groups } as never] });
    expect(await screen.findByRole('heading', { name: 'Invoices' })).toBeVisible();
    expect(await screen.findByRole('group')).toBeVisible();
  });

  describe('empty lists said once', () => {
    const notes = { kind: 'list' as const, from: 'note', path: 'customer_id', title: 'Notes', columns: ['id', 'body'] };
    const noteView = viewDefinition('page:customer:2', 'note', ['id', 'body']);
    const keys = [
      { name: 'customer_id', from: { table: 'invoice', columns: ['customer_id'] }, to: { table: 'customer', columns: ['id'] } },
      { name: 'note_customer_id', from: { table: 'note', columns: ['customer_id'] }, to: { table: 'customer', columns: ['id'] } },
    ];
    /* The reader may add a row of either list when the catalog says so: the door the page never takes away. */
    const withKeys = async (run: () => Promise<void>) => {
      const { state } = (await import('../core.js')) as unknown as { state: { schema: { foreignKeys: unknown[] } } };
      state.schema.foreignKeys.push(...keys);
      try {
        await run();
      } finally {
        for (const key of keys) state.schema.foreignKeys.splice(state.schema.foreignKeys.indexOf(key), 1);
      }
    };
    const plans = [
      { index: 1, view },
      { index: 2, view: noteView },
    ];

    test('side by side, collapsing lists are one line, with each Add where the reader may add', async () => {
      appMode = true;
      insertable = true;
      allEmpty();
      await withKeys(async () => {
        draw({
          page: {
            ...page,
            sections: [
              { kind: 'fields', paths: ['id', 'name'] },
              { ...invoices, emptyMode: 'collapse' },
              { ...notes, emptyMode: 'collapse' },
            ],
          },
          plans,
        });
        const line = await waitFor(() => {
          const found = document.querySelector('.page-empty-run');
          expect(found).not.toBeNull();
          return found as HTMLElement;
        });
        expect(line).toHaveTextContent('No invoices or notes yet');
        // One line, not a heading and an empty sentence under each of two lists.
        expect(document.querySelectorAll('.page-empty-run')).toHaveLength(1);
        expect(screen.queryByRole('heading', { name: 'Invoices' })).toBeNull();
        expect(screen.queryByRole('heading', { name: 'Notes' })).toBeNull();
        expect(within(line).getByRole('button', { name: '+ Add invoice' })).toBeVisible();
        expect(within(line).getByRole('button', { name: '+ Add note' })).toBeVisible();
      });
    });

    test('a list that offers an Add collapses rather than hides, and one that offers none is left out', async () => {
      appMode = true;
      allEmpty();
      const sections = [
        { kind: 'fields' as const, paths: ['id', 'name'] },
        { ...invoices, emptyMode: 'hide' as const },
      ];
      await withKeys(async () => {
        insertable = true;
        draw({ page: { ...page, sections }, plans: [plans[0]] });
        expect(await screen.findByText('No invoices yet')).toBeVisible();
        expect(screen.getByRole('button', { name: '+ Add invoice' })).toBeVisible();
        cleanup();
        insertable = false;
        draw({ page: { ...page, sections }, plans: [plans[0]] });
        await waitFor(() => expect(calls.some((call) => call.path === '/api/view/run')).toBe(true));
        await waitFor(() => expect(document.querySelector('.page-empty-run')).toBeNull());
        expect(screen.queryByText('No invoices yet')).toBeNull();
      });
    });

    test('a list with rows between two empty ones keeps them apart', async () => {
      appMode = true;
      viewRows = undefined;
      rowsByBase = {
        customer: [{ id: 4, name: 'Harbour Freight', status: 'active' }],
        invoice: [],
        note: [{ id: 9, body: 'Called back' }],
      };
      const third = { ...invoices, title: 'Credits' };
      draw({
        page: {
          ...page,
          sections: [
            { kind: 'fields', paths: ['id', 'name'] },
            { ...invoices, emptyMode: 'collapse' },
            { ...notes, emptyMode: 'collapse' },
            { ...third, emptyMode: 'collapse' },
          ],
        },
        plans: [...plans, { index: 3, view: viewDefinition('page:customer:3', 'invoice', ['id', 'total']) }],
      });
      expect(await screen.findByRole('heading', { name: 'Notes' })).toBeVisible();
      await waitFor(() => expect(document.querySelectorAll('.page-empty-run')).toHaveLength(2));
      const lines = [...document.querySelectorAll('.page-empty-run')].map((line) => line.textContent);
      expect(lines).toEqual(['No invoices yet', 'No credits yet']);
    });

    test('a tab that holds only empty lists keeps them in a line, not a blank panel', async () => {
      appMode = true;
      allEmpty();
      const user = userEvent.setup();
      draw({
        page: {
          ...page,
          sections: [
            { kind: 'fields', paths: ['id', 'name'], tab: 'Overview' },
            { ...invoices, emptyMode: 'hide', tab: 'Billing' },
          ],
        },
        plans: [plans[0]],
      });
      await user.click(await screen.findByRole('tab', { name: 'Billing' }));
      expect(await screen.findByText('No invoices yet')).toBeVisible();
    });
  });

  test('totals are read from their own planned measure and said in one footer row', async () => {
    viewRows = [{ id: 1001, total: 627.95 }];
    const totals = {
      base: 'invoice',
      by: [],
      measures: [{ fn: 'sum' as const, path: 'total', alias: 'total_0' }],
      filter: { groups: [[{ path: 'customer_id', op: '=' as const, value: 4 }]] },
      limit: 1,
    };
    draw({
      page: {
        ...page,
        sections: [
          { kind: 'fields', paths: ['id', 'name'] },
          { ...invoices, totals: ['total'] },
        ],
      },
      plans: [{ index: 1, view, totals }],
    });
    const footer = await screen.findByText('Total', { selector: '.grid-totals-label' });
    await waitFor(() => expect(footer.closest('tr')).toHaveTextContent(/4,812\.5/));
    expect(
      calls.find((call) => call.path === '/api/breakdown' && (call.body.def as { base?: string })?.base === 'invoice')?.body.def,
    ).toEqual(totals);
  });

  test("in an App a list of the record's children leaves out the column that points back at the record, which holds one value", async () => {
    appMode = true;
    viewRows = [{ id: 1001, customer_id: 4, total: 627.95 }];
    const back = { ...invoices, columns: ['id', 'customer_id', 'total'] };
    draw({
      page: { ...page, sections: [{ kind: 'fields', paths: ['id', 'name'] }, back] },
      plans: [{ index: 1, view: viewDefinition('page:customer:1', 'invoice', ['id', 'customer_id', 'total']) }],
    });
    const heads = await waitFor(() => {
      const found = [...document.querySelectorAll('.result-table th')].map((th) => th.textContent ?? '');
      expect(found.length).toBeGreaterThan(0);
      return found;
    });
    expect(heads.some((head) => /customer/i.test(head))).toBe(false);
    expect(heads.some((head) => /total/i.test(head))).toBe(true);
  });

  test('a footer that sums more rows than the list shows says what it is a total of', async () => {
    viewRows = [{ id: 1001, total: 627.95 }];
    viewTotal = 12;
    const totals = {
      base: 'invoice',
      by: [],
      measures: [{ fn: 'sum' as const, path: 'total', alias: 'total_0' }],
      filter: { groups: [[{ path: 'customer_id', op: '=' as const, value: 4 }]] },
      limit: 1,
    };
    draw({
      page: {
        ...page,
        sections: [
          { kind: 'fields', paths: ['id', 'name'] },
          { ...invoices, totals: ['total'] },
        ],
      },
      plans: [{ index: 1, view, totals }],
    });
    expect(await screen.findByText('Total · all 12 invoices', { selector: '.grid-totals-label' })).toBeVisible();
  });
});

describe('related record keys', () => {
  test.each([false, true])('omitted PK is fetched but hidden, and row clicks preserve its exact value (App=%s)', async (app) => {
    appMode = app;
    viewRows = [{ id: '9007199254740993', body: 'Follow-up recorded' }];
    const view = viewDefinition('related-records', 'note', ['body']);
    const before = structuredClone(view);
    draw({ page: { ...page, sections: [{ kind: 'list', from: 'note', columns: ['body'] }] }, plans: [{ index: 0, view }] });
    const grid = within(await screen.findByRole('grid'));
    const cell = await grid.findByText('Follow-up recorded');
    expect(screen.getAllByRole('columnheader').map((header) => header.textContent)).toEqual(['body']);
    expect(grid.queryByText('9007199254740993')).toBeNull();
    expect(calls[0].body.view).toMatchObject({ columns: [{ path: 'body' }, { path: 'id', alias: '__tw_key_0' }] });
    await userEvent.setup().click(cell);
    expect(gone.at(-1)).toEqual(['open', 'note', { id: '9007199254740993' }, '9007199254740993']);
    expect(view).toEqual(before);
  });

  test('App related summaries retain inferred names without displaying hidden navigation keys', async () => {
    appMode = true;
    const id = '80f10b3a8c783f909806af2b801a85d5';
    viewRows = [{ id, name: 'Northstar account', status: 'active' }];
    draw({
      page: { ...page, sections: [{ kind: 'list', from: 'customer', columns: ['name', 'status'] }] },
      plans: [{ index: 0, view: viewDefinition('related-accounts', 'customer', ['name', 'status']) }],
    });
    const title = await screen.findByRole('button', { name: 'Northstar account' });
    expect(screen.queryByText(id)).not.toBeInTheDocument();
    await userEvent.setup().click(title);
    expect(gone.at(-1)).toEqual([
      'open',
      'customer',
      { id },
      'Northstar account',
      'push',
      {
        records: [{ key: { id }, label: 'Northstar account' }],
        list: undefined,
      },
    ]);
  });

  test('aliased composite keys navigate using returned values, not filter constants or displayed names', async () => {
    const original = tables.note;
    tables.note = { ...note, columns: [...note.columns, col('tenant_id', 'TEXT', { primaryKey: true })] };
    try {
      viewRows = [{ id: '0007', tenant_id: 'north', body: 'Composite record' }];
      const view: HttpViewDefinition = {
        ...viewDefinition('related-composite', 'note', []),
        columns: [
          { path: 'body', alias: '__tw_key_1' },
          { path: 'id', alias: 'Record' },
        ],
        filter: { groups: [[{ path: 'tenant_id', op: '=', value: 'must-not-supply-key' }]] },
      };
      draw({ page: { ...page, sections: [{ kind: 'list', from: 'note' }] }, plans: [{ index: 0, view }] });
      await userEvent.setup().click(await screen.findByText('Composite record'));
      expect(gone.at(-1)).toEqual(['open', 'note', { id: '0007', tenant_id: 'north' }, '0007']);
      expect(screen.queryByText('north')).toBeNull();
      expect(screen.getAllByRole('columnheader').map((header) => header.textContent)).toEqual(['__tw_key_1', 'Record']);
    } finally {
      tables.note = original;
    }
  });

  test('keyless and incomplete rows do not fabricate navigation keys', async () => {
    const original = tables.note;
    try {
      for (const keyless of [true, false]) {
        tables.note = keyless ? { ...note, columns: note.columns.map((column) => ({ ...column, primaryKey: false })) } : note;
        viewRows = [{ body: 'No usable key' }];
        draw({
          page: { ...page, sections: [{ kind: 'list', from: 'note' }] },
          plans: [
            {
              index: 0,
              view: { ...viewDefinition('missing-key', 'note', ['body']), filter: { groups: [[{ path: 'id', op: '=', value: 123 }]] } },
            },
          ],
        });
        await userEvent.setup().click(await screen.findByText('No usable key'));
        expect(gone).toEqual([]);
        if (keyless) expect(calls.at(-1)?.body.view).toMatchObject({ columns: [{ path: 'body' }] });
        cleanup();
      }
    } finally {
      tables.note = original;
    }
  });
});

describe('typed section reads', () => {
  const kinds = ['fields', 'metric', 'breakdown', 'list', 'timeline'] as const;
  const invalidView = viewDefinition('invalid', 'invoice', ['id', 'total']);
  const fallback = {
    fields: 'These fields could not be read.',
    metric: 'This metric could not be read.',
    breakdown: 'These groups could not be read.',
    list: 'This list could not be read.',
    timeline: 'This activity stream could not be read.',
  };

  for (const withMessage of [true, false]) {
    test.each(kinds)(`%s handles an error-only HTTP 200 reply (diagnostic=${withMessage}) without fabricated data`, async (kind) => {
      const message = `Invalid ${kind} query.`;
      const failure = { errors: withMessage ? [{ message }] : [] };
      if (kind === 'breakdown') breakdownOverride = failure;
      else viewOverride = failure;
      // A metric with a breakdown reads its figure from it (below); this one reads the view.
      const plan: SectionPlan = {
        index: 0,
        view: invalidView,
        counts: true,
        ...(kind === 'breakdown' ? { breakdown: { base: 'invoice', by: [{ path: 'status' }], measures: [{ fn: 'count' as const }] } } : {}),
        streams: [{ from: 'invoice', at: 'created_at', show: 'id', view: invalidView }],
      };
      const { onLabel } = draw({ page: { ...page, sections: [{ kind, from: 'invoice', paths: ['name'] }] }, plans: [plan] });
      const problem = await screen.findByText(withMessage ? message : fallback[kind]);
      expect(problem.closest('.page-section')).toHaveClass('page-broken');
      expect(document.querySelector('.page-field-grid, .page-metric-value, .page-breakdown-rows, .page-list-body, .timeline')).toBeNull();
      expect(screen.queryByText('That record is no longer there.')).toBeNull();
      expect(onLabel).not.toHaveBeenCalled();
    });
  }

  test.each([
    { kind: 'metric' as const, message: 'This metric has no view definition.' },
    { kind: 'list' as const, message: 'This list has no view definition.' },
    { kind: 'breakdown' as const, message: 'This section has no breakdown definition.' },
  ])('a nonempty $kind missing its definition is broken, not loading or an unfiltered request', async ({ kind, message }) => {
    const { client } = draw({ page: { ...page, sections: [{ kind, from: 'invoice' }] }, plans: [{ index: 0 }] });
    expect(screen.getByText(message).closest('.page-section')).toHaveClass('page-broken');
    expect(calls).toEqual([]);
    // Even a manually refetched disabled query must not delegate an absent definition.
    const query = client.getQueryCache().find({ queryKey: [`page-${kind}`], exact: false });
    expect(query).toBeDefined();
    await act(async () => {
      await expect(query!.fetch()).rejects.toThrow(message);
    });
    expect(calls).toEqual([]);
  });

  test('a nonempty activity stream missing its view is broken without sending a request', async () => {
    draw({
      page: { ...page, sections: [{ kind: 'timeline', from: 'invoice' }] },
      plans: [{ index: 0, streams: [{ from: 'invoice', at: 'created_at', show: 'id' }] }],
    });
    expect(await screen.findByText('This activity stream has no view definition.')).toBeInTheDocument();
    expect(calls).toEqual([]);
  });

  test('an activity row says who wrote it, under the day it was written', async () => {
    viewRows = [{ created_at: '2026-09-01', total: 'Called back', customer_id: 'Maya Chen' }];
    const view = viewDefinition('activity', 'invoice', ['created_at', 'total', 'customer_id']);
    draw({
      page: { ...page, sections: [{ kind: 'timeline', from: 'invoice', title: 'Activity' }] },
      plans: [{ index: 0, streams: [{ from: 'invoice', at: 'created_at', show: 'total', by: 'customer_id', view }] }],
    });
    const row = (await screen.findByText('Called back')).closest('.timeline-row') as HTMLElement;
    // Who wrote it leads the row's header; a day alone has no time of day, and the day heads its rows.
    expect(within(row).getByText('Maya Chen')).toHaveClass('timeline-by');
    expect(row.querySelector('time')).toBeNull();
    const day = row.closest('.timeline-day')!.querySelector('.timeline-day-label')!;
    expect(day).toHaveAttribute('datetime', '2026-09-01');
    expect(day.textContent).not.toBe('2026-09-01');
  });

  test('a merged activity row names its resource by its noun and dresses its line by the display rules', async () => {
    appMode = true;
    moneyDisplay = true;
    appResource = { resources: { invoice: { noun: { one: 'bill', other: 'bills' } } } };
    viewRows = [{ created_at: '2026-09-01', total: 627.95, body: 'Called back' }];
    draw({
      page: { ...page, sections: [{ kind: 'timeline', from: 'invoice', title: 'Activity' }] },
      plans: [
        {
          index: 0,
          streams: [
            {
              from: 'invoice',
              at: 'created_at',
              show: 'id',
              detail: 'total',
              view: viewDefinition('bills', 'invoice', ['created_at', 'id', 'total']),
            },
            { from: 'note', at: 'created_at', show: 'body', view: viewDefinition('notes', 'note', ['created_at', 'body']) },
          ],
        },
      ],
    });
    await screen.findByText('Called back');
    const sources = [...document.querySelectorAll('.timeline-head')].map((head) => [
      head.querySelector('.timeline-source')?.textContent,
      head.querySelector('.timeline-kind')?.textContent,
    ]);
    // The noun where the resource gives one, the table as a person says it where not; the figure as money.
    expect(sources).toContainEqual(['Bill', '$627.95']);
    expect(sources).toContainEqual(['Note', undefined]);
  });

  test.each(['metric', 'list', 'breakdown'] as const)(
    'an explicitly empty %s plan remains empty without requesting a definition',
    (kind) => {
      draw({ page: { ...page, sections: [{ kind, from: 'invoice', of: 'owner' }] }, plans: [{ index: 0, empty: true }] });
      expect(calls).toEqual([]);
      expect(document.querySelector('.page-broken, .loading')).toBeNull();
      expect(document.querySelector(`.page-${kind}`)).toBeInTheDocument();
    },
  );

  test('a count metric is counted, never the rows a page of them returned', async () => {
    viewOverride = viewResponse(invalidView, { rows: [{ id: 1 }], total: 12 });
    draw({
      page: { ...page, sections: [{ kind: 'metric', from: 'invoice', title: 'Invoices' }] },
      plans: [{ index: 0, view: invalidView, counts: true }],
    });
    expect(await screen.findByText('12')).toHaveClass('metric-number');
    const asked = calls.find((call) => call.path === '/api/breakdown' || call.path === '/api/breakdowns');
    expect(asked?.body).toMatchObject({ def: { base: 'invoice', by: [], measures: [{ fn: 'count', alias: 'value' }] } });
  });

  test('a known zero count remains zero', async () => {
    viewOverride = viewResponse(invalidView, { total: 0 });
    draw({ page: { ...page, sections: [{ kind: 'metric', from: 'invoice' }] }, plans: [{ index: 0, view: invalidView, counts: true }] });
    expect(await screen.findByText('0')).toHaveClass('metric-number');
  });

  test.each([
    [{}, '3.33333333', '3.3'],
    [{ unit: 'of 5' }, '3.33333333', '3.3 of 5'],
    [{ format: 'percent' as const }, 53.84615, '53.8%'],
    [{ format: 'number' as const, unit: 'days' }, 4.25, '4.3 days'],
  ])("a page metric's figure is said as a dashboard's: %j over %s is %s", async (said, value, text) => {
    /* An account's "Satisfaction, 90 days (1–5)" averaged to "3.333", and a page metric took no format. */
    viewOverride = viewResponse(invalidView, { rows: [{ value }] });
    draw({
      page: { ...page, sections: [{ kind: 'metric', fn: 'avg', column: 'total', from: 'invoice', ...said }] },
      plans: [{ index: 0, view: invalidView }],
    });
    await waitFor(() => expect(document.querySelector('.page-metric-value:not([aria-hidden]) .metric-number')).not.toBeNull());
    expect(document.querySelector('.page-metric-value:not([aria-hidden]) .metric-number')!.textContent!.replace(/\u00a0/g, ' ')).toBe(text);
  });

  test.each([425111, 0, '9007199254740993'])('a monetary total respects its column format without rounding %s', async (value) => {
    moneyDisplay = true;
    viewOverride = viewResponse(invalidView, { rows: [{ value }] });
    draw({
      page: { ...page, sections: [{ kind: 'metric', fn: 'sum', column: 'total', from: 'invoice' }] },
      plans: [{ index: 0, view: invalidView }],
    });
    // The figure's box is held, unseen, while it is read (PageMetrics.tsx): the figure is the one that is not.
    await waitFor(() => expect(document.querySelector('.page-metric-value:not([aria-hidden]) .metric-number')).not.toBeNull());
    const said = document.querySelector('.page-metric-value:not([aria-hidden]) .metric-number')!.textContent!;
    if (typeof value === 'number') expect(said).toContain('$');
    else expect(said.replace(/[^0-9]/g, '')).toBe(value);
  });

  test('a narrowed sum reads its one figure from a keyless breakdown and reopens as the rows it measured', async () => {
    moneyDisplay = true;
    const filter = {
      groups: [
        [
          { path: 'customer_id', op: '=' as const, value: 4 },
          { path: 'status', op: '=' as const, value: 'open' },
        ],
      ],
    };
    breakdownOverride = {
      breakdown: { base: 'invoice', by: [], measures: [{ fn: 'sum', path: 'total', alias: 'value' }], filter, limit: 1 },
      resolved: [],
      ms: 1,
      offset: 0,
      columns: ['value'],
      rows: [{ value: 1250 }],
      total: 1,
    };
    draw({
      page: {
        ...page,
        sections: [{ kind: 'metric', fn: 'sum', column: 'total', from: 'invoice', path: 'customer_id', filter: 'status = open' }],
      },
      plans: [
        {
          index: 0,
          view: { ...invalidView, filter },
          query: 'invoice customer_id = 4 and status = open',
          breakdown: { base: 'invoice', by: [], measures: [{ fn: 'sum', path: 'total', alias: 'value' }], filter, limit: 1 },
        },
      ],
    });
    expect(await screen.findByText('$1,250')).toHaveClass('metric-number');
    expect(calls.filter((call) => call.path === '/api/breakdown')).toHaveLength(1);
    expect(
      calls.some((call) => call.path === '/api/view/run' && (call.body.view as HttpViewDefinition | undefined)?.id === 'invalid'),
    ).toBe(false);
    await userEvent.setup().click(screen.getByRole('button', { name: /\$1,250/ }));
    expect(gone).toContainEqual([
      'go',
      { kind: 'table', table: 'invoice', query: 'invoice customer_id = 4 and status = open', tab: undefined },
      'push',
    ]);
  });

  test("a breakdown says its bars in the author's format and unit, as a metric does (G111)", async () => {
    const def = { base: 'invoice', by: [{ path: 'status' }], measures: [{ fn: 'avg' as const, path: 'total' }] };
    breakdownOverride = {
      breakdown: { ...def, limit: 10 },
      resolved: [],
      ms: 1,
      offset: 0,
      columns: ['status', 'value'],
      rows: [
        { status: 'paid', value: 86.44 },
        { status: 'open', value: 40 },
      ],
      total: 2,
    };
    draw({
      page: {
        ...page,
        sections: [
          {
            kind: 'breakdown',
            title: 'Rate',
            from: 'invoice',
            by: 'status',
            path: 'customer_id',
            fn: 'avg',
            column: 'total',
            format: 'percent',
            unit: 'paid',
          },
        ],
      },
      plans: [{ index: 0, breakdown: def }],
    });
    expect(await screen.findByText('86.4% paid')).toHaveClass('pbd-count');
    expect(screen.getByText('40% paid')).toHaveClass('pbd-count');
  });

  test('a narrowed sum whose breakdown is refused says so in place', async () => {
    breakdownOverride = { errors: [{ message: 'Invalid measure.' }] };
    draw({
      page: { ...page, sections: [{ kind: 'metric', fn: 'sum', column: 'total', from: 'invoice' }] },
      plans: [
        { index: 0, view: invalidView, breakdown: { base: 'invoice', by: [], measures: [{ fn: 'sum', path: 'total', alias: 'value' }] } },
      ],
    });
    expect((await screen.findByText('Invalid measure.')).closest('.page-section')).toHaveClass('page-broken');
  });

  test('a list with no total pages using more, without claiming a total', async () => {
    viewOverride = viewResponse(invalidView, { rows: [{ id: 1, total: 12 }], more: true });
    const user = userEvent.setup();
    draw({
      page: { ...page, sections: [{ kind: 'list', from: 'invoice', limit: 1 }] },
      plans: [{ index: 0, view: { ...invalidView, limit: 1 } }],
    });
    expect(await screen.findByText('1–1')).toHaveClass('page-range');
    await user.click(screen.getByRole('button', { name: 'More rows' }));
    await waitFor(() => expect(calls.at(-1)?.body.offset).toBe(1));
    expect(await screen.findByText('2–2')).toHaveClass('page-range');
  });

  test('root-key bindings preserve a large integer string without coercion', async () => {
    const id = '9007199254740993';
    draw({
      page: { ...page, sections: [{ kind: 'fields', paths: ['name'] }] },
      plans: [],
      entry: { kind: 'page', pageId: page.id, key: { id } },
    });
    await screen.findByText('Harbour Freight');
    expect(calls[0].body.view).toMatchObject({ filter: { groups: [[{ path: 'id', op: '=', value: id }]] } });
  });
});

test.each([false, true])('Page fields honor column writability with resource editing enabled in app mode %s', async (app) => {
  editing = true;
  appMode = app;
  const base = { ...customer, columns: customer.columns.map((c) => ({ ...c, writable: c.name !== 'name' })) };
  draw({ base, page: { ...page, sections: [{ kind: 'fields', paths: ['id', 'name', 'status'] }] }, plans: [] });
  expect(await screen.findByText('Harbour Freight')).toBeVisible();
  expect(screen.queryByRole('textbox', { name: /name/i })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Edit Name' })).toBeNull();
  expect(screen.queryByRole('textbox', { name: /^id/i })).toBeNull();
  if (app) expect(screen.getByRole('button', { name: 'Edit Status' })).toBeVisible();
  else expect(screen.getByRole('textbox', { name: 'status (TEXT)' })).toHaveValue('active');
});

describe('the page', () => {
  test('a successful empty related list uses authored guidance', async () => {
    appMode = true;
    draw({
      page: {
        ...page,
        sections: [
          {
            kind: 'list',
            from: 'note',
            columns: ['id', 'body'],
            empty: { title: 'Add the first note', description: 'Keep the next teammate informed.' },
          },
        ],
      },
      plans: [{ index: 0, view: viewDefinition('empty', 'note', ['id', 'body']) }],
    });
    // The one empty block: a sentence on the section's edge, not a heading louder than the section.
    expect(await screen.findByText('Add the first note')).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Add the first note' })).toBeNull();
    expect(screen.getByText('Keep the next teammate informed.')).toBeVisible();
    expect(screen.queryByText('No related records yet.')).toBeNull();
  });

  test('a missing reference keeps its explanation instead of authored empty guidance', async () => {
    appMode = true;
    draw({
      page: {
        ...page,
        sections: [{ kind: 'list', from: 'note', of: 'manager_id', columns: ['id', 'body'], empty: { title: 'Add the first note' } }],
      },
      plans: [{ index: 0, empty: true }],
    });
    // Said as the reader would, with no header row over nothing.
    expect(await screen.findByText('No manager is set, so there are no notes to show.')).toBeVisible();
    expect(screen.queryByText('Add the first note')).toBeNull();
    expect(document.querySelector('.page-list thead')).toBeNull();
  });

  test.each([
    ['Decisions', 'No decisions yet.'],
    [undefined, 'No related records yet.'],
  ])('App empty lists use readable copy (%s)', async (title, message) => {
    appMode = true;
    draw({
      page: { ...page, sections: [{ kind: 'list', from: 'note', title, columns: ['id', 'body'] }] },
      plans: [{ index: 0, view: viewDefinition('empty', 'note', ['id', 'body']) }],
    });
    expect(await screen.findByText(message!)).toBeInTheDocument();
    expect(screen.queryByText('No note for this record.')).not.toBeInTheDocument();
  });

  test("names itself and its record, and the fields land with the row's name", async () => {
    const { onLabel } = draw();
    // The title is a picker: the suggested page is always there to switch to.
    expect(screen.getByText('Customer desk')).toHaveClass('page-title');
    expect(document.querySelector('.root-current')).toHaveTextContent('4');
    await screen.findByText('Harbour Freight');
    // Sent a microtask after the sections mount, with any others of that tick (pageFieldsRead.ts).
    const fieldRead = calls.find(
      (call) => call.path === '/api/view/run' && String((call.body.view as HttpViewDefinition)?.id).endsWith(':fields'),
    );
    expect(fieldRead?.body.count).toBe('none');
    expect(onLabel).toHaveBeenCalledWith('Harbour Freight');
    expect(document.querySelectorAll('.page-field')).toHaveLength(2);
  });

  test("in an App the head says the record's name, so its owning section stops repeating the field", async () => {
    appMode = true;
    labelled = 'name';
    const { onLabel } = draw();
    // The row has landed once the section names the record.
    await waitFor(() => expect(onLabel).toHaveBeenCalledWith('Harbour Freight'));
    const fields = [...document.querySelectorAll('.page-field dt')].map((dt) => dt.getAttribute('title'));
    expect(fields).toEqual(['id']);
    // Read-only here: the head is plain text, not an editor.
    expect(within(document.querySelector('.root-current') as HTMLElement).queryByRole('button')).toBeNull();
  });

  test('uses the configured local label for a record avatar without changing the heading name', async () => {
    appMode = true;
    labelled = 'name';
    appResource = { resources: { customer: { display: { name: { avatar: true } } } } };
    draw({ entry: { kind: 'page', pageId: page.id, table: 'customer', key: { id: 4 }, label: 'Harbour Freight' } });
    await screen.findByText('Harbour Freight');
    const avatar = document.querySelector('.page-record-avatar');
    expect(avatar).toHaveTextContent('HF');
    expect(avatar).toHaveAttribute('aria-hidden', 'true');
    expect(document.querySelector('.root-current')).toHaveTextContent('Harbour Freight');
  });

  test('does not make an avatar from the record key when its label is not loaded', () => {
    appMode = true;
    labelled = 'name';
    appResource = { resources: { customer: { display: { name: { avatar: true } } } } };
    draw({ entry: { kind: 'page', pageId: page.id, table: 'customer', key: { id: 4 } } });
    expect(document.querySelector('.page-record-avatar')).toBeNull();
  });

  test('where the name may be changed, the head is its editor', async () => {
    appMode = true;
    editing = true;
    labelled = 'name';
    appResource = { resources: { customer: { display: { name: { avatar: true } } } } };
    draw({ entry: { kind: 'page', pageId: page.id, table: 'customer', key: { id: 4 }, label: 'Harbour Freight' } });
    // The head is redrawn as the editor once the row lands, so it is read after, not before.
    await waitFor(() => expect(document.querySelector('.root-current [aria-label^="Edit"]')).not.toBeNull());
    const head = document.querySelector('.root-current') as HTMLElement;
    expect(within(head).getByRole('button', { name: /^Edit /i })).toHaveTextContent('Harbour Freight');
    expect(head).toHaveAttribute('role', 'heading');
    expect(document.querySelector('.page-record-avatar')).toHaveTextContent('HF');
    expect([...document.querySelectorAll('.page-field dt')].map((dt) => dt.getAttribute('title'))).not.toContain('name');
  });

  test('a run of metrics is one strip; a metric opens what it counted; a broken one is named in place', async () => {
    const user = userEvent.setup();
    draw();
    const strip = document.querySelector('.page-metric-row')!;
    expect(strip).toBeInTheDocument();
    const value = await within(strip as HTMLElement).findByTitle('Open the invoice this counted');
    expect(value).toHaveTextContent('7');
    await user.click(value);
    expect(gone[0]).toEqual(['go', { kind: 'table', table: 'invoice', query: 'invoice customer_id = 4', tab: undefined }, 'push']);
    const broken = within(strip as HTMLElement)
      .getByText('invoice has no column called amount')
      .closest('.page-section')!;
    expect(broken).toHaveClass('page-broken');
    expect(within(broken as HTMLElement).getByRole('heading', { level: 2 })).toHaveTextContent('Broken');
  });

  test('a breakdown ranks its groups against the whole, and a group is a doorway', async () => {
    const user = userEvent.setup();
    draw();
    const paid = await screen.findByTitle('Open invoice where status = paid');
    expect(within(paid).getByText('5')).toBeInTheDocument();
    await user.click(paid);
    expect(gone.at(-1)).toEqual([
      'go',
      { kind: 'table', table: 'invoice', query: 'invoice customer_id = 4 and status = paid', tab: undefined },
      'push',
    ]);
  });

  test('a section with a when is there only while the record satisfies it', async () => {
    matches = {};
    draw();
    await screen.findByText('Harbour Freight');
    await vi.waitFor(() => expect(calls.some((c) => c.path === '/api/run')).toBe(true));
    expect(screen.queryByText('Converted to')).toBeNull();
    cleanup();
    matches = { 'customer id = 4 and status = converted': true };
    draw();
    expect(await screen.findByText('Converted to')).toBeInTheDocument();
  });

  test('a run of lists is a tab strip, and a tab is fetched when opened', async () => {
    const user = userEvent.setup();
    const { onTab } = draw();
    const strip = await screen.findByRole('tablist', { name: 'Related lists' });
    const tabs = within(strip).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['invoice', 'note']);
    await screen.findByText('627.95');
    expect(calls.filter((c) => (c.body.view as { id?: string })?.id === 'list-notes')).toHaveLength(0);
    const panels = document.querySelectorAll('.page-tabpanel');
    expect(panels[1]).toHaveAttribute('inert');
    expect(panels[1]).toHaveAttribute('aria-hidden', 'true');
    expect(panels[1]).toHaveAttribute('tabindex', '-1');
    await user.click(tabs[1]);
    expect(await screen.findByText('Called back')).toBeInTheDocument();
    expect(onTab).toHaveBeenCalledWith('note');
    expect(panels[0]).toHaveAttribute('inert');
    expect(panels[0]).toHaveAttribute('aria-hidden', 'true');
    expect(panels[1]).not.toHaveAttribute('inert');
    expect(panels[1]).toHaveAttribute('aria-hidden', 'false');
    await user.keyboard('{ArrowLeft}');
    expect(onTab).toHaveBeenLastCalledWith(undefined);
  });

  test('the chooser is drawn into the body, when no record is chosen', () => {
    draw({ entry: { kind: 'page', pageId: page.id, table: 'customer' }, chooser: 'the list' });
    expect(screen.getByText('the list')).toHaveClass('page-body');
    expect(document.querySelector('.root-current')).toBeNull();
  });
});

describe('record context region', () => {
  test('a host that rebuilds page and key objects on every label settles instead of republishing forever', async () => {
    /* The record modal re-renders on each label it is handed and, at the
       time of the bug, rebuilt its page and entry per render; with an aside
       in play the label memo restarted each time and the two fed each other. */
    const split: PageDef = {
      ...page,
      sections: [
        { kind: 'fields', title: 'Record', paths: ['name'] },
        { kind: 'fields', region: 'aside', title: 'Context', paths: ['status'] },
      ],
    };
    const published = vi.fn();
    function Host() {
      const [name, setName] = useState('');
      return (
        <>
          <output data-testid="host-name">{name}</output>
          <PageView
            entry={{ kind: 'page', pageId: page.id, table: 'customer', key: { id: 4 }, label: '4' }}
            page={{ ...split, sections: split.sections.map((section) => ({ ...section })) }}
            base={customer}
            plans={[]}
            others={[]}
            onLabel={(next) => {
              published(next);
              setName(next);
            }}
            onTab={() => {}}
            onLayout={() => {}}
          />
        </>
      );
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(createElement(QueryClientProvider, { client }, <Host />));
    await screen.findByText('Harbour Freight');
    await waitFor(() => expect(screen.getByTestId('host-name')).toHaveTextContent('Harbour Freight'));
    expect(published).toHaveBeenCalledExactlyOnceWith('Harbour Freight');
  });

  test('partitions original indices in main-first reading order without extra requests or competing labels', async () => {
    const split: PageDef = {
      ...page,
      sections: [
        { kind: 'fields', region: 'aside', title: 'Context', paths: ['status'] },
        { kind: 'fields', title: 'Record', paths: ['name'] },
        { kind: 'fields', region: 'aside', title: 'Hidden context', hidden: true },
        { kind: 'metric', region: 'aside', title: 'Invoices', from: 'invoice' },
        { kind: 'breakdown', title: 'By status', from: 'invoice', by: 'status', path: 'customer_id' },
      ],
    };
    const { onLabel } = draw({
      page: split,
      plans: [
        { ...plans[0], index: 3 },
        { ...plans[2], index: 4 },
      ],
    });
    const aside = screen.getByRole('complementary', { name: 'Record context' });
    const main = document.querySelector('.page-main')!;
    await within(main as HTMLElement).findByText('Harbour Freight');
    await within(aside).findByText('active');
    await within(aside).findByText('7');
    expect(within(main as HTMLElement).getByText('By status')).toBeInTheDocument();
    expect(document.querySelector('.page-layout')?.children[0]).toBe(main);
    expect(document.querySelector('.page-layout')?.children[1]).toBe(aside);
    expect(screen.queryByText('Hidden context')).toBeNull();
    expect(onLabel).toHaveBeenCalledExactlyOnceWith('Harbour Freight');
    // Both fields sections read the one row together: one request asking every column either named.
    const fieldReads = calls.filter((call) => (call.body.view as { id?: string })?.id?.endsWith(':fields'));
    expect(fieldReads).toHaveLength(1);
    expect(
      (fieldReads[0].body.view as HttpViewDefinition).columns.map((column) => (typeof column === 'string' ? column : column.path)).sort(),
    ).toEqual(['name', 'status']);
    // The count and the breakdown are the page's figures, asked in one request (breakdownBatch.ts).
    const figures = calls.filter((call) => call.path === '/api/breakdowns' || call.path === '/api/breakdown');
    expect(figures).toHaveLength(1);
    expect((figures[0].body as { items?: unknown[] }).items).toHaveLength(2);
    expect(document.querySelector('.page-head')?.closest('.page-layout')).toBeNull();
  });

  const tabbed: PageDef = {
    ...page,
    sections: [
      { kind: 'fields', paths: ['name'] },
      { kind: 'list', from: 'invoice', title: 'Invoices' },
      { kind: 'list', region: 'aside', from: 'invoice', title: 'Invoices' },
      { kind: 'list', from: 'note', title: 'Notes' },
      { kind: 'list', region: 'aside', from: 'note', title: 'Notes' },
    ],
  };
  const tabPlans: SectionPlan[] = [
    { index: 1, view: viewDefinition('main-invoices', 'invoice', ['id', 'total']) },
    { index: 2, view: viewDefinition('aside-invoices', 'invoice', ['id', 'total']) },
    { index: 3, view: viewDefinition('main-notes', 'note', ['id', 'body']) },
    { index: 4, view: viewDefinition('aside-notes', 'note', ['id', 'body']) },
  ];
  test('main and aside tabs have unique DOM identities and independent lazy fetching and keyboard focus', async () => {
    const user = userEvent.setup();
    const { onTab } = draw({ page: tabbed, plans: tabPlans });
    await screen.findAllByText('627.95');
    const main = document.querySelector('.page-main')!;
    const aside = screen.getByRole('complementary', { name: 'Record context' });
    const tabs = screen.getAllByRole('tab');
    expect(new Set(tabs.map((tab) => tab.id)).size).toBe(4);
    for (const tab of tabs) {
      const panel = document.getElementById(tab.getAttribute('aria-controls')!)!;
      expect(panel).toHaveAttribute('aria-labelledby', tab.id);
      expect(panel.closest('.page-body')).toBe(tab.closest('.page-body'));
    }
    expect(calls.some((call) => String((call.body.view as { id?: string })?.id).endsWith('-notes'))).toBe(false);
    const asideNotes = within(aside).getByRole('tab', { name: 'Notes' });
    await user.click(asideNotes);
    await within(aside).findByText('Called back');
    expect(onTab).toHaveBeenLastCalledWith('section:4');
    expect(calls.some((call) => (call.body.view as { id?: string })?.id === 'main-notes')).toBe(false);
    expect(within(main as HTMLElement).getByRole('tab', { name: 'Invoices' })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowLeft}');
    expect(within(aside).getByRole('tab', { name: 'Invoices' })).toHaveFocus();
    expect(onTab).toHaveBeenLastCalledWith('section:2');
  });

  test('secondary tab URLs restore the addressed region without selecting a matching label in main', async () => {
    draw({ page: tabbed, plans: tabPlans, entry: { kind: 'page', pageId: page.id, table: 'customer', key: { id: 4 }, tab: 'section:4' } });
    const aside = screen.getByRole('complementary', { name: 'Record context' });
    await within(aside).findByText('Called back');
    expect(within(aside).getByRole('tab', { name: 'Notes' })).toHaveAttribute('aria-selected', 'true');
    expect(calls.some((call) => (call.body.view as { id?: string })?.id === 'aside-invoices')).toBe(false);
    expect(calls.some((call) => (call.body.view as { id?: string })?.id === 'main-notes')).toBe(false);
  });

  test('hidden aside sections leave the original page layout and the chooser unchanged', async () => {
    const hidden: PageDef = {
      ...page,
      sections: [
        { kind: 'fields', paths: ['name'] },
        { kind: 'fields', region: 'aside', hidden: true },
      ],
    };
    draw({ page: hidden });
    await screen.findByText('Harbour Freight');
    expect(document.querySelector('.page-layout')).toBeNull();
    expect(screen.queryByRole('complementary')).toBeNull();
    cleanup();
    draw({ page: tabbed, entry: { kind: 'page', pageId: page.id }, chooser: 'Choose a record' });
    expect(screen.getByText('Choose a record')).toHaveClass('page-body');
    expect(document.querySelector('.page-layout')).toBeNull();
  });

  test('an aside-only fields page can still supply its record label', async () => {
    const { onLabel } = draw({ page: { ...page, sections: [{ kind: 'fields', region: 'aside', paths: ['name'] }] }, plans: [] });
    await within(screen.getByRole('complementary', { name: 'Record context' })).findByText('Harbour Freight');
    expect(onLabel).toHaveBeenCalledExactlyOnceWith('Harbour Freight');
  });

  test('a gated main section does not prevent an aside from supplying the record label', async () => {
    const { onLabel } = draw({
      page: {
        ...page,
        sections: [
          { kind: 'fields', paths: ['name'], when: 'status = converted' },
          { kind: 'fields', region: 'aside', paths: ['name'] },
        ],
      },
      plans: [],
    });
    await within(screen.getByRole('complementary', { name: 'Record context' })).findByText('Harbour Freight');
    expect(onLabel).toHaveBeenCalledExactlyOnceWith('Harbour Freight');
    expect(document.querySelector('.page-main')).toBeEmptyDOMElement();
    expect(calls.filter((call) => (call.body.view as { id?: string })?.id?.endsWith(':fields'))).toHaveLength(1);
  });

  test('a main label releases ownership when its section is gated off and resumes when shown', async () => {
    contextLabel = 'Initial context name';
    const { client, onLabel } = draw({
      page: {
        ...page,
        sections: [
          { kind: 'fields', paths: ['name'], when: 'status = converted' },
          { kind: 'fields', region: 'aside', paths: ['status'] },
        ],
      },
      plans: [],
    });
    await within(screen.getByRole('complementary', { name: 'Record context' })).findByText('active');
    expect(onLabel).toHaveBeenLastCalledWith('Initial context name');
    const gate = ['when', customer.id, { id: 4 }, 'status = converted'];
    act(() => {
      client.setQueryData(gate, true);
    });
    await screen.findByText('Harbour Freight');
    expect(onLabel).toHaveBeenLastCalledWith('Harbour Freight');

    act(() => {
      client.setQueryData(gate, false);
    });
    await waitFor(() => expect(document.querySelector('.page-main')).toBeEmptyDOMElement());
    expect(onLabel).toHaveBeenLastCalledWith('Initial context name');
    contextLabel = 'Refreshed context name';
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['page-fields', page.id, customer.id, { id: 4 }, ['status']] });
    });
    await waitFor(() => expect(onLabel).toHaveBeenLastCalledWith('Refreshed context name'));

    act(() => {
      client.setQueryData(gate, true);
    });
    await screen.findByText('Harbour Freight');
    expect(onLabel).toHaveBeenLastCalledWith('Harbour Freight');
  });
});

test('a facts line says the values alone, and a sheet leaves out a value the record lacks', async () => {
  viewRows = [{ id: 4, name: 'Harbour Freight', status: 'active' }];
  draw({
    page: {
      ...page,
      sections: [
        { kind: 'fields' as const, paths: ['id', 'name'] },
        { kind: 'fields' as const, title: 'Key facts', paths: ['name', 'status', 'email'], presentation: 'facts' as const },
        { kind: 'fields' as const, title: 'The record', paths: ['name', 'status', 'email'], presentation: 'table' as const, columns: 2 },
      ],
    },
    plans: [],
  });
  const facts = await screen.findByRole('list', { name: 'Key facts' });
  const items = [...facts.querySelectorAll('li')];
  expect(items).toHaveLength(2);
  expect(items[0]).toHaveTextContent('Harbour Freight');
  expect(items[0].querySelector('.visually-hidden')).toHaveTextContent('Name:');
  const sheet = document.querySelector('.page-sheet')!;
  expect([...sheet.querySelectorAll('dt')].map((dt) => dt.textContent)).toEqual(['Name', 'Status']);
  expect(sheet).toHaveStyle({ '--page-sheet-columns': '2' });
});

test('a facts line names the record a reference points at, one hop away or two, never its key', async () => {
  const { state } = (await import('../core.js')) as unknown as { state: { schema: { tables: TableMeta[]; foreignKeys: unknown[] } } };
  const department: TableMeta = {
    id: 'department',
    name: 'department',
    schema: '',
    isView: false,
    indexed: ['id'],
    columns: [col('id', 'INTEGER', { primaryKey: true, nullable: false }), col('name', 'TEXT')] as TableMeta['columns'],
  };
  const employee: TableMeta = {
    id: 'employee',
    name: 'employee',
    schema: '',
    isView: false,
    indexed: ['id'],
    columns: [
      col('id', 'INTEGER', { primaryKey: true, nullable: false }),
      col('name', 'TEXT'),
      col('department_id', 'INTEGER', { references: { table: 'department', column: 'id' } }),
      col('manager_id', 'INTEGER', { references: { table: 'employee', column: 'id' } }),
    ] as TableMeta['columns'],
  };
  const before = { tables: state.schema.tables, foreignKeys: state.schema.foreignKeys };
  Object.assign(tables, { department, employee });
  state.schema.tables = [...before.tables, department, employee];
  state.schema.foreignKeys = [
    { name: 'employee_department', from: { table: 'employee', columns: ['department_id'] }, to: { table: 'department', columns: ['id'] } },
    { name: 'employee_manager', from: { table: 'employee', columns: ['manager_id'] }, to: { table: 'employee', columns: ['id'] } },
  ];
  try {
    appMode = true;
    labelled = 'name';
    viewRows = [
      {
        id: 7,
        name: 'Ava Chen',
        department_id: 1,
        'department_id.name': 'Finance',
        'manager_id.department_id': 5,
        'manager_id.department_id.name': 'Operations',
      },
    ];
    draw({
      page: {
        ...page,
        base: 'employee',
        sections: [
          {
            kind: 'fields' as const,
            title: 'Key facts',
            paths: ['department_id', 'manager_id.department_id'],
            presentation: 'facts' as const,
          },
        ],
      },
      base: employee,
      plans: [],
    });
    const facts = await screen.findByRole('list', { name: 'Key facts' });
    expect([...facts.querySelectorAll('.ref-jump-value')].map((value) => value.textContent)).toEqual(['Finance', 'Operations']);
    expect(facts).not.toHaveTextContent('1');
    expect(facts).not.toHaveTextContent('5');
    const read = calls.find((call) => String((call.body.view as HttpViewDefinition | undefined)?.id).endsWith(':fields'));
    expect((read!.body.view as HttpViewDefinition).columns.map((column) => column.path)).toEqual(
      expect.arrayContaining(['department_id.name', 'manager_id.department_id.name']),
    );
  } finally {
    state.schema.tables = before.tables;
    state.schema.foreignKeys = before.foreignKeys;
    delete tables.department;
    delete tables.employee;
  }
});

test('sections named into tabs are one strip where the first stands; a panel keeps its headings and fetches lists when opened', async () => {
  const user = userEvent.setup();
  draw({
    page: {
      ...page,
      sections: [
        { kind: 'fields' as const, paths: ['id', 'name'] },
        { kind: 'fields' as const, title: 'Standing', paths: ['status'], tab: 'Details' },
        { kind: 'list' as const, from: 'invoice', title: 'Invoices', columns: ['id', 'total'], tab: 'Money' },
        { kind: 'list' as const, from: 'note', title: 'Notes', columns: ['id', 'body'], tab: 'Details' },
      ],
    },
    plans: [
      { index: 2, view: viewDefinition('list-invoices', 'invoice', ['id', 'total']) },
      { index: 3, view: viewDefinition('list-notes', 'note', ['id', 'body']) },
    ],
  });
  const strip = await screen.findByRole('tablist', { name: 'Record sections' });
  expect(
    within(strip)
      .getAllByRole('tab')
      .map((tab) => tab.textContent),
  ).toEqual(['Details', 'Money']);
  // The untabbed fields stand before the strip, as they were written.
  expect(document.querySelector('.page-body > .page-tabs-sections')?.previousElementSibling).toHaveClass('page-section');
  const details = screen.getByRole('tabpanel', { name: 'Details' });
  expect(await within(details).findByText('Called back')).toBeVisible();
  expect(within(details).getByText('Standing')).toBeVisible();
  // A panel's lists stack; a strip of lists inside a strip of sections would be tabs in tabs.
  expect(within(details).queryByRole('tablist')).toBeNull();
  const invoices = () => calls.some((call) => (call.body.view as HttpViewDefinition | undefined)?.id === 'list-invoices');
  expect(invoices()).toBe(false);
  await user.click(within(strip).getByRole('tab', { name: 'Money' }));
  await waitFor(() => expect(invoices()).toBe(true));
  expect(screen.getByRole('tab', { name: 'Money' })).toHaveAttribute('aria-selected', 'true');
});

test("a tab panel holding the record's fields is drawn at once, hidden, and one tab name alone draws no strip", async () => {
  draw({
    page: {
      ...page,
      sections: [
        { kind: 'list' as const, from: 'note', title: 'Notes', columns: ['id', 'body'], tab: 'Activity' },
        { kind: 'fields' as const, title: 'Standing', paths: ['status'], tab: 'Details' },
      ],
    },
    plans: [{ index: 0, view: viewDefinition('list-notes', 'note', ['id', 'body']) }],
  });
  await screen.findByText('Called back');
  await waitFor(() => expect(document.querySelector('.page-tabpanel[hidden] .page-field')).not.toBeNull());
  cleanup();
  draw({
    page: {
      ...page,
      sections: [
        { kind: 'fields' as const, title: 'Standing', paths: ['status'], tab: 'Details' },
        { kind: 'fields' as const, title: 'Hidden', paths: ['name'], tab: 'Other', hidden: true },
      ],
    },
    plans: [],
  });
  await screen.findByText('Standing');
  expect(screen.queryByRole('tablist')).toBeNull();
});

test('a record that is gone is said once, for the whole page, with nothing offered to do to it', async () => {
  appMode = true;
  viewRows = [];
  draw({
    actions: {
      list: [{ id: 'closeAccount', label: 'Close account', set: { status: 'closed' } }] as never,
      matches: async () => true,
      canUpdate: true,
    },
  });
  await screen.findByText('This customer no longer exists. It may have been deleted.');
  // The name the link carried is not the heading of a record that is not there.
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Customer not found');
  expect(screen.getByRole('button', { name: 'Back to the customer list' })).toBeInTheDocument();
  // Not once per section, and no verbs in the head.
  expect(screen.queryByText('That record is no longer there.')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Close account' })).toBeNull();
});

test('a property rail keeps an empty field, where a value is set, and edits each writable one in place', async () => {
  editing = true;
  appMode = true;
  viewRows = [{ id: 4, name: 'Harbour Freight', status: 'active' }];
  const base = { ...customer, columns: [...customer.columns, col('email', 'TEXT')] as TableMeta['columns'] };
  draw({
    base,
    page: {
      ...page,
      sections: [
        { kind: 'fields' as const, title: 'Properties', paths: ['status', 'email', 'id'], presentation: 'properties' as const, columns: 2 },
      ],
    },
    plans: [],
  });
  const status = await screen.findByRole('button', { name: 'Edit Status' });
  const rail = document.querySelector('dl.page-properties')!;
  expect(rail).toContainElement(status);
  expect([...rail.querySelectorAll('dt')].map((dt) => dt.textContent)).toEqual(['status', 'email', 'id']);
  expect(within(rail as HTMLElement).getByRole('button', { name: 'Edit Email' })).toBeVisible();
  // The key is a property, never an editor.
  expect(within(rail as HTMLElement).queryByRole('button', { name: 'Edit Id' })).toBeNull();
  expect(rail).toHaveStyle({ '--page-properties-columns': '2' });
  expect(document.querySelector('.page-field-grid')).toBeNull();
});

test('a property rail of one field keeps its caption, where a titled group of one lets the title say it', async () => {
  viewRows = [{ id: 4, name: 'Harbour Freight', status: 'active' }];
  draw({
    page: {
      ...page,
      sections: [
        { kind: 'fields' as const, title: 'Standing', paths: ['status'], presentation: 'properties' as const },
        { kind: 'fields' as const, title: 'Called', paths: ['name'] },
      ],
    },
    plans: [],
  });
  await waitFor(() => expect(document.querySelector('dl.page-properties')).not.toBeNull());
  const rail = document.querySelector('dl.page-properties')!;
  const caption = rail.querySelector('dt')!;
  expect(caption).toHaveTextContent('status');
  expect(caption).not.toHaveClass('visually-hidden');
  expect(document.querySelector('dl.page-field-grid dt')).toHaveClass('visually-hidden');
});

test("long text in a property rail stands under its caption at the rail's width, and alone under its title", async () => {
  const long = 'A sturdy freight forwarder on the north quay, open late on weekdays, with a loading bay for two trucks at once.';
  viewRows = [{ id: 4, name: long, status: 'active' }];
  draw({
    page: {
      ...page,
      sections: [
        { kind: 'fields' as const, title: 'Standing', paths: ['status', 'name'], presentation: 'properties' as const },
        { kind: 'fields' as const, title: 'About', paths: ['name'], presentation: 'properties' as const },
      ],
    },
    plans: [],
  });
  await waitFor(() => expect(document.querySelectorAll('dl.page-properties')).toHaveLength(2));
  const [standing, about] = [...document.querySelectorAll('dl.page-properties')];
  const fields = [...standing!.querySelectorAll('.page-field')];
  // A short value stays beside its caption; the long one goes under it.
  expect(fields[0]).not.toHaveClass('page-field-wide');
  expect(fields[1]).toHaveClass('page-field-wide');
  expect(fields[1]!.querySelector('dt')).not.toHaveClass('visually-hidden');
  // Alone under a title, the title says its caption, as a document's paragraph.
  expect(about!.querySelector('.page-field')).toHaveClass('page-field-wide');
  expect(about!.querySelector('dt')).toHaveClass('visually-hidden');
});

describe('a chart and a note on a record', () => {
  const sections = [
    {
      kind: 'chart' as const,
      from: 'invoice',
      by: 'status',
      path: 'customer_id',
      title: 'Invoice mix',
      shape: 'donut' as const,
      fn: 'count',
    },
    { kind: 'note' as const, title: 'Credit', text: 'Call before extending credit.\n\nThe limit is on the record.' },
  ];
  const chartPlan: SectionPlan = {
    index: 0,
    breakdown: {
      base: 'invoice',
      by: [{ path: 'status', alias: 'key_1' }],
      measures: [{ fn: 'count', alias: 'value' }],
      filter: { groups: [[{ path: 'customer_id', op: '=', value: 4 }]] },
    },
  };

  test('the chart asks for its planned groups and the note says its words, reading nothing', async () => {
    draw({ page: { ...page, sections }, plans: [chartPlan] });
    expect(await screen.findByRole('heading', { name: 'Credit' })).toBeInTheDocument();
    expect(screen.getByText('The limit is on the record.')).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('.page-section .chart-host')).not.toBeNull());
    expect(screen.getByRole('heading', { name: 'Invoice mix' })).toBeInTheDocument();
    const reads = calls.filter((call) => call.path === '/api/breakdown');
    expect(reads).toHaveLength(1);
    expect(reads[0].body.def).toEqual(chartPlan.breakdown);
    // The note is not a question: nothing else was asked on its behalf.
    expect(calls.filter((call) => call.path !== '/api/breakdown')).toEqual([]);
  });

  test('a chart with no groups says so', async () => {
    breakdownOverride = {
      breakdown: { ...chartPlan.breakdown!, limit: 400 },
      resolved: [],
      ms: 1,
      offset: 0,
      columns: ['key_1', 'value'],
      rows: [],
      total: 0,
    };
    draw({ page: { ...page, sections: [sections[0]] }, plans: [chartPlan] });
    expect(await screen.findByText('No invoice for this record.')).toBeInTheDocument();
  });
});

/* ---------- a record header and a current card ---------- */

const unitPage = (sections: PageDef['sections']): PageDef => ({ id: 'unit', name: 'Unit', base: 'unit', source: 'config', sections });
const drawUnit = (sections: PageDef['sections'], unitPlans: SectionPlan[] = []) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onLabel = vi.fn();
  render(
    createElement(
      QueryClientProvider,
      { client },
      <PageView
        entry={{ kind: 'page', pageId: 'unit', table: 'unit', key: { id: 4 }, label: '4' }}
        page={unitPage(sections)}
        base={unit}
        plans={unitPlans}
        others={[]}
        onLabel={onLabel}
        onTab={() => {}}
        onLayout={() => {}}
      />,
    ),
  );
  return { onLabel };
};

test("a record header is drawn in the head: the page's word over the name, the status beside it, the facts under it, and never as a section", async () => {
  appMode = true;
  labelled = 'name';
  viewRows = [{ id: 4, name: 'Maple Court B103', status: 'occupied', beds: 3, rent: 1450 }];
  const { onLabel } = drawUnit([
    {
      kind: 'fields',
      presentation: 'header',
      status: 'status',
      paths: ['beds', 'rent'],
      factLabels: { beds: { one: 'bed' }, rent: { one: 'Asking', position: 'before' } },
    },
    { kind: 'fields', title: 'Details', paths: ['rent'] },
  ]);
  const head = document.querySelector('.page-head')!;
  // The facts' line is held, unseen, while the row is read (PageHead.tsx).
  await waitFor(() => expect(head.querySelector('.page-head-facts:not([aria-hidden])')).not.toBeNull());
  expect(within(head as HTMLElement).getByText('Unit')).toHaveClass('page-title');
  expect(head.querySelector('.root-bar .page-head-status')?.textContent).toMatch(/occupied/);
  const facts = [...head.querySelectorAll('.page-head-facts .page-fact')].map((fact) => fact.textContent);
  expect(facts[0]).toBe('3 beds');
  // A word written to lead stands before the value, and is its caption for everyone.
  expect(facts[1]).toMatch(/^Asking \S/);
  expect(facts[1]).not.toMatch(/Rent/);
  // The header names the record, and no section on the page is it.
  await waitFor(() => expect(onLabel).toHaveBeenCalledWith('Maple Court B103'));
  expect(document.querySelectorAll('.page-section .page-facts')).toHaveLength(0);
});

test("a fact's word agrees with a count and nothing else, and a unit is said once", async () => {
  appMode = true;
  labelled = 'name';
  displays = { balance: { format: 'money', currency: 'USD' }, mileage: { format: 'number', unit: 'mi' } };
  viewRows = [{ id: 4, name: 'Maple Court B103', status: 'occupied', beds: 3, balance: 18400, mileage: 48341 }];
  drawUnit([
    {
      kind: 'fields',
      presentation: 'header',
      paths: ['beds', 'balance', 'mileage'],
      factLabels: { beds: { one: 'bed' }, balance: { one: 'left to pay' }, mileage: { one: 'mi' } },
    },
  ]);
  const head = document.querySelector('.page-head')!;
  await waitFor(() => expect(head.querySelector('.page-head-facts:not([aria-hidden])')).not.toBeNull());
  const facts = [...head.querySelectorAll('.page-head-facts .page-fact')].map((fact) => fact.textContent);
  // A count agrees: "3 beds". A money figure is not a count of its word: never "left to pays".
  expect(facts[0]).toBe('3 beds');
  expect(facts[1]).toMatch(/18,400.* left to pay$/);
  // The unit is the figure's word: "48,341 mi", never "48,341 mi mis".
  expect(facts[2]).toMatch(/48,341 mi$/);
  expect(facts[2]).not.toMatch(/mi mi/);
});

test('a destructive verb is one the header names by id, one that confirms, or one that sets a value toned bad', () => {
  const tones = { status: { lost: 'bad', won: 'good' } };
  expect(isDestructive({ id: 'markLost', label: 'Mark lost', set: { status: 'lost' } }, undefined, tones)).toBe(true);
  expect(isDestructive({ id: 'markWon', label: 'Mark won', set: { status: 'won' } }, undefined, tones)).toBe(false);
  expect(isDestructive({ id: 'archive', label: 'Archive', set: { status: 'archived' }, confirm: true }, undefined, tones)).toBe(true);
  expect(
    isDestructive(
      { id: 'warnMember', label: 'Warn member', command: { id: 'warn', version: 1, target: 'member', input: {} } } as never,
      ['warnMember'],
      tones,
    ),
  ).toBe(true);
  expect(
    isDestructive(
      { id: 'reply', label: 'Reply', command: { id: 'reply', version: 1, target: 'member', input: {} } } as never,
      ['warnMember'],
      tones,
    ),
  ).toBe(false);
});

test('a current card is the one chosen row, titled by its name and opening it, and says so when there is none', async () => {
  appMode = true;
  labelled = 'name';
  const card = {
    kind: 'list' as const,
    from: 'lease',
    path: 'unit_id',
    title: 'Current lease',
    presentation: 'card' as const,
    limit: 1,
    columns: ['name', 'rent', 'ends_on'],
  };
  const cardPlans: SectionPlan[] = [
    { index: 1, view: { ...viewDefinition('current-lease', 'lease', ['id', 'name', 'rent', 'ends_on']), limit: 1 } },
  ];
  viewRows = [{ id: 7, name: 'Lease 7', rent: 1450, ends_on: '2027-01-31' }];
  drawUnit([{ kind: 'fields', paths: ['name'] }, card], cardPlans);
  const title = await screen.findByRole('button', { name: 'Lease 7' });
  const box = title.closest('.page-current')!;
  expect(within(box as HTMLElement).getByText('Current lease')).toHaveClass('page-card-caption');
  expect([...box.querySelectorAll('.page-card-fact dt')].map((dt) => dt.textContent)).toEqual(['Rent', 'Ends on']);
  await userEvent.setup().click(within(box as HTMLElement).getByRole('button', { name: 'View lease' }));
  expect(gone.at(-1)).toEqual(['open', 'lease', { id: 7 }, 'Lease 7']);
  cleanup();
  rowsByBase = { unit: [{ id: 4, name: 'Maple Court B103' }], lease: [] };
  drawUnit([{ kind: 'fields', paths: ['name'] }, card], cardPlans);
  // The record's noun, not the title: a title such as "In the shop now" is a heading, not a noun.
  expect(await screen.findByText('No lease right now.')).toBeVisible();
  expect(document.querySelector('.page-current .page-card-foot')).toBeNull();
});

/* Keystone dealer: a card's foot said "View dealer account" where the resource calls one a seller. */
test("a card's foot names its record by the resource's noun", async () => {
  appMode = true;
  const unitColumn = lease.columns.find((column) => column.name === 'unit_id')!;
  unitColumn.references = { table: 'unit', column: 'id' };
  try {
    appResource = { resources: { unit: { noun: { one: 'home', many: 'homes' } } } };
    rowsByBase = { lease: [{ id: 7, unit_id: 4, name: 'Lease 7' }] };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      createElement(
        QueryClientProvider,
        { client },
        <PageView
          entry={{ kind: 'page', pageId: 'lease', table: 'lease', key: { id: 7 }, label: '7' }}
          page={{
            id: 'lease',
            name: 'Lease',
            base: 'lease',
            source: 'config',
            sections: [{ kind: 'fields', title: 'Where', presentation: 'card', paths: ['unit_id', 'name'] }],
          }}
          base={lease}
          plans={[]}
          others={[]}
          onLabel={vi.fn()}
          onTab={() => {}}
          onLayout={() => {}}
        />,
      ),
    );
    expect(await screen.findByRole('button', { name: 'View home' })).toBeInTheDocument();
  } finally {
    delete unitColumn.references;
  }
});

/* ---------- a page's archetype (shared/pageLayouts.ts) ---------- */

describe("a page's layout", () => {
  const drawLaid = (layout: PageDef['layout'], sections: PageDef['sections']) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      createElement(
        QueryClientProvider,
        { client },
        <PageView
          entry={{ kind: 'page', pageId: 'unit', table: 'unit', key: { id: 4 }, label: '4' }}
          page={{ ...unitPage(sections), layout }}
          base={unit}
          plans={[]}
          others={[]}
          onLabel={vi.fn()}
          onTab={() => {}}
          onLayout={() => {}}
        />,
      ),
    );
  };

  test('a showcase is drawn as its bands on the first render: the photos, the panel named by its offer, then the body', () => {
    appMode = true;
    drawLaid('showcase', [
      { kind: 'list', title: 'Photos', from: 'lease', columns: ['id'], presentation: 'gallery' },
      { kind: 'fields', presentation: 'headline', region: 'aside', paths: ['rent'] },
      { kind: 'fields', title: 'The home', paths: ['beds'] },
    ]);
    // Before any section has answered: the arrangement is the payload's, so nothing moves when one lands.
    const layout = document.querySelector('.page-layout')!;
    expect(layout).toHaveAttribute('data-layout', 'showcase');
    expect([...layout.children].map((child) => child.className)).toEqual([
      'page-body page-main page-showcase',
      'page-body page-aside page-panel',
      'page-body page-showcase-body',
    ]);
    // One complementary landmark, named by what it offers; the body under the photos is not an aside.
    expect(screen.getAllByRole('complementary')).toHaveLength(1);
    expect(screen.getByRole('complementary', { name: 'Unit: Rent' })).toBe(layout.children[1]);
    expect(layout.children[2].textContent).toMatch(/The home/);
    expect(layout.children[0].textContent).not.toMatch(/The home/);
  });

  test('a conversation keeps the main column first in reading order, the record context beside it', () => {
    appMode = true;
    drawLaid('conversation', [
      { kind: 'fields', title: 'The repair', paths: ['beds'] },
      { kind: 'fields', title: 'Home', presentation: 'card', region: 'aside', paths: ['name'] },
    ]);
    const layout = document.querySelector('.page-layout')!;
    expect(layout).toHaveAttribute('data-layout', 'conversation');
    expect([...layout.children].map((child) => child.tagName)).toEqual(['DIV', 'ASIDE']);
    expect(screen.getByRole('complementary', { name: 'Record context' })).toBe(layout.children[1]);
  });

  test('an article is one column with no aside, its head on the same measure', () => {
    appMode = true;
    drawLaid('article', [{ kind: 'fields', title: 'The task', paths: ['name', 'beds'] }]);
    expect(document.querySelector('.page-layout')).toBeNull();
    expect(document.querySelector('.page-body')).toHaveAttribute('data-layout', 'article');
    expect(document.querySelector('.page-head')).toHaveAttribute('data-layout', 'article');
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  test('a page that names no layout is the record skeleton, with no data-layout', () => {
    appMode = true;
    drawLaid(undefined, [
      { kind: 'fields', title: 'Details', paths: ['beds'] },
      { kind: 'fields', title: 'Home', presentation: 'card', region: 'aside', paths: ['name'] },
    ]);
    expect(document.querySelector('.page-layout')).not.toHaveAttribute('data-layout');
    expect(document.querySelector('.page-head')).not.toHaveAttribute('data-layout');
  });
});
