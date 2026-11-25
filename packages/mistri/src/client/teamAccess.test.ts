/* The team as the administration and invitation routes tell it: what an account is granted decides what it is shown
   and can do, and each action is the exact intent those routes take (versions, ids, terms). */
import { beforeEach, expect, test, vi } from 'vitest';

const owner = { mode: 'authenticated', accountId: 'eve', appId: 'desk', epoch: 1, tenant: { tenantId: 'north' } };
const identity = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('@mistriwork/kit/client/sessionIdentity.js', () => ({ captureAccountIdentity: () => identity.current }));
const admin = vi.hoisted(() => ({
  openAdministration: vi.fn(),
  listAdministrationTenants: vi.fn(),
  listAdministrationMemberships: vi.fn(),
  executeAdministration: vi.fn(),
}));
const invites = vi.hoisted(() => ({
  openInvitationIssuer: vi.fn(),
  listInvitationTargets: vi.fn(),
  listInvitations: vi.fn(),
  executeInvitation: vi.fn(),
}));
const core = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@mistriwork/kit/client/core.js', () => core);
vi.mock('./tenantAdministration.js', () => admin);
vi.mock('./tenantInvitations.js', () => invites);
const { createTeamAccess } = await import('./teamAccess.js');

const tenant = { tenantId: 'north', status: 'active', version: '7' };
const member = (id: string, accountId: string, extra = {}) => ({
  membershipId: id,
  tenantId: 'north',
  accountId,
  status: 'active',
  version: '3',
  roles: ['reader'],
  validUntil: 99,
  ...extra,
});
const pair = {
  email: 'new@example.test',
  invitation: { invitationId: 'inv-1', version: '2', roles: ['reader'], redeemUntil: 50, validUntil: 99, status: 'pending' },
  membership: { membershipId: 'mem-9', version: '4' },
};

beforeEach(() => {
  vi.clearAllMocks();
  identity.current = owner;
  /* The members' own read of who is on the team, as the tenant host answers it (tenantTeamRoute.ts). */
  core.api.mockResolvedValue({
    members: [
      { id: 'mem-1', account: 'eve', name: 'Eve Adams', you: true },
      { id: 'mem-2', account: 'bo', name: 'Bo', you: false },
      { id: 'mem-3', account: 'nameless', name: '', you: false },
    ],
  });
  admin.openAdministration.mockResolvedValue({ context: 'c', expiresAt: Date.now() + 600_000, maxMembershipLifetimeMs: 1e9 });
  admin.listAdministrationTenants.mockResolvedValue({
    items: [
      {
        tenantId: 'north',
        capabilities: [
          { operation: 'replaceMembership', roles: ['reader', 'admin'] },
          { operation: 'revokeMembership', roles: ['reader', 'admin'] },
        ],
      },
    ],
    next: null,
  });
  admin.listAdministrationMemberships.mockResolvedValue({
    tenant,
    items: [member('mem-1', 'eve', { name: 'Eve', email: 'eve@example.test', roles: ['admin'] }), member('mem-2', 'bo', { name: 'Bo' })],
    next: null,
  });
  admin.executeAdministration.mockResolvedValue({});
  invites.openInvitationIssuer.mockResolvedValue({
    context: 'i',
    expiresAt: Date.now() + 600_000,
    maxMembershipLifetimeMs: 1e9,
    maxRedemptionLifetimeMs: 60_000,
    maxPendingPerTenant: 5,
  });
  invites.listInvitationTargets.mockResolvedValue({
    items: [
      {
        tenantId: 'north',
        tenant,
        capabilities: [
          { operation: 'issueInvitation', roles: ['reader'] },
          { operation: 'revokeInvitation', roles: ['reader'] },
          { operation: 'reissueInvitation', roles: ['reader'] },
        ],
      },
    ],
    next: null,
  });
  invites.listInvitations.mockResolvedValue({ tenant, items: [pair], next: null });
  invites.executeInvitation.mockResolvedValue({ result: {}, token: 'tok' });
});

test('it lists members and invitations, marks the reader, and says they may manage', async () => {
  const read = await createTeamAccess().read();
  expect(read.canManage).toBe(true);
  expect([...read.roles].sort()).toEqual(['admin', 'reader']);
  expect(read.read).toBe('administration');
  expect(read.members).toEqual([
    { id: 'mem-1', account: 'eve', name: 'Eve', initials: 'E', email: 'eve@example.test', role: 'admin', you: true },
    { id: 'mem-2', account: 'bo', name: 'Bo', initials: 'B', email: '', role: 'reader', you: false },
  ]);
  // A manager is read the administration's list, never the narrower one in its place.
  expect(core.api).not.toHaveBeenCalled();
  expect(read.invitations).toEqual([{ id: 'inv-1', email: 'new@example.test', role: 'reader', expiresAt: 50 }]);
});

test('an account with no grant on this tenant sees a team it cannot manage', async () => {
  admin.openAdministration.mockResolvedValue(null);
  invites.openInvitationIssuer.mockResolvedValue(null);
  /* A field report: this was an empty team, so a member who is not a manager could not list people to assign work to.
     They are read the members' names now, and nothing the administration's list says beside a name. */
  const read = await createTeamAccess().read();
  expect(core.api).toHaveBeenCalledWith('/api/team', {});
  expect(read).toEqual({
    read: 'names',
    members: [
      { id: 'mem-1', account: 'eve', name: 'Eve Adams', initials: 'EA', email: '', role: '', you: true },
      { id: 'mem-2', account: 'bo', name: 'Bo', initials: 'B', email: '', role: '', you: false },
      { id: 'mem-3', account: 'nameless', name: '', initials: '', email: '', role: '', you: false },
    ],
    invitations: [],
    roles: [],
    canManage: false,
  });
  const team = createTeamAccess();
  await expect(team.remove('mem-2')).rejects.toThrow();
  expect(admin.executeAdministration).not.toHaveBeenCalled();
});

test('the narrow read passes on a name and two ids of each member, whatever else a reply carried', async () => {
  admin.openAdministration.mockResolvedValue(null);
  invites.openInvitationIssuer.mockResolvedValue(null);
  core.api.mockResolvedValue({
    members: [
      { id: 'mem-2', account: 'bo', name: 'Bo', you: false, email: 'bo@example.test', role: 'admin', roles: ['admin'], status: 'active' },
    ],
  });
  const read = await createTeamAccess().read();
  expect(read.members).toEqual([{ id: 'mem-2', account: 'bo', name: 'Bo', initials: 'B', email: '', role: '', you: false }]);
  expect(JSON.stringify(read)).not.toMatch(/bo@example\.test|admin|active/);
});

test('an App that keeps no members read, or a refusal, is no list: the team says so', async () => {
  admin.openAdministration.mockResolvedValue(null);
  invites.openInvitationIssuer.mockResolvedValue(null);
  core.api.mockRejectedValue(Object.assign(new Error('Not found.'), { status: 404 }));
  expect(await createTeamAccess().read()).toEqual({ read: 'none', members: [], invitations: [], roles: [], canManage: false });
});

test('outside a tenant lease nothing is requested', async () => {
  identity.current = { ...owner, tenant: undefined };
  expect((await createTeamAccess().read()).canManage).toBe(false);
  expect(admin.openAdministration).not.toHaveBeenCalled();
  expect(invites.openInvitationIssuer).not.toHaveBeenCalled();
  expect(core.api).not.toHaveBeenCalled();
});

test('each action is the intent the routes take, at the versions just read', async () => {
  const team = createTeamAccess();
  await team.read();
  await team.changeRole('mem-2', 'admin');
  await team.remove('mem-2');
  const [, , first] = admin.executeAdministration.mock.calls[0];
  expect(first.intent).toEqual({
    operation: 'replaceMembership',
    tenantId: 'north',
    expectedTenantVersion: '7',
    membershipId: 'mem-2',
    expectedMembershipVersion: '3',
    roles: ['admin'],
    validUntil: 99,
  });
  expect(admin.executeAdministration.mock.calls[1][2].intent).toMatchObject({ operation: 'revokeMembership', membershipId: 'mem-2' });
  expect(await team.invite(' New@Example.test ', 'reader')).toEqual({ token: 'tok' });
  expect(invites.executeInvitation.mock.calls[0][2].intent).toMatchObject({
    operation: 'issueInvitation',
    tenantId: 'north',
    expectedTenantVersion: '7',
    email: 'new@example.test',
    roles: ['reader'],
  });
  expect(await team.reissue('inv-1')).toEqual({ token: 'tok' });
  expect(invites.executeInvitation.mock.calls[1][2].intent).toMatchObject({
    operation: 'reissueInvitation',
    invitationId: 'inv-1',
    expectedInvitationVersion: '2',
    membershipId: 'mem-9',
    expectedMembershipVersion: '4',
  });
  await team.cancel('inv-1');
  expect(invites.executeInvitation.mock.calls[2][2].intent).toMatchObject({ operation: 'revokeInvitation', invitationId: 'inv-1' });
  await expect(team.changeRole('unknown', 'admin')).rejects.toThrow();
});
