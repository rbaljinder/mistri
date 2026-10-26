import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { unmountAll } from '../../../kit/src/client/components/mount.js';
import { loadPublicForm, showPublicForm } from './publicForm.js';
import { rereadFirstPaint } from '../../../kit/src/client/firstPaint.js';
import { FIRST_PAINT_ELEMENT, readKey } from '../../../engine/src/shared/firstPaint.js';

const app = { id: 'workshop', name: 'Workshop' };
const form = {
  id: 'join',
  label: 'Join the workshop',
  input: [{ name: 'agree', label: 'I have read the rules', type: 'boolean' as const, required: true, accept: true as const }],
};

beforeEach(() => {
  document.body.innerHTML = `<header class="topbar"><button type="button" class="brand" id="home-button"><span class="brand-mark"></span><span class="brand-name">mistri</span></button>
    <div class="topbar-actions"><span id="more-host"></span></div></header><main id="content"></main>`;
});
afterEach(() => {
  act(() => {
    unmountAll();
  });
  document.body.replaceChildren();
  document.body.className = '';
  vi.unstubAllGlobals();
  rereadFirstPaint();
});

test("a form served as the App's home offers staff a quiet Sign in at the top bar's end, once", async () => {
  await act(async () => {
    showPublicForm({ app, form }, undefined, { signIn: true });
  });
  const links = document.querySelectorAll<HTMLAnchorElement>('.topbar a.account-sign-in');
  expect(links).toHaveLength(1);
  expect(links[0]).toHaveAttribute('href', '/workshop/sign-in');
  expect(links[0]).toHaveTextContent('Sign in');
  // Outside the actions the public form hides: the bar's own last thing.
  expect(links[0].closest('.topbar-actions')).toBeNull();
  expect(document.querySelector('.topbar')!.lastElementChild).toBe(links[0]);
  await act(async () => {
    showPublicForm({ app, form }, undefined, { signIn: true });
  });
  expect(document.querySelectorAll('.account-sign-in')).toHaveLength(1);
});

test("the form's own address, a link handed to applicants, draws no Sign in", async () => {
  await act(async () => {
    showPublicForm({ app, form });
  });
  expect(document.querySelector('.account-sign-in')).toBeNull();
  expect(document.querySelector('h1')).toHaveTextContent('Join the workshop');
});

test('a placed token carried in HTML is never used; the named GET supplies its whole fresh envelope', async () => {
  const placement = {
    version: 1,
    binding: 'pp1.carried',
    submission: 'carried-submission-key',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    recoverUntil: new Date(Date.now() + 120_000).toISOString(),
    recoveryUrl: 'https://canonical.example/api/forms/join/receipt',
  };
  const envelope = { app, form, placement };
  const block = document.createElement('script');
  block.id = FIRST_PAINT_ELEMENT;
  block.type = 'application/json';
  block.textContent = JSON.stringify({ reads: { [readKey('GET', '/api/forms/join')]: { body: envelope } }, items: {} });
  document.body.append(block);
  rereadFirstPaint();
  const fresh = { ...envelope, placement: { ...placement, binding: 'pp1.fresh', submission: 'fresh-submission-key' } };
  const fetcher = vi.fn(async () => new Response(JSON.stringify(fresh), { status: 200 }));
  vi.stubGlobal('fetch', fetcher);
  expect(await loadPublicForm('join', { appId: app.id })).toEqual(fresh);
  expect(fetcher).toHaveBeenCalledWith('/api/forms/join', expect.objectContaining({ credentials: 'omit', cache: 'no-store' }));
  expect(document.getElementById(FIRST_PAINT_ELEMENT)).toBeNull();
});

test("a tenant's link carries its intake address on to the form's read, so its choices are that tenant's", async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ app, form }), { status: 200 }));
  vi.stubGlobal('fetch', fetcher);
  window.history.replaceState(null, '', '/workshop/form/join?via=north-intake%20A%26B');
  try {
    expect(await loadPublicForm('join', { appId: app.id })).toEqual({ app, form });
    expect(fetcher).toHaveBeenCalledWith('/api/forms/join?via=north-intake+A%26B', expect.objectContaining({ credentials: 'omit' }));
    // A link with no address reads the form as it always did.
    window.history.replaceState(null, '', '/workshop/form/join');
    await loadPublicForm('join', { appId: app.id });
    expect(fetcher).toHaveBeenLastCalledWith('/api/forms/join', expect.anything());
  } finally {
    window.history.replaceState(null, '', '/');
  }
});

test('the standalone page passes the entire prepared envelope into its lazy placed surface', async () => {
  const prepared = {
    app: { ...app, id: 'placed-workshop' },
    form,
    placement: {
      version: 1 as const,
      binding: 'pp1.standalone',
      submission: 'standalone-issued-key',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      recoverUntil: new Date(Date.now() + 120_000).toISOString(),
      recoveryUrl: 'https://canonical.example/api/forms/join/receipt',
    },
  };
  const fetcher = vi.fn(
    async () => new Response(JSON.stringify({ reference: 'JOIN-1', receipt: { id: 'receipt-join', status: 'applied' } }), { status: 200 }),
  );
  vi.stubGlobal('fetch', fetcher);
  await act(async () => {
    showPublicForm(prepared);
  });
  fireEvent.click(await screen.findByRole('checkbox', { name: 'I have read the rules (required)' }));
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
  await screen.findByRole('heading', { name: 'Received' });
  expect(fetcher).toHaveBeenCalledWith(
    expect.stringMatching(/\/api\/forms\/join$/),
    expect.objectContaining({
      credentials: 'omit',
      body: JSON.stringify({
        input: { agree: true },
        submission: prepared.placement.submission,
        placement: { version: 1, binding: prepared.placement.binding },
      }),
    }),
  );
});
