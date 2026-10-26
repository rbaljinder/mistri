import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type {
  AdministrationAttempt,
  AdministrationDecisionUsageRow,
  AdministrationMembershipImage,
  AdministrationResult,
  AdministrationSession,
  AdministrationTenantTarget,
  AdministrationUsageRow,
} from '../../shared/tenantAdministration.js';
import { establishSessionIdentity, lockSessionIdentity, requireTenantSelection } from '../../../../kit/src/client/sessionIdentity.js';
import { hasUnresolvedAdministration, TenantAdministrationController } from '../tenantAdministration.js';
import { TenantAdministration } from './TenantAdministration.js';

let controller: TenantAdministrationController;
let session: AdministrationSession;
let targets: AdministrationTenantTarget[];
let executed: AdministrationAttempt[];
let checks: AdministrationAttempt[];
let mode: 'success' | 'lost' | 'absent' | 'refused';
let originalResult: AdministrationResult | null;
let member: AdministrationMembershipImage;
let fetcher: ReturnType<typeof vi.fn>;
let usage: AdministrationUsageRow[] | undefined;
let decisionUsage: AdministrationDecisionUsageRow[] | undefined;
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'x-mistri-account': 'operator', 'x-mistri-app': 'app', 'x-mistri-administration-context': session.context },
  });

beforeEach(async () => {
  lockSessionIdentity();
  establishSessionIdentity({ signedIn: true, accountId: 'operator', appId: 'app' });
  requireTenantSelection();
  session = {
    accountId: 'operator',
    appId: 'app',
    context: 'context',
    expiresAt: Date.now() + 300_000,
    maxMembershipLifetimeMs: 86_400_000,
  };
  targets = [
    { tenantId: 'new', tenant: null, capabilities: [{ operation: 'createTenant', roles: [] }] },
    {
      tenantId: 'north',
      tenant: { tenantId: 'north', status: 'active', version: '9007199254740993' },
      capabilities: [
        { operation: 'setTenantStatus', roles: [] },
        { operation: 'grantMembership', roles: ['reader'] },
        { operation: 'replaceMembership', roles: ['editor'] },
        { operation: 'revokeMembership', roles: ['auditor'] },
      ],
    },
  ];
  member = {
    membershipId: 'member-id',
    tenantId: 'north',
    accountId: 'native-member',
    status: 'active',
    version: '21',
    roles: ['editor'],
    validUntil: Date.now() + 3_600_000,
  };
  usage = undefined;
  decisionUsage = undefined;
  executed = [];
  checks = [];
  mode = 'success';
  originalResult = null;
  fetcher = vi.fn(async (path: string, init: RequestInit) => {
    const url = new URL(path, 'http://app.test');
    if (url.pathname.endsWith('/open')) return response({ session });
    if (url.pathname.endsWith('/tenants'))
      return response({
        page: { items: targets, next: null, ...(usage ? { usage: true } : {}), ...(decisionUsage ? { decisionUsage: true } : {}) },
      });
    if (url.pathname.endsWith('/assistant-usage')) return response({ usage: { rows: usage ?? [], truncated: false } });
    if (url.pathname.endsWith('/decision-usage')) return response({ usage: { rows: decisionUsage ?? [], truncated: false } });
    if (url.pathname.endsWith('/memberships')) {
      const operation = url.searchParams.get('operation');
      const roles = operation === 'replaceMembership' ? ['editor'] : ['auditor'];
      return response({ page: { tenant: targets[1].tenant, operation, roles, items: [{ ...member, roles }], next: null } });
    }
    const captured = JSON.parse(init.body as string) as AdministrationAttempt;
    if (url.pathname.endsWith('/status')) {
      checks.push(captured);
      if (mode === 'refused') return response({ outcome: 'not_applied' }, 403);
      if (mode === 'absent') return response({ status: 'not_found', outcome: 'unknown', result: null });
      return response({ status: 'completed', outcome: 'applied', result: { ...originalResult, replayed: true } });
    }
    executed.push(captured);
    const intent = captured.intent,
      target = targets.find((t) => t.tenantId === intent.tenantId)!;
    const before = target.tenant
      ? {
          tenant: target.tenant,
          ...('membershipId' in intent
            ? { membership: { ...member, roles: intent.operation === 'revokeMembership' ? ['auditor'] : member.roles } }
            : {}),
        }
      : null;
    if (intent.operation === 'setTenantAssistant') {
      const assistant = { enabled: intent.enabled, consent: intent.consent };
      originalResult = {
        receiptId: 'receipt',
        requestId: 'request',
        completedAt: new Date().toISOString(),
        replayed: false,
        change: {
          operation: intent.operation,
          before: { tenant: target.tenant!, assistant: target.assistant! },
          after: { tenant: target.tenant!, assistant },
        },
      };
      targets = targets.map((t) => (t === target ? { ...t, assistant } : t));
      return response({ outcome: 'applied', result: originalResult });
    }
    if (intent.operation === 'setTenantDecisions') {
      const decisions = { provider: intent.provider, enabled: intent.enabled, consent: intent.consent };
      originalResult = {
        receiptId: 'receipt',
        requestId: 'request',
        completedAt: new Date().toISOString(),
        replayed: false,
        change: {
          operation: intent.operation,
          before: { tenant: target.tenant!, decisions: target.decisions!.find((d) => d.provider === intent.provider)! },
          after: { tenant: target.tenant!, decisions },
        },
      };
      targets = targets.map((t) =>
        t === target ? { ...t, decisions: t.decisions!.map((d) => (d.provider === intent.provider ? decisions : d)) } : t,
      );
      return response({ outcome: 'applied', result: originalResult });
    }
    const after =
      intent.operation === 'createTenant'
        ? { tenant: { tenantId: intent.tenantId, status: 'active' as const, version: '1' } }
        : intent.operation === 'setTenantStatus'
          ? { tenant: { ...target.tenant!, status: intent.status, version: String(BigInt(target.tenant!.version) + 1n) } }
          : {
              tenant: target.tenant!,
              membership: {
                ...member,
                status: intent.operation === 'revokeMembership' ? ('revoked' as const) : ('active' as const),
                version: intent.operation === 'grantMembership' ? '1' : '22',
                ...('accountId' in intent ? { accountId: intent.accountId } : {}),
                ...('roles' in intent ? { roles: intent.roles, validUntil: intent.validUntil } : { roles: ['auditor'] }),
              },
            };
    originalResult = {
      receiptId: 'receipt',
      requestId: 'request',
      completedAt: new Date().toISOString(),
      replayed: false,
      change: { operation: intent.operation, before, after },
    };
    targets = targets.map((t) => (t === target ? { ...t, tenant: after.tenant } : t));
    if (mode === 'lost') throw new Error('Lost acknowledgement');
    return response({ outcome: 'applied', result: originalResult });
  });
  vi.stubGlobal('fetch', fetcher);
  controller = new TenantAdministrationController();
  await controller.open();
});
afterEach(() => {
  cleanup();
  controller.retire();
  lockSessionIdentity();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function draw() {
  const onClose = vi.fn();
  const tree = render(<TenantAdministration controller={controller} onClose={onClose} />);
  await screen.findByRole('button', { name: 'north active' });
  return { user: userEvent.setup(), onClose, tree };
}

test('zero-business-membership operator creates an authorized tenant from the shared modal', async () => {
  const { user } = await draw();
  expect(screen.getByRole('dialog', { name: 'Manage tenants' })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'new Not created' }));
  await user.click(screen.getByRole('button', { name: 'Create tenant' }));
  await user.click(screen.getByRole('button', { name: 'Review change' }));
  expect(executed).toHaveLength(0);
  await user.click(screen.getByRole('button', { name: 'Apply change' }));
  expect(executed[0].intent).toEqual({ operation: 'createTenant', tenantId: 'new' });
  await screen.findByRole('button', { name: 'new active' });
});

test.each(['suspended', 'closed'] as const)('tenant status %s freezes its decimal version and requires review', async (status) => {
  const { user } = await draw();
  await user.click(screen.getByRole('button', { name: 'north active' }));
  await user.click(screen.getByRole('button', { name: 'Change tenant status' }));
  await user.click(screen.getByLabelText(status));
  await user.click(screen.getByRole('button', { name: 'Review change' }));
  expect(executed).toHaveLength(0);
  if (status === 'closed') expect(screen.getByText(/Closing a tenant is permanent/)).toBeVisible();
  await user.click(screen.getByRole('button', { name: status === 'closed' ? 'Confirm change tenant status' : 'Apply change' }));
  expect(executed[0].intent).toEqual({
    operation: 'setTenantStatus',
    tenantId: 'north',
    expectedTenantVersion: '9007199254740993',
    status,
  });
  await screen.findByRole('button', { name: `north ${status}` });
});

test('grant accepts an exact native ID and only its operation’s roles, preserving edits across review', async () => {
  const { user } = await draw();
  await user.click(screen.getByRole('button', { name: 'north active' }));
  await user.click(screen.getByRole('button', { name: 'Grant membership' }));
  expect(screen.queryByRole('checkbox', { name: 'Auditor' })).toBeNull();
  expect(screen.queryByRole('checkbox', { name: 'Editor' })).toBeNull();
  await user.type(screen.getByLabelText('Native account ID'), 'native-id-not-email');
  await user.click(screen.getByRole('checkbox', { name: 'Reader' }));
  const validUntil = Date.parse((screen.getByLabelText('Valid until (local time)') as HTMLInputElement).value);
  await user.click(screen.getByRole('button', { name: 'Review change' }));
  await user.click(screen.getByRole('button', { name: 'Back to edit' }));
  expect(screen.getByLabelText('Native account ID')).toHaveValue('native-id-not-email');
  await user.click(screen.getByRole('button', { name: 'Review change' }));
  await user.click(screen.getByRole('button', { name: 'Apply change' }));
  expect(executed[0].intent).toEqual({
    operation: 'grantMembership',
    tenantId: 'north',
    expectedTenantVersion: '9007199254740993',
    accountId: 'native-id-not-email',
    roles: ['reader'],
    validUntil,
  });
});

test.each(['Replace membership', 'Revoke membership'])('%s lists only its own ceiling and freezes both versions', async (label) => {
  const { user } = await draw();
  await user.click(screen.getByRole('button', { name: 'north active' }));
  await user.click(screen.getByRole('button', { name: label }));
  await user.click(await screen.findByRole('button', { name: /native-member member-id/ }));
  if (label === 'Replace membership') {
    expect(screen.getByRole('checkbox', { name: 'Editor' })).toBeChecked();
    expect(screen.queryByRole('checkbox', { name: 'Auditor' })).toBeNull();
  }
  await user.click(screen.getByRole('button', { name: 'Review change' }));
  expect(executed).toHaveLength(0);
  if (label === 'Revoke membership') expect(screen.getByText(/Revocation is permanent/)).toBeVisible();
  await user.click(screen.getByRole('button', { name: label === 'Revoke membership' ? 'Confirm revoke membership' : 'Apply change' }));
  expect(executed[0].intent).toMatchObject({
    operation: label === 'Revoke membership' ? 'revokeMembership' : 'replaceMembership',
    expectedTenantVersion: '9007199254740993',
    membershipId: 'member-id',
    expectedMembershipVersion: '21',
  });
  expect(fetcher.mock.calls.find(([url]) => url.includes('/memberships?'))![0]).toContain(`operation=${executed[0].intent.operation}`);
});

test('unknown locks Escape, close and navigation; absent/refused status retains the attempt until historical confirmation', async () => {
  const { user, onClose } = await draw();
  mode = 'lost';
  await user.click(screen.getByRole('button', { name: 'new Not created' }));
  await user.click(screen.getByRole('button', { name: 'Create tenant' }));
  await user.click(screen.getByRole('button', { name: 'Review change' }));
  await user.click(screen.getByRole('button', { name: 'Apply change' }));
  await screen.findByRole('button', { name: 'Check attempt status' });
  expect(hasUnresolvedAdministration()).toBe(true);
  expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
  await user.keyboard('{Escape}');
  expect(onClose).not.toHaveBeenCalled();
  mode = 'absent';
  await user.click(screen.getByRole('button', { name: 'Check attempt status' }));
  expect(screen.getByRole('alert')).toHaveTextContent('No receipt was found');
  mode = 'refused';
  await user.click(screen.getByRole('button', { name: 'Check attempt status' }));
  expect(screen.getByRole('alert')).toHaveTextContent('remains unconfirmed');
  expect(executed).toHaveLength(1);
  expect(checks).toEqual([executed[0], executed[0]]);
  mode = 'success';
  targets[0] = { ...targets[0], tenant: { tenantId: 'new', status: 'closed', version: '3' } };
  await user.click(screen.getByRole('button', { name: 'Check attempt status' }));
  await screen.findByRole('button', { name: 'new closed' });
  expect(hasUnresolvedAdministration()).toBe(false);
  expect(screen.getByRole('button', { name: 'Close' })).toBeEnabled();
});

test('expiry requires an explicit fresh context and keeps the exact unknown attempt', async () => {
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const { user, tree } = await draw();
  mode = 'lost';
  await user.click(screen.getByRole('button', { name: 'new Not created' }));
  await user.click(screen.getByRole('button', { name: 'Create tenant' }));
  await user.click(screen.getByRole('button', { name: 'Review change' }));
  await user.click(screen.getByRole('button', { name: 'Apply change' }));
  const captured = controller.snapshot().attempt;
  now += 300_001;
  tree.rerender(<TenantAdministration controller={controller} onClose={() => {}} />);
  expect(fetcher.mock.calls.filter(([url]) => url.includes('/open?'))).toHaveLength(1);
  session = { ...session, context: 'fresh', expiresAt: now + 300_000 };
  await user.click(screen.getByRole('button', { name: 'Refresh administration access' }));
  expect(controller.snapshot().attempt).toBe(captured);
  expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
  mode = 'success';
  await user.click(screen.getByRole('button', { name: 'Check attempt status' }));
  expect(checks).toEqual(executed);
});

test('pending success cannot paint after the native UI owner is retired', async () => {
  const { user } = await draw();
  let resolve!: (response: Response) => void;
  await user.click(screen.getByRole('button', { name: 'new Not created' }));
  await user.click(screen.getByRole('button', { name: 'Create tenant' }));
  await user.click(screen.getByRole('button', { name: 'Review change' }));
  fetcher.mockImplementationOnce(
    () =>
      new Promise<Response>((yes) => {
        resolve = yes;
      }),
  );
  await user.click(screen.getByRole('button', { name: 'Apply change' }));
  expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
  await act(async () => {
    lockSessionIdentity();
    establishSessionIdentity({ signedIn: true, accountId: 'operator', appId: 'app' });
  });
  expect(screen.queryByRole('dialog')).toBeNull();
  await act(async () => {
    resolve(response({ outcome: 'applied', result: originalResult }));
  });
  expect(screen.queryByText(/Receipt/)).toBeNull();
  expect(hasUnresolvedAdministration()).toBe(false);
});

test('tenant and membership pages are bounded and switching operation discards a held previous page', async () => {
  const { user } = await draw();
  await user.click(screen.getByRole('button', { name: 'north active' }));
  let resolve!: (value: Response) => void;
  fetcher.mockImplementationOnce(
    () =>
      new Promise<Response>((yes) => {
        resolve = yes;
      }),
  );
  await user.click(screen.getByRole('button', { name: 'Replace membership' }));
  await user.click(screen.getByRole('button', { name: 'Revoke membership' }));
  await screen.findByRole('button', { name: /Auditor/ });
  await act(async () => {
    resolve(
      response({
        page: { tenant: targets[1].tenant, operation: 'replaceMembership', roles: ['editor'], items: [member], next: 'member-id' },
      }),
    );
  });
  expect(screen.queryByRole('button', { name: /Editor/ })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Next memberships' })).toBeNull();
  fetcher.mockResolvedValueOnce(response({ page: { items: [targets[0]], next: 'new' } }));
  await user.click(screen.getByRole('button', { name: 'Refresh tenants' }));
  await user.click(await screen.findByRole('button', { name: 'Next tenants' }));
  await waitFor(() => expect(fetcher.mock.calls.at(-1)![0]).toContain('limit=20&after=new'));
});

test('a maximum-lifetime violation never dispatches a grant', async () => {
  const { user } = await draw();
  await user.click(screen.getByRole('button', { name: 'north active' }));
  await user.click(screen.getByRole('button', { name: 'Grant membership' }));
  await user.type(screen.getByLabelText('Native account ID'), 'native-id');
  await user.click(screen.getByRole('checkbox', { name: 'Reader' }));
  fireEvent.change(screen.getByLabelText('Valid until (local time)'), { target: { value: '2099-01-01T12:00' } });
  fireEvent.submit(screen.getByRole('button', { name: 'Review change' }).closest('form')!);
  expect(screen.getByRole('alert')).toHaveTextContent('maximum lifetime');
  expect(executed).toHaveLength(0);
});

test('a tenant is said by its name where the server gave one, and roles as words; the request still names the id', async () => {
  targets = targets.map((t) => (t.tenantId === 'north' ? { ...t, name: 'North Motors' } : t));
  render(<TenantAdministration controller={controller} onClose={vi.fn()} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'North Motors active' }));
  expect(screen.getByRole('heading', { name: 'North Motors' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Grant membership' }));
  await user.type(screen.getByLabelText('Native account ID'), 'native-id');
  await user.click(screen.getByRole('checkbox', { name: 'Reader' }));
  await user.click(screen.getByRole('button', { name: 'Review change' }));
  const review = screen.getByRole('region', { name: 'Review tenant change' });
  expect(review).toHaveTextContent('North Motors');
  expect(review).toHaveTextContent('Reader');
  await user.click(screen.getByRole('button', { name: 'Apply change' }));
  expect(executed[0].intent).toMatchObject({ operation: 'grantMembership', tenantId: 'north', roles: ['reader'] });
});

test('the assistant switch names a consent reference to turn on, and the change says what was set', async () => {
  targets[1] = {
    ...targets[1],
    capabilities: [...targets[1].capabilities, { operation: 'setTenantAssistant', roles: [] }],
    assistant: { enabled: false, consent: '' },
  };
  const { user } = await draw();
  await user.click(screen.getByRole('button', { name: /^north active/ }));
  await user.click(screen.getByRole('button', { name: 'Set the assistant' }));
  await user.click(screen.getByLabelText('On'));
  await user.click(screen.getByRole('button', { name: 'Review change' }));
  // On without a consent reference is not a change to review.
  expect(screen.queryByRole('button', { name: 'Apply change' })).toBeNull();
  await user.type(screen.getByRole('textbox', { name: 'Consent reference' }), '  DPA-2026-014 ');
  await user.click(screen.getByRole('button', { name: 'Review change' }));
  expect(screen.getByText('DPA-2026-014')).toBeVisible();
  expect(executed).toHaveLength(0);
  await user.click(screen.getByRole('button', { name: 'Apply change' }));
  expect(executed[0].intent).toEqual({
    operation: 'setTenantAssistant',
    tenantId: 'north',
    expectedTenantVersion: '9007199254740993',
    enabled: true,
    consent: 'DPA-2026-014',
  });
});

test('assistant usage reads by day or by month, and downloads as a CSV whose cells cannot be formulas', async () => {
  usage = [
    { tenantId: 'north', day: '2026-10-08', tokens: 1200 },
    { tenantId: '=south', day: '2026-10-07', tokens: 300 },
    { tenantId: 'north', day: '2026-10-01', tokens: 800 },
  ];
  await controller.loadTenants();
  const { user } = await draw();
  await user.click(screen.getByRole('tab', { name: 'Assistant usage' }));
  const table = await screen.findByRole('table');
  expect(table.querySelectorAll('tbody tr')).toHaveLength(3);
  await user.click(screen.getByRole('button', { name: 'By month' }));
  const months = [...table.querySelectorAll('tbody tr')].map((row) => [...row.querySelectorAll('td')].map((cell) => cell.textContent));
  expect(months).toEqual([
    ['2026-10', 'north', '2,000'],
    ['2026-10', '=south', '300'],
  ]);
  const blobs: Blob[] = [];
  vi.stubGlobal(
    'URL',
    Object.assign(URL, { createObjectURL: (blob: Blob) => (blobs.push(blob), 'blob:usage'), revokeObjectURL: () => {} }),
  );
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  await user.click(screen.getByRole('button', { name: 'Download CSV' }));
  expect(click).toHaveBeenCalledOnce();
  expect((await blobs[0].text()).split('\r\n')).toEqual([
    'tenant_id,tenant,month,tokens',
    'north,north,2026-10,2000',
    `"'=south","'=south",2026-10,300`,
  ]);
});

test('the decisions switch names a provider and a consent reference to turn on, and the change says what was set', async () => {
  targets[1] = {
    ...targets[1],
    capabilities: [...targets[1].capabilities, { operation: 'setTenantDecisions', roles: [] }],
    decisions: [
      { provider: 'anthropic', enabled: false, consent: '' },
      { provider: 'jev', enabled: true, consent: 'DPA-2026-001' },
    ],
  };
  const { user } = await draw();
  await user.click(screen.getByRole('button', { name: /^north active/ }));
  expect(screen.getByText('Decisions with Claude: off')).toBeVisible();
  expect(screen.getByText('Decisions with Jev: on')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Set the decisions' }));
  // Jev is on, so choosing it offers off; Claude is off, so choosing it offers on.
  await user.click(screen.getByLabelText('Claude'));
  await user.click(screen.getByLabelText('On'));
  await user.click(screen.getByRole('button', { name: 'Review change' }));
  // On without a consent reference is not a change to review.
  expect(screen.queryByRole('button', { name: 'Apply change' })).toBeNull();
  await user.type(screen.getByRole('textbox', { name: 'Consent reference' }), '  DPA-2026-014 ');
  await user.click(screen.getByRole('button', { name: 'Review change' }));
  expect(screen.getByText('DPA-2026-014')).toBeVisible();
  expect(executed).toHaveLength(0);
  await user.click(screen.getByRole('button', { name: 'Apply change' }));
  expect(executed[0].intent).toEqual({
    operation: 'setTenantDecisions',
    tenantId: 'north',
    expectedTenantVersion: '9007199254740993',
    provider: 'anthropic',
    enabled: true,
    consent: 'DPA-2026-014',
  });
});

test('decision usage reads by day or by month in dollars, and downloads as a CSV whose cells cannot be formulas', async () => {
  decisionUsage = [
    { tenantId: 'north', day: '2026-10-08', calls: 3, units: 1200, costMicros: 1_500_000 },
    { tenantId: '=south', day: '2026-10-07', calls: 1, units: 300, costMicros: 1250 },
    { tenantId: 'north', day: '2026-10-01', calls: 2, units: 800, costMicros: 500_000 },
  ];
  await controller.loadTenants();
  const { user } = await draw();
  expect(screen.queryByRole('tab', { name: 'Assistant usage' })).toBeNull();
  await user.click(screen.getByRole('tab', { name: 'Decision usage' }));
  const table = await screen.findByRole('table');
  expect(table.querySelectorAll('tbody tr')).toHaveLength(3);
  await user.click(screen.getByRole('button', { name: 'By month' }));
  const months = [...table.querySelectorAll('tbody tr')].map((row) => [...row.querySelectorAll('td')].map((cell) => cell.textContent));
  expect(months).toEqual([
    ['2026-10', 'north', '5', '2,000', '$2.00'],
    ['2026-10', '=south', '1', '300', '$0.0013'],
  ]);
  const blobs: Blob[] = [];
  vi.stubGlobal(
    'URL',
    Object.assign(URL, { createObjectURL: (blob: Blob) => (blobs.push(blob), 'blob:usage'), revokeObjectURL: () => {} }),
  );
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  await user.click(screen.getByRole('button', { name: 'Download CSV' }));
  expect(click).toHaveBeenCalledOnce();
  expect((await blobs[0].text()).split('\r\n')).toEqual([
    'tenant_id,tenant,month,calls,units,cost_usd',
    'north,north,2026-10,5,2000,2',
    `"'=south","'=south",2026-10,1,300,0.00125`,
  ]);
});
