/* An App never draws the Workbench: a visitor the public grant gives no view
   of their own starts on its public home, and an administrator of an App that
   declares no `admin` role (shot --as admin on a small App) sees the App with
   nothing in it — with no views, the shell was once the Workbench, Run and Schema. */
import { expect, test, vi } from 'vitest';

const identity = vi.hoisted(() => ({ mode: 'signed-out' }));
vi.mock('../../../kit/src/client/core.js', () => ({ state: { activeConnection: 'shop' } }));
vi.mock('../../../kit/src/client/sessionIdentity.js', () => ({ sessionIdentity: () => identity }));

const { inAppMode, setAppCache } = await import('./appState.js');

const served = (extra: Record<string, unknown>) =>
  ({ id: 'shop', name: 'Shop', views: {}, nav: [], resources: {}, ui: {}, ...extra }) as never;

test('an App is in its own mode whatever its grants show, and only no App is the Workbench', () => {
  setAppCache({ owner: 'shop', identity: identity as never, app: served({ home: 'welcome' }) });
  expect(inAppMode()).toBe(true);
  setAppCache({ owner: 'shop', identity: identity as never, app: served({}) });
  expect(inAppMode()).toBe(true);
  setAppCache({ owner: 'shop', identity: identity as never, app: served({ views: { repairs: { table: 'repair' } } }) });
  expect(inAppMode()).toBe(true);
  setAppCache({ owner: 'shop', identity: identity as never, app: null });
  expect(inAppMode()).toBe(false);
  setAppCache(null);
  expect(inAppMode()).toBe(false);
});
