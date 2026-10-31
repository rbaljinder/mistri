import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';

const html = readFileSync('packages/kit/src/client/index.html', 'utf8');

// The unrelated explorer composer attaches its menu item and listeners at import time.
vi.mock('./composerEntry.js', () => ({}));

// Keep the actual boot and sign-in seam; startup reveal is an animation frame.
vi.mock('./startup.js', () => ({
  finishStartup: vi.fn(),
  failStartup: vi.fn(),
  rememberStartupAppearance: vi.fn(),
  whenStartupReady: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
});

afterEach(async () => {
  const { unmountAll } = await import('./components/mount.js');
  await act(async () => {
    unmountAll();
  });
  document.body.replaceChildren();
  document.body.className = '';
  vi.unstubAllGlobals();
});

// This functional boundary test cold-imports the entire App graph through Vite.
// Its budget includes transformation under the full suite's worker contention;
// it is not a five-second page-load benchmark (at a load average of 20 the 8s
// heading wait ran out while every assertion was right). Keep the network/DOM assertions.
// who-am-I's `home` — a public view a signed-out visitor starts on — is the only
// reason a signed-out boot asks for the front page or a form; a home that
// neither answers for still signs in.
test('a signed-out App whose home is public asks for it, and signs in when nothing answers', async () => {
  document.body.innerHTML = html.match(/<body>([\s\S]*?)<\/body>/)![1];
  window.history.replaceState(null, '', '/ignition-commands');
  const signIn = { app: 'Ignition · Assignments', providers: ['email'], signUp: 'invite' };
  const fetch = vi.fn(async (path: string) => {
    if (path === '/api/landing' || path === '/api/forms/welcome')
      return new Response(JSON.stringify({ error: 'Not found.' }), { status: 404 });
    if (path !== '/api/whoami?app=ignition-commands') throw new Error(`Unexpected metadata request: ${path}`);
    return new Response(
      JSON.stringify({ signedIn: false, accountId: null, appId: 'ignition-commands', who: null, header: null, signIn, home: 'welcome' }),
    );
  });
  vi.stubGlobal('fetch', fetch);
  await act(async () => {
    await import('./boot.js');
  });
  expect(await screen.findByRole('heading', { name: 'Sign in to Ignition · Assignments' }, { timeout: 20_000 })).toBeInTheDocument();
  // No `/api/landing` probe: who-am-I names no landing here, so the boot resolves it to null and
  // the public home goes straight to the form instead of probing a landing that answers 404.
  expect(fetch.mock.calls.map(([path]) => path)).toEqual(['/api/whoami?app=ignition-commands', '/api/forms/welcome']);
}, 30_000);

// A public home the landing does not claim is a public form: it is drawn
// signed out, and nothing is asked of the App beyond the form.
test('a signed-out App whose home is a public form draws the form and never signs in', async () => {
  document.body.innerHTML = html.match(/<body>([\s\S]*?)<\/body>/)![1];
  window.history.replaceState(null, '', '/ignition-commands');
  const signIn = { app: 'Ignition · Assignments', providers: ['email'], signUp: 'invite' };
  const app = { id: 'ignition-commands', name: 'Ignition · Assignments' };
  const form = {
    id: 'finance',
    label: 'Apply for financing',
    input: [{ name: 'name', label: 'Name', type: 'text' }],
    steps: [{ id: 'you', label: 'You', fields: ['name'] }],
  };
  const fetch = vi.fn(async (path: string) => {
    if (path === '/api/landing')
      return new Response(JSON.stringify({ app, view: 'welcome', landing: { hero: { heading: 'Hello', actions: [] } } }));
    if (path === '/api/forms/finance') return new Response(JSON.stringify({ app, form }));
    if (path !== '/api/whoami?app=ignition-commands') throw new Error(`Unexpected metadata request: ${path}`);
    return new Response(
      JSON.stringify({ signedIn: false, accountId: null, appId: 'ignition-commands', who: null, header: null, signIn, home: 'finance' }),
    );
  });
  vi.stubGlobal('fetch', fetch);
  await act(async () => {
    await import('./boot.js');
  });
  expect(await screen.findByRole('heading', { name: 'Apply for financing' })).toBeInTheDocument();
  expect(document.querySelector('.signin')).toBeNull();
  // No `/api/landing` probe here either: the boot resolves an unnamed landing to null, so the
  // public form is drawn without asking the App for a landing first.
  expect(fetch.mock.calls.map(([path]) => path)).toEqual(['/api/whoami?app=ignition-commands', '/api/forms/finance']);
}, 30_000);

test.each(['whoami', 'tenant-whoami', 'runtime-401'])(
  'signed-out App boot stops at %s and reveals only its public name',
  async (entry) => {
    document.body.innerHTML = html.match(/<body>([\s\S]*?)<\/body>/)![1];
    window.history.replaceState(null, '', '/ignition-commands');
    const signIn = { app: 'Ignition · Assignments', providers: ['email'], signUp: 'invite' };
    const fetch = vi.fn(async (path: string) => {
      if (entry === 'runtime-401' && path === '/api/runtime')
        return new Response(JSON.stringify({ error: 'Sign in to continue.', signIn }), { status: 401 });
      if (path !== '/api/whoami?app=ignition-commands') throw new Error(`Unexpected metadata request: ${path}`);
      if (entry === 'runtime-401') return new Response(JSON.stringify({ signedIn: false }));
      return new Response(
        JSON.stringify({
          signedIn: false,
          accountId: null,
          appId: 'ignition-commands',
          who: null,
          header: null,
          signIn,
          ...(entry === 'tenant-whoami' ? { tenant: true, appName: signIn.app } : {}),
        }),
      );
    });
    vi.stubGlobal('fetch', fetch);
    await act(async () => {
      await import('./boot.js');
    });
    expect(await screen.findByRole('heading', { name: 'Sign in to Ignition · Assignments' }, { timeout: 20_000 })).toBeInTheDocument();
    const { finishStartup, failStartup } = await import('./startup.js');
    await vi.waitFor(() => expect(finishStartup).toHaveBeenCalled());
    expect(failStartup).not.toHaveBeenCalled();
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      '/api/whoami?app=ignition-commands',
      ...(entry === 'runtime-401' ? ['/api/runtime'] : []),
    ]);
    expect(document.querySelector('.brand-name')).toHaveTextContent('Ignition · Assignments');
    expect(document.body).toHaveClass('app-mode', 'signed-out');
  },
  30_000,
);
