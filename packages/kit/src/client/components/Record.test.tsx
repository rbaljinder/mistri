/**
 * The record view, drawn and driven: the fields from a one-row view, the
 * label arriving after the row, the rail of relationships and the children
 * under the chosen one.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { bridgeShell } from '../../../../../test/shellBridge.js';
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';
import type { ResourceClientReply, ResourceHttpSuccess } from '../../../../engine/src/shared/resourceHttp.js';
import { columnKind, labelColumn, labelPath as sharedLabelPath, primaryKey } from '../../../../engine/src/shared/schema.js';

const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
const gone: unknown[] = [];
let explained = '';
let editing = false;
let appMode = false;
let listeners = new Set<() => void>();
let recordReply: ResourceClientReply<'/api/view/run'> | undefined;
const viewDefinition = { id: 'record:customer', name: 'customer', base: 'customer', columns: [{ path: 'id' }, { path: 'name' }] };
const defaultRecord: ResourceHttpSuccess<'/api/view/run', 'db'> = {
  view: viewDefinition,
  columns: ['id', 'name', 'active', 'signed_up'],
  rows: [{ id: 4, name: 'Harbour Freight', active: 1, signed_up: '2023-02-11' }],
  resolved: [],
  sql: { text: 'SELECT …', params: [] },
  joins: [],
  explain: 'SELECT …',
  text: '',
  errors: [],
  ms: 1,
  more: false,
  limit: 1,
  offset: 0,
};

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
    col('active', 'INTEGER'),
    col('signed_up', 'DATE'),
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
    col('customer_id', 'INTEGER', { references: { table: 'customer', column: 'id' } }),
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
    col('customer_id', 'INTEGER', { references: { table: 'customer', column: 'id' } }),
    col('body', 'TEXT'),
  ] as TableMeta['columns'],
};
const tables: Record<string, TableMeta> = { customer, invoice, note };
const fks = [
  { name: 'invoice_customer', from: { table: 'invoice', columns: ['customer_id'] }, to: { table: 'customer', columns: ['id'] } },
  { name: 'note_customer', from: { table: 'note', columns: ['customer_id'] }, to: { table: 'customer', columns: ['id'] } },
];
const schema = { tables: Object.values(tables), foreignKeys: fks };

vi.mock('../core.js', () => ({
  state: { activeConnection: 'demo', schema, stack: [] },
  subscribeWalk: (fn: () => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  walkVersion: () => 0,
  api: async (path: string, body: Record<string, unknown>) => {
    calls.push({ path, body });
    if (path === '/api/view/run') return recordReply ?? defaultRecord;
    if (path === '/api/references')
      return {
        references: [
          { constraint: 'invoice_customer', count: 2 },
          { constraint: 'note_customer', count: 0 },
        ],
      };
    if (path === '/api/query') {
      const t = String(body.table);
      if (t === 'invoice')
        return {
          columns: ['id', 'customer_id', 'total'],
          rows: [
            { id: 1001, customer_id: 4, total: 627.95 },
            { id: 1002, customer_id: 4, total: 389.5 },
          ],
          total: 2,
        };
      return { columns: ['id', 'customer_id', 'body'], rows: [], total: 0 };
    }
    return {};
  },
  findTable: (id: string) => tables[id],
  refsTo: (id: string) => fks.filter((f) => f.to.table === id),
  refsFrom: (id: string) => fks.filter((f) => f.from.table === id),
  keyOf: (_t: TableMeta, row: Record<string, unknown>) => (row.id === undefined ? null : { id: row.id }),
  keyFilter: (key: Record<string, unknown>) => ({ groups: [Object.entries(key).map(([column, value]) => ({ column, op: '=', value }))] }),
  rowLabel: (_t: TableMeta, row: Record<string, unknown>) => String(row.name ?? row.id),
  labelPath: (t: TableMeta) => sharedLabelPath(schema as never, t),
  labelColumn,
  primaryKey,
  columnKind,
  columnDisplay: () => null,
  columnLabel: () => null,
  emptyWord: () => 'null',
  prefersPages: () => appMode,
  currentEntry: () => ({ kind: 'row', table: 'customer', key: { id: 4 } }),
  openRecord: (...a: unknown[]) => gone.push(['open', ...a]),
  go: (e: unknown, mode?: string) => gone.push(['go', e, mode]),
  pageView: (pageId: string, table: string, key: unknown, label: unknown) => ({ kind: 'page', pageId, table, key, label }),
  tableView: (table: string, query: string) => ({ kind: 'table', table, query }),
  quote: (v: unknown) => String(v),
  setExplain: (sql: string) => {
    explained = sql;
  },
  toast: () => {},
  loadJson: () => ({}),
  saveJson: () => {},
  el: (tag: string, attrs: Record<string, unknown> = {}, children: unknown = []) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'text') node.textContent = String(v);
      else if (k === 'class') node.className = String(v);
      else if (typeof v === 'function') node.addEventListener(k.slice(2), v as EventListener);
      else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, String(v));
    }
    for (const c of [children].flat()) if (c) node.append(c as Node);
    return node;
  },
  viewportBox: (n: Element) => n.getBoundingClientRect(),
  viewportSize: () => ({ width: 1000, height: 800 }),
}));
vi.mock('../handoff.js', () => ({ copyPosition: async () => {}, positionOf: () => ({}) }));
vi.mock('../page.js', () => ({ pagesFor: async () => [] }));
vi.mock('../../../../mistri/src/client/appState.js', () => ({ appSaveMode: () => 'explicit', inAppMode: () => false }));
/* The kit reads the App through the shell's answers (shellMode.ts), which the mock above gives it. */
beforeEach(bridgeShell);
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
vi.mock('../template.js', () => ({
  activeDraft: () => null,
  hasSavedTemplate: () => false,
  savedTemplate: () => null,
  openTemplateBuilder: () => {},
  fieldPathsOf: (t: { sections: Array<{ kind: string; paths?: string[]; off?: boolean }> }) =>
    t.sections.filter((s) => s.kind === 'fields' && !s.off).flatMap((s) => s.paths ?? []),
  listSectionsOf: (t: { sections: Array<{ kind: string; off?: boolean }> }) => t.sections.filter((s) => s.kind === 'list' && !s.off),
}));
vi.mock('../thmenu.js', () => ({ openFilterMenu: () => {}, sortBy: () => {} }));
vi.mock('../peek.js', () => ({ peekable: (n: Node) => n }));

const { RecordView } = await import('./Record.js');

const template = {
  sections: [
    { kind: 'fields' as const, title: undefined, paths: ['id', 'name'] },
    { kind: 'fields' as const, title: 'Details', paths: ['active', 'signed_up'] },
    { kind: 'list' as const, via: 'invoice_customer', columns: ['total'], limit: 10 },
    { kind: 'list' as const, via: 'note_customer', columns: ['body'], limit: 10 },
  ],
};

function draw(props: Partial<Parameters<typeof RecordView>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onLabel = vi.fn();
  const onChooseTab = vi.fn();
  const entry = { kind: 'row' as const, table: 'customer', key: { id: 4 }, label: '4' };
  render(
    createElement(
      QueryClientProvider,
      { client },
      <RecordView entry={entry} table={customer} template={template} onLabel={onLabel} onChooseTab={onChooseTab} {...props} />,
    ),
  );
  return { onLabel, onChooseTab };
}

beforeEach(() => {
  calls.length = 0;
  gone.length = 0;
  explained = '';
  listeners = new Set();
  editing = false;
  appMode = false;
  recordReply = undefined;
});
afterEach(() => cleanup());

test.each([false, true])('record controls honor column writability with resource editing enabled in app mode %s', async (app) => {
  editing = true;
  appMode = app;
  const table = {
    ...customer,
    columns: customer.columns.map((c) => (c.name === 'name' ? { ...c, nullable: false, writable: false } : { ...c, writable: true })),
  };
  draw({ table });
  expect(await screen.findByText('Harbour Freight')).toBeVisible();
  expect(screen.queryByRole('textbox', { name: /name/i })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Edit Name' })).toBeNull();
  const field = screen.getByText('Harbour Freight').closest('.field') as HTMLElement;
  expect(within(field).queryByTitle('NOT NULL')).toBeNull();
  if (app) expect(screen.getByRole('button', { name: 'Edit Active' })).toBeVisible();
  else expect(screen.getByRole('textbox', { name: 'active (INTEGER)' })).toHaveValue('1');
});

describe('the record', () => {
  test('a 200 parse error is not mistaken for a missing record or an empty result', async () => {
    recordReply = { errors: [{ message: 'Unknown record path.' }] };
    const { onLabel } = draw();
    expect(await screen.findByText('Unknown record path.')).toBeInTheDocument();
    expect(screen.queryByText('That row is no longer there.')).not.toBeInTheDocument();
    expect(document.querySelector('.field-groups')).toBeNull();
    expect(document.querySelector('.child-panel')).toBeNull();
    expect(onLabel).not.toHaveBeenCalled();
    expect(explained).toBeUndefined();
  });

  test('large string keys remain unchanged in row and child filters', async () => {
    const id = '9007199254740993';
    draw({ entry: { kind: 'row', table: 'customer', key: { id } } });
    await screen.findByText('Harbour Freight');
    const request = calls.find((c) => c.path === '/api/view/run')!.body;
    expect(request.count).toBe('none');
    expect(request.view).toMatchObject({ filter: { groups: [[{ path: 'id', op: '=', value: id }]] } });
    await vi.waitFor(() => expect(calls.filter((c) => c.path === '/api/query')).toHaveLength(2));
    for (const call of calls.filter((c) => c.path === '/api/query')) {
      expect(call.body.filter).toEqual({ groups: [[{ column: 'customer_id', op: '=', value: id }]] });
    }
  });

  test('unusable key values never reach row or child resource requests', async () => {
    draw({ entry: { kind: 'row', table: 'customer', key: { id: {} } } });
    await screen.findByText('That row is no longer there.');
    expect(calls.filter((c) => c.path === '/api/view/run' || c.path === '/api/query')).toEqual([]);
  });

  test('App records render when SQL diagnostics are omitted', async () => {
    const core = vi.mocked(await import('../core.js'));
    const real = core.api;
    core.api = (async (path: string) =>
      path === '/api/view/run'
        ? { view: viewDefinition, rows: [{ id: 4, name: 'App record' }], resolved: [] }
        : { references: [] }) as never;
    try {
      draw();
      expect(await screen.findByText('App record')).toBeInTheDocument();
      expect(explained).toBeUndefined();
    } finally {
      core.api = real;
    }
  });
  test('runs as a one-row view, names itself once the row is here, and says what the SQL was', async () => {
    const { onLabel } = draw();
    expect(screen.getByRole('heading', { level: 1, name: /customer · 4/ })).toBeInTheDocument();
    await screen.findByText('Harbour Freight');
    expect(onLabel).toHaveBeenCalledWith('Harbour Freight');
    expect(explained).toBe('SELECT …');
    const view = calls.find((c) => c.path === '/api/view/run')!.body.view as { columns: Array<{ path: string }>; limit: number };
    expect(view.columns.map((c) => c.path)).toEqual(['id', 'name', 'active', 'signed_up']);
    expect(view.limit).toBe(1);
  });

  test('groups the fields as the layout says, with the type beside each name and the key marked', async () => {
    draw();
    await screen.findByText('Harbour Freight');
    const groups = document.querySelectorAll('.field-group');
    expect(groups).toHaveLength(2);
    expect(groups[0]).toHaveClass('field-group-plain');
    expect(within(groups[1] as HTMLElement).getByRole('button', { name: /Details/ })).toHaveAttribute('aria-expanded', 'true');
    const id = document.querySelector('.field dt')!;
    expect(id).toHaveTextContent('id');
    expect(id.querySelector('.pk')).toHaveTextContent('key');
    expect(id.querySelector('.type')).toHaveTextContent('integer');
  });

  test('a group folds and unfolds', async () => {
    const user = userEvent.setup();
    draw();
    await screen.findByText('Harbour Freight');
    const head = screen.getByRole('button', { name: /Details/ });
    await user.click(head);
    expect(head).toHaveAttribute('aria-expanded', 'false');
    expect(head.closest('.field-group')).toHaveClass('collapsed');
  });

  test('says when the row is no longer there', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const core = vi.mocked(await import('../core.js'));
    const real = core.api;
    core.api = (async (path: string) =>
      path === '/api/view/run' ? { ...defaultRecord, rows: [], sql: { text: '', params: [] } } : { references: [] }) as never;
    try {
      render(
        createElement(
          QueryClientProvider,
          { client },
          <RecordView
            entry={{ kind: 'row', table: 'customer', key: { id: 99 }, label: '99' }}
            table={customer}
            template={template}
            onLabel={() => {}}
            onChooseTab={() => {}}
          />,
        ),
      );
      expect(await screen.findByText('That row is no longer there.')).toBeInTheDocument();
    } finally {
      core.api = real;
    }
  });
});

describe('what points at the row', () => {
  test('the rail lists every relationship with its count, empty ones disabled, the fullest one open', async () => {
    draw();
    const rail = await screen.findByRole('tablist');
    const tabs = within(rail).getAllByRole('tab');
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toHaveTextContent('2');
    expect(tabs[0]).toHaveTextContent('invoice');
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[1]).toBeDisabled();
    expect(tabs[1]).toHaveClass('empty');
    // The children under the fields: the invoices, with the layout's columns.
    const panel = document.querySelector('.child-panel')!;
    expect(within(panel as HTMLElement).getByRole('heading', { level: 2 })).toHaveTextContent('invoice');
    expect(within(panel as HTMLElement).getByText('via customer_id')).toBeInTheDocument();
    expect(within(panel as HTMLElement).getByText('627.95')).toBeInTheDocument();
    // Offered only when hiding leaves something behind — one of two is empty.
    expect(screen.getByRole('button', { name: 'hide 1 empty' })).toBeInTheDocument();
  });

  test('a child row opens its record through the same seam as the grid', async () => {
    const user = userEvent.setup();
    draw();
    await screen.findByText('627.95');
    await user.click(screen.getByText('627.95'));
    expect(gone[0]).toEqual(['open', 'invoice', { id: 1001 }, '1001']);
  });

  test('hiding the empties is a fold, not a removal', async () => {
    const user = userEvent.setup();
    draw();
    await screen.findByRole('tablist');
    await user.click(screen.getByRole('button', { name: 'hide 1 empty' }));
    expect(screen.getByRole('tablist')).toHaveClass('hide-empty');
    expect(screen.getByRole('button', { name: 'show 1 empty' })).toBeInTheDocument();
    expect(within(screen.getByRole('tablist')).getAllByRole('tab', { hidden: true })).toHaveLength(2);
  });
});
