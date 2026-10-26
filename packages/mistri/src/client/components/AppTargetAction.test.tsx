import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AppTargetAction } from './AppTargetAction.js';
import { configureAppTargetLinks } from '../appTargetLinks.js';
import {
  captureSessionIdentity,
  establishSessionIdentity,
  establishTenantSelection,
  lockSessionIdentity,
  requireTenantSelection,
  suspendTenantLease,
} from '../../../../kit/src/client/sessionIdentity.js';
import type { AppTarget } from '../../../../engine/src/shared/appLinks.js';

const target: AppTarget = { app: 'lender', kind: 'record', resource: 'loan_application', key: { id: { column: 'id' } } };
const fetcher = vi.fn();
const answer = (accountId = 'subject', href = '/tools/work/9007199254740993') => ({ ok: true, json: async () => ({ accountId, href }) });
function signIn() {
  establishSessionIdentity({ signedIn: true, accountId: 'subject', appId: 'leads' });
}
function configure() {
  configureAppTargetLinks({ basePath: '/tools', appId: 'leads' });
}
function select(tenantId: string) {
  requireTenantSelection();
  establishTenantSelection({
    accountId: 'subject',
    appId: 'leads',
    tenantId,
    tabId: `tab-${tenantId}`,
    context: `secret-${tenantId}`,
    revision: 1,
    expiresAt: Date.now() + 60000,
  });
}
beforeEach(() => {
  lockSessionIdentity();
  signIn();
  fetcher.mockReset();
  fetcher.mockResolvedValue(answer());
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => {
  cleanup();
  configureAppTargetLinks(null);
  vi.unstubAllGlobals();
});

test('standalone and malformed configuration never invent a suite endpoint', async () => {
  const { rerender } = render(<AppTargetAction label="Lender" to={{ app: 'lender', kind: 'home' }} />);
  await act(async () => {});
  expect(fetcher).not.toHaveBeenCalled();
  for (const metadata of [
    { basePath: '//elsewhere', appId: 'leads' },
    { basePath: '/tools', appId: 'other' },
  ]) {
    act(() => configureAppTargetLinks(metadata));
    rerender(<AppTargetAction label="Lender" to={{ app: 'lender', kind: 'home' }} />);
    expect(fetcher).not.toHaveBeenCalled();
  }
});

test('served values produce account-only resolution and an ordinary external anchor', async () => {
  configure();
  select('north');
  render(<AppTargetAction label="Lender" to={target} row={{ id: '9007199254740993' }} />);
  const link = await screen.findByRole('link', { name: 'Lender' });
  expect(link).toHaveAttribute('href', '/tools/work/9007199254740993');
  const [url, request] = fetcher.mock.calls[0];
  expect(url).toBe('/tools/api/suite/links/resolve');
  expect(request.headers).toEqual({ 'content-type': 'application/json', 'x-mistri-account': 'subject' });
  expect(request.credentials).toBe('same-origin');
  expect(JSON.parse(request.body)).toEqual({
    sourceApp: 'leads',
    target: { app: 'lender', kind: 'record', resource: 'loan_application', key: { id: '9007199254740993' } },
  });
  expect(request.body).not.toContain('secret-north');
  for (const modifiers of [{ ctrlKey: true }, { metaKey: true }]) {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, ...modifiers });
    fireEvent(link, event);
    expect(event.defaultPrevented).toBe(false);
  }
});

test.each([undefined, {}, { unrelated: '1' }, { id: null }, { id: Number.MAX_SAFE_INTEGER + 1 }])(
  'missing or hidden source values %j hide without a request',
  async (row) => {
    configure();
    render(<AppTargetAction label="Lender" to={target} row={row} />);
    await act(async () => {});
    expect(fetcher).not.toHaveBeenCalled();
    expect(screen.queryByRole('link')).toBeNull();
  },
);

test('unmount and account replacement abort and discard delayed resolution', async () => {
  let finish!: (value: ReturnType<typeof answer>) => void;
  fetcher.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  configure();
  const { unmount } = render(<AppTargetAction label="Lender" to={target} row={{ id: '1' }} />);
  const signal = fetcher.mock.calls[0][1].signal as AbortSignal;
  act(() => {
    lockSessionIdentity();
    signIn();
  });
  expect(signal.aborted).toBe(true);
  await act(async () => {
    finish(answer());
  });
  expect(screen.queryByRole('link')).toBeNull();
  unmount();
});

test('unmount cancels the suite request before its response is available', async () => {
  fetcher.mockImplementation(() => new Promise(() => {}));
  configure();
  const { unmount } = render(<AppTargetAction label="Lender" to={target} row={{ id: '1' }} />);
  const signal = fetcher.mock.calls[0][1].signal as AbortSignal;
  expect(signal.aborted).toBe(false);
  unmount();
  expect(signal.aborted).toBe(true);
});

test('context replacement cannot rebind a retained source row; fresh row can resolve', async () => {
  configure();
  select('north');
  const row = { id: '1' };
  const { rerender } = render(<AppTargetAction label="Lender" to={target} row={row} />);
  await screen.findByRole('link');
  const first = captureSessionIdentity();
  act(() => select('south'));
  expect(captureSessionIdentity()).not.toBe(first);
  expect(screen.queryByRole('link')).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
  rerender(<AppTargetAction label="Lender" to={target} row={{ id: '2' }} />);
  await screen.findByRole('link');
  expect(fetcher).toHaveBeenCalledTimes(2);
  act(() => suspendTenantLease());
  expect(screen.queryByRole('link')).toBeNull();
});

test('focus rechecks revoked target grants and hides the old link immediately', async () => {
  configure();
  render(<AppTargetAction label="Lender" to={target} row={{ id: '1' }} />);
  await screen.findByRole('link');
  fetcher.mockResolvedValue({ ok: false, status: 403 });
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('link')).toBeNull();
});

test('a foreign account reply never renders a link', async () => {
  configure();
  fetcher.mockResolvedValue(answer('other'));
  render(<AppTargetAction label="Lender" to={target} row={{ id: '1' }} />);
  await act(async () => {});
  expect(screen.queryByRole('link')).toBeNull();
});
