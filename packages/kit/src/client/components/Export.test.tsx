/**
 * The export control: two scopes with their counts, a column chooser that
 * re-runs the query when the file would differ from the screen.
 */
import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';
import { bridgeShell } from '../../../../../test/shellBridge.js';
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';

const col = (name: string, type: string, extra = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
const invoice: TableMeta = {
  id: 'invoice',
  name: 'invoice',
  schema: '',
  isView: false,
  indexed: ['id'],
  columns: [col('id', 'INTEGER', { primaryKey: true, nullable: false }), col('memo', 'TEXT'), col('total', 'REAL')] as TableMeta['columns'],
};
const calls: Array<Record<string, unknown>> = [];
/* An App's display rules, by `table.column`. */
const displays: Record<string, unknown> = {};
const toasts: string[] = [];
const store = new Map<string, unknown>();
/* download() writes through an anchor and a blob URL; both are caught here
   so the test can read the file back. */
const blobs: Blob[] = [];
const anchors: HTMLAnchorElement[] = [];
URL.createObjectURL = (blob: Blob) => {
  blobs.push(blob);
  return 'blob:test';
};
URL.revokeObjectURL = () => {};
HTMLAnchorElement.prototype.click = () => {};
async function saved(): Promise<Array<[string, string]>> {
  return Promise.all(anchors.map(async (a, i) => [a.getAttribute('download')!, await blobs[i].text()] as [string, string]));
}
vi.mock('../core.js', () => ({
  viewportBox: (n: Element) => n.getBoundingClientRect(),
  viewportSize: () => ({ width: 1000, height: 800 }),
  state: { page: 0, activeConnection: 'demo', schema: { tables: [invoice], foreignKeys: [] } },
  api: async (_path: string, body: Record<string, unknown>) => {
    calls.push(body);
    return { columns: ['id', 'memo', 'total'], rows: [{ id: 1, memo: 'a', total: 9 }] };
  },
  findTable: (id: string) => (id === 'invoice' ? invoice : undefined),
  columnDisplay: (table: string, column: string) => displays[`${table}.${column}`] ?? null,
  pageSize: () => 20,
  toast: (m: string) => toasts.push(m),
  loadJson: (k: string, d: unknown) => store.get(k) ?? d,
  saveJson: (k: string, v: unknown) => store.set(k, v),
  el: (tag: string, attrs: Record<string, unknown> = {}) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    if (tag === 'a') anchors.push(node as HTMLAnchorElement);
    return node;
  },
}));
let appMode = false;
vi.mock('../../../../mistri/src/client/appState.js', () => ({ inAppMode: () => appMode }));
vi.mock('../handoff.js', () => ({ copyPosition: async () => {}, positionOf: () => ({}) }));
vi.mock('../sessionIdentity.js', () => ({ captureSessionIdentity: () => ({ mode: 'anonymous' }) }));
vi.mock('../requestIdentity.js', () => ({
  scopeApiRequest: (path: string, body: Record<string, unknown>, conn: string) => ({ url: path, payload: { conn, ...body } }),
}));
/* The streamed export is a plain fetch of `/api/export`; each test says what it answers. */
const exports: Array<Record<string, unknown>> = [];
let exportAnswer: () => Response = () => new Response('{"error":"unavailable"}', { status: 403 });
globalThis.fetch = (async (_url: string, init: RequestInit) => {
  exports.push(JSON.parse(String(init.body)));
  return exportAnswer();
}) as typeof fetch;

const { ExportControl } = await import('./Export.js');

const entry = { table: 'invoice', query: 'invoice' };
const data = {
  table: 'invoice',
  columns: ['id', 'memo'],
  rows: [
    { id: 1, memo: 'a' },
    { id: 2, memo: 'b' },
  ],
  total: 50,
};

beforeEach(bridgeShell);

afterEach(() => {
  appMode = false;
  for (const key of Object.keys(displays)) delete displays[key];
  cleanup();
  calls.length = 0;
  exports.length = 0;
  toasts.length = 0;
  blobs.length = 0;
  anchors.length = 0;
  store.clear();
});

describe('the menu', () => {
  test('in an App it offers the columns and CSV only; the Workbench keeps JSON and the agent hand-off', async () => {
    const user = userEvent.setup();
    appMode = true;
    render(<ExportControl entry={entry} data={data} />);
    await user.click(screen.getByRole('button', { name: 'Export' }));
    expect(screen.getByRole('menuitem', { name: /Choose columns/ })).toBeInTheDocument();
    expect(screen.getAllByRole('menuitem', { name: 'this page (2 rows)' })).toHaveLength(1);
    expect(screen.queryByText('JSON')).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Copy this position' })).toBeNull();
    cleanup();
    appMode = false;
    render(<ExportControl entry={entry} data={data} />);
    await user.click(screen.getByRole('button', { name: 'Export' }));
    expect(screen.getByText('JSON')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Copy this position' })).toBeInTheDocument();
  });

  test("money kept in minor units is written as the figure, in each row's own currency, where the server cannot stream", async () => {
    const user = userEvent.setup();
    appMode = true;
    displays['invoice.memo'] = { format: 'money', minor: true, currency: 'USD', currencyColumn: 'cur' };
    const rows = [
      { id: 1, memo: 1999, cur: 'USD' },
      { id: 2, memo: 1500, cur: 'JPY' },
    ];
    render(<ExportControl entry={entry} data={{ ...data, rows }} />);
    await user.click(screen.getByRole('button', { name: 'Export' }));
    await user.click(screen.getAllByRole('menuitem', { name: 'this page (2 rows)' })[0]);
    expect((await saved())[0][1]).toBe('\ufeffid,memo\r\n1,19.99\r\n2,1500\r\n');
  });

  test('spells out both scopes with their counts, and what the file will hold', async () => {
    render(<ExportControl entry={entry} data={data} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Export' }));
    expect(screen.getAllByRole('menuitem', { name: 'this page (2 rows)' })).toHaveLength(2);
    expect(screen.getAllByRole('menuitem', { name: 'all matching rows (50)' })).toHaveLength(2);
    expect(document.querySelector('.export-count')).toHaveTextContent('2 of 3');
  });

  test('this page writes what is on screen; all matching rows re-runs the line once, bounded', async () => {
    const user = userEvent.setup();
    render(<ExportControl entry={entry} data={data} />);
    await user.click(screen.getByRole('button', { name: 'Export' }));
    await user.click(screen.getAllByRole('menuitem', { name: 'this page (2 rows)' })[0]);
    let files = await saved();
    expect(files).toHaveLength(1);
    expect(files[0][0]).toMatch(/^invoice-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(files[0][1]).toBe('\ufeffid,memo\r\n1,a\r\n2,b\r\n');
    expect(calls).toEqual([]);
    // Where the server cannot stream (a row-policy App refuses), one bounded re-run.
    await user.click(screen.getByRole('button', { name: 'Export' }));
    await user.click(screen.getAllByRole('menuitem', { name: 'all matching rows (50)' })[1]);
    await vi.waitFor(() => expect(anchors).toHaveLength(2));
    files = await saved();
    expect(exports).toHaveLength(1);
    // Two of three columns are on screen, so the re-run asks for exactly those.
    expect(calls).toEqual([{ q: 'invoice show id, memo', limit: 50, offset: 0 }]);
    expect(files[1][0]).toMatch(/\.json$/);
    expect(toasts).toEqual(['Exported 2 rows.', 'Exported 1 row.']);
  });

  test('all matching rows is the file the server streams, with the columns on screen and no rows read here', async () => {
    exportAnswer = () =>
      new Response('\ufeffid,memo\r\n1,a\r\n', {
        status: 200,
        headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="invoice.csv"' },
      });
    try {
      const user = userEvent.setup();
      render(<ExportControl entry={entry} data={data} />);
      await user.click(screen.getByRole('button', { name: 'Export' }));
      await user.click(screen.getAllByRole('menuitem', { name: 'all matching rows (50)' })[0]);
      await vi.waitFor(() => expect(anchors).toHaveLength(1));
      expect(exports).toEqual([{ conn: 'demo', q: 'invoice show id, memo', format: 'csv', columns: ['id', 'memo'] }]);
      expect(calls).toEqual([]);
      expect(anchors[0].getAttribute('download')).toMatch(/^invoice-\d{4}-\d{2}-\d{2}\.csv$/);
      expect(toasts).toEqual(['Exported all matching rows.']);
    } finally {
      exportAnswer = () => new Response('{"error":"unavailable"}', { status: 403 });
    }
  });
});

describe('the column chooser', () => {
  test('a column not on screen is fetched, and the choice is remembered', async () => {
    const user = userEvent.setup();
    render(<ExportControl entry={entry} data={data} />);
    await user.click(screen.getByRole('button', { name: 'Export' }));
    await user.click(screen.getByRole('menuitem', { name: /Choose columns/ }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('not shown')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('checkbox', { name: /total/ }));
    expect(within(dialog).getByText('3 of 3 selected')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Use these columns' }));
    await user.click(screen.getByRole('button', { name: 'Export' }));
    expect(document.querySelector('.export-count')).toHaveTextContent('3 of 3');
    /* Every declared column: the same query the grid ran, no `show`, re-fetched
       because the rows in hand lack the third column. */
    await user.click(screen.getAllByRole('menuitem', { name: 'this page (2 rows)' })[0]);
    await vi.waitFor(() => expect(anchors).toHaveLength(1));
    expect(calls).toEqual([{ q: 'invoice', limit: 20, offset: 0 }]);
    expect((await saved())[0][1]).toBe('\ufeffid,memo,total\r\n1,a,9\r\n');
    expect(store.get('mistri.export-columns.v1')).toEqual({ demo: { invoice: ['id', 'memo', 'total'] } });
  });

  test('nothing ticked is refused rather than written', async () => {
    const user = userEvent.setup();
    render(<ExportControl entry={entry} data={data} />);
    await user.click(screen.getByRole('button', { name: 'Export' }));
    await user.click(screen.getByRole('menuitem', { name: /Choose columns/ }));
    await user.click(screen.getByRole('button', { name: 'None' }));
    await user.click(screen.getByRole('button', { name: 'Use these columns' }));
    expect(toasts).toEqual(['Pick at least one column to export.']);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
