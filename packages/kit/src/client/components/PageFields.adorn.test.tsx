/**
 * The shell's word at a record's own field (pageContext.ts `FieldAdornment`, from shellMode.ts `useFieldAdornment`):
 * in the empty mark's place when the field is empty, after the value in the same <dd> when it is not, nothing when the
 * shell has none or the page is a preview.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { bridgeShell } from '../../../../../test/shellBridge.js';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';
import { columnKind, labelColumn, primaryKey } from '../../../../engine/src/shared/schema.js';
import type { PageDef } from './pageModel.js';
import type { HttpViewDefinition } from '../../../../engine/src/shared/resourceHttp.js';
import type { FieldAdornment } from './pageContext.js';

let fieldRow: Record<string, unknown> = {};

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

vi.mock('../core.js', () => ({
  state: { activeConnection: 'demo', schema: { tables: [customer], foreignKeys: [] }, stack: [] },
  subscribeWalk: () => () => {},
  walkVersion: () => 0,
  api: async (path: string, body: { view?: HttpViewDefinition }) => {
    if (path !== '/api/view/run' || !body.view) return {};
    const view = body.view;
    return {
      view,
      columns: view.columns.map((column) => column.alias ?? column.path),
      rows: [Object.fromEntries(view.columns.map((column) => [column.alias ?? column.path, fieldRow[column.path]]))],
      resolved: [],
      joinCount: 0,
      errors: [],
      text: '',
      ms: 1,
      more: false,
      limit: 10,
      offset: 0,
    };
  },
  findTable: () => customer,
  writeAllowed: () => false,
  keyOf: (_t: TableMeta, row: Record<string, unknown>) => (row.id === undefined ? null : { id: row.id }),
  rowLabel: (_t: TableMeta, row: Record<string, unknown>) => String(row.name ?? row.id),
  labelPath: () => undefined,
  recordLabel: () => undefined,
  refsFrom: () => [],
  labelColumn,
  primaryKey,
  columnKind,
  columnDisplay: () => null,
  columnLabel: () => null,
  emptyWord: () => 'null',
  prefersPages: () => false,
  currentEntry: () => ({ kind: 'page' }),
  openRecord: () => {},
  go: () => {},
  tableView: (table: string, query: string) => ({ kind: 'table', table, query }),
  quote: (v: unknown) => String(v),
  disclosure: (d: HTMLElement) => d,
  toast: () => {},
  loadJson: () => ({}),
  saveJson: () => {},
  el: (tag: string) => document.createElement(tag),
  viewportBox: (n: Element) => n.getBoundingClientRect(),
  viewportSize: () => ({ width: 1000, height: 800 }),
  registerSurfaceMutationPendingProbe: () => () => {},
  setRecordMutationPendingProbe: () => {},
}));
vi.mock('../../../../mistri/src/client/appState.js', () => ({
  inAppMode: () => false,
  activeApp: () => null,
  appSaveMode: () => 'explicit',
}));
vi.mock('../insert.js', () => ({ canInsert: () => false, openRelatedRecord: vi.fn() }));
vi.mock('../write.js', () => ({
  canEditRow: () => false,
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
const { installShell, shell } = await import('../shellMode.js');
const { captureRecordSurfaceOwner } = await import('./recordSurface.js');

const page: PageDef = {
  id: 'customer',
  name: 'Customer',
  base: 'customer',
  source: 'config',
  sections: [{ kind: 'fields', paths: ['name', 'status'] }],
};
const chip: FieldAdornment = ({ column, filled }) =>
  column === 'name' ? <span data-testid="chip">{filled ? 'trailing' : 'standing'}</span> : null;

function draw(adorn: FieldAdornment | undefined, preview?: { connection: string }, shown: PageDef = page, adornHeld = false) {
  const host = {
    owner: captureRecordSurfaceOwner(() => true),
    pendingBar: 'inline' as never,
    onRecordChange: () => {},
    onActionDone: () => {},
    onDeleted: () => {},
    onDeleteStateChange: () => {},
  };
  const asked: Array<Readonly<Record<string, unknown>> | undefined> = [];
  installShell({
    slots: {
      ...shell().slots,
      useFieldAdornment: (_connection, _table, key) => {
        asked.push(key);
        const held = adornHeld && key !== undefined ? ['name'] : [];
        return adorn && key ? { adorn, held } : { held };
      },
    },
  });
  render(
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      <PageView
        entry={{ kind: 'page', pageId: shown.id, table: 'customer', key: { id: 4 }, label: '4' }}
        page={shown}
        base={customer}
        plans={[]}
        others={[]}
        onLabel={() => {}}
        onTab={() => {}}
        onLayout={() => {}}
        host={host}
        preview={preview}
      />,
    ),
  );
  return asked;
}
const ddOf = (caption: string) => screen.getByText(caption, { selector: 'dt' }).parentElement!.querySelector('dd')!;

beforeEach(bridgeShell);
afterEach(cleanup);

test("an empty field draws the adornment in the empty mark's place", async () => {
  fieldRow = { id: 4, name: null, status: 'active' };
  draw(chip);
  const chipEl = await screen.findByTestId('chip');
  expect(chipEl).toHaveTextContent('standing');
  const dd = chipEl.closest('dd')!;
  expect(dd).toHaveClass('page-field-adorned');
  expect(dd).not.toHaveClass('null');
  expect(dd.textContent).not.toContain('null');
});

test('a filled field draws its value, then the adornment, in the same dd', async () => {
  fieldRow = { id: 4, name: 'Harbour Freight', status: 'active' };
  draw(chip);
  const chipEl = await screen.findByTestId('chip');
  expect(chipEl).toHaveTextContent('trailing');
  const dd = chipEl.closest('dd')!;
  expect(dd).not.toHaveClass('page-field-adorned');
  expect(dd.textContent).toBe('Harbour Freighttrailing');
  expect(dd.lastElementChild).toBe(chipEl);
});

test('with no adornment, an empty field keeps its empty mark', async () => {
  fieldRow = { id: 4, name: null, status: 'active' };
  draw(undefined);
  await screen.findByText('active');
  expect(document.querySelector('.page-field-adorned')).toBeNull();
  expect(screen.queryByTestId('chip')).toBeNull();
  expect(document.querySelector('dd.null')).not.toBeNull();
});

test('a field the host has nothing for keeps its empty mark', async () => {
  fieldRow = { id: 4, name: 'Harbour Freight', status: null };
  draw(chip);
  await screen.findByText('Harbour Freight');
  expect(ddOf('status')).toHaveClass('null');
});

test('a preview draws no adornment', async () => {
  fieldRow = { id: 4, name: null, status: 'active' };
  const asked = draw(chip, { connection: 'preview-db' });
  await screen.findByText('active');
  // A preview asks for no record at all.
  expect(asked.every((key) => key === undefined)).toBe(true);
  expect(screen.queryByTestId('chip')).toBeNull();
  expect(document.querySelector('.page-field-adorned')).toBeNull();
});

/* A header leaves an empty fact out, so an adorned one is drawn as a fact of its own; while the host is still asking,
   the facts' line is held, so the adornment never grows a line already painted. */
const headed: PageDef = { ...page, sections: [{ kind: 'fields', presentation: 'header', paths: ['name', 'status'] }] };

test("a header's empty fact is drawn when the host adorns it, its caption over the adornment", async () => {
  fieldRow = { id: 4, name: null, status: 'active' };
  draw(chip, undefined, headed);
  const chipEl = await screen.findByTestId('chip');
  expect(chipEl).toHaveTextContent('standing');
  const fact = chipEl.closest('li.page-fact')!;
  expect(fact.textContent).toBe('Name: standing');
});

test("a header's facts' line is held while the host's adornments are asked", async () => {
  fieldRow = { id: 4, name: null, status: 'active' };
  draw(chip, undefined, headed, true);
  // The row has come, and the line still waits.
  await waitFor(() => expect(document.querySelector('ul.page-head-facts')).not.toBeNull());
  await new Promise((done) => setTimeout(done, 50));
  const held = document.querySelector('ul.page-head-facts')!;
  expect(held).toHaveAttribute('aria-hidden', 'true');
  expect(screen.queryByTestId('chip')).toBeNull();
});

test("a header's facts' line is not held when the asked column is already filled: it could only trail, never grow", async () => {
  fieldRow = { id: 4, name: 'Harbour Freight', status: 'active' };
  draw(chip, undefined, headed, true);
  await screen.findByText('Harbour Freight');
  expect(document.querySelector('ul.page-head-facts')).not.toHaveAttribute('aria-hidden');
});
