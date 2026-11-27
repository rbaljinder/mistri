/**
 * Regression test using the real (unmocked) sessionIdentity store:
 * `establishTenantSelection()` attaches `.tenant` to `captureSessionIdentity()`,
 * while `captureAccountIdentity()` intentionally keeps the tenant-less root account
 * snapshot. `useReadAudit()` (`createReadAuditAccess`), `useTeam()` (`createTeamAccess`),
 * and `MemberPicker` must all read `captureSessionIdentity()` so they work in real
 * tenant browser sessions and re-fetch on tenant switches (#586 and sibling bugs).
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import {
  captureAccountIdentity,
  captureSessionIdentity,
  establishSessionIdentity,
  establishTenantSelection,
  requireTenantSelection,
} from '@mistriwork/kit/client/sessionIdentity.js';

const core = vi.hoisted(() => ({ api: vi.fn() }));
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
vi.mock('@mistriwork/kit/client/core.js', () => core);
vi.mock('./tenantAdministration.js', () => admin);
vi.mock('./tenantInvitations.js', () => invites);

const { createReadAuditAccess } = await import('./readAuditAccess.js');
const { createTeamAccess } = await import('./teamAccess.js');
const { MemberPicker, forgetTeamNames } = await import('./components/MemberPicker.js');

const selectTenant = (tenantId: string) =>
  establishTenantSelection({
    appId: 'desk',
    accountId: 'eve',
    tenantId,
    tabId: `tab-${tenantId}`,
    context: `ctx-${tenantId}`,
    revision: 1,
    expiresAt: Date.now() + 60_000,
  });

beforeEach(() => {
  vi.clearAllMocks();
  forgetTeamNames();
  establishSessionIdentity({ signedIn: true, accountId: 'eve', appId: 'desk' });
  requireTenantSelection();
  selectTenant('north');
});

afterEach(() => {
  cleanup();
});

test('real tenant selection: captureAccountIdentity has no tenant while readAuditAccess, teamAccess, and MemberPicker see it', async () => {
  // Confirm the invariant that masked the bug in mocked tests:
  expect(captureAccountIdentity().tenant).toBeUndefined();
  expect(captureSessionIdentity().tenant?.tenantId).toBe('north');

  // 1. useReadAudit() / createReadAuditAccess() asks /api/reads
  const auditPage = {
    reads: [{ id: 1, at: '2026-11-27T00:00:00Z', actor: 'eve', resource: 'patient', route: 'page', kind: 'opened', record: '42' }],
    resources: ['patient'],
  };
  core.api.mockResolvedValueOnce(auditPage);
  expect(await createReadAuditAccess().read({ resource: 'patient' })).toBe(auditPage);
  expect(core.api).toHaveBeenCalledWith('/api/reads', { resource: 'patient' });

  // 2. useTeam() / createTeamAccess() asks /api/team for non-admin member
  admin.openAdministration.mockRejectedValueOnce(new Error('not admin'));
  invites.openInvitationIssuer.mockRejectedValueOnce(new Error('not issuer'));
  core.api.mockResolvedValueOnce({
    members: [{ id: 'mem-1', account: 'eve', name: 'Eve North', you: true }],
  });
  const team = await createTeamAccess().read();
  expect(team.read).toBe('names');
  expect(team.members).toHaveLength(1);
  expect(team.members[0]!.name).toBe('Eve North');

  // 3. MemberPicker re-reads /api/team when switching tenants under the same account
  core.api
    .mockResolvedValueOnce({ members: [{ id: 'mem-1', account: 'eve', name: 'Eve North', you: true }] })
    .mockResolvedValueOnce({ members: [{ id: 'mem-2', account: 'sam', name: 'Sam South', you: false }] });
  const view = render(<MemberPicker id="clinician" label="Clinician" value={undefined} onChange={() => {}} />);
  await waitFor(() => expect(core.api).toHaveBeenCalledTimes(3));

  selectTenant('south');
  expect(captureAccountIdentity().tenant).toBeUndefined();
  expect(captureSessionIdentity().tenant?.tenantId).toBe('south');

  view.unmount();
  render(<MemberPicker id="clinician" label="Clinician" value={undefined} onChange={() => {}} />);
  await waitFor(() => expect(core.api).toHaveBeenCalledTimes(4));
});
