/**
 * A tenant's team as a page component asks for it (`useTeam()`): who its members are, which invitations wait, and
 * the five things a manager does with them — over the administration and invitation routes the shell's own
 * account dialogs use (tenantAdministration.ts, tenantInvitations.ts), never a route of its own. Each route
 * answers for the signed-in account's own grant, so what this can do is exactly what those routes allow: an
 * account with no grant on this tenant sees a team it cannot manage (`canManage: false`, nothing listed that the
 * routes would not list it). Nothing here is authority; every request is judged on the server.
 *
 * Outside a tenant App (no tenant lease) the team is empty and nothing is requested.
 */
import { captureAccountIdentity, type SessionIdentitySnapshot } from '@mistriwork/kit/client/sessionIdentity.js';
import type { AdministrationMembershipImage, AdministrationSession, AdministrationTenantImage } from '../shared/tenantAdministration.js';
import type { InvitationIssuerSession, InvitationPair } from '../shared/tenantInvitations.js';
import {
  executeAdministration,
  listAdministrationMemberships,
  listAdministrationTenants,
  openAdministration,
} from './tenantAdministration.js';
import { EMPTY_TEAM, type TeamAccess, type TeamRead } from './teamTypes.js';
import { executeInvitation, listInvitations, listInvitationTargets, openInvitationIssuer } from './tenantInvitations.js';
import { say } from './copy/tenancy/teamAccess.js';

export type { TeamAccess };

const DAY = 86_400_000;
const PAGES = 50;

/** What one load learned and the actions need: the sessions, the tenant's versions and the exact rows. */
interface Held {
  owner: SessionIdentitySnapshot;
  tenantId: string;
  admin: AdministrationSession | null;
  issuer: InvitationIssuerSession | null;
  adminRoles: { replace: readonly string[]; revoke: readonly string[] };
  inviteRoles: { issue: readonly string[]; revoke: readonly string[]; reissue: readonly string[] };
  memberTenant: AdministrationTenantImage | null;
  members: Map<string, AdministrationMembershipImage>;
  inviteTenant: AdministrationTenantImage | null;
  pairs: Map<string, InvitationPair>;
  /** Which list each pair was read from: the operation whose roles bound it and whose tenant version stands. */
  pairTenant: Map<string, AdministrationTenantImage | null>;
}

const fresh = (session: { expiresAt: number } | null) => !!session && session.expiresAt > Date.now() + 5_000;

async function pages<T>(read: (after?: string) => Promise<{ items: readonly T[]; next: string | null }>): Promise<T[]> {
  const all: T[] = [];
  let after: string | undefined;
  for (let page = 0; page < PAGES; page++) {
    const got = await read(after);
    all.push(...got.items);
    if (!got.next) return all;
    after = got.next;
  }
  return all;
}

export function createTeamAccess(): TeamAccess {
  let held: Held | null = null;

  const target = (): { owner: SessionIdentitySnapshot; tenantId: string } | null => {
    const owner = captureAccountIdentity();
    const tenantId = owner.tenant?.tenantId;
    if (owner.mode !== 'authenticated' || !owner.accountId || !owner.appId || !tenantId || owner.tenant?.realm) return null;
    return { owner, tenantId };
  };

  const load = async (): Promise<Held | null> => {
    const at = target();
    if (!at) return (held = null);
    const { owner, tenantId } = at;
    const next: Held = {
      owner,
      tenantId,
      admin: null,
      issuer: null,
      adminRoles: { replace: [], revoke: [] },
      inviteRoles: { issue: [], revoke: [], reissue: [] },
      memberTenant: null,
      members: new Map(),
      inviteTenant: null,
      pairs: new Map(),
      pairTenant: new Map(),
    };
    /* Each door is asked on its own: an account granted one and not the other still sees what that one lets it. */
    try {
      next.admin = await openAdministration(owner);
    } catch {
      next.admin = null;
    }
    if (next.admin) {
      const admin = next.admin;
      const tenants = await pages((after) => listAdministrationTenants(owner, admin, after)).catch(() => []);
      const mine = tenants.find((item) => item.tenantId === tenantId);
      const roles = (operation: string) => mine?.capabilities.find((c) => c.operation === operation)?.roles ?? [];
      next.adminRoles = { replace: roles('replaceMembership'), revoke: roles('revokeMembership') };
      for (const operation of ['replaceMembership', 'revokeMembership'] as const) {
        if (!(operation === 'replaceMembership' ? next.adminRoles.replace : next.adminRoles.revoke).length) continue;
        let tenant: AdministrationTenantImage | null = null;
        const rows = await pages(async (after) => {
          const page = await listAdministrationMemberships(owner, admin, tenantId, operation, after);
          tenant = page.tenant;
          return page;
        }).catch(() => []);
        if (operation === 'replaceMembership' || !next.memberTenant) next.memberTenant = tenant ?? next.memberTenant;
        for (const row of rows) if (!next.members.has(row.membershipId)) next.members.set(row.membershipId, row);
      }
    }
    try {
      next.issuer = await openInvitationIssuer(owner);
    } catch {
      next.issuer = null;
    }
    if (next.issuer) {
      const issuer = next.issuer;
      const targets = await pages((after) => listInvitationTargets(owner, issuer, after)).catch(() => []);
      const mine = targets.find((item) => item.tenantId === tenantId);
      const roles = (operation: string) => mine?.capabilities.find((c) => c.operation === operation)?.roles ?? [];
      next.inviteRoles = { issue: roles('issueInvitation'), revoke: roles('revokeInvitation'), reissue: roles('reissueInvitation') };
      next.inviteTenant = mine?.tenant ?? null;
      for (const operation of ['revokeInvitation', 'reissueInvitation'] as const) {
        if (!(operation === 'revokeInvitation' ? next.inviteRoles.revoke : next.inviteRoles.reissue).length) continue;
        let tenant: AdministrationTenantImage | null = null;
        const rows = await pages(async (after) => {
          const page = await listInvitations(owner, issuer, tenantId, operation, after);
          tenant = page.tenant;
          return page;
        }).catch(() => []);
        for (const row of rows) {
          if (next.pairs.has(row.invitation.invitationId)) continue;
          next.pairs.set(row.invitation.invitationId, row);
          next.pairTenant.set(row.invitation.invitationId, tenant);
        }
      }
    }
    return (held = next);
  };

  const read = async (): Promise<TeamRead> => {
    const now = await load();
    if (!now) return EMPTY_TEAM;
    const roles = [...new Set([...now.adminRoles.replace, ...now.inviteRoles.issue, ...now.adminRoles.revoke, ...now.inviteRoles.reissue])];
    return {
      members: [...now.members.values()]
        .filter((member) => member.status === 'active')
        .map((member) => ({
          id: member.membershipId,
          name: member.name ?? '',
          email: member.email ?? '',
          role: member.roles[0] ?? '',
          you: member.accountId === now.owner.accountId,
        })),
      invitations: [...now.pairs.values()].map((pair) => ({
        id: pair.invitation.invitationId,
        email: pair.email ?? '',
        role: pair.invitation.roles[0] ?? '',
        expiresAt: pair.invitation.redeemUntil,
      })),
      roles,
      canManage:
        now.adminRoles.replace.length + now.adminRoles.revoke.length + now.inviteRoles.issue.length + now.inviteRoles.revoke.length > 0,
    };
  };

  /** The held context, read again when there is none, the account changed or a session ran out. */
  const ready = async (): Promise<Held> => {
    const at = target();
    if (!held || !at || held.owner !== at.owner || (held.admin && !fresh(held.admin)) || (held.issuer && !fresh(held.issuer))) await load();
    if (!held) throw new Error(say('noTeam'));
    return held;
  };

  const key = () => crypto.randomUUID();
  const memberOf = (now: Held, id: string) => {
    const member = now.members.get(id);
    if (!member || !now.admin || !now.memberTenant) throw new Error(say('memberOutOfReach'));
    return { member, admin: now.admin, tenant: now.memberTenant };
  };
  const pairOf = (now: Held, id: string) => {
    const pair = now.pairs.get(id);
    const tenant = now.pairTenant.get(id);
    if (!pair || !now.issuer || !tenant) throw new Error(say('invitationOutOfReach'));
    return { pair, issuer: now.issuer, tenant };
  };
  /** The terms a new invitation holds: redeemable for up to a week, a member for as long as the grant allows (a year at most). */
  const terms = (issuer: InvitationIssuerSession) => {
    const at = Date.now();
    const lifetime = Math.min(issuer.maxMembershipLifetimeMs, 365 * DAY);
    return { validUntil: at + lifetime, redeemUntil: at + Math.min(issuer.maxRedemptionLifetimeMs, lifetime, 7 * DAY) };
  };

  return {
    read,
    async changeRole(memberId, role) {
      const { member, admin, tenant } = memberOf(await ready(), memberId);
      await executeAdministration(held!.owner, admin, {
        idempotencyKey: key(),
        intent: {
          operation: 'replaceMembership',
          tenantId: held!.tenantId,
          expectedTenantVersion: tenant.version,
          membershipId: member.membershipId,
          expectedMembershipVersion: member.version,
          roles: [role],
          validUntil: member.validUntil,
        },
      });
    },
    async remove(memberId) {
      const { member, admin, tenant } = memberOf(await ready(), memberId);
      await executeAdministration(held!.owner, admin, {
        idempotencyKey: key(),
        intent: {
          operation: 'revokeMembership',
          tenantId: held!.tenantId,
          expectedTenantVersion: tenant.version,
          membershipId: member.membershipId,
          expectedMembershipVersion: member.version,
        },
      });
    },
    async invite(email, role) {
      const now = await ready();
      if (!now.issuer || !now.inviteTenant) throw new Error(say('cannotInvite'));
      const reply = await executeInvitation(now.owner, now.issuer, {
        idempotencyKey: key(),
        intent: {
          operation: 'issueInvitation',
          tenantId: now.tenantId,
          expectedTenantVersion: now.inviteTenant.version,
          email: email.trim().toLowerCase(),
          roles: [role],
          ...terms(now.issuer),
        },
      });
      return reply.token ? { token: reply.token } : {};
    },
    async reissue(invitationId) {
      const now = await ready();
      const { pair, issuer, tenant } = pairOf(now, invitationId);
      const reply = await executeInvitation(now.owner, issuer, {
        idempotencyKey: key(),
        intent: {
          operation: 'reissueInvitation',
          tenantId: now.tenantId,
          expectedTenantVersion: tenant.version,
          invitationId: pair.invitation.invitationId,
          expectedInvitationVersion: pair.invitation.version,
          membershipId: pair.membership.membershipId,
          expectedMembershipVersion: pair.membership.version,
          roles: pair.invitation.roles,
          ...terms(issuer),
        },
      });
      return reply.token ? { token: reply.token } : {};
    },
    async cancel(invitationId) {
      const now = await ready();
      const { pair, issuer, tenant } = pairOf(now, invitationId);
      await executeInvitation(now.owner, issuer, {
        idempotencyKey: key(),
        intent: {
          operation: 'revokeInvitation',
          tenantId: now.tenantId,
          expectedTenantVersion: tenant.version,
          invitationId: pair.invitation.invitationId,
          expectedInvitationVersion: pair.invitation.version,
          membershipId: pair.membership.membershipId,
          expectedMembershipVersion: pair.membership.version,
        },
      });
    },
  };
}
