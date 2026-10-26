import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import {
  INVITATION_HTTP_HEADER,
  type InvitationAcceptanceResult,
  type InvitationAttempt,
  type InvitationIssuerSession,
  type InvitationPreview,
  type InvitationRecipientSession,
  type InvitationResult,
  type InvitationTarget,
} from '../../shared/tenantInvitations.js';
import {
  establishSessionIdentity,
  lockSessionIdentity,
  requireTenantSelection,
  sessionIdentity,
} from '../../../../kit/src/client/sessionIdentity.js';
import { hasUnresolvedInvitations, TenantInvitationsController } from '../tenantInvitations.js';
import { TenantInvitations } from './TenantInvitations.js';
import { formatDateTime } from '../../../../kit/src/client/locale.js';

const invitationId = '11111111-1111-4111-8111-111111111111',
  membershipId = '22222222-2222-4222-8222-222222222222';
const token = `twi1.${invitationId}.${'A'.repeat(43)}`,
  revision = '9007199254740993';
let controller: TenantInvitationsController;
let issuer: InvitationIssuerSession, recipient: InvitationRecipientSession, target: InvitationTarget, preview: InvitationPreview;
let executed: Array<InvitationAttempt & { token?: string }>, checks: InvitationAttempt[];
let originalResult: InvitationResult | InvitationAcceptanceResult | null;
let outcome: 'success' | 'lost' | 'absent' | 'refused';
let fetcher: ReturnType<typeof vi.fn>;
const response = (body: unknown, context = issuer.context, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'x-mistri-account': 'operator',
      'x-mistri-app': 'app',
      [INVITATION_HTTP_HEADER]: context,
    },
  });
const localTime = (value: number) => new Date(value - new Date(value).getTimezoneOffset() * 60_000).toISOString().slice(0, 23);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

beforeEach(() => {
  lockSessionIdentity();
  establishSessionIdentity({ signedIn: true, accountId: 'operator', appId: 'app' });
  requireTenantSelection();
  const now = Date.now();
  recipient = { appId: 'app', accountId: 'operator', context: 'recipient-context', expiresAt: now + 300_000 };
  issuer = {
    ...recipient,
    context: 'issuer-context',
    maxMembershipLifetimeMs: 86_400_000,
    maxRedemptionLifetimeMs: 3_600_000,
    maxPendingPerTenant: 100,
  };
  target = {
    tenantId: 'north',
    tenant: { tenantId: 'north', status: 'active', version: revision },
    capabilities: [
      { operation: 'issueInvitation', roles: ['reader'] },
      { operation: 'reissueInvitation', roles: ['editor'] },
    ],
  };
  preview = {
    intent: {
      operation: 'acceptInvitation',
      tenantId: 'north',
      expectedTenantVersion: revision,
      invitationId,
      expectedInvitationVersion: revision,
      membershipId,
      expectedMembershipVersion: revision,
    },
    roles: ['reader', 'auditor'],
    redeemUntil: now + 3_600_000,
    validUntil: now + 86_400_000,
  };
  executed = [];
  checks = [];
  originalResult = null;
  outcome = 'success';
  fetcher = vi.fn(async (path: string, init: RequestInit) => {
    const url = new URL(path, 'http://app.test');
    const route = url.pathname.split('/').pop();
    if (route === 'open-issuer') return response({ session: issuer });
    if (route === 'open-recipient') return response({ session: recipient }, recipient.context);
    if (route === 'targets') return response({ page: { items: [target], next: null } });
    if (route === 'preview') return response({ preview }, recipient.context);
    const captured = JSON.parse(init.body as string) as InvitationAttempt & { token?: string };
    const context = captured.intent.operation === 'acceptInvitation' ? recipient.context : issuer.context;
    if (route === 'status') {
      checks.push(captured);
      if (outcome === 'refused')
        return response({ code: 'tenant_invitation_unavailable', error: 'Unavailable', outcome: 'not_applied' }, context, 403);
      if (outcome === 'absent') return response({ status: 'not_found', outcome: 'unknown', result: null }, context);
      return response({ status: 'completed', outcome: 'applied', result: { ...originalResult, replayed: true } }, context);
    }
    if (route !== 'execute') throw new Error('Unexpected route');
    executed.push(captured);
    const intent = captured.intent,
      receipt = { receiptId: 'receipt', requestId: 'request', completedAt: new Date().toISOString(), replayed: false };
    if (intent.operation === 'acceptInvitation')
      originalResult = {
        ...receipt,
        invitationId,
        tenantId: 'north',
        membershipId,
        membershipVersion: '9007199254740994',
        roles: preview.roles,
        validUntil: preview.validUntil,
        status: 'accepted',
      };
    else {
      if (intent.operation !== 'issueInvitation' || !('accountId' in intent)) throw new Error('Unexpected issuer operation');
      originalResult = {
        ...receipt,
        change: {
          operation: 'issueInvitation',
          tenant: target.tenant!,
          before: null,
          after: {
            invitation: {
              invitationId,
              membershipId,
              tenantId: 'north',
              accountId: intent.accountId,
              inviterId: 'operator',
              version: '1',
              roles: intent.roles,
              expectedTenantVersion: revision,
              policyId: 'policy',
              policyVersion: 'v1',
              issuanceOperation: 'issueInvitation',
              createdAt: Date.now(),
              redeemUntil: intent.redeemUntil,
              validUntil: intent.validUntil,
              status: 'pending',
            },
            membership: {
              membershipId,
              tenantId: 'north',
              accountId: intent.accountId,
              status: 'invited',
              version: '1',
              roles: intent.roles,
              validUntil: intent.validUntil,
            },
          },
        },
      };
    }
    if (outcome === 'lost') throw new Error('Lost acknowledgement');
    return response({ outcome: 'applied', result: originalResult, ...(intent.operation === 'issueInvitation' ? { token } : {}) }, context);
  });
  vi.stubGlobal('fetch', fetcher);
  controller = new TenantInvitationsController();
});
afterEach(() => {
  cleanup();
  controller.retire();
  lockSessionIdentity();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function draw(mode: 'issuer' | 'recipient' = 'issuer') {
  if (mode === 'issuer') await controller.openIssuer();
  const onClose = vi.fn(),
    tree = render(<TenantInvitations controller={controller} mode={mode} onClose={onClose} />);
  if (mode === 'issuer') await screen.findByRole('button', { name: 'north active' });
  return { user: userEvent.setup(), onClose, tree };
}
async function issueForm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'north active' }));
  await user.click(screen.getByRole('button', { name: 'Issue invitation' }));
  await user.type(screen.getByLabelText('Native account ID'), 'native-recipient');
  await user.click(screen.getByRole('checkbox', { name: 'Reader' }));
}
async function review(mode: 'issuer' | 'recipient', user: ReturnType<typeof userEvent.setup>) {
  if (mode === 'issuer') {
    await issueForm(user);
    await user.click(screen.getByRole('button', { name: 'Review change' }));
  } else {
    await user.type(screen.getByLabelText('Invitation token'), token);
    await user.click(screen.getByRole('button', { name: 'Review invitation' }));
  }
  return screen.findByRole('region', { name: 'Review invitation change' });
}

test('issue requires explicit review with exact native account, role ceiling and frozen absolute terms', async () => {
  const { user } = await draw();
  await issueForm(user);
  expect(screen.queryByRole('checkbox', { name: 'Editor' })).toBeNull();
  const redeemUntil = Date.parse((screen.getByLabelText('Redeem before (local time)') as HTMLInputElement).value);
  const validUntil = Date.parse((screen.getByLabelText('Membership valid until (local time)') as HTMLInputElement).value);
  await user.click(screen.getByRole('button', { name: 'Review change' }));
  const reviewed = screen.getByRole('region', { name: 'Review invitation change' });
  expect(reviewed).toHaveTextContent('native-recipient');
  expect(reviewed).toHaveTextContent(revision);
  expect(executed).toHaveLength(0);
  expect(controller.snapshot().phase).toBe('review');
  await user.click(within(reviewed).getByRole('button', { name: 'Issue invitation' }));
  expect(executed).toHaveLength(1);
  expect(executed[0].intent).toEqual({
    operation: 'issueInvitation',
    tenantId: 'north',
    expectedTenantVersion: revision,
    accountId: 'native-recipient',
    roles: ['reader'],
    redeemUntil,
    validUntil,
  });
  expect(await screen.findByLabelText('One-time invitation token')).toHaveValue(token);
  expect(screen.getByText(/Receipt receipt/)).toBeVisible();
  expect(sessionIdentity().tenant).toBeUndefined();
});

test.each(['account', 'roles', 'past', 'ceiling', 'ordering'] as const)(
  'invalid %s never prepares or executes an invitation',
  async (invalid) => {
    const { user } = await draw();
    await issueForm(user);
    if (invalid === 'account') await user.clear(screen.getByLabelText('Native account ID'));
    if (invalid === 'roles') await user.click(screen.getByRole('checkbox', { name: 'Reader' }));
    if (invalid === 'past')
      fireEvent.change(screen.getByLabelText('Redeem before (local time)'), { target: { value: localTime(Date.now() - 60_000) } });
    if (invalid === 'ceiling')
      fireEvent.change(screen.getByLabelText('Membership valid until (local time)'), { target: { value: '2099-01-01T12:00' } });
    if (invalid === 'ordering')
      fireEvent.change(screen.getByLabelText('Membership valid until (local time)'), { target: { value: localTime(Date.now() + 60_000) } });
    // Bypass native constraint validation to prove the controller also refuses the form.
    fireEvent.submit(screen.getByRole('button', { name: 'Review change' }).closest('form')!);
    expect(screen.getByRole('alert')).toHaveTextContent('Check the exact account ID');
    expect(controller.snapshot().attempt).toBeNull();
    expect(executed).toHaveLength(0);
    expect(screen.queryByRole('region', { name: 'Review invitation change' })).toBeNull();
  },
);

test('recipient review displays server roles and both expiries without exposing the credential or selecting a tenant', async () => {
  const { user } = await draw('recipient');
  const region = await review('recipient', user);
  expect(region).toHaveTextContent('Reader, Auditor');
  expect(region).toHaveTextContent('north');
  expect(region).toHaveTextContent(formatDateTime(preview.redeemUntil));
  expect(region).toHaveTextContent(formatDateTime(preview.validUntil));
  expect(region).toHaveTextContent(revision);
  expect(region).toHaveTextContent(invitationId);
  expect(screen.queryByLabelText('Invitation token')).toBeNull();
  expect(document.body.innerHTML).not.toContain(token);
  expect(JSON.stringify(controller.snapshot())).not.toContain(token);
  expect(executed).toHaveLength(0);
  expect(sessionIdentity().tenant).toBeUndefined();
  await user.click(within(region).getByRole('button', { name: 'Accept invitation' }));
  expect(await screen.findByText(/Receipt receipt/)).toBeVisible();
  expect(executed[0].token).toBe(token);
  expect(screen.queryByLabelText('One-time invitation token')).toBeNull();
  expect(sessionIdentity().tenant).toBeUndefined();
});

test('submitting a recipient token clears the local password immediately while preview remains held', async () => {
  const { user } = await draw('recipient'),
    held = deferred<Response>();
  fetcher.mockImplementationOnce(() => held.promise);
  await user.type(screen.getByLabelText('Invitation token'), token);
  await user.click(screen.getByRole('button', { name: 'Review invitation' }));
  expect(screen.getByLabelText('Invitation token')).toHaveValue('');
  expect(screen.getByLabelText('Invitation token')).toBeDisabled();
  expect(controller.snapshot().attempt).toBeNull();
  await act(async () => {
    held.resolve(response({ session: recipient }, recipient.context));
  });
  await screen.findByRole('region', { name: 'Review invitation change' });
  expect(executed).toHaveLength(0);
});

test('canceling recipient review erases the credential and requires a new token before execution', async () => {
  const { user } = await draw('recipient');
  await review('recipient', user);
  await user.click(screen.getByRole('button', { name: 'Cancel review' }));
  expect(screen.getByLabelText('Invitation token')).toHaveValue('');
  expect(controller.snapshot()).toMatchObject({ attempt: null, preview: null, phase: 'idle' });
  await act(async () => {
    await controller.execute();
  });
  expect(executed).toHaveLength(0);
  expect(document.body.innerHTML).not.toContain(token);
});

test.each(['review', 'handoff'] as const)('ordinary close clears %s secrets and operation state', async (stage) => {
  const mode = stage === 'review' ? 'recipient' : 'issuer';
  const { user, onClose } = await draw(mode);
  await review(mode, user);
  if (stage === 'handoff') {
    await user.click(screen.getByRole('button', { name: 'Issue invitation' }));
    expect(await screen.findByLabelText('One-time invitation token')).toHaveValue(token);
  }
  await user.click(screen.getByRole('button', { name: 'Close' }));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(controller.snapshot()).toMatchObject({ phase: 'idle', attempt: null, preview: null, handoffToken: null, result: null });
  await act(async () => {
    await controller.execute();
  });
  expect(executed).toHaveLength(stage === 'handoff' ? 1 : 0);
});

test('explicit clear-token action removes the handoff but keeps its confirmed receipt', async () => {
  const { user } = await draw();
  await review('issuer', user);
  await user.click(screen.getByRole('button', { name: 'Issue invitation' }));
  await screen.findByLabelText('One-time invitation token');
  await user.click(screen.getByRole('button', { name: 'Clear token' }));
  expect(screen.queryByLabelText('One-time invitation token')).toBeNull();
  expect(screen.getByText(/Receipt receipt/)).toBeVisible();
  expect(controller.snapshot().handoffToken).toBeNull();
});

test.each(['issuer', 'recipient'] as const)(
  '%s unknown blocks close/Escape; missing and denied status retain the secret-free exact attempt',
  async (mode) => {
    const { user, onClose } = await draw(mode);
    await review(mode, user);
    outcome = 'lost';
    const attempt = controller.snapshot().attempt;
    await user.click(screen.getByRole('button', { name: mode === 'issuer' ? 'Issue invitation' : 'Accept invitation' }));
    await screen.findByRole('button', { name: 'Check attempt status' });
    expect(hasUnresolvedInvitations()).toBe(true);
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Close invitations' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Cancel review' })).toBeNull();
    expect(screen.queryByLabelText('Invitation token')).toBeNull();
    outcome = 'absent';
    await user.click(screen.getByRole('button', { name: 'Check attempt status' }));
    expect(screen.getByRole('alert')).toHaveTextContent('No receipt was found');
    outcome = 'refused';
    await user.click(screen.getByRole('button', { name: 'Check attempt status' }));
    expect(screen.getByRole('alert')).toHaveTextContent('remains unconfirmed');
    expect(controller.snapshot().attempt).toBe(attempt);
    expect(executed).toHaveLength(1);
    expect(checks).toEqual([attempt, attempt]);
    expect(JSON.stringify(checks)).not.toContain(token);
    outcome = 'success';
    await user.click(screen.getByRole('button', { name: 'Check attempt status' }));
    expect(await screen.findByText(/Receipt receipt/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Close' })).toBeEnabled();
    expect(hasUnresolvedInvitations()).toBe(false);
    expect(screen.queryByLabelText('One-time invitation token')).toBeNull();
    if (mode === 'issuer') expect(screen.getByText(/original token cannot be recovered/)).toHaveTextContent('explicitly reissue');
    expect(document.body.innerHTML).not.toContain(token);
    for (const [url, init] of fetcher.mock.calls.filter(([url]) => url.includes('/status?'))) {
      expect(url).not.toContain(token);
      expect(JSON.parse(init.body)).toEqual(attempt);
      expect(init.headers).toEqual({
        'x-mistri-account': 'operator',
        'x-mistri-app': 'app',
        [INVITATION_HTTP_HEADER]: mode === 'issuer' ? issuer.context : recipient.context,
        'content-type': 'application/json',
      });
    }
  },
);

test.each(['issuer', 'recipient'] as const)(
  '%s expiry requires an explicit context refresh and preserves the unknown attempt',
  async (mode) => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { user, tree, onClose } = await draw(mode);
    await review(mode, user);
    outcome = 'lost';
    await user.click(screen.getByRole('button', { name: mode === 'issuer' ? 'Issue invitation' : 'Accept invitation' }));
    const attempt = controller.snapshot().attempt,
      count = fetcher.mock.calls.length;
    now += 300_001;
    tree.rerender(<TenantInvitations controller={controller} mode={mode} onClose={onClose} />);
    expect(screen.getByRole('button', { name: 'Check attempt status' })).toBeDisabled();
    expect(fetcher).toHaveBeenCalledTimes(count);
    if (mode === 'issuer') issuer = { ...issuer, context: 'fresh-issuer', expiresAt: now + 300_000 };
    else recipient = { ...recipient, context: 'fresh-recipient', expiresAt: now + 300_000 };
    await user.click(screen.getByRole('button', { name: 'Refresh invitation access' }));
    expect(controller.snapshot().attempt).toBe(attempt);
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
    const [url, init] = fetcher.mock.calls.at(-1)!;
    expect(url).toContain(mode === 'issuer' ? '/open-issuer?' : '/open-recipient?');
    expect(JSON.parse(init.body)).toEqual(mode === 'issuer' ? {} : { invitationId });
    outcome = 'success';
    await user.click(screen.getByRole('button', { name: 'Check attempt status' }));
    expect(checks).toEqual([attempt]);
    expect(executed).toHaveLength(1);
    expect(fetcher.mock.calls.at(-1)![1].headers[INVITATION_HTTP_HEADER]).toBe(mode === 'issuer' ? issuer.context : recipient.context);
  },
);

test('native account retirement removes review DOM and prevents a held acceptance from repainting a receipt', async () => {
  const { user } = await draw('recipient');
  await review('recipient', user);
  const held = deferred<Response>();
  fetcher.mockImplementationOnce(() => held.promise);
  await user.click(screen.getByRole('button', { name: 'Accept invitation' }));
  expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
  await act(async () => {
    lockSessionIdentity();
    establishSessionIdentity({ signedIn: true, accountId: 'operator', appId: 'app' });
  });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.body.textContent).not.toContain(invitationId);
  await act(async () => {
    held.resolve(
      response(
        {
          outcome: 'applied',
          result: {
            receiptId: 'late',
            requestId: 'request',
            completedAt: new Date().toISOString(),
            replayed: false,
            invitationId,
            tenantId: 'north',
            membershipId,
            membershipVersion: '9007199254740994',
            roles: preview.roles,
            validUntil: preview.validUntil,
            status: 'accepted',
          },
        },
        recipient.context,
      ),
    );
  });
  expect(screen.queryByText(/Receipt/)).toBeNull();
  expect(hasUnresolvedInvitations()).toBe(false);
  expect(controller.snapshot().attempt).toBeNull();
});

test('native lock removes a confirmed handoff from the DOM and controller memory', async () => {
  const { user } = await draw();
  await review('issuer', user);
  await user.click(screen.getByRole('button', { name: 'Issue invitation' }));
  await screen.findByLabelText('One-time invitation token');
  await act(async () => {
    lockSessionIdentity();
  });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.body.innerHTML).not.toContain(token);
  expect(controller.snapshot()).toMatchObject({ handoffToken: null, result: null });
});

test('closing a held recipient review clears its token and prevents late review DOM', async () => {
  const { user, onClose, tree } = await draw('recipient'),
    held = deferred<Response>();
  fetcher.mockImplementationOnce(() => held.promise);
  await user.type(screen.getByLabelText('Invitation token'), token);
  await user.click(screen.getByRole('button', { name: 'Review invitation' }));
  await user.click(screen.getByRole('button', { name: 'Close' }));
  expect(onClose).toHaveBeenCalledTimes(1);
  tree.unmount();
  await act(async () => {
    held.resolve(response({ session: recipient }, recipient.context));
  });
  expect(controller.snapshot()).toMatchObject({ phase: 'idle', attempt: null, preview: null, loading: false });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('wrong-account preview is never shown as a review or accepted automatically', async () => {
  const { user } = await draw('recipient');
  fetcher.mockResolvedValueOnce(response({ session: recipient }, recipient.context));
  const foreign = response({ preview }, recipient.context);
  foreign.headers.set('x-mistri-account', 'foreign');
  fetcher.mockResolvedValueOnce(foreign);
  await user.type(screen.getByLabelText('Invitation token'), token);
  await user.click(screen.getByRole('button', { name: 'Review invitation' }));
  await waitFor(() => expect(screen.getByText(/invitation could not be reviewed/)).toBeVisible());
  expect(screen.queryByRole('region', { name: 'Review invitation change' })).toBeNull();
  expect(screen.getByLabelText('Invitation token')).toHaveValue('');
  expect(executed).toHaveLength(0);
});

test('a target tenant is said by its name where the server gave one; the invitation still names the id', async () => {
  target = { ...target, name: 'North Motors' };
  await controller.openIssuer();
  render(<TenantInvitations controller={controller} mode="issuer" onClose={vi.fn()} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'North Motors active' }));
  expect(screen.getByRole('heading', { name: 'North Motors' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Issue invitation' }));
  await user.type(screen.getByLabelText('Native account ID'), 'native-recipient');
  await user.click(screen.getByRole('checkbox', { name: 'Reader' }));
  await user.click(screen.getByRole('button', { name: 'Review change' }));
  const reviewed = screen.getByRole('region', { name: 'Review invitation change' });
  expect(reviewed).toHaveTextContent('North Motors');
  expect(reviewed).toHaveTextContent('Reader');
  await user.click(within(reviewed).getByRole('button', { name: 'Issue invitation' }));
  expect(executed[0].intent).toMatchObject({ operation: 'issueInvitation', tenantId: 'north', roles: ['reader'] });
});
