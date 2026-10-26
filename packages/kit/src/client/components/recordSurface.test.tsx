import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { bridgeShell } from '../../../../../test/shellBridge.js';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';
import type { AppAction } from '../../../../mistri/src/shared/app.js';
import type { PageProps } from './Page.js';
import type { PageEntry } from './pageModel.js';
import type { RecordSurfaceAlternative, RecordSurfaceEntry, RecordSurfaceOwner, RecordSurfacePage } from './recordSurface.js';
import { beginConnectionTransition } from '../connectionTransition.js';
import {
  acceptTenantRenewal,
  establishSessionIdentity,
  establishTenantSelection,
  lockSessionIdentity,
  requireTenantSelection,
  sessionIdentity,
  suspendTenantLease,
} from '../sessionIdentity.js';

const table: TableMeta = {
  id: 'issue',
  name: 'Issue',
  schema: '',
  isView: false,
  columns: [
    { name: 'tenant', type: 'TEXT', primaryKey: true, nullable: false },
    { name: 'id', type: 'BIGINT', primaryKey: true, nullable: false },
    { name: 'name', type: 'TEXT', primaryKey: false, nullable: false },
  ],
};
const key = { tenant: 'north', id: '9007199254740993' };
const definition: RecordSurfacePage = {
  id: 'config-issue',
  name: 'Issue',
  base: 'issue',
  source: 'config',
  sections: [{ kind: 'fields', paths: ['name'] }],
};
const actions: AppAction[] = [
  { id: 'start', label: 'Start', set: { status: 'active' }, when: 'status = ready' },
  { id: 'assign', label: 'Assign', command: { id: 'assign', version: 1, target: 'issue', input: [] } },
];
const state = { activeConnection: 'demo', schema: { tables: [table] }, stack: [] as PageEntry[] };
/* A record page offers its resource's actions, as /api/app serves them. */
let app: { grantedCommands: string[]; resources: Record<string, { actions?: AppAction[] }> } = {
  grantedCommands: ['assign'],
  resources: { issue: { actions } },
};
let appMode = true,
  canWrite = true,
  walkTick = 0;
let currentEntry: PageEntry | undefined;
const walkListeners = new Set<() => void>();
const tick = () => {
  walkTick++;
  for (const listener of walkListeners) listener();
};
const crumbs = vi.fn(tick),
  visit = vi.fn(),
  sync = vi.fn(),
  go = vi.fn(),
  builder = vi.fn(),
  forget = vi.fn();
const pageById = vi.fn(),
  pagesFor = vi.fn(),
  api = vi.fn(),
  matches = vi.fn();
let renderedPage: PageProps | undefined;

vi.mock('../core.js', () => ({
  state,
  api,
  currentEntry: () => currentEntry,
  findTable: (id: string) => state.schema.tables.find((t) => t.id === id),
  labelPath: () => 'name',
  primaryKey: (t: TableMeta) => t.columns.filter((c) => c.primaryKey).map((c) => c.name),
  writeAllowed: () => canWrite,
  rowLabel: (_table: TableMeta, row: Record<string, unknown>) => row.name,
  subscribeWalk: (listener: () => void) => {
    walkListeners.add(listener);
    return () => walkListeners.delete(listener);
  },
  walkVersion: () => walkTick,
  renderCrumbs: crumbs,
  go,
  humanName: (name: string) => name,
  pageView: (pageId: string, table: string, key?: Record<string, unknown>, label?: string) => ({ kind: 'page', pageId, table, key, label }),
  tableView: (table: string) => ({ kind: 'table', table }),
}));
vi.mock('../../../../mistri/src/client/appState.js', () => ({ activeApp: () => app, inAppMode: () => appMode }));
/* The plan comes with the page's reads composed (recordCompose.ts); here, as the plan it carries. */
vi.mock('../recordCompose.js', () => ({
  composeRecordPage: (connection: string, page: unknown, key: unknown) => api('/api/pages/plan', { conn: connection, page, key }),
}));
vi.mock('../page.js', () => ({ pageById, pagesFor }));
/* The rootless chooser's list; a record page's actions are its resource's, never a list's. */
vi.mock('./appListModel.js', () => ({ appListFor: () => ({ table: 'issue' }), appListQuery: () => 'issue' }));
vi.mock('./pageModel.js', () => ({ rootMatches: matches, rootLabel: (key: Record<string, unknown>) => Object.values(key).join(' · ') }));
vi.mock('../pagemarks.js', () => ({ rememberVisit: visit, forgetPage: forget }));
vi.mock('../../../../tablewalk/src/client/pagebuilder.js', () => ({ openBuilder: builder }));
vi.mock('../url.js', () => ({ syncHash: sync, readdress: () => undefined }));
vi.mock('../filterbar.js', () => ({ deriveFilterNames: () => ['name'] }));
vi.mock('./Rooms.js', () => ({ AppListRoom: () => <div>Collection chooser</div> }));
vi.mock('./TableRoom.js', () => ({ FilterSection: () => null, TableRoom: () => <div>Workbench chooser</div> }));
vi.mock('./Page.js', () => ({
  PageView: (props: PageProps) => {
    renderedPage = props;
    return (
      <div>
        {props.entry.key ? 'Record rendered' : props.chooser}
        <button onClick={() => props.onLabel('Renamed')}>Rename callback</button>
        <button onClick={() => props.onTab('Discussion')}>Tab callback</button>
        <button onClick={props.onLayout}>Layout callback</button>
      </div>
    );
  },
}));

const { captureRecordSurfaceOwner, useRecordSurface } = await import('./recordSurface.js');
const { PageRoom } = await import('./PageRoom.js');
const clients: QueryClient[] = [];
function provider() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  return {
    client,
    wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  };
}
const entry = (): RecordSurfaceEntry => ({ kind: 'page', pageId: definition.id, table: table.id, key: { ...key } });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function drawSurface(owner = captureRecordSurfaceOwner(() => true), selected = entry()) {
  return renderHook((props: { owner: RecordSurfaceOwner; entry: RecordSurfaceEntry }) => useRecordSurface(props), {
    initialProps: { owner, entry: selected },
    wrapper: provider().wrapper,
  });
}
function ready(hook: ReturnType<typeof drawSurface>) {
  const result = hook.result.current.result;
  if (result.status !== 'ready') throw new Error(`Expected ready, got ${result.status}`);
  return result.content;
}

beforeEach(bridgeShell);

beforeEach(() => {
  vi.clearAllMocks();
  state.activeConnection = 'demo';
  state.schema = { tables: [table] };
  state.stack = [];
  currentEntry = undefined;
  app = { grantedCommands: ['assign'], resources: { issue: { actions } } };
  appMode = true;
  canWrite = true;
  renderedPage = undefined;
  pageById.mockReset().mockResolvedValue(definition);
  pagesFor.mockReset().mockResolvedValue([definition, { ...definition, id: 'broken', error: 'Bad layout' }]);
  matches.mockReset().mockResolvedValue(true);
  api.mockReset().mockImplementation(async (path: string) => {
    if (path === '/api/view/run') return { rows: [{ ...key, name: 'Issue one' }] };
    if (path === '/api/pages/plan') return { page: definition, plans: [{ index: 0 }] };
    throw new Error(`Unexpected request: ${path}`);
  });
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
});

test('an explicit non-route entry uses the same four reads and retains authored commands', async () => {
  const selected = entry();
  const hook = drawSurface(undefined, selected);
  await waitFor(() => expect(hook.result.current.result.status).toBe('ready'));
  const content = ready(hook);
  expect(pageById).toHaveBeenCalledExactlyOnceWith('config-issue', 'issue');
  expect(pagesFor).toHaveBeenCalledExactlyOnceWith('issue');
  // The plan first: the probe then waits for the row its compose reads.
  expect(api.mock.calls.map(([path]) => path)).toEqual(['/api/pages/plan', '/api/view/run']);
  expect(api.mock.calls[1][1]).toMatchObject({
    conn: 'demo',
    count: 'none',
    view: {
      base: 'issue',
      columns: [{ path: 'tenant' }, { path: 'id' }, { path: 'name' }],
      filter: {
        groups: [
          [
            { path: 'tenant', op: '=', value: 'north' },
            { path: 'id', op: '=', value: key.id },
          ],
        ],
      },
      limit: 1,
    },
  });
  expect(api.mock.calls[0][1]).toEqual({ conn: 'demo', page: 'config-issue', key });
  expect(content).toMatchObject({ entry: selected, page: definition, plans: [{ index: 0 }], others: [definition] });
  expect(content.actions).toMatchObject({ list: actions, grantedCommands: ['assign'], canUpdate: true });
  expect(content.actions?.queryScope).toEqual(expect.any(Number));
  expect(content.actions?.list[1].command?.id).toBe('assign');
  expect(hook.result.current.rootRow?.name).toBe('Issue one');
  expect(selected.label).toBeUndefined();
  expect(crumbs).not.toHaveBeenCalled();
  expect(visit).not.toHaveBeenCalled();
  expect(go).not.toHaveBeenCalled();
  hook.rerender({ owner: captureRecordSurfaceOwner(() => false), entry: selected });
  expect(hook.result.current.result.status).toBe('retired');
});

test.each(['saved', 'suggested'] as const)('%s layouts retain the existing planner envelope', async (source) => {
  const page = { ...definition, source, id: `${source}:issue` };
  pageById.mockResolvedValue(page);
  const hook = drawSurface();
  await waitFor(() => expect(hook.result.current.result.status).toBe('ready'));
  expect(api.mock.calls[0][1].page).toEqual(source === 'saved' ? page : page.id);
});

test('failed alternatives preserve the record; explicit read-only CRUD does not discard commands', async () => {
  pagesFor.mockRejectedValue(new Error('Alternatives unavailable'));
  canWrite = false;
  const hook = drawSurface();
  await waitFor(() => expect(hook.result.current.result.status).toBe('ready'));
  expect(ready(hook)).toMatchObject({ others: [], actions: { list: actions, canUpdate: false, grantedCommands: ['assign'] } });
});

test.each(['page-def', 'page-plan'])('%s refresh failure preserves the explicit editor only for its current owner', async (query) => {
  const selected = entry(),
    { client, wrapper } = provider();
  let live = true;
  const owner = captureRecordSurfaceOwner(() => live);
  const hook = renderHook(() => useRecordSurface({ owner, entry: selected }), { wrapper });
  await waitFor(() => expect(hook.result.current.result.status).toBe('ready'));
  const before = hook.result.current.result;
  if (before.status !== 'ready') throw new Error('Expected loaded editor');
  if (query === 'page-def') pageById.mockRejectedValue(new Error('Offline refresh'));
  else api.mockRejectedValue(new Error('Offline refresh'));
  await act(async () => {
    await client.refetchQueries({ queryKey: [query] });
  });
  await waitFor(() => expect(client.getQueryCache().find({ queryKey: [query], exact: false })?.state.status).toBe('error'));
  expect(hook.result.current.result).toMatchObject({ status: 'ready', refreshFailed: true });
  const after = hook.result.current.result;
  if (after.status !== 'ready') throw new Error('Expected retained editor');
  expect(after.content.entry).toBe(before.content.entry);
  expect(after.content.plans).toBe(before.content.plans);
  live = false;
  hook.rerender();
  expect(hook.result.current.result.status).toBe('retired');
});

test.each(['page-def', 'page-plan'])('%s refresh failure does not remount a routed editor', async (query) => {
  const selected = entry();
  currentEntry = selected;
  const { client, wrapper } = provider();
  render(<PageRoom entry={selected} />, { wrapper });
  const editor = await screen.findByText('Record rendered');
  if (query === 'page-def') pageById.mockRejectedValue(new Error('Offline refresh'));
  else api.mockRejectedValue(new Error('Offline refresh'));
  await act(async () => {
    await client.refetchQueries({ queryKey: [query] });
  });
  await waitFor(() => expect(client.getQueryCache().find({ queryKey: [query], exact: false })?.state.status).toBe('error'));
  expect(screen.getByText('Record rendered')).toBe(editor);
  expect(screen.getByRole('alert')).toHaveTextContent('Could not refresh');
});

test('a held alternatives list does not delay the root probe or planning', async () => {
  const held = deferred<RecordSurfaceAlternative[]>();
  pagesFor.mockReturnValueOnce(held.promise);
  const hook = drawSurface();
  await waitFor(() => expect(api.mock.calls.map(([path]) => path)).toEqual(['/api/pages/plan', '/api/view/run']));
  expect(hook.result.current.result.status).toBe('loading');
  await act(async () => {
    held.resolve([definition]);
  });
  await waitFor(() => expect(hook.result.current.result.status).toBe('ready'));
});

test('a held root probe starts planning but cannot render a record or missing state', async () => {
  const probe = deferred<{ rows: Array<Record<string, unknown>> }>();
  const plan = deferred<{ page: RecordSurfacePage; plans: Array<{ index: number }> }>();
  api.mockImplementation((path: string) =>
    path === '/api/view/run'
      ? probe.promise
      : path === '/api/pages/plan'
        ? plan.promise
        : Promise.reject(new Error(`Unexpected request: ${path}`)),
  );
  const surface = drawSurface();
  await waitFor(() => expect(api.mock.calls.map(([path]) => path)).toEqual(['/api/pages/plan', '/api/view/run']));
  await act(async () => {
    plan.resolve({ page: definition, plans: [{ index: 0 }] });
  });
  expect(surface.result.current.result.status).toBe('loading');
  expect(surface.result.current.rootRow).toBeUndefined();
  await act(async () => {
    probe.resolve({ rows: [] });
  });
  await waitFor(() => expect(surface.result.current.result.status).toBe('missing'));
});

test('a missing root never renders a concurrent plan, while an unreachable probe preserves the planning error', async () => {
  api.mockImplementation(async (path: string) =>
    path === '/api/view/run'
      ? { rows: [] }
      : path === '/api/pages/plan'
        ? { page: definition, plans: [{ index: 0 }] }
        : Promise.reject(new Error(`Unexpected request: ${path}`)),
  );
  const missing = drawSurface();
  await waitFor(() => expect(missing.result.current.result.status).toBe('missing'));
  expect(api.mock.calls.map(([path]) => path)).toEqual(['/api/pages/plan', '/api/view/run']);
  missing.unmount();
  api
    .mockReset()
    .mockImplementation((path: string) =>
      path === '/api/view/run'
        ? Promise.reject(new Error('Offline'))
        : path === '/api/pages/plan'
          ? Promise.reject(new Error('Plan unavailable'))
          : Promise.reject(new Error(`Unexpected request: ${path}`)),
    );
  const unavailable = drawSurface();
  await waitFor(() => expect(unavailable.result.current.result).toEqual({ status: 'error', message: 'Plan unavailable' }));
  expect(api).toHaveBeenCalledTimes(2);
});

test('explicit surfaces never resolve a mismatched table by mutating their entry', async () => {
  const selected = { ...entry(), table: 'different' };
  const hook = drawSurface(undefined, selected);
  await waitFor(() => expect(hook.result.current.result.status).toBe('error'));
  expect(selected.table).toBe('different');
  expect(pagesFor).not.toHaveBeenCalled();
  expect(api).not.toHaveBeenCalled();
});

test.each([{}, { id: key.id }, { ...key, extra: 'another' }, { ...key, id: null }])(
  'an explicit surface refuses an incomplete or invalid key before root reads: %j',
  async (invalid) => {
    const hook = drawSurface(undefined, { ...entry(), key: invalid });
    await waitFor(() => expect(hook.result.current.result.status).toBe('error'));
    expect(api).not.toHaveBeenCalled();
    expect(pagesFor).not.toHaveBeenCalled();
  },
);

test('tenant renewal keeps the captured owner; a new business context retires it', () => {
  establishSessionIdentity({ signedIn: true, accountId: 'account', appId: 'demo' });
  requireTenantSelection();
  const lease = {
    appId: 'demo',
    accountId: 'account',
    tenantId: 'north',
    tabId: 'tab',
    context: 'context-1',
    revision: 1,
    expiresAt: Date.now() + 60_000,
  };
  establishTenantSelection(lease);
  const identity = sessionIdentity();
  const owner = captureRecordSurfaceOwner(() => true);
  suspendTenantLease(identity);
  // The existing suspension overlay/API lease gate owns availability. Keeping
  // this identity preserves the mounted editor instead of resetting its draft.
  expect(owner.isCurrent()).toBe(true);
  acceptTenantRenewal(identity, 1, { ...lease, revision: 2, expiresAt: lease.expiresAt + 60_000 });
  expect(owner.isCurrent()).toBe(true);
  requireTenantSelection();
  establishTenantSelection({ ...lease, tenantId: 'south', context: 'context-2' });
  expect(owner.isCurrent()).toBe(false);
});

test.each(['host', 'schema', 'connection', 'generation', 'account', 'app', 'mode'] as const)(
  '%s replacement fences a held definition before any dependent request',
  async (change) => {
    const held = deferred<RecordSurfacePage>();
    pageById.mockReturnValueOnce(held.promise);
    let live = true;
    const hook = drawSurface(captureRecordSurfaceOwner(() => live));
    await waitFor(() => expect(pageById).toHaveBeenCalledOnce());
    await act(async () => {
      if (change === 'host') live = false;
      if (change === 'schema') state.schema = { tables: [table] };
      if (change === 'connection') state.activeConnection = 'other';
      if (change === 'generation') beginConnectionTransition().finish();
      if (change === 'account') establishSessionIdentity({ signedIn: true, accountId: 'new-account', appId: 'demo' });
      if (change === 'app') app = { grantedCommands: [], resources: { issue: { actions } } };
      if (change === 'mode') appMode = false;
      held.resolve(definition);
    });
    await waitFor(() => expect(hook.result.current.result.status).toBe('retired'));
    expect(pagesFor).not.toHaveBeenCalled();
    expect(api).not.toHaveBeenCalled();
  },
);

test('held old probe and plan responses cannot populate the same record reopened under a new surface', async () => {
  const probe = deferred<{ rows: Array<Record<string, unknown>> }>();
  const plan = deferred<{ page: RecordSurfacePage; plans: Array<{ index: number }> }>();
  let views = 0,
    plans = 0;
  api.mockImplementation((path: string) => {
    if (path === '/api/view/run') return ++views === 1 ? probe.promise : Promise.resolve({ rows: [{ ...key, name: 'Issue one' }] });
    if (path === '/api/pages/plan') return ++plans === 1 ? plan.promise : Promise.resolve({ page: definition, plans: [{ index: 0 }] });
    return Promise.reject(new Error(`Unexpected request: ${path}`));
  });
  let generation = 1;
  const selected = entry();
  const hook = drawSurface(
    captureRecordSurfaceOwner(() => generation === 1),
    selected,
  );
  await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
  generation = 2;
  hook.rerender({ owner: captureRecordSurfaceOwner(() => generation === 2), entry: selected });
  await waitFor(() => expect(hook.result.current.result.status).toBe('ready'));
  await act(async () => {
    probe.resolve({ rows: [{ ...key, name: 'Obsolete response' }] });
    plan.resolve({ page: definition, plans: [{ index: 0 }] });
  });
  expect(hook.result.current.rootRow?.name).toBe('Issue one');
  expect(api.mock.calls.filter(([path]) => path === '/api/pages/plan')).toHaveLength(2);
});

test('a retired planner failure is not published into the replacement surface', async () => {
  const held = deferred<never>();
  api.mockImplementation(async (path: string) => (path === '/api/view/run' ? { rows: [{ ...key, name: 'Issue one' }] } : held.promise));
  let live = true;
  const hook = drawSurface(captureRecordSurfaceOwner(() => live));
  await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
  await act(async () => {
    live = false;
    held.reject(Object.assign(new Error('Unknown outcome'), { outcome: 'unknown' }));
  });
  await waitFor(() => expect(hook.result.current.result.status).toBe('retired'));
  expect(api.mock.calls.every(([path]) => ['/api/view/run', '/api/pages/plan'].includes(path))).toBe(true);
  expect(go).not.toHaveBeenCalled();
});

test('action visibility rechecks ownership after awaiting and before a subsequent read', async () => {
  const hook = drawSurface();
  await waitFor(() => expect(hook.result.current.result.status).toBe('ready'));
  const action = ready(hook).actions!;
  const held = deferred<boolean>();
  matches.mockReturnValueOnce(held.promise);
  const pending = action.matches('status = ready');
  expect(matches).toHaveBeenCalledWith(table, key, 'status = ready', 'demo');
  await act(async () => {
    lockSessionIdentity();
    held.resolve(true);
  });
  expect(await pending).toBe(false);
  expect(await action.matches('status = ready')).toBe(false);
  expect(matches).toHaveBeenCalledOnce();
});

test('routed rendering retains early labels, visits, authored actions and tab/label callbacks', async () => {
  const selected = entry();
  currentEntry = selected;
  render(<PageRoom entry={selected} />, { wrapper: provider().wrapper });
  await screen.findByText('Record rendered');
  expect(selected.label).toBe('Issue one');
  expect(visit).toHaveBeenCalledWith({ pageId: definition.id, name: definition.name, base: definition.base, key, label: 'Issue one' });
  expect(renderedPage?.actions?.list).toEqual(actions);
  expect(renderedPage?.actions?.queryScope).toEqual(expect.any(Number));
  fireEvent.click(screen.getByText('Tab callback'));
  expect(selected.tab).toBe('Discussion');
  expect(sync).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByText('Rename callback'));
  expect(selected.label).toBe('Renamed');
  expect(visit).toHaveBeenLastCalledWith(expect.objectContaining({ key, label: 'Renamed' }));
  fireEvent.click(screen.getByText('Layout callback'));
  const callbacks = builder.mock.calls[0][1];
  callbacks.onSaved({ id: 'saved:issue', base: 'issue' });
  expect(go).toHaveBeenLastCalledWith({ kind: 'page', pageId: 'saved:issue', table: 'issue', key, label: 'Renamed' }, 'replace');
  callbacks.onDeleted();
  expect(forget).toHaveBeenCalledWith(definition.id);
  expect(go).toHaveBeenLastCalledWith({ kind: 'table', table: 'issue' }, 'replace');
});

test('a stale routed callback cannot act as an explicit surface merely because its data is loaded', async () => {
  const selected = entry();
  currentEntry = selected;
  render(<PageRoom entry={selected} />, { wrapper: provider().wrapper });
  await screen.findByText('Record rendered');
  const callbacks = renderedPage!;
  currentEntry = entry();
  crumbs.mockClear();
  visit.mockClear();
  sync.mockClear();
  callbacks.onLabel('Stale label');
  callbacks.onTab('Stale tab');
  expect(selected.label).toBe('Issue one');
  expect(selected.tab).toBeUndefined();
  expect(crumbs).not.toHaveBeenCalled();
  expect(visit).not.toHaveBeenCalled();
  expect(sync).not.toHaveBeenCalled();
});

test('navigation during a routed root read cannot rename or visit the abandoned entry', async () => {
  const held = deferred<{ rows: Array<Record<string, unknown>> }>();
  api.mockImplementation(async (path: string) => (path === '/api/view/run' ? held.promise : { page: definition, plans: [{ index: 0 }] }));
  const selected = entry();
  currentEntry = selected;
  render(<PageRoom entry={selected} />, { wrapper: provider().wrapper });
  await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
  await act(async () => {
    currentEntry = entry();
    tick();
    held.resolve({ rows: [{ ...key, name: 'Old record' }] });
  });
  expect(selected.label).toBeUndefined();
  expect(visit).not.toHaveBeenCalled();
  expect(crumbs).not.toHaveBeenCalled();
  expect(screen.queryByText('Record rendered')).not.toBeInTheDocument();
  expect(api).toHaveBeenCalledTimes(2);
});

test('cold routed links resolve their complete string key before record reads', async () => {
  const selected: PageEntry = { kind: 'page', pageId: definition.id, rootBody: `tenant=north,id=${key.id}` };
  currentEntry = selected;
  render(<PageRoom entry={selected} />, { wrapper: provider().wrapper });
  await screen.findByText('Record rendered');
  expect(selected.table).toBe('issue');
  expect(selected.key).toEqual(key);
  expect(api.mock.calls[0][1].key).toEqual(key);
});

test('rootless routed pages retain their chooser and do not run root/plan queries', async () => {
  const selected: PageEntry = { kind: 'page', pageId: definition.id, table: 'issue' };
  currentEntry = selected;
  render(<PageRoom entry={selected} />, { wrapper: provider().wrapper });
  await screen.findByText('Collection chooser');
  expect(selected.label).toBe('Issue');
  expect(api).not.toHaveBeenCalled();
  expect(visit).not.toHaveBeenCalled();
});
