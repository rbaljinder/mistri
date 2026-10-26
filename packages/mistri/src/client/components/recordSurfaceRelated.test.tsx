import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { bridgeShell } from '../../../../../test/shellBridge.js';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PageProps, PageViewHost } from '../../../../kit/src/client/components/Page.js';
import type { ColumnMeta, DatabaseSchema, TableMeta } from '../../../../engine/src/shared/schema.js';
import { columnKind, primaryKey } from '../../../../engine/src/shared/schema.js';
import { humanName } from '../../../../engine/src/shared/model.js';
import type { ResolvedResource } from '../../shared/app.js';
import { establishSessionIdentity, lockSessionIdentity, sessionIdentity } from '../../../../kit/src/client/sessionIdentity.js';

const model = vi.hoisted(() => ({
  current: true,
  route: {},
  api: vi.fn(),
  go: vi.fn(),
  open: vi.fn(),
  refresh: vi.fn(),
  app: null as { resources: Record<string, ResolvedResource> } | null,
  probes: new Set<() => boolean>(),
  mount: vi.fn(),
  state: {
    activeConnection: 'thread',
    canWrite: true,
    connections: [{ id: 'thread', writable: true }],
    schema: undefined as DatabaseSchema | undefined,
  },
}));
vi.mock('../../../../kit/src/client/core.js', () => ({
  recordLabel: () => undefined,
  columnDisplay: () => null,
  $: () => ({ addEventListener() {}, setAttribute() {}, textContent: '', title: '' }),
  state: model.state,
  api: model.api,
  go: model.go,
  openRecord: model.open,
  currentEntry: () => model.route,
  allowMutationExit: () => ![...model.probes].some((probe) => probe()),
  registerSurfaceMutationPendingProbe: (probe: () => boolean) => {
    model.probes.add(probe);
    return () => model.probes.delete(probe);
  },
  whenConnectionChanges: () => () => {},
  captureNavigation: () => () => true,
  setRecordMutationPendingProbe: () => {},
  findTable: (id: string) => model.state.schema?.tables.find((table) => table.id === id),
  rowLabel: (_table: TableMeta, row: Record<string, unknown>) => String(row.name ?? row.id),
  labelPath: () => 'name',
  primaryKey,
  columnKind,
  humanName,
  columnLabel: () => null,
  refsFrom: () => [],
  prefersPages: () => true,
  writeAllowed: () => true,
  emptyWord: () => 'Empty',
  quote: (v: unknown) => String(v),
  loadJson: () => ({}),
  saveJson: () => {},
  render: () => {},
  toast: () => {},
  el: (tag: string, attrs?: { class?: string }) => Object.assign(document.createElement(tag), { className: attrs?.class ?? '' }),
  viewportBox: (node: Element) => node.getBoundingClientRect(),
  viewportSize: () => ({ width: 1000, height: 800 }),
  disclosure: () => {},
}));
vi.mock('../appState.js', () => ({ inAppMode: () => true, appSaveMode: () => 'explicit', activeApp: () => model.app }));
vi.mock('../../../../kit/src/client/url.js', () => ({ syncHash: () => {} }));
vi.mock('../../../../kit/src/client/prefs.js', () => ({ relatedRows: () => 10 }));
vi.mock('../../../../kit/src/client/pagemarks.js', () => ({ isPinned: () => false, togglePinned: () => true }));
vi.mock('../../../../kit/src/client/prompt.js', () => ({ ask: vi.fn(), confirmFor: vi.fn() }));
vi.mock('../../../../tablewalk/src/client/undo.js', () => ({
  refreshUndo: model.refresh,
  undoLast: async () => {},
  undoEntry: async () => undefined,
}));
vi.mock('../../../../kit/src/client/recordWriteRefresh.js', () => ({ captureRecordWriteRefresh: () => () => {} }));
vi.mock('../../../../kit/src/client/components/mount.js', () => ({ mount: model.mount, unmount: vi.fn() }));
vi.mock('../../../../kit/src/client/components/walk.js', () => ({ useWalk: () => {} }));
vi.mock('./Actions.js', () => ({ ActionBar: () => null, useReachable: () => new Set() }));
vi.mock('../../../../kit/src/client/components/DeleteButton.js', () => ({
  useDelete: () => ({ available: false, blocked: false, ask: () => {}, dialog: null }),
}));
vi.mock('../../../../kit/src/client/components/WorkflowStatus.js', () => ({ WorkflowStatus: () => null }));
vi.mock('../../../../kit/src/client/components/Value.js', () => ({
  Value: ({ value }: { value: unknown }) => <span>{String(value)}</span>,
  RefJump: () => null,
}));
vi.mock('../../../../kit/src/client/components/Grid.js', () => ({ Grid: () => <div>Related records</div> }));
const { PageView } = await import('../../../../kit/src/client/components/Page.js');
const { Modal } = await import('@mistriwork/ui/Modal.js');
const { activateDraft, discardStaged, stagedValue } = await import('../../../../kit/src/client/write.js');
const { updateAttempts } = await import('../../../../kit/src/client/updateAttempts.js');

const column = (name: string, extra: Partial<ColumnMeta> = {}): ColumnMeta => ({
  name,
  type: 'TEXT',
  primaryKey: false,
  nullable: false,
  ...extra,
});
const issue: TableMeta = {
  id: 'issue',
  name: 'issue',
  schema: '',
  isView: false,
  columns: [column('id', { primaryKey: true }), column('name')],
};
const person: TableMeta = {
  id: 'person',
  name: 'person',
  schema: '',
  isView: false,
  columns: [column('id', { primaryKey: true }), column('name')],
};
const update: TableMeta = {
  id: 'comment',
  name: 'comment',
  schema: '',
  isView: false,
  columns: [
    column('id', { primaryKey: true, identity: 'always' }),
    column('issue_id', { references: { table: 'issue', column: 'id' } }),
    column('body'),
    column('author_id', { references: { table: 'person', column: 'id' } }),
  ],
};
const key = { id: '9007199254740993' },
  row = { ...key, name: 'Parent issue' };
const clients: QueryClient[] = [];
let withCreate = true;
function pageProps(): PageProps {
  return {
    entry: { kind: 'page', pageId: 'issue', table: 'issue', key, label: row.name },
    page: {
      id: 'issue',
      name: 'Issue',
      base: 'issue',
      source: 'config',
      sections: [
        { kind: 'fields', paths: ['name'] },
        {
          kind: 'list',
          title: 'Discussion',
          from: 'comment',
          path: 'issue_id',
          ...(withCreate ? { create: { label: 'Add update', show: ['body', 'author_id'] } } : {}),
        },
      ],
    },
    base: issue,
    plans: [
      { index: 0 },
      { index: 1, view: { id: 'discussion', name: 'Discussion', base: 'comment', columns: [{ path: 'id' }, { path: 'body' }], limit: 10 } },
    ],
    others: [],
    onLabel: vi.fn(),
    onTab: vi.fn(),
    onLayout: vi.fn(),
  };
}
function draw(hosted = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const identity = sessionIdentity(),
    schema = model.state.schema;
  const current = () =>
    model.current && sessionIdentity() === identity && model.state.schema === schema && model.state.activeConnection === 'thread';
  const host: PageViewHost = {
    owner: { isCurrent: current, connection: 'thread', queryScope: 1 } as unknown as PageViewHost['owner'],
    pendingBar: 'inline',
    onRecordChange: vi.fn(),
    onActionDone: vi.fn(),
    onDeleted: vi.fn(),
    onDeleteStateChange: vi.fn(),
  };
  const close = vi.fn();
  const view = render(
    <QueryClientProvider client={client}>
      <Modal
        className="record-modal"
        aria-label="Parent issue"
        onClose={close}
        beforeClose={() => ![...model.probes].some((probe) => probe())}
      >
        <PageView {...pageProps()} host={hosted ? host : undefined} />
      </Modal>
    </QueryClientProvider>,
  );
  return { ...view, client, host, close };
}
beforeEach(bridgeShell);

beforeEach(() => {
  withCreate = true;
  model.current = true;
  model.route = {};
  model.state.activeConnection = 'thread';
  model.app = null;
  model.state.schema = {
    label: 'Thread',
    dialect: 'sqlite',
    readAt: '',
    tables: [issue, update, person],
    foreignKeys: [{ name: 'issue_id', from: { table: 'comment', columns: ['issue_id'] }, to: { table: 'issue', columns: ['id'] } }],
  };
  establishSessionIdentity({ signedIn: false });
  act(() => {
    updateAttempts.reset();
    activateDraft(issue, key);
    discardStaged();
  });
  model.go.mockReset();
  model.open.mockReset();
  model.refresh.mockReset();
  model.mount.mockReset();
  model.api.mockReset();
  model.api.mockImplementation(async (path, body) => {
    if (path === '/api/run' || path === '/api/query') return { rows: [{ id: 'author-7', name: 'Alice' }] };
    if (path === '/api/view/run')
      return {
        view: body.view,
        rows: body.view.base === 'issue' ? [row] : [],
        columns: body.view.columns.map((c: { path: string }) => c.path),
        errors: [],
        more: false,
        limit: 10,
      };
    if (path === '/api/insert') return { key: { id: 'update-1' } };
    throw new Error(`Unexpected request: ${path}`);
  });
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  model.probes.clear();
  lockSessionIdentity();
});
const blocked = () => [...model.probes].some((probe) => probe());

/* Who may add a file is who may add the row: a row policy says so through the catalog's `insertable`, as for any New. */
test.each([true, false])('a file upload is offered where the catalog lets this reader insert: %s', async (allowed) => {
  model.app = { resources: { comment: { file: { content: 'body', name: 'id' } } } };
  if (!allowed)
    model.state.schema = {
      ...model.state.schema!,
      tables: model.state.schema!.tables.map((table) => (table.id === 'comment' ? { ...table, insertable: false } : table)),
    };
  draw(false);
  await screen.findByText('No discussion yet.');
  expect(screen.queryByRole('button', { name: '+ Add update' }) !== null).toBe(allowed);
  expect(screen.queryByText('or drop files here') !== null).toBe(allowed);
});
// The file's own columns are the upload's to fill, so a list of files needs no create to take one.
test('a list of files offers its upload with no create of its own', async () => {
  withCreate = false;
  model.app = { resources: { comment: { file: { content: 'body', name: 'id' } } } };
  draw(false);
  await screen.findByText('No discussion yet.');
  expect(screen.getByText('or drop files here')).toBeInTheDocument();
});
const inserts = () => model.api.mock.calls.filter(([path]) => path === '/api/insert');
async function openRelated() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Edit Name' }));
  const parentInput = screen.getByRole('textbox', { name: 'Name' });
  await user.type(parentInput, ' draft');
  const draft = activateDraft(issue, key);
  const trigger = await screen.findByRole('button', { name: '+ Add update' });
  await user.click(trigger);
  const dialog = await screen.findByRole('dialog', { name: 'New comment' });
  return { user, parentInput, draft, trigger, dialog };
}
async function fillRelated() {
  const opened = await openRelated();
  await opened.user.type(within(opened.dialog).getByRole('textbox', { name: 'Body' }), 'Discussion text');
  await opened.user.type(within(opened.dialog).getByRole('combobox', { name: 'Author ID' }), 'Ali');
  await opened.user.click(await screen.findByRole('option', { name: 'Alice author-7' }));
  return opened;
}

test('nested shared form/picker insert preserves the exact mounted parent editor/draft and route', async () => {
  const view = draw();
  const opened = await fillRelated();
  expect(opened.dialog).toHaveClass('insert-dialog');
  expect(opened.dialog).toHaveAttribute('data-nested');
  expect(screen.queryByRole('textbox', { name: 'Issue id' })).toBeNull();
  expect(model.mount).not.toHaveBeenCalled();
  expect(document.querySelector('.newpanel-host')).toBeNull();
  await opened.user.click(within(opened.dialog).getByRole('button', { name: 'Add' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New comment' })).toBeNull());
  expect(inserts()).toEqual([
    ['/api/insert', { conn: 'thread', table: 'comment', values: { issue_id: key.id, body: 'Discussion text', author_id: 'author-7' } }],
  ]);
  expect(screen.getByRole('textbox', { name: 'Name' })).toBe(opened.parentInput);
  expect(opened.parentInput).toHaveValue('Parent issue draft');
  expect(activateDraft(issue, key)).toBe(opened.draft);
  expect(stagedValue('name')).toBe('Parent issue draft');
  expect(model.open).not.toHaveBeenCalled();
  expect(model.go).not.toHaveBeenCalled();
  expect(view.close).not.toHaveBeenCalled();
  expect(blocked()).toBe(false);
  expect(await screen.findByText('Record added')).toBeVisible();
  expect(model.refresh).toHaveBeenCalledOnce();
});

test('ordinary routed related creation retains the existing drawer path', async () => {
  draw(false);
  await userEvent.setup().click(await screen.findByRole('button', { name: '+ Add update' }));
  expect(model.mount).toHaveBeenCalledOnce();
  expect(document.querySelector('.newpanel-host')).not.toBeNull();
  expect(screen.queryByRole('dialog', { name: 'New comment' })).toBeNull();
  document.querySelector('.newpanel-host')?.remove();
});

test('discard confirmation closes only the nested draft and restores its trigger', async () => {
  const view = draw();
  const opened = await fillRelated();
  await opened.user.click(within(opened.dialog).getByRole('button', { name: 'Cancel' }));
  await opened.user.click(await screen.findByRole('button', { name: 'Keep editing' }));
  expect(within(opened.dialog).getByRole('textbox', { name: 'Body' })).toHaveValue('Discussion text');
  await opened.user.click(within(opened.dialog).getByRole('button', { name: 'Cancel' }));
  await opened.user.click(await screen.findByRole('button', { name: 'Discard record' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New comment' })).toBeNull());
  expect(stagedValue('name')).toBe('Parent issue draft');
  expect(activateDraft(issue, key)).toBe(opened.draft);
  expect(inserts()).toHaveLength(0);
  expect(view.close).not.toHaveBeenCalled();
});

test.each(['unknown', 'rejected'])('nested insert %s preserves the actual outcome and parent navigation lock', async (outcome) => {
  let settle!: (value: unknown) => void;
  const original = model.api.getMockImplementation()!;
  model.api.mockImplementation((path, body) =>
    path === '/api/insert'
      ? new Promise((resolve) => {
          settle = resolve;
        })
      : original(path, body),
  );
  draw();
  const opened = await fillRelated();
  await opened.user.click(within(opened.dialog).getByRole('button', { name: 'Add' }));
  expect(blocked()).toBe(true);
  expect(within(opened.dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
  await act(async () => settle({ errors: [{ message: 'Could not add' }], outcome }));
  await waitFor(() => expect(blocked()).toBe(outcome === 'unknown'));
  expect(within(opened.dialog).getByRole('button', { name: 'Cancel' })).toHaveProperty('disabled', outcome === 'unknown');
  expect(within(opened.dialog).getByRole('button', { name: 'Add' })).toHaveProperty('disabled', outcome === 'unknown');
  expect(stagedValue('name')).toBe('Parent issue draft');
  expect(inserts()).toHaveLength(1);
  if (outcome === 'unknown') {
    await opened.user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'New comment' })).toBeInTheDocument();
    expect(blocked()).toBe(true);
  }
});

test.each(['host', 'native', 'schema', 'connection', 'route'])('nested form refuses dispatch after %s retirement', async (boundary) => {
  draw();
  const opened = await fillRelated();
  if (boundary === 'host') model.current = false;
  if (boundary === 'native') act(() => lockSessionIdentity());
  if (boundary === 'schema') model.state.schema = { ...model.state.schema! };
  if (boundary === 'connection') model.state.activeConnection = 'other';
  if (boundary === 'route') model.route = {};
  fireEvent.submit(opened.dialog.querySelector('form')!);
  await act(async () => {});
  expect(inserts()).toHaveLength(0);
  expect(model.open).not.toHaveBeenCalled();
  expect(model.go).not.toHaveBeenCalled();
});
