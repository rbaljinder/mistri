import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { bindRecordBranding, compileBranding, fromRecord } from '../shared/branding.js';

const mocks = vi.hoisted(() => ({ api: vi.fn(), state: { activeConnection: 'app', schema: null, stack: [] } }));
vi.mock('../../../kit/src/client/core.js', () => ({
  ...mocks,
  refsFrom: () => [],
  /* Lumen starts compact, so wearing it applies a density, which re-reads the zoom (density.js). */
  refreshViewportScale() {},
}));
vi.mock('./tenantTransport.js', () => ({ isTenantMutationPath: () => false, tenantMutationApi() {}, tenantReadApi() {} }));
vi.mock('../../../kit/src/client/messages.js', () => ({ messageLanguage: () => 'en', setMessageScope() {} }));
vi.mock('../../../kit/src/client/peekpanel.js', () => ({ openPeek() {} }));
/* The App shell's parts that draw (appnav.js appShell): this file reads none of them. */
vi.mock('./components/presentedList.js', () => ({ presentList() {} }));
vi.mock('./components/Actions.js', () => ({ ActionBar() {}, useReachable() {} }));
vi.mock('../../../kit/src/client/components/onDemand.js', () => ({ onDemand: () => () => null }));
vi.mock('./components/sdk/appComponents.js', () => ({ appComponents: {} }));
vi.mock('./applist.js', () => ({ appListFor() {} }));
vi.mock('./appLabels.js', () => ({ appColumnLabel() {} }));
vi.mock('../../../kit/src/client/components/appRooms.js', () => ({ resourceOf() {}, homeRoom() {}, isListRoom: () => false }));
vi.mock('./publicAddress.js', () => ({
  appAddress() {},
  appStackFrom: () => null,
  listParams() {},
  needsNaturalKey() {},
  viewEntryFromAddress() {},
}));
vi.mock('../../../kit/src/client/components/Icon.js', () => ({ registerIcons() {} }));
vi.mock('../../../kit/src/client/connectionTransition.js', () => ({ connectionGeneration: () => 1, replaceAppPresentation() {} }));
vi.mock('../../../kit/src/client/requestIdentity.js', () => ({ appRequestScope: () => true }));
vi.mock('./copy/shell/appNavigation.js', () => ({ say: () => 'Wrong App' }));
vi.mock('../../../kit/src/client/copy/shell/sessionIdentity.js', () => ({ say: () => 'Identity changed' }));
vi.mock('../../../kit/src/client/copy/shell/visualTheme.js', () => ({ say: () => 'Default' }));
vi.mock('../../../kit/src/client/copy/shell/theme.js', () => ({ say: () => 'Theme' }));

let identity: typeof import('../../../kit/src/client/sessionIdentity.js');
let nav: typeof import('./appNavigation.js');
let appState: typeof import('./appState.js');
let theme: typeof import('./appTheme.js');
let visual: typeof import('../../../kit/src/client/visualTheme.js');
const authored = {
  id: 'app',
  name: 'Static App',
  ui: { theme: { preset: 'sage', accent: '#006b73', radius: '7px', font: 'Georgia, serif' } },
};
const binding = bindRecordBranding(
  fromRecord('site', { by: 'tenant', tenantField: 'tenant', fallback: { preset: 'lumen' }, fields: { name: 'name', accent: 'color' } }),
  {
    resources: {
      site: { primaryKey: ['id'], columns: { id: 'text', tenant: 'text', version: 'integer', name: 'text', color: 'text' } },
    },
  },
);
function branded(tenant = 'north') {
  const value = compileBranding(
    binding,
    { id: tenant, tenant, version: 1, name: `${tenant} private`, color: '#1d3f8c' },
    { app: 'app', deployment: 'test', source: 'test', bindingRevision: '1', catalogRevision: '1', tenant },
  );
  return {
    id: 'app',
    name: value.content.name!,
    views: { items: {} },
    ui: { theme: { preset: value.theme.id, branding: value, readerPicker: true }, customThemes: [value.theme] },
  };
}
function select(tenant: string) {
  identity.requireTenantSelection();
  identity.establishTenantSelection({
    appId: 'app',
    accountId: 'alice',
    tenantId: tenant,
    tabId: 'tab',
    context: `context-${tenant}`,
    revision: 1,
    expiresAt: Date.now() + 60000,
  });
}
let mediaChange: () => void;
let modeChange: () => void;
let listeners: Array<[string, EventListenerOrEventListenerObject]>;
beforeEach(async () => {
  vi.resetModules();
  mocks.api.mockReset();
  mocks.state.activeConnection = 'app';
  localStorage.clear();
  sessionStorage.clear();
  document.body.innerHTML = '<span class="brand-name"></span>';
  document.documentElement.removeAttribute('style');
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-record-branding');
  listeners = [];
  const add = window.addEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
    listeners.push([type, listener]);
    add(type, listener, options);
  });
  vi.stubGlobal(
    'MutationObserver',
    class {
      constructor(callback: () => void) {
        modeChange = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: (_: string, listener: () => void) => {
      mediaChange = listener;
    },
  }));
  identity = await import('../../../kit/src/client/sessionIdentity.js');
  identity.establishSessionIdentity({ signedIn: true, accountId: 'alice', appId: 'app' });
  select('north');
  theme = await import('./appTheme.js');
  visual = await import('../../../kit/src/client/visualTheme.js');
  nav = await import('./appNavigation.js');
  appState = await import('./appState.js');
  visual.initVisualTheme();
  theme.applyAppTheme(true, authored);
});
afterEach(() => {
  for (const [name, listener] of listeners) window.removeEventListener(name, listener);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.getElementById('mistri-branding')?.remove();
  document.getElementById('mistri-branding-style')?.remove();
});

async function wear(value = branded()) {
  mocks.api.mockResolvedValueOnce({ appId: 'app', app: value });
  await nav.loadAppNav();
  theme.applyAppTheme(true);
  document.querySelector('.brand-name')!.textContent = appState.activeApp()!.name;
  document.title = `Record · ${appState.activeApp()!.name}`;
  expect(document.body.style.getPropertyValue('--accent')).toBe('#1d3f8c');
  return value;
}

test.each(['switch', 'denial', 'lock'])(
  '%s retires private presentation before the next paint and theme events cannot restore it',
  async (reason) => {
    const old = await wear();
    document.head.insertAdjacentHTML(
      'beforeend',
      '<script type="application/json" id="mistri-branding">{}</script><style id="mistri-branding-style"></style>',
    );
    sessionStorage.setItem('mistri.startup.v1', 'old tenant');
    document.documentElement.style.setProperty('--startup-ground', '#123456');
    if (reason === 'lock') identity.lockSessionIdentity();
    else identity.requireTenantSelection();
    nav.retireAppNav();
    theme.retireAppTheme(authored, true);
    expect(appState.activeApp()).toBeNull();
    expect(document.querySelector('.brand-name')!.textContent).toBe('Static App');
    expect(document.title).toBe('Static App');
    expect(document.body.style.getPropertyValue('--accent')).toBe('#006b73');
    expect(document.body.style.getPropertyValue('--radius')).toBe('7px');
    expect(document.documentElement.style.getPropertyValue('--mono')).toBe('Georgia, serif');
    expect(document.getElementById('mistri-branding')).toBeNull();
    expect(document.getElementById('mistri-branding-style')).toBeNull();
    expect(sessionStorage.getItem('mistri.startup.v1')).toBeNull();
    expect(document.documentElement.style.getPropertyValue('--startup-ground')).toBe('');
    window.dispatchEvent(new Event(visual.VISUAL_THEME_EVENT));
    mediaChange();
    document.documentElement.dataset.theme = 'dark';
    modeChange();
    const safeAccent = document.body.style.getPropertyValue('--accent');
    theme.applyAppTheme(true, old); // A retained presentation is also fenced.
    expect(document.body.style.getPropertyValue('--accent')).toBe(safeAccent);
    expect(document.documentElement.hasAttribute('data-record-branding')).toBe(false);
    expect(document.title).toBe('Static App');
  },
);

test.each(['switch', 'denial', 'lock'])('a delayed previous payload cannot repopulate the App cache after %s', async (reason) => {
  await wear();
  let resolve!: (value: unknown) => void;
  mocks.api.mockReturnValueOnce(
    new Promise((yes) => {
      resolve = yes;
    }),
  );
  const pending = nav.loadAppNav();
  if (reason === 'lock') identity.lockSessionIdentity();
  else identity.requireTenantSelection();
  nav.retireAppNav();
  theme.retireAppTheme(authored, true);
  if (reason === 'switch') {
    select('south');
    await wear(branded('south'));
  }
  resolve({ appId: 'app', app: branded('north') });
  await pending;
  expect(appState.activeApp()?.name ?? null).toBe(reason === 'switch' ? 'south private' : null);
  theme.applyAppTheme(true);
  window.dispatchEvent(new Event(visual.VISUAL_THEME_EVENT));
  expect(document.documentElement.hasAttribute('data-record-branding')).toBe(reason === 'switch');
  expect(document.title).not.toContain('north');
});

test('same-App identity changes retire the cache even before the surface callback runs', async () => {
  await wear();
  select('south');
  expect(appState.activeApp()).toBeNull();
  window.dispatchEvent(new Event(visual.VISUAL_THEME_EVENT));
  expect(document.documentElement.hasAttribute('data-record-branding')).toBe(false);
  expect(document.body.style.getPropertyValue('--accent')).toBe('#006b73');
});

test('returning to the same tenant does not revive an earlier presentation generation', async () => {
  const old = await wear();
  identity.requireTenantSelection();
  nav.retireAppNav();
  theme.retireAppTheme(authored, true);
  select('north');
  theme.applyAppTheme(true, old);
  expect(document.documentElement.hasAttribute('data-record-branding')).toBe(false);
  expect(document.body.style.getPropertyValue('--accent')).toBe('#006b73');
  await wear(branded());
  expect(document.documentElement.hasAttribute('data-record-branding')).toBe(true);
});

test('retirement preserves static authored defaults and the independent explicit Workbench choice', async () => {
  theme.retireAppTheme();
  expect(document.body.style.getPropertyValue('--accent')).toBe('#006b73');
  theme.applyAppTheme(false);
  visual.setVisualTheme('sage');
  /* Boot applies the reader's density (shellStart.js): the Workbench's comfortable zoom is part of what it wears,
     and a compact look worn in between (Lumen) must hand it back. */
  (await import('../../../kit/src/client/density.js')).applyDensity();
  const tokens = () => {
    const style = document.documentElement.style;
    return Object.fromEntries(Array.from({ length: style.length }, (_, index) => [style[index], style.getPropertyValue(style[index])]));
  };
  const workbench = tokens();
  theme.applyAppTheme(true, authored);
  await wear();
  theme.applyAppTheme(false);
  theme.retireAppTheme(authored);
  window.dispatchEvent(new Event(visual.VISUAL_THEME_EVENT));
  expect(visual.visualThemeChoice()).toBe('sage');
  expect(localStorage.getItem(visual.WORKBENCH_VISUAL_THEME_KEY)).toBe('sage');
  expect(tokens()).toEqual(workbench);
  expect(document.body.style.getPropertyValue('--accent')).toBe('');
  theme.applyAppTheme(true, authored);
  expect(document.body.style.getPropertyValue('--accent')).toBe('#006b73');
});
