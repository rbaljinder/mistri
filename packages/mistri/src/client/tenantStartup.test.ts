import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';

const html = readFileSync('packages/kit/src/client/index.html', 'utf8');

// The unrelated explorer composer attaches its menu item and listeners at import time.
vi.mock('../../../kit/src/client/composerEntry.js', () => ({}));
vi.mock('../../../kit/src/client/startup.js', () => ({
  finishStartup: vi.fn(),
  failStartup: vi.fn(),
  rememberStartupAppearance: vi.fn(),
  whenStartupReady: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
});

afterEach(async () => {
  const { unmountAll } = await import('../../../kit/src/client/components/mount.js');
  await act(async () => {
    unmountAll();
  });
  document.head.querySelector('meta[name="mistri-tenant-enters"]')?.remove();
  document.body.replaceChildren();
  document.body.className = '';
  vi.unstubAllGlobals();
});

/* A tenant App's page starts with entering, which answers who-am-I too (tenantTransport.ts `enterFirst`): a signed-out
   visitor is shown the sign-in from that answer, with no who-am-I request before or after it. */
test("a tenant App's first page asks no who-am-I: entering answers it, and a signed-out visitor still gets the sign-in", async () => {
  document.body.innerHTML = html.match(/<body>([\s\S]*?)<\/body>/)![1];
  const meta = document.createElement('meta');
  meta.name = 'mistri-tenant-enters';
  meta.content = '1';
  document.head.append(meta);
  window.history.replaceState(null, '', '/clinic/appointments');
  const signIn = { app: 'Clinic', providers: ['email'], signUp: 'invite' };
  const fetch = vi.fn(async (path: string) => {
    if (path !== '/api/tenant/enter?app=clinic') throw new Error(`Unexpected request: ${path}`);
    return new Response(
      JSON.stringify({
        status: 'signed_out',
        whoami: { signedIn: false, accountId: null, appId: 'clinic', who: null, header: null, signIn, tenant: true, appName: 'Clinic' },
      }),
    );
  });
  vi.stubGlobal('fetch', fetch);
  await act(async () => {
    await import('../../../kit/src/client/boot.js');
  });
  expect(await screen.findByRole('heading', { name: 'Clinic' }, { timeout: 20_000 })).toBeInTheDocument();
  expect(fetch.mock.calls.map(([path]) => path)).toEqual(['/api/tenant/enter?app=clinic']);
}, 30_000);

/* The same page where entering is not answered as who-am-I: who-am-I is asked, as it always was. */
test("a tenant App's page whose entry does not answer asks who-am-I as before", async () => {
  document.body.innerHTML = html.match(/<body>([\s\S]*?)<\/body>/)![1];
  const meta = document.createElement('meta');
  meta.name = 'mistri-tenant-enters';
  meta.content = '1';
  document.head.append(meta);
  window.history.replaceState(null, '', '/clinic/appointments');
  const signIn = { app: 'Clinic', providers: ['email'], signUp: 'invite' };
  const fetch = vi.fn(async (path: string) => {
    if (path === '/api/tenant/enter?app=clinic') return new Response(JSON.stringify({ error: 'busy' }), { status: 503 });
    if (path !== '/api/whoami?app=clinic') throw new Error(`Unexpected request: ${path}`);
    return new Response(JSON.stringify({ signedIn: false, accountId: null, appId: 'clinic', who: null, header: null, signIn }));
  });
  vi.stubGlobal('fetch', fetch);
  await act(async () => {
    await import('../../../kit/src/client/boot.js');
  });
  expect(await screen.findByRole('heading', { name: 'Clinic' }, { timeout: 20_000 })).toBeInTheDocument();
  expect(fetch.mock.calls.map(([path]) => path)).toEqual(['/api/tenant/enter?app=clinic', '/api/whoami?app=clinic']);
}, 30_000);
