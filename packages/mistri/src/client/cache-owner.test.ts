import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { PageBuilderProps } from '../../../tablewalk/src/client/components/PageBuilder.js';
import type { LayoutBuilderProps } from '../../../kit/src/client/components/LayoutBuilder.js';

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  mount: vi.fn(),
  unmount: vi.fn(),
  changed: vi.fn(),
  toast: vi.fn(),
  prompt: vi.fn(),
  render: vi.fn(),
}));
vi.mock('../../../kit/src/client/core.js', async () => {
  const { sessionStorageKey } = await import('../../../kit/src/client/sessionIdentity.js');
  const table = {
    id: 'item',
    name: 'item',
    schema: '',
    isView: false,
    columns: [
      { name: 'id', type: 'TEXT', primaryKey: true, nullable: false },
      { name: 'name', type: 'TEXT', primaryKey: false, nullable: false },
    ],
  };
  const state = { activeConnection: 'same-connection', schema: { tables: [table], foreignKeys: [] } };
  const entry = {};
  return {
    ...mocks,
    state,
    findTable: () => table,
    refsTo: () => [],
    currentEntry: () => entry,
    subscribeWalk: () => () => {},
    whenConnectionChanges: () => () => {},
    go: vi.fn(),
    pageView: vi.fn(),
    loadJson: (key: string, fallback: unknown) => {
      const mapped = sessionStorageKey(key);
      return mapped ? (JSON.parse(localStorage.getItem(mapped) ?? 'null') ?? fallback) : fallback;
    },
    saveJson: (key: string, value: unknown) => {
      const mapped = sessionStorageKey(key);
      if (!mapped) return false;
      localStorage.setItem(mapped, JSON.stringify(value));
      return true;
    },
  };
});
vi.mock('../../../kit/src/client/components/mount.js', async () => {
  const { QueryClient } = await import('@tanstack/react-query');
  return {
    mount: mocks.mount,
    unmount: mocks.unmount,
    queryClient: new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } }),
  };
});
vi.mock('../../../kit/src/client/prompt.js', () => ({ promptFor: mocks.prompt, confirmFor: vi.fn() }));
vi.mock('../../../kit/src/client/components/LayoutBuilder.js', () => ({ LayoutBuilder: () => null }));
vi.mock('../../../kit/src/client/components/Peek.js', () => ({ PeekLayer: () => null }));
vi.mock('../../../kit/src/client/components/appListModel.js', () => ({
  appListFor: vi.fn(),
  appListQuery: vi.fn(),
  appCrumbLabel: vi.fn(),
}));
vi.mock('../../../kit/src/client/connectionScope.js', () => ({ canUseDatabaseTools: () => true }));

let identity: typeof import('../../../kit/src/client/sessionIdentity.js');
let pages: typeof import('../../../tablewalk/src/client/pagebuilder.js') & typeof import('../../../kit/src/client/savedPages.js');
let layouts: typeof import('../../../kit/src/client/template.js');
let sql: typeof import('../../../tablewalk/src/client/sqlsaved.js');
let lists: typeof import('./applist.js');
let peek: typeof import('../../../kit/src/client/peek.js');
let queryClient: (typeof import('../../../kit/src/client/components/mount.js'))['queryClient'];
const page = (name: string) => ({
  id: 'saved:item',
  name,
  base: 'item',
  source: 'saved' as const,
  sections: [{ kind: 'fields' as const }],
});
const layout = (name: string) => ({ id: 'item-layout', name, base: 'item', sections: [{ kind: 'fields' as const, paths: ['name'] }] });
function deferred() {
  let resolve!: (value: unknown) => void, reject!: (error: Error) => void;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
let generation = 0;
function select(tenantId = 'north') {
  identity.requireTenantSelection();
  identity.establishTenantSelection({
    appId: 'app',
    accountId: 'ada',
    tenantId,
    tabId: 'tab',
    context: `context-${++generation}`,
    revision: 1,
    expiresAt: Date.now() + 60000,
  });
}
const editor = () => (mocks.mount.mock.calls.at(-1)![1] as ReactElement<PageBuilderProps>).props;
const layoutEditor = () => (mocks.mount.mock.calls.at(-1)![1] as ReactElement<LayoutBuilderProps>).props;
const disk = () => Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)]);

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  localStorage.clear();
  document.body.innerHTML = '';
  mocks.api.mockResolvedValue({ ok: true });
  generation = 0;
  identity = await import('../../../kit/src/client/sessionIdentity.js');
  identity.establishSessionIdentity({ signedIn: true, appId: 'app', accountId: 'ada' });
  select();
  ({ queryClient } = await import('../../../kit/src/client/components/mount.js'));
  (await import('../../../kit/src/client/surfaces.js')).registerSurface('pageBuilder', () => null);
  pages = { ...(await import('../../../tablewalk/src/client/pagebuilder.js')), ...(await import('../../../kit/src/client/savedPages.js')) };
  pages.whenSavedPagesChange(mocks.changed);
  layouts = await import('../../../kit/src/client/template.js');
  sql = await import('../../../tablewalk/src/client/sqlsaved.js');
  lists = await import('./applist.js');
  peek = await import('../../../kit/src/client/peek.js');
});
afterEach(() => {
  identity.lockSessionIdentity();
  queryClient.clear();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

test('same-connection tenant selection retires synchronous page/layout/SQL/filter/peek caches', async () => {
  mocks.api.mockResolvedValueOnce({ pages: { saved: page('North page') } });
  await pages.loadSavedPages();
  mocks.api.mockResolvedValueOnce({ layouts: { item: layout('North layout') } });
  await layouts.loadTemplates();
  mocks.api.mockResolvedValueOnce({ queries: [{ name: 'North SQL', sql: 'SELECT private_north' }] });
  await sql.loadSavedSql();
  queryClient.setQueryData(['filters', 'same-connection'], { private: 'north' });
  queryClient.setQueryData(['peek', 'same-connection', 'item'], { name: 'North row' });
  expect(pages.savedPages()[0].name).toBe('North page');
  expect(layouts.savedTemplate('item')?.name).toBe('North layout');
  expect(sql.savedStatements()).toHaveLength(1);
  select('south');
  expect(pages.savedPages()).toEqual([]);
  expect(layouts.savedTemplate('item')).toBeNull();
  expect(sql.savedStatements()).toEqual([]);
  expect(queryClient.getQueryData(['filters', 'same-connection'])).toBeUndefined();
  expect(queryClient.getQueryData(['peek', 'same-connection', 'item'])).toBeUndefined();
  select('north');
  expect(pages.savedPages()).toEqual([]);
  expect(layouts.savedTemplate('item')).toBeNull();
});

test('tenant selection cannot fall back to the old account-wide storage mirrors', async () => {
  identity.lockSessionIdentity();
  identity.establishSessionIdentity({ signedIn: true, appId: 'app', accountId: 'ada' });
  await pages.savePage(page('Account-wide page'));
  mocks.api.mockResolvedValueOnce({ layouts: { item: layout('Account-wide layout') } });
  await layouts.loadTemplates();
  sql.saveStatement('Account-wide SQL', 'SELECT secret');
  expect(pages.savedPages()).toHaveLength(1);
  expect(layouts.hasSavedTemplate('item')).toBe(true);
  identity.requireTenantSelection();
  expect(pages.savedPages()).toEqual([]);
  expect(layouts.savedTemplate('item')).toBeNull();
  expect(sql.savedStatements()).toEqual([]);
  select();
  expect(pages.savedPages()).toEqual([]);
  expect(layouts.savedTemplate('item')).toBeNull();
  expect(sql.savedStatements()).toEqual([]);
});

test.each(['pages', 'layouts', 'SQL'])('late successful %s reads cannot overwrite a newer owner mirror or storage', async (kind) => {
  const read = deferred();
  mocks.api.mockReturnValueOnce(read.promise);
  const loading = kind === 'pages' ? pages.loadSavedPages() : kind === 'layouts' ? layouts.loadTemplates() : sql.loadSavedSql();
  select('south');
  mocks.api.mockResolvedValueOnce(
    kind === 'pages'
      ? { pages: { saved: page('South') } }
      : kind === 'layouts'
        ? { layouts: { item: layout('South') } }
        : { queries: [{ name: 'South', sql: 'SELECT south' }] },
  );
  await (kind === 'pages' ? pages.loadSavedPages() : kind === 'layouts' ? layouts.loadTemplates() : sql.loadSavedSql());
  const before = disk();
  read.resolve(
    kind === 'pages'
      ? { pages: { saved: page('North') } }
      : kind === 'layouts'
        ? { layouts: { item: layout('North') } }
        : { queries: [{ name: 'North', sql: 'SELECT north' }] },
  );
  await loading;
  expect(disk()).toEqual(before);
  if (kind === 'pages') expect(pages.savedPages()[0].name).toBe('South');
  else if (kind === 'layouts') expect(layouts.savedTemplate('item')?.name).toBe('South');
  else expect(sql.savedStatements()[0].name).toBe('South');
});

test('late SQL rejection cannot clear a newer owner config cache', async () => {
  const read = deferred();
  mocks.api.mockReturnValueOnce(read.promise);
  const loading = sql.loadSavedSql();
  select('south');
  mocks.api.mockResolvedValueOnce({ queries: [{ name: 'South', sql: 'SELECT south' }] });
  await sql.loadSavedSql();
  read.reject(new Error('Old connection lost'));
  await loading;
  expect(sql.savedStatements()[0].name).toBe('South');
});

test.each(['save', 'delete'])('late page %s acknowledgement cannot update a newer owner or announce success', async (operation) => {
  await pages.savePage(page('North'));
  const reply = deferred();
  mocks.api.mockReturnValueOnce(reply.promise);
  const pending = operation === 'save' ? pages.savePage(page('Late north')) : pages.deletePage('saved:item');
  select('south');
  await pages.savePage(page('South'));
  const before = disk();
  mocks.changed.mockClear();
  mocks.toast.mockClear();
  reply.resolve({ ok: true });
  await pending;
  expect(pages.savedPages()[0].name).toBe('South');
  expect(disk()).toEqual(before);
  expect(mocks.changed).not.toHaveBeenCalled();
  expect(mocks.toast).not.toHaveBeenCalled();
});

test('late page relations and name prompt cannot mount an old-owner builder', async () => {
  const relations = deferred();
  mocks.api.mockReturnValueOnce(relations.promise);
  const opening = pages.openBuilder(page('North'));
  select('south');
  relations.resolve({ relations: [{ private: 'north' }] });
  await opening;
  expect(mocks.mount).not.toHaveBeenCalled();
  const name = deferred();
  mocks.prompt.mockReturnValueOnce(name.promise);
  const creating = pages.newPage('item');
  select('north');
  name.resolve('South draft');
  await creating;
  expect(mocks.mount).not.toHaveBeenCalled();
});

test('identity transition closes page editor and retained callbacks cannot close or clear the newer editor', async () => {
  await pages.openBuilder(page('North'));
  const old = editor();
  old.onDraftChange?.(page('North draft'));
  select('south');
  expect(document.querySelector('.host-contents')).toBeNull();
  await pages.openBuilder(page('South'));
  const current = editor();
  current.onDraftChange?.(page('South draft'));
  const before = disk();
  old.onDiscard?.();
  old.onClose();
  old.onDraftChange?.(page('Late north'));
  expect(document.querySelector('.host-contents')).not.toBeNull();
  expect(disk()).toEqual(before);
  await expect(old.onSave(page('Late north'))).rejects.toThrow(/changed/);
});

test('a page editor pending save cannot clear recovery or callback into the next owner', async () => {
  const onSaved = vi.fn();
  await pages.openBuilder(page('North'), { onSaved });
  const old = editor();
  const reply = deferred();
  mocks.api.mockReturnValueOnce(reply.promise);
  const saving = old.onSave(page('North'));
  select('south');
  await pages.openBuilder(page('South'));
  editor().onDraftChange?.(page('South draft'));
  const before = disk();
  reply.resolve({ ok: true });
  await saving;
  expect(onSaved).not.toHaveBeenCalled();
  expect(disk()).toEqual(before);
  expect(document.querySelector('.host-contents')).not.toBeNull();
});

test('layout drafts and memory-only recovery are not inherited by the next tenant', () => {
  layouts.openTemplateBuilder('item');
  const old = layoutEditor();
  const fault = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('No storage');
  });
  old.draft.name = 'Private north draft';
  old.onApplied();
  expect(layouts.activeDraft('item')?.name).toBe('Private north draft');
  select('south');
  expect(layouts.activeDraft('item')).toBeNull();
  expect(document.querySelector('.tpl')).toBeNull();
  fault.mockRestore();
  layouts.openTemplateBuilder('item');
  const current = layoutEditor();
  expect(current.hasRecovery).toBe(false);
  expect(current.draft.name).not.toBe('Private north draft');
  const before = disk();
  old.onPreview();
  old.onSave();
  old.onCancel();
  expect(layouts.activeDraft('item')).toBe(current.draft);
  expect(disk()).toEqual(before);
});

test('late layout write cannot publish or clear the newer same-key pending save gate', async () => {
  layouts.openTemplateBuilder('item');
  layoutEditor().draft.name = 'North';
  const north = deferred();
  mocks.api.mockReturnValueOnce(north.promise);
  layoutEditor().onSave();
  select('south');
  layouts.openTemplateBuilder('item');
  layoutEditor().draft.name = 'South';
  const south = deferred();
  mocks.api.mockReturnValueOnce(south.promise);
  layoutEditor().onSave();
  const before = disk();
  north.resolve({ ok: true });
  await vi.waitFor(() => expect(mocks.api).toHaveBeenCalledTimes(2));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(layouts.savedTemplate('item')).toBeNull();
  expect(disk()).toEqual(before);
  expect(layoutEditor().saving).toBe(true);
  layoutEditor().onSave();
  expect(mocks.api).toHaveBeenCalledTimes(2);
  // Reopening after navigation must still hit South's pending gate. Merely
  // checking the old editor's saving flag would not detect deletion of it.
  const core = await import('../../../kit/src/client/core.js');
  core.state.schema = { ...core.state.schema };
  const mounts = mocks.mount.mock.calls.length;
  layouts.openTemplateBuilder('item');
  expect(mocks.mount).toHaveBeenCalledTimes(mounts);
  expect(mocks.toast).toHaveBeenCalledExactlyOnceWith('This table still has a layout save pending.', 'error');
  south.resolve({ ok: true });
  await vi.waitFor(() => expect(layouts.savedTemplate('item')?.name).toBe('South'));
  expect(mocks.toast).toHaveBeenCalledTimes(1);
});

test('old filter prefetch is cancelled and cannot seed or overwrite the next owner query', async () => {
  const north = deferred();
  mocks.api.mockReturnValueOnce(north.promise);
  const first = lists.loadSavedFilters();
  select('south');
  mocks.api.mockResolvedValueOnce({ filters: { south: [] } });
  await lists.loadSavedFilters();
  north.resolve({ filters: { privateNorth: [] } });
  await first;
  // A reply that does not say whose list it is offers no Save.
  expect(queryClient.getQueryData(['filters', 'same-connection'])).toEqual({ filters: { south: [] }, store: 'none' });
});

test('identity transition remounts the single peek layer and retires pending row cache', async () => {
  peek.initPeek();
  peek.initPeek();
  expect(document.querySelectorAll('.peek-host')).toHaveLength(1);
  const original = mocks.mount.mock.calls.at(-1)!;
  const reply = deferred();
  const pending = queryClient
    .fetchQuery({ queryKey: ['peek', 'same-connection', 'item'], queryFn: () => reply.promise })
    .catch(() => undefined);
  select('south');
  const current = mocks.mount.mock.calls.at(-1)!;
  expect(current[0]).toBe(original[0]);
  expect(current[1].key).not.toBe(original[1].key);
  reply.resolve({ name: 'Private north' });
  await pending;
  expect(queryClient.getQueryData(['peek', 'same-connection', 'item'])).toBeUndefined();
});

test('account change and lock retire memory independently of an unchanged connection', async () => {
  await pages.savePage(page('Ada'));
  mocks.api.mockResolvedValueOnce({ layouts: { item: layout('Ada') } });
  await layouts.loadTemplates();
  identity.establishSessionIdentity({ signedIn: true, accountId: 'bob', appId: 'app' });
  expect(pages.savedPages()).toEqual([]);
  expect(layouts.savedTemplate('item')).toBeNull();
  await pages.savePage(page('Bob'));
  identity.lockSessionIdentity();
  expect(pages.savedPages()).toEqual([]);
  expect(layouts.savedTemplate('item')).toBeNull();
});
