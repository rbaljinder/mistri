/**
 * The sign-in screen, drawn and driven.
 *
 * Against a fetch that answers like Better Auth would: a sentence on
 * refusal, an empty body on success. What the page does after success is
 * a reload, stubbed here — the browser suite covers the real one.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, StrictMode } from 'react';
import { SignIn, type SignInInfo } from './SignIn.js';
import { AccountControl } from './AccountControl.js';
import { beginSessionSignOut, configureSessionLifecycle, SESSION_CHANGE_KEY } from '../../../../kit/src/client/sessionLifecycle.js';
import {
  captureAccountIdentity,
  establishSessionIdentity,
  establishTenantSelection,
  lockSessionIdentity,
  requireTenantSelection,
  sessionIdentity,
} from '../../../../kit/src/client/sessionIdentity.js';
import { INVITATION_HTTP_HEADER, type InvitationAcceptanceResult, type InvitationPreview } from '../../shared/tenantInvitations.js';
import { hasInvitationSession, hasUnresolvedInvitations, TenantInvitationsController } from '../tenantInvitations.js';

const info: SignInInfo = { app: 'Compass CRM', providers: ['email', 'github'], signUp: 'open' };

function draw(tree: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(createElement(QueryClientProvider, { client }, tree));
}

const calls: Array<{ path: string; body: unknown }> = [];
let answer: { ok: boolean; status: number; body: unknown } = { ok: true, status: 200, body: {} };

beforeEach(() => {
  configureSessionLifecycle({ onLock: () => {} });
  calls.length = 0;
  answer = { ok: true, status: 200, body: {} };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init: RequestInit) => {
      calls.push({ path, body: JSON.parse(String(init.body)) });
      return { ok: answer.ok, status: answer.status, json: async () => answer.body };
    }),
  );
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, reload: vi.fn(), href: 'http://app.test/crm' },
  });
});

afterEach(() => {
  cleanup();
  document.getElementById('session-lock')?.remove();
  configureSessionLifecycle({ onLock: () => {} });
  vi.unstubAllGlobals();
});

describe('pre-selection tenant administration entry', () => {
  beforeEach(() => {
    lockSessionIdentity();
    establishSessionIdentity({ signedIn: true, accountId: 'operator', appId: 'app' });
    requireTenantSelection();
  });
  function administrationReply(authorized: boolean) {
    return new Response(
      JSON.stringify({
        session: authorized
          ? {
              accountId: 'operator',
              appId: 'app',
              context: 'admin-context',
              expiresAt: Date.now() + 300_000,
              maxMembershipLifetimeMs: 86_400_000,
            }
          : null,
      }),
      {
        headers: {
          'x-mistri-account': 'operator',
          'x-mistri-app': 'app',
          ...(authorized ? { 'x-mistri-administration-context': 'admin-context' } : {}),
        },
      },
    );
  }
  test('configuration alone does not show Manage tenants when open returns null', async () => {
    const fetcher = vi.fn(async () => administrationReply(false));
    vi.stubGlobal('fetch', fetcher);
    const user = userEvent.setup();
    render(<AccountControl who="Ordinary user" tenantAdministration />);
    await user.click(screen.getByRole('button', { name: 'Account: Ordinary user' }));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menuitem', { name: 'Manage tenants' })).toBeNull();
  });
  test('an owned native UI opens once across strict effects, rerenders and dialog reopenings', async () => {
    const fetcher = vi.fn(async (url: string) =>
      url.includes('/open?')
        ? administrationReply(true)
        : new Response(JSON.stringify({ page: { items: [], next: null } }), {
            headers: {
              'x-mistri-account': 'operator',
              'x-mistri-app': 'app',
              'x-mistri-administration-context': 'admin-context',
            },
          }),
    );
    vi.stubGlobal('fetch', fetcher);
    const user = userEvent.setup();
    const tree = render(
      <StrictMode>
        <AccountControl who="Operator" tenantAdministration />
      </StrictMode>,
    );
    await user.click(screen.getByRole('button', { name: 'Account: Operator' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Manage tenants' }));
    expect(await screen.findByRole('dialog', { name: 'Manage tenants' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    tree.rerender(
      <StrictMode>
        <AccountControl who="Operator" tenantAdministration />
      </StrictMode>,
    );
    await user.click(screen.getByRole('button', { name: 'Account: Operator' }));
    await user.click(screen.getByRole('menuitem', { name: 'Manage tenants' }));
    expect(screen.getByRole('dialog', { name: 'Manage tenants' })).toBeVisible();
    expect(fetcher.mock.calls.filter(([url]) => url.includes('/open?'))).toHaveLength(1);
    expect(sessionIdentity().tenant).toBeUndefined();
  });
  test('held metadata cannot enable an old menu after same-account native owner replacement', async () => {
    let resolve!: (value: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((yes) => {
            resolve = yes;
          }),
      ),
    );
    const user = userEvent.setup();
    const tree = render(<AccountControl who="Operator" tenantAdministration />);
    // Reaching for the menu is what opens administration (AccountControl.tsx).
    act(() => {
      screen.getByRole('button', { name: 'Account: Operator' }).focus();
    });
    await act(async () => {
      lockSessionIdentity();
      establishSessionIdentity({ signedIn: true, accountId: 'operator', appId: 'app' });
      resolve(administrationReply(true));
    });
    tree.rerender(<AccountControl who="Operator" tenantAdministration />);
    await user.click(screen.getByRole('button', { name: 'Account: Operator' }));
    expect(screen.queryByRole('menuitem', { name: 'Manage tenants' })).toBeNull();
  });
  test('administration is not opened until the reader reaches for the account menu', async () => {
    const fetcher = vi.fn(async () => administrationReply(true));
    vi.stubGlobal('fetch', fetcher);
    const user = userEvent.setup();
    render(<AccountControl who="Operator" tenantAdministration />);
    await act(async () => {
      await Promise.resolve();
    });
    // Drawing the shell asks nothing: the open is a writer transaction (AccountControl.tsx).
    expect(fetcher).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Account: Operator' }));
    expect(await screen.findByRole('menuitem', { name: 'Manage tenants' })).toBeVisible();
    expect(fetcher).toHaveBeenCalledOnce();
  });
  test('an unconfigured account menu does not open administration metadata', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const user = userEvent.setup();
    render(<AccountControl who="Operator" />);
    await user.click(screen.getByRole('button', { name: 'Account: Operator' }));
    expect(fetcher).not.toHaveBeenCalled();
    expect(screen.queryByRole('menuitem', { name: 'Manage tenants' })).toBeNull();
  });
  test('native account rerenders across business selections retain admission and can still sign out', async () => {
    const fetcher = vi.fn(async (url: string) => (url.includes('/open?') ? administrationReply(true) : new Response('{}')));
    vi.stubGlobal('fetch', fetcher);
    const user = userEvent.setup();
    const tree = render(<AccountControl key={captureAccountIdentity().epoch} who="Operator" tenantAdministration />);
    await user.click(screen.getByRole('button', { name: 'Account: Operator' }));
    expect(await screen.findByRole('menuitem', { name: 'Manage tenants' })).toBeVisible();
    await user.keyboard('{Escape}');
    for (let i = 0; i < 20; i++) {
      await act(async () => {
        requireTenantSelection();
        establishTenantSelection({
          appId: 'app',
          accountId: 'operator',
          tenantId: 'north',
          tabId: 'tab',
          context: `business-${i}`,
          revision: 1,
          expiresAt: Date.now() + 60_000,
        });
      });
      tree.rerender(<AccountControl key={captureAccountIdentity().epoch} who="Operator" tenantAdministration />);
    }
    await user.click(screen.getByRole('button', { name: 'Account: Operator' }));
    expect(screen.getByRole('menuitem', { name: 'Manage tenants' })).toBeVisible();
    expect(fetcher.mock.calls.filter(([url]) => url.includes('/open?'))).toHaveLength(1);
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    expect(fetcher.mock.calls.filter(([url]) => url.includes('/sign-out'))).toHaveLength(1);
    expect(sessionIdentity().mode).toBe('locked');
    expect(window.location.reload).toHaveBeenCalledTimes(1);
  });
  test('failed initial admission exposes an explicit retry instead of silently removing management forever', async () => {
    const fetcher = vi.fn(async () => administrationReply(true)).mockRejectedValueOnce(new Error('Offline'));
    vi.stubGlobal('fetch', fetcher);
    const user = userEvent.setup();
    render(<AccountControl who="Operator" tenantAdministration />);
    await user.click(screen.getByRole('button', { name: 'Account: Operator' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Retry tenant administration' }));
    await user.click(screen.getByRole('button', { name: 'Account: Operator' }));
    expect(await screen.findByRole('menuitem', { name: 'Manage tenants' })).toBeVisible();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  test('a profile retired by business selection can reopen from the preserved account menu', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            profile: {
              accountId: 'operator',
              appId: 'app',
              name: 'Operator',
              email: 'operator@example.test',
              providers: ['email'],
            },
          }),
          { headers: { 'x-mistri-account': 'operator' } },
        ),
    );
    vi.stubGlobal('fetch', fetcher);
    const user = userEvent.setup();
    render(<AccountControl who="Operator" accountProfile />);
    await user.click(screen.getByRole('button', { name: 'Account: Operator' }));
    await user.click(screen.getByRole('menuitem', { name: 'Your profile' }));
    expect(await screen.findByRole('textbox', { name: 'Name' })).toHaveValue('Operator');
    await act(async () => {
      requireTenantSelection();
    });
    expect(screen.queryByRole('dialog', { name: 'Your profile' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Account: Operator' }));
    await user.click(screen.getByRole('menuitem', { name: 'Your profile' }));
    expect(await screen.findByRole('textbox', { name: 'Name' })).toHaveValue('Operator');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe('pre-selection invitation entry', () => {
  const invitationId = '11111111-1111-4111-8111-111111111111',
    membershipId = '22222222-2222-4222-8222-222222222222';
  const token = `twi1.${invitationId}.${'A'.repeat(43)}`;
  let preview: InvitationPreview;
  let authorized: boolean, lost: boolean;
  let fetcher: ReturnType<typeof vi.fn>;
  const owned: TenantInvitationsController[] = [];
  function invitationReply(body: unknown, context: string | null = 'issuer-context') {
    return new Response(JSON.stringify(body), {
      headers: {
        'content-type': 'application/json',
        'x-mistri-account': 'operator',
        'x-mistri-app': 'app',
        ...(context ? { [INVITATION_HTTP_HEADER]: context } : {}),
      },
    });
  }
  function admission() {
    return invitationReply(
      {
        session: authorized
          ? {
              appId: 'app',
              accountId: 'operator',
              context: 'issuer-context',
              expiresAt: Date.now() + 300_000,
              maxMembershipLifetimeMs: 86_400_000,
              maxRedemptionLifetimeMs: 3_600_000,
              maxPendingPerTenant: 100,
            }
          : null,
      },
      authorized ? 'issuer-context' : null,
    );
  }
  function accepted(replayed = false): InvitationAcceptanceResult {
    return {
      receiptId: 'acceptance-receipt',
      requestId: 'request',
      completedAt: new Date().toISOString(),
      replayed,
      invitationId,
      tenantId: 'north',
      membershipId,
      membershipVersion: '2',
      roles: preview.roles,
      validUntil: preview.validUntil,
      status: 'accepted',
    };
  }
  beforeEach(() => {
    lockSessionIdentity();
    establishSessionIdentity({ signedIn: true, accountId: 'operator', appId: 'app' });
    requireTenantSelection();
    authorized = true;
    lost = false;
    preview = {
      intent: {
        operation: 'acceptInvitation',
        tenantId: 'north',
        expectedTenantVersion: '1',
        invitationId,
        expectedInvitationVersion: '1',
        membershipId,
        expectedMembershipVersion: '1',
      },
      roles: ['reader'],
      redeemUntil: Date.now() + 60_000,
      validUntil: Date.now() + 3_600_000,
    };
    fetcher = vi.fn(async (path: string) => {
      if (path.includes('/open-issuer?')) return admission();
      if (path.includes('/targets?')) return invitationReply({ page: { items: [], next: null } });
      if (path.includes('/open-recipient?'))
        return invitationReply(
          { session: { appId: 'app', accountId: 'operator', context: 'recipient-context', expiresAt: Date.now() + 300_000 } },
          'recipient-context',
        );
      if (path.includes('/preview?')) return invitationReply({ preview }, 'recipient-context');
      if (path.includes('/execute?')) {
        if (lost) throw new Error('Lost acceptance acknowledgement');
        return invitationReply({ outcome: 'applied', result: accepted() }, 'recipient-context');
      }
      if (path.includes('/status?'))
        return invitationReply({ status: 'completed', outcome: 'applied', result: accepted(true) }, 'recipient-context');
      if (path === '/api/auth/sign-out') return new Response('{}');
      throw new Error('Unexpected request');
    });
    vi.stubGlobal('fetch', fetcher);
  });
  afterEach(async () => {
    await act(async () => {
      owned.splice(0).forEach((c) => c.retire());
      lockSessionIdentity();
    });
  });

  test('without invitation capability the account menu does not request admission or offer invitation actions', async () => {
    const user = userEvent.setup();
    render(<AccountControl who="Operator" />);
    await user.click(screen.getByRole('button', { name: 'Account: Operator' }));
    expect(fetcher).not.toHaveBeenCalled();
    expect(screen.queryByRole('menuitem', { name: 'Manage invitations' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Accept invitation' })).toBeNull();
  });

  test.each([false, true])(
    'recipient entry is available before business selection; issuer menu follows authorized=%s admission',
    async (permitted) => {
      authorized = permitted;
      const user = userEvent.setup();
      render(<AccountControl who="Operator" tenantInvitations />);
      await user.click(screen.getByRole('button', { name: 'Account: Operator' }));
      expect(screen.getByRole('menuitem', { name: 'Accept invitation' })).toBeVisible();
      if (permitted) expect(await screen.findByRole('menuitem', { name: 'Manage invitations' })).toBeVisible();
      else expect(screen.queryByRole('menuitem', { name: 'Manage invitations' })).toBeNull();
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(sessionIdentity().tenant).toBeUndefined();
      await user.click(screen.getByRole('menuitem', { name: 'Accept invitation' }));
      expect(await screen.findByRole('dialog', { name: 'Accept invitation' })).toBeVisible();
      expect(screen.getByLabelText('Invitation token')).toHaveValue('');
    },
  );

  test('StrictMode, business denial, rerenders and dialog reopenings reuse one account-owned issuer admission', async () => {
    const user = userEvent.setup(),
      tree = render(
        <StrictMode>
          <AccountControl who="Operator" tenantInvitations />
        </StrictMode>,
      );
    await user.click(screen.getByRole('button', { name: 'Account: Operator' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Manage invitations' }));
    expect(await screen.findByText('No authorized invitation targets are available.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Account: Operator' })).toHaveFocus());
    const owner = captureAccountIdentity();
    await act(async () => {
      establishTenantSelection({
        appId: 'app',
        accountId: 'operator',
        tenantId: 'north',
        tabId: 'tab',
        context: 'business-context',
        revision: 1,
        expiresAt: Date.now() + 60_000,
      });
      requireTenantSelection();
    });
    tree.rerender(
      <StrictMode>
        <AccountControl who="Operator" tenantInvitations />
      </StrictMode>,
    );
    await user.click(screen.getByRole('button', { name: 'Account: Operator' }));
    await user.click(screen.getByRole('menuitem', { name: 'Manage invitations' }));
    expect(screen.getByRole('dialog', { name: 'Manage invitations' })).toBeVisible();
    expect(captureAccountIdentity()).toBe(owner);
    expect(hasInvitationSession()).toBe(true);
    expect(fetcher.mock.calls.filter(([url]) => url.includes('/open-issuer?'))).toHaveLength(1);
  });

  test('failed issuer admission offers explicit permission recheck without hiding recipient entry', async () => {
    fetcher.mockRejectedValueOnce(new Error('Offline'));
    const user = userEvent.setup();
    render(<AccountControl who="Operator" tenantInvitations />);
    await user.click(screen.getByRole('button', { name: 'Account: Operator' }));
    expect(screen.getByRole('menuitem', { name: 'Accept invitation' })).toBeVisible();
    await user.click(await screen.findByRole('menuitem', { name: 'Check invitation permissions' }));
    await user.click(screen.getByRole('button', { name: 'Account: Operator' }));
    expect(await screen.findByRole('menuitem', { name: 'Manage invitations' })).toBeVisible();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test('held admission cannot enable stale invitation actions after native account replacement', async () => {
    let resolve!: (value: Response) => void;
    fetcher.mockImplementationOnce(
      () =>
        new Promise<Response>((yes) => {
          resolve = yes;
        }),
    );
    const user = userEvent.setup(),
      tree = render(<AccountControl who="Operator" tenantInvitations />);
    act(() => {
      screen.getByRole('button', { name: 'Account: Operator' }).focus();
    });
    await act(async () => {
      lockSessionIdentity();
      establishSessionIdentity({ signedIn: true, accountId: 'operator', appId: 'app' });
      resolve(admission());
    });
    tree.rerender(<AccountControl who="Operator" tenantInvitations />);
    await user.click(screen.getByRole('button', { name: 'Account: Operator' }));
    expect(screen.queryByRole('menuitem', { name: 'Manage invitations' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Accept invitation' })).toBeNull();
    expect(hasInvitationSession()).toBe(false);
  });

  test.each([false, true])(
    'acceptance callback fires once after confirmed receipt (lost acknowledgement=%s), without implicit selection',
    async (lostAck) => {
      lost = lostAck;
      authorized = false;
      const user = userEvent.setup(),
        refresh = vi.fn();
      const tree = render(
        <StrictMode>
          <AccountControl who="Operator" tenantInvitations onInvitationAccepted={refresh} />
        </StrictMode>,
      );
      await user.click(screen.getByRole('button', { name: 'Account: Operator' }));
      await user.click(screen.getByRole('menuitem', { name: 'Accept invitation' }));
      await user.type(screen.getByLabelText('Invitation token'), token);
      await user.click(screen.getByRole('button', { name: 'Review invitation' }));
      const region = await screen.findByRole('region', { name: 'Review invitation change' });
      expect(refresh).not.toHaveBeenCalled();
      await user.click(within(region).getByRole('button', { name: 'Accept invitation' }));
      if (lostAck) {
        await screen.findByRole('button', { name: 'Check attempt status' });
        expect(refresh).not.toHaveBeenCalled();
        await user.click(screen.getByRole('button', { name: 'Check attempt status' }));
        const status = fetcher.mock.calls.find(([url]) => url.includes('/status?'))!;
        expect(String(status[1]?.body)).not.toContain(token);
      }
      await screen.findByText(/Receipt acceptance-receipt/);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(sessionIdentity().tenant).toBeUndefined();
      tree.rerender(
        <StrictMode>
          <AccountControl who="Operator" tenantInvitations onInvitationAccepted={refresh} />
        </StrictMode>,
      );
      expect(refresh).toHaveBeenCalledTimes(1);
      await user.click(screen.getByRole('button', { name: 'Close' }));
      await user.click(screen.getByRole('button', { name: 'Account: Operator' }));
      await user.click(screen.getByRole('menuitem', { name: 'Accept invitation' }));
      expect(screen.getByLabelText('Invitation token')).toHaveValue('');
      expect(refresh).toHaveBeenCalledTimes(1);
    },
  );

  test.each(['executing', 'unknown', 'checking'] as const)(
    'global %s invitation guard prevents the explicit account sign-out handler from dispatching',
    async (phase) => {
      const user = userEvent.setup();
      render(<AccountControl who="Operator" tenantInvitations />);
      await user.click(screen.getByRole('button', { name: 'Account: Operator' }));
      // A separate account-owned operation exercises the global shell guard even
      // when no modal is mounted to intercept the menu interaction.
      const operation = new TenantInvitationsController();
      owned.push(operation);
      await operation.previewToken(token);
      let settle: ((value: Response) => void) | undefined, pending: Promise<void> | undefined;
      if (phase === 'executing') {
        fetcher.mockImplementationOnce(
          () =>
            new Promise<Response>((yes) => {
              settle = yes;
            }),
        );
        pending = operation.execute();
      } else {
        lost = true;
        await operation.execute();
        if (phase === 'checking') {
          fetcher.mockImplementationOnce(
            () =>
              new Promise<Response>((yes) => {
                settle = yes;
              }),
          );
          pending = operation.check();
        }
      }
      expect(operation.snapshot().phase).toBe(phase);
      expect(hasUnresolvedInvitations()).toBe(true);
      const count = fetcher.mock.calls.length;
      await user.click(screen.getByRole('menuitem', { name: 'Sign out' }));
      expect(fetcher).toHaveBeenCalledTimes(count);
      expect(sessionIdentity().mode).toBe('authenticated');
      expect(window.location.reload).not.toHaveBeenCalled();
      if (settle) {
        const result =
          phase === 'checking'
            ? { status: 'completed', outcome: 'applied', result: accepted(true) }
            : { outcome: 'applied', result: accepted() };
        settle(invitationReply(result, 'recipient-context'));
        await pending;
      } else await operation.check();
      expect(hasUnresolvedInvitations()).toBe(false);
      await user.click(screen.getByRole('button', { name: 'Account: Operator' }));
      await user.click(screen.getByRole('menuitem', { name: 'Sign out' }));
      expect(fetcher.mock.calls.filter(([url]) => url === '/api/auth/sign-out')).toHaveLength(1);
      expect(sessionIdentity().mode).toBe('locked');
      expect(window.location.reload).toHaveBeenCalledTimes(1);
    },
  );
});

describe('the sign-in screen', () => {
  test('wears the app name and offers every provider', () => {
    draw(<SignIn info={info} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Compass CRM');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue with GitHub' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New here? Create an account' })).toBeInTheDocument();
  });

  test('signs in with email and password, then starts over', async () => {
    const user = userEvent.setup();
    draw(<SignIn info={info} />);
    await user.type(screen.getByLabelText('Email'), 'ada@example.org');
    await user.type(screen.getByLabelText('Password'), 'correct-horse');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(calls).toEqual([
      {
        path: '/api/auth/sign-in/email',
        body: { email: 'ada@example.org', password: 'correct-horse', rememberMe: true },
      },
    ]);
    expect(window.location.reload).toHaveBeenCalled();
  });

  test("shows a refusal in the server's words and stays", async () => {
    answer = { ok: false, status: 401, body: { message: 'Invalid email or password' } };
    const user = userEvent.setup();
    draw(<SignIn info={info} />);
    await user.type(screen.getByLabelText('Email'), 'ada@example.org');
    await user.type(screen.getByLabelText('Password'), 'wrong-horse');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password');
    expect(window.location.reload).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
    // Busy while asking, never disabled: the focus stays on the button rather than falling to the page.
    expect(screen.getByRole('button', { name: 'Sign in' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Sign in' })).not.toHaveAttribute('aria-disabled');
  });

  test('flips to creating an account, which asks for a name', async () => {
    const user = userEvent.setup();
    draw(<SignIn info={info} />);
    await user.click(screen.getByRole('button', { name: 'New here? Create an account' }));
    expect(screen.getByLabelText('Name')).toHaveFocus();
    await user.type(screen.getByLabelText('Name'), 'Ada');
    await user.type(screen.getByLabelText('Email'), 'ada@example.org');
    await user.type(screen.getByLabelText('Password'), 'correct-horse');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(calls[0]).toEqual({
      path: '/api/auth/sign-up/email',
      body: { name: 'Ada', email: 'ada@example.org', password: 'correct-horse' },
    });
  });

  test('invite-only offers no sign-up and adds no line about it', () => {
    draw(<SignIn info={{ ...info, signUp: 'invite' }} />);
    expect(screen.queryByRole('button', { name: /Create an account/ })).toBeNull();
    expect(screen.queryByText(/created by an admin/)).toBeNull();
  });

  test("GitHub and Google wear their mark at the button's start; an OpenID Connect provider wears none", () => {
    draw(
      <SignIn
        info={{
          app: 'Lending',
          providers: ['email', 'github', 'google', 'oidc:workforce'],
          signUp: 'open',
          labels: { 'oidc:workforce': 'Contoso' },
        }}
      />,
    );
    const mark = (name: string) => screen.getByRole('button', { name }).querySelector('svg.signin-mark');
    expect(mark('Continue with GitHub')).not.toBeNull();
    expect(mark('Continue with GitHub')?.getAttribute('aria-hidden')).toBe('true');
    expect(mark('Continue with Google')?.querySelectorAll('path')).toHaveLength(4);
    expect(mark('Continue with Contoso')).toBeNull();
  });

  test('a social provider sends the page where the server says', async () => {
    answer = { ok: true, status: 200, body: { url: 'https://github.com/login/oauth' } };
    const user = userEvent.setup();
    draw(<SignIn info={info} />);
    await user.click(screen.getByRole('button', { name: 'Continue with GitHub' }));
    expect(calls[0]).toEqual({
      path: '/api/auth/sign-in/social',
      body: { provider: 'github', callbackURL: 'http://app.test/crm', errorCallbackURL: 'http://app.test/crm' },
    });
    await vi.waitFor(() => expect(window.location.href).toBe('https://github.com/login/oauth'));
  });

  test("an identity provider is its label on the button, and its config entry's name to Better Auth", async () => {
    answer = { ok: true, status: 200, body: { url: 'https://login.example/authorize' } };
    const user = userEvent.setup();
    draw(
      <SignIn
        info={{ app: 'Lending', providers: ['email', 'oidc:workforce'], signUp: 'provider', labels: { 'oidc:workforce': 'Contoso' } }}
      />,
    );
    // Accounts are made at a first sign-in through the provider: no email sign-up.
    expect(screen.queryByRole('button', { name: /Create an account/ })).toBeNull();
    expect(screen.queryByText('Accounts are created by an admin.')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Continue with Contoso' }));
    expect(calls[0].body).toEqual({ provider: 'workforce', callbackURL: 'http://app.test/crm', errorCallbackURL: 'http://app.test/crm' });
  });

  test("a work email finds its organization's provider and signs in there with the address as a hint", async () => {
    const user = userEvent.setup();
    draw(<SignIn info={{ app: 'Lending', providers: ['email', 'oidc:*'], signUp: 'invite' }} />);
    await user.click(screen.getByRole('button', { name: 'Sign in with your work email' }));
    answer = { ok: true, status: 200, body: { provider: null } };
    await user.type(screen.getByLabelText('Email'), 'kim@elsewhere.example');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(
      await screen.findByText(
        'No organization signs in to Lending with elsewhere.example addresses. Use another way to sign in, or ask your administrator.',
      ),
    ).toBeInTheDocument();
    answer = { ok: true, status: 200, body: { provider: 'north-sso', url: 'https://north.example/authorize' } };
    await user.clear(screen.getByLabelText('Email'));
    await user.type(screen.getByLabelText('Email'), 'kim@north.example');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await vi.waitFor(() => expect(calls.at(-1)?.path).toBe('/api/auth/sign-in/social'));
    expect(calls.at(-2)).toEqual({ path: '/api/auth/work-email', body: { email: 'kim@north.example' } });
    expect(calls.at(-1)?.body).toEqual({
      provider: 'north-sso',
      callbackURL: 'http://app.test/crm',
      errorCallbackURL: 'http://app.test/crm',
      loginHint: 'kim@north.example',
    });
  });

  test('a SAML provider is a button that starts its own sign-in, naming only the provider and where to come back to', async () => {
    const user = userEvent.setup();
    answer = { ok: true, status: 200, body: { url: 'https://okta.example/sso', redirect: true } };
    draw(<SignIn info={{ app: 'Lending', providers: ['email', 'saml:okta'], signUp: 'invite', labels: { 'saml:okta': 'Okta' } }} />);
    await user.click(screen.getByRole('button', { name: 'Continue with Okta' }));
    expect(calls[0]).toEqual({
      path: '/api/auth/sign-in/sso',
      body: { providerId: 'okta', callbackURL: 'http://app.test/crm', errorCallbackURL: 'http://app.test/crm' },
    });
  });

  test("a work email whose organization signs in by SAML starts that provider's sign-in, without a hint", async () => {
    const user = userEvent.setup();
    draw(<SignIn info={{ app: 'Lending', providers: ['email', 'saml:*'], signUp: 'invite' }} />);
    await user.click(screen.getByRole('button', { name: 'Sign in with your work email' }));
    answer = { ok: true, status: 200, body: { provider: 'north-saml', kind: 'saml', url: 'https://north.example/sso' } };
    await user.type(screen.getByLabelText('Email'), 'kim@north.example');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await vi.waitFor(() => expect(calls.at(-1)?.path).toBe('/api/auth/sign-in/sso'));
    expect(calls.at(-1)?.body).toEqual({
      providerId: 'north-saml',
      callbackURL: 'http://app.test/crm',
      errorCallbackURL: 'http://app.test/crm',
    });
  });

  test('a refused sign-in comes back with a code, said as a sentence, and the address forgets it', () => {
    const replaced: string[] = [];
    vi.spyOn(window.history, 'replaceState').mockImplementation((_state, _title, url) => {
      replaced.push(String(url));
    });
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload: vi.fn(), href: 'http://app.test/crm?error=no_role&error_description=Anything+anyone+wrote' },
    });
    draw(<SignIn info={{ app: 'Lending', providers: ['oidc:workforce'], signUp: 'invite' }} />);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Your organization signed you in, and gives you no role in Lending. Ask your administrator for access.',
    );
    expect(screen.queryByText(/Anything anyone wrote/)).toBeNull();
    expect(replaced).toEqual(['/crm']);
  });

  test('says what is wrong beside each field, focuses the first, and asks nothing', async () => {
    const user = userEvent.setup();
    draw(<SignIn info={info} />);
    await user.type(screen.getByLabelText('Email'), 'ada@');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    const email = screen.getByLabelText('Email');
    await vi.waitFor(() => expect(email).toHaveFocus());
    expect(email).toHaveAttribute('aria-invalid', 'true');
    expect(email).toHaveAccessibleDescription('Enter an email address, like name@example.com.');
    expect(screen.getByLabelText('Password')).toHaveAccessibleDescription('Enter your password.');
    expect(calls).toEqual([]);
    // Typing again takes the problem away.
    await user.type(email, 'example.org');
    expect(email).not.toHaveAttribute('aria-invalid');
  });

  test('a refusal about one field is said beside that field', async () => {
    answer = { ok: false, status: 422, body: { code: 'USER_ALREADY_EXISTS', message: 'User already exists' } };
    const user = userEvent.setup();
    draw(<SignIn info={info} />);
    await user.click(screen.getByRole('button', { name: 'New here? Create an account' }));
    await user.type(screen.getByLabelText('Name'), 'Ada');
    await user.type(screen.getByLabelText('Email'), 'ada@example.org');
    await user.type(screen.getByLabelText('Password'), 'correct-horse');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    const email = screen.getByLabelText('Email');
    await vi.waitFor(() => expect(email).toHaveAttribute('aria-invalid', 'true'));
    expect(email).toHaveAccessibleDescription(/already uses this email address/);
    expect(screen.getByRole('alert', { hidden: true })).not.toBeVisible();
  });

  test('a forgotten password asks for a link that comes back to this page, and says the same whatever the address', async () => {
    const user = userEvent.setup();
    draw(<SignIn info={{ ...info, reset: 'link' }} />);
    await user.click(screen.getByRole('button', { name: 'Forgot password?' }));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Reset your password');
    await user.type(screen.getByLabelText('Email'), 'ada@example.org');
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(calls).toEqual([
      { path: '/api/auth/request-password-reset', body: { email: 'ada@example.org', redirectTo: 'http://app.test/crm?reset=1' } },
    ]);
    expect(await screen.findByRole('status')).toHaveTextContent(
      'If an account uses ada@example.org, a link to choose a new password is on its way.',
    );
    await user.click(screen.getByRole('button', { name: 'Back to sign in' }));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Sign in to Compass CRM');
  });

  test('without a delivery for reset links, the screen says who resets a password', async () => {
    const user = userEvent.setup();
    draw(<SignIn info={info} />);
    await user.click(screen.getByRole('button', { name: 'Forgot password?' }));
    expect(screen.getByText(/made by its administrator/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send reset link' })).toBeNull();
  });

  test('a reset link lands on a new password, spends its token once, and leaves no token in the address', async () => {
    const replace = vi.spyOn(window.history, 'replaceState');
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        ...window.location,
        reload: vi.fn(),
        href: 'http://app.test/crm/sign-in?reset=1&token=abc',
        search: '?reset=1&token=abc',
        origin: 'http://app.test',
        pathname: '/crm/sign-in',
      },
    });
    const user = userEvent.setup();
    draw(<SignIn info={{ ...info, reset: 'link' }} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Choose a new password');
    expect(replace).toHaveBeenCalledWith(null, '', '/crm/sign-in');
    await user.type(screen.getByLabelText('New password'), 'second-horse');
    await user.type(screen.getByLabelText('Confirm new password'), 'second-hors');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(screen.getByLabelText('Confirm new password')).toHaveAccessibleDescription('The passwords do not match.');
    expect(calls).toEqual([]);
    await user.type(screen.getByLabelText('Confirm new password'), 'e');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(calls).toEqual([{ path: '/api/auth/reset-password', body: { newPassword: 'second-horse', token: 'abc' } }]);
    expect(await screen.findByRole('status')).toHaveTextContent('Your password is changed. Sign in with the new one.');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Sign in to Compass CRM');
    replace.mockRestore();
  });

  test('a spent or expired link asks for a new one', async () => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        ...window.location,
        reload: vi.fn(),
        href: 'http://app.test/crm?reset=1&error=INVALID_TOKEN',
        search: '?reset=1&error=INVALID_TOKEN',
        origin: 'http://app.test',
        pathname: '/crm',
      },
    });
    draw(<SignIn info={{ ...info, reset: 'link' }} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Reset your password');
    expect(screen.getByRole('alert')).toHaveTextContent('That link has expired or was already used.');
  });

  test('a door beside public pages leads back to them', () => {
    draw(<SignIn info={info} home={{ href: '/crm' }} />);
    expect(screen.getByRole('link', { name: 'Back to Compass CRM' })).toHaveAttribute('href', '/crm');
  });
});

describe('the account control', () => {
  beforeEach(() => {
    establishSessionIdentity({ signedIn: true, accountId: 'account-ada', appId: 'crm' });
  });

  function lockSurface() {
    const lock = document.createElement('section');
    lock.id = 'session-lock';
    const title = document.createElement('h1');
    title.id = 'session-lock-title';
    title.textContent = 'Signed out';
    const reload = document.createElement('button');
    reload.textContent = 'Reload';
    lock.append(title, reload);
    document.body.append(lock);
    return { lock, title, reload };
  }

  test('an account known only by its email is its avatar in the bar; a named one shows its name', () => {
    const tree = draw(<AccountControl who="ada@example.org" />);
    const trigger = screen.getByRole('button', { name: 'Account: ada@example.org' });
    expect(trigger.querySelector('.account-name')).toBeNull();
    expect(trigger.querySelector('.account-avatar')).toHaveTextContent('A');
    tree.unmount();
    draw(<AccountControl who="Ada Lovelace" />);
    expect(screen.getByRole('button', { name: 'Account: Ada Lovelace' }).querySelector('.account-name')).toHaveTextContent('Ada Lovelace');
  });

  test('opening the identity menu only shows identity and an explicit Sign out', async () => {
    const lock = vi.fn();
    configureSessionLifecycle({ onLock: lock });
    const user = userEvent.setup();
    draw(<AccountControl who="ada@example.org" />);
    const trigger = screen.getByRole('button', { name: 'Account: ada@example.org' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const menu = screen.getByRole('menu');
    expect(within(menu).getByText('Signed in as')).toBeInTheDocument();
    expect(within(menu).getByText('ada@example.org')).toBeInTheDocument();
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(1);
    expect(within(menu).getByRole('menuitem', { name: 'Sign out' })).toBeInTheDocument();
    expect(calls).toEqual([]);
    expect(lock).not.toHaveBeenCalled();
    expect(sessionIdentity().mode).toBe('authenticated');
  });

  test.each(['{Enter}', ' ', '{ArrowDown}'])('%s opens by keyboard; Escape restores trigger focus without signing out', async (key) => {
    const user = userEvent.setup();
    draw(<AccountControl who="Ada" />);
    const trigger = screen.getByRole('button', { name: 'Account: Ada' });
    trigger.focus();
    await user.keyboard(key);
    await vi.waitFor(() => expect(screen.getByRole('menuitem', { name: 'Sign out' })).toHaveFocus());
    await user.keyboard('{Escape}');
    await vi.waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(calls).toEqual([]);
    expect(sessionIdentity().mode).toBe('authenticated');
  });

  test('an outside click dismisses without signing out', async () => {
    const user = userEvent.setup();
    draw(
      <>
        <AccountControl who="Ada" />
        <button type="button">Outside</button>
      </>,
    );
    await user.click(screen.getByRole('button', { name: 'Account: Ada' }));
    await user.click(screen.getByRole('button', { name: 'Outside' }));
    await vi.waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(calls).toEqual([]);
    expect(sessionIdentity().mode).toBe('authenticated');
  });

  test('the explicit action signs out the captured account and reloads only after success', async () => {
    const user = userEvent.setup();
    draw(<AccountControl who="ada@example.org" />);
    screen.getByRole('button', { name: 'Account: ada@example.org' }).focus();
    await user.keyboard('{ArrowDown}');
    await vi.waitFor(() => expect(screen.getByRole('menuitem', { name: 'Sign out' })).toHaveFocus());
    await user.keyboard('{Enter}');
    expect(calls).toEqual([{ path: '/api/auth/sign-out', body: {} }]);
    const init = vi.mocked(fetch).mock.calls[0][1];
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin' });
    expect(new Headers(init?.headers).get('x-mistri-account')).toBe('account-ada');
    expect(sessionIdentity().mode).toBe('locked');
    await vi.waitFor(() => expect(window.location.reload).toHaveBeenCalled());
  });

  test('locks before dispatch and blocks double/reentrant sign-out while awaiting acknowledgment', async () => {
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const fetcher = vi.fn(() => {
      expect(sessionIdentity().mode).toBe('locked');
      expect(screen.getByRole('button', { name: 'Reload' })).toBeDisabled();
      return pending;
    });
    vi.stubGlobal('fetch', fetcher);
    const user = userEvent.setup();
    draw(<AccountControl who="Ada" />);
    await user.click(screen.getByRole('button', { name: 'Account: Ada' }));
    const item = screen.getByRole('menuitem', { name: 'Sign out' });
    const lock = vi.fn(() => {
      lockSurface();
      fireEvent.click(item);
    });
    configureSessionLifecycle({ onLock: lock });
    fireEvent.click(item);
    fireEvent.click(item);
    expect(lock).toHaveBeenCalledExactlyOnceWith('signed-out');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(window.location.reload).not.toHaveBeenCalled();
    await act(async () => {
      finish(new Response('{}'));
    });
    expect(window.location.reload).toHaveBeenCalledTimes(1);
  });

  test.each(['network', 'timeout', 'http'])('%s failure stays locked and uncertain without blind retry or reload', async (failure) => {
    configureSessionLifecycle({
      onLock: () => {
        lockSurface();
      },
    });
    const fetcher = vi.fn(async () => {
      if (failure === 'http') return new Response('{}', { status: 503 });
      throw failure === 'timeout' ? new DOMException('Timed out', 'TimeoutError') : new Error('Connection lost');
    });
    vi.stubGlobal('fetch', fetcher);
    const user = userEvent.setup();
    draw(<AccountControl who="Ada" />);
    const trigger = screen.getByRole('button', { name: 'Account: Ada' });
    await user.click(trigger);
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    expect(screen.getByRole('heading')).toHaveTextContent('Sign-out could not be confirmed');
    expect(screen.getByRole('button', { name: 'Reload' })).toBeEnabled();
    expect(sessionIdentity().mode).toBe('locked');
    // Production unmounts this control on lock; even a retained handler cannot retry.
    await user.click(trigger);
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(window.location.reload).not.toHaveBeenCalled();
  });

  test('an old menu cannot sign out a newly established account', async () => {
    const user = userEvent.setup();
    draw(<AccountControl who="Ada" />);
    await user.click(screen.getByRole('button', { name: 'Account: Ada' }));
    establishSessionIdentity({ signedIn: true, accountId: 'account-bob', appId: 'crm' });
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    expect(calls).toEqual([]);
    expect(sessionIdentity().accountId).toBe('account-bob');
  });

  test('a parent rerender cannot transfer an old-label menu to a newly established account', async () => {
    const user = userEvent.setup();
    const tree = render(<AccountControl who="Ada" />);
    establishSessionIdentity({ signedIn: true, accountId: 'account-bob', appId: 'crm' });
    tree.rerender(<AccountControl who="Ada" />);
    await user.click(screen.getByRole('button', { name: 'Account: Ada' }));
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    expect(calls).toEqual([]);
    expect(sessionIdentity().accountId).toBe('account-bob');
  });

  test.each([
    ['success', 'authenticated'],
    ['failure', 'authenticated'],
    ['success', 'locked'],
    ['failure', 'locked'],
  ])('late %s from A cannot affect B after B becomes %s', async (outcome, mode) => {
    let finish!: (response: Response) => void;
    let fail!: (error: Error) => void;
    const pending = new Promise<Response>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    const fetcher = vi.fn(() => pending);
    vi.stubGlobal('fetch', fetcher);
    configureSessionLifecycle({
      onLock: () => {
        lockSurface();
      },
    });
    const user = userEvent.setup();
    const tree = draw(<AccountControl who="Ada" />);
    await user.click(screen.getByRole('button', { name: 'Account: Ada' }));
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    tree.unmount();
    const originalLock = screen.getByRole('heading');
    const originalReload = screen.getByRole('button', { name: 'Reload' });
    expect(originalReload).toBeDisabled();
    document.getElementById('session-lock')!.remove();
    establishSessionIdentity({ signedIn: true, accountId: 'account-bob', appId: 'crm' });
    if (mode === 'locked') {
      beginSessionSignOut();
      screen.getByRole('heading').textContent = 'B session lock';
      screen.getByRole('button', { name: 'Reload' }).setAttribute('disabled', '');
    }
    const current = sessionIdentity();
    const notice = localStorage.getItem(SESSION_CHANGE_KEY);
    await act(async () => {
      if (outcome === 'success') finish(new Response('{}'));
      else fail(new Error('Lost A acknowledgment'));
    });
    expect(sessionIdentity()).toBe(current);
    expect(localStorage.getItem(SESSION_CHANGE_KEY)).toBe(notice);
    expect(window.location.reload).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(originalLock).toHaveTextContent('Signed out');
    expect(originalReload).toBeDisabled();
    if (mode === 'locked') {
      expect(screen.getByRole('heading')).toHaveTextContent('B session lock');
      expect(screen.getByRole('button', { name: 'Reload' })).toBeDisabled();
    } else {
      expect(screen.queryByRole('heading')).toBeNull();
    }
  });

  test('an uncertain response updates the lock after the private UI has unmounted', async () => {
    let fail!: (error: Error) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((_resolve, reject) => {
            fail = reject;
          }),
      ),
    );
    const user = userEvent.setup();
    const tree = draw(<AccountControl who="Ada" />);
    configureSessionLifecycle({
      onLock: () => {
        lockSurface();
      },
    });
    await user.click(screen.getByRole('button', { name: 'Account: Ada' }));
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    tree.unmount();
    expect(screen.queryByRole('menu')).toBeNull();
    await act(async () => {
      fail(new Error('Lost acknowledgment'));
    });
    expect(screen.getByRole('heading')).toHaveTextContent('Sign-out could not be confirmed');
    expect(window.location.reload).not.toHaveBeenCalled();
  });
});

test("a saved form's account screen opens the door on creating an account where anyone may, with why it is here", () => {
  // An address of its own: an earlier test's reset link leaves its words in the stub's search.
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, search: '', reload: vi.fn(), href: 'http://app.test/crm/form/apply/claim' },
  });
  draw(<SignIn info={info} start="up" lead="Sign in to add the application you just submitted to your account." />);
  expect(screen.getByRole('heading', { name: 'Create your Compass CRM account' })).toBeInTheDocument();
  expect(screen.getByText('Sign in to add the application you just submitted to your account.')).toBeInTheDocument();
  cleanup();
  // An App that only invites people has no sign-up to open on.
  draw(<SignIn info={{ ...info, signUp: 'invite' }} start="up" />);
  expect(screen.getByRole('heading', { name: 'Sign in to Compass CRM' })).toBeInTheDocument();
});
