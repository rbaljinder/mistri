import { beforeEach, expect, test, vi } from 'vitest';

const { state, api, appListFor } = vi.hoisted(() => ({
  state: { activeConnection: 'a', schema: {}, stack: [] as unknown[] },
  api: vi.fn(),
  appListFor: vi.fn(),
}));
vi.mock('../../../kit/src/client/core.js', () => ({
  state,
  api,
  refsFrom: vi.fn(),
}));
vi.mock('../../../kit/src/client/peekpanel.js', () => ({ openPeek: vi.fn() }));
vi.mock('./applist.js', () => ({ appListFor }));
vi.mock('../../../kit/src/client/visualTheme.js', () => ({
  configureVisualThemes: vi.fn(),
  customThemeTokens: vi.fn(),
  VISUAL_THEME_EVENT: 'theme',
  visualThemeOverrides: vi.fn(),
  visualThemePalette: vi.fn(),
}));

let nav: typeof import('./appNavigation.js');
let appState: typeof import('./appState.js');
const app = (editing?: unknown) => ({
  id: 'a',
  name: 'Editing',
  views: { tasks: { table: 'tasks', label: 'Tasks' } },
  nav: [{ view: 'tasks', label: 'Tasks' }],
  resources: {},
  ui: editing === undefined ? {} : { editing },
});
async function load(value: unknown) {
  api.mockResolvedValueOnce({ appId: state.activeConnection, app: value });
  await nav.loadAppNav();
  api.mockClear();
}

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  state.activeConnection = 'a';
  state.stack = [];
  nav = await import('./appNavigation.js');
  appState = await import('./appState.js');
});

test('unloaded, absent, explicit and malformed settings resolve to explicit without requests', async () => {
  expect(appState.appSaveMode()).toBe('explicit');
  for (const value of [null, app(), app({ save: 'explicit' }), app({}), app({ save: 'auto' }), app(null)]) {
    await load(value);
    expect(appState.appSaveMode()).toBe('explicit');
    expect(api).not.toHaveBeenCalled();
  }
});

test('blur policy applies on cold custom pages and records independently of navigation selection', async () => {
  await load(app({ save: 'blur' }));
  for (const stack of [
    [],
    [{ kind: 'page', pageId: 'custom-page', key: { id: '7' } }],
    [{ kind: 'record', table: 'other', key: { id: '7' } }],
    [{ kind: 'table', table: 'tasks', query: 'title = unrelated' }],
  ]) {
    state.stack = stack;
    expect(appState.inAppMode()).toBe(true);
    expect(appState.appSaveMode()).toBe('blur');
  }
  expect(appListFor).not.toHaveBeenCalled();
  expect(api).not.toHaveBeenCalled();
});

test('an App keeps its save preference, one with no room to open too, and no App saves explicitly', async () => {
  await load(app({ save: 'blur' }));
  expect(appState.appSaveMode()).toBe('blur');
  /* An App with no room to open is still the App (never the Workbench, appState.js), so its preference holds. */
  await load({ ...app({ save: 'blur' }), views: {}, nav: [] });
  expect(appState.inAppMode()).toBe(true);
  expect(appState.appSaveMode()).toBe('blur');
  await load(null);
  expect(appState.inAppMode()).toBe(false);
  expect(appState.appSaveMode()).toBe('explicit');
});

test('save preference neither requires nor adds writable metadata', async () => {
  for (const writableTables of [undefined, false, [], ['tasks']]) {
    const value = { ...app({ save: 'blur' }), writableTables };
    await load(value);
    expect(appState.appSaveMode()).toBe('blur');
    expect(appState.activeApp()?.writableTables).toEqual(writableTables);
    expect(api).not.toHaveBeenCalled();
  }
});

test('connection replacement and failed metadata loading cannot reuse the old blur preference', async () => {
  await load(app({ save: 'blur' }));
  state.activeConnection = 'b';
  expect(appState.appSaveMode()).toBe('explicit');
  await load({ ...app(), id: 'b' });
  expect(appState.appSaveMode()).toBe('explicit');
  await load({ ...app({ save: 'blur' }), id: 'b' });
  expect(appState.appSaveMode()).toBe('blur');
  api.mockRejectedValueOnce(new Error('Offline'));
  await nav.loadAppNav();
  expect(appState.appSaveMode()).toBe('explicit');
});

test('an obsolete App response cannot restore blur after a newer explicit response', async () => {
  let resolve!: (value: unknown) => void;
  api.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const old = nav.loadAppNav();
  await load(app({ save: 'explicit' }));
  resolve({ appId: 'a', app: app({ save: 'blur' }) });
  await old;
  expect(appState.appSaveMode()).toBe('explicit');
});
