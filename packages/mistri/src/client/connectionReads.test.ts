import { beforeEach, expect, test, vi } from 'vitest';

const state = { activeConnection: 'a', schema: {} };
const api = vi.fn();
const store: Record<string, unknown> = {};
vi.mock('../../../kit/src/client/core.js', () => ({
  state,
  api,
  toast: vi.fn(),
  render: vi.fn(),
  findTable: vi.fn(),
  refsTo: vi.fn(),
  refsFrom: vi.fn(),
  loadJson: (key: string, fallback: unknown) => structuredClone(store[key] ?? fallback),
  saveJson: (key: string, value: unknown) => {
    store[key] = structuredClone(value);
    return true;
  },
}));
vi.mock('../../../kit/src/client/components/mount.js', () => ({ mount: vi.fn(), unmount: vi.fn() }));
vi.mock('../../../kit/src/client/components/LayoutBuilder.js', () => ({ LayoutBuilder: () => null }));
vi.mock('../../../kit/src/client/peekpanel.js', () => ({ openPeek: vi.fn() }));
vi.mock('./applist.js', () => ({ appListFor: vi.fn() }));
vi.mock('../../../kit/src/client/visualTheme.js', () => ({
  configureVisualThemes: vi.fn(),
  customThemeTokens: vi.fn(),
  VISUAL_THEME_EVENT: 'theme',
  visualThemeOverrides: vi.fn(),
  visualThemePalette: vi.fn(),
}));

let transitions: typeof import('../../../kit/src/client/connectionTransition.js');
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const app = (name: string) => ({ id: name, name, nav: [], views: {} });

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  state.activeConnection = 'a';
  for (const key of Object.keys(store)) delete store[key];
  transitions = await import('../../../kit/src/client/connectionTransition.js');
});

test('late layouts are mirrored under their original connection, not the active one', async () => {
  const templates = await import('../../../kit/src/client/template.js');
  const old = deferred();
  api.mockReturnValueOnce(old.promise);
  const loading = templates.loadTemplates();
  state.activeConnection = 'b';
  api.mockResolvedValueOnce({ layouts: { customer: { name: 'B layout' } } });
  await templates.loadTemplates();
  old.resolve({ layouts: { customer: { name: 'A layout' } } });
  await loading;
  expect(templates.savedTemplate('customer')).toEqual({ name: 'B layout' });
  state.activeConnection = 'a';
  expect(templates.savedTemplate('customer')).toEqual({ name: 'A layout' });
});

test('a newer layout read wins when an earlier read of the same connection arrives last', async () => {
  const templates = await import('../../../kit/src/client/template.js');
  const old = deferred();
  api.mockReturnValueOnce(old.promise);
  const loading = templates.loadTemplates();
  api.mockResolvedValueOnce({ layouts: { customer: { name: 'New layout' } } });
  await templates.loadTemplates();
  old.resolve({ layouts: { customer: { name: 'Old layout' } } });
  await loading;
  expect(templates.savedTemplate('customer')).toEqual({ name: 'New layout' });
});

test.each(['resolved', 'rejected'] as const)('a %s old manifest cannot overwrite the current app', async (outcome) => {
  const nav = await import('./appNavigation.js');
  const appState = await import('./appState.js');
  const old = deferred();
  api.mockReturnValueOnce(old.promise);
  const loading = nav.loadAppNav();
  transitions.beginConnectionTransition().finish();
  state.activeConnection = 'b';
  api.mockResolvedValueOnce({ connection: 'b', app: app('B') });
  await nav.loadAppNav();
  if (outcome === 'resolved') old.resolve({ connection: 'a', app: app('A') });
  else old.reject(new Error('Offline'));
  await loading;
  expect(appState.activeApp()?.name).toBe('B');
});

test('a manifest started before a new transition is obsolete even before its replacement load starts', async () => {
  const nav = await import('./appNavigation.js');
  const appState = await import('./appState.js');
  const old = deferred();
  api.mockReturnValueOnce(old.promise);
  const loading = nav.loadAppNav();
  transitions.beginConnectionTransition().finish();
  old.resolve({ connection: 'a', app: app('Old A') });
  await loading;
  expect(appState.activeApp()).toBeNull();
});

test('App manifest ownership uses appId without connection response metadata', async () => {
  const identity = await import('../../../kit/src/client/requestIdentity.js');
  identity.setAppRequestScope(true);
  const nav = await import('./appNavigation.js');
  const appState = await import('./appState.js');
  api.mockResolvedValueOnce({ appId: 'a', app: app('Atlas') });
  await nav.loadAppNav();
  expect(appState.activeApp()?.name).toBe('Atlas');
  expect(identity.appRequestScope()).toBe(true);
  state.activeConnection = 'b';
  expect(appState.activeApp()).toBeNull();
  api.mockResolvedValueOnce({ appId: 'b', app: app('Finance') });
  await nav.loadAppNav();
  expect(appState.activeApp()?.name).toBe('Finance');
});

test.each([
  { appId: 'wrong', app: app('Other') },
  { connection: 'physical-database', app: app('Legacy') },
])('App manifests without the requested authored identity cannot populate the active app', async (response) => {
  (await import('../../../kit/src/client/requestIdentity.js')).setAppRequestScope(true);
  const nav = await import('./appNavigation.js');
  const appState = await import('./appState.js');
  api.mockResolvedValueOnce(response);
  await nav.loadAppNav();
  expect(appState.activeApp()).toBeNull();
});

test.each(['resolved', 'rejected'] as const)('a %s old SQL load cannot overwrite a newer load after an A/B/A switch', async (outcome) => {
  const sql = await import('../../../tablewalk/src/client/sqlsaved.js');
  const old = deferred();
  api.mockReturnValueOnce(old.promise);
  const loading = sql.loadSavedSql();
  state.activeConnection = 'b';
  transitions.beginConnectionTransition().finish();
  state.activeConnection = 'a';
  transitions.beginConnectionTransition().finish();
  api.mockResolvedValueOnce({ connection: 'a', queries: [{ name: 'New A', sql: 'select 2' }] });
  await sql.loadSavedSql();
  if (outcome === 'resolved') old.resolve({ connection: 'a', queries: [{ name: 'Old A', sql: 'select 1' }] });
  else old.reject(new Error('Offline'));
  await loading;
  expect(sql.savedStatements()).toEqual([{ name: 'New A', sql: 'select 2', source: 'config' }]);
});

test('SQL names from another connection do not reserve names in this one', async () => {
  const sql = await import('../../../tablewalk/src/client/sqlsaved.js');
  api.mockResolvedValueOnce({ connection: 'a', queries: [{ name: 'Report', sql: 'select 1' }] });
  await sql.loadSavedSql();
  state.activeConnection = 'b';
  expect(sql.saveStatement('Report', 'select 2')).toBe(true);
  expect(sql.savedStatements()).toEqual([{ name: 'Report', sql: 'select 2', source: 'saved' }]);
});
