/**
 * A tenant's members by name, read by any of its members on their own lease (tenantHttp.ts): who is on the team, so a
 * page can offer "assign this to a person" to someone who does not manage the team (a field report: `useTeam()` read
 * through the administration routes, which answer only a manager, so everyone else's team was empty).
 *
 * It is the narrow half of the team, on purpose. A member is told each member's name, the ids a pick is stored by
 * (the membership's and the account's) and which one is theirs, and nothing else: no address, no role, no status, no
 * end date, no invitation. Those are the administration's (tenantAdministration.ts), for a reader its policy grants.
 * A member the sign-in store keeps no name for is listed with an empty one, never by their address.
 *
 * The tenant is the lease's and nothing else: the request names none. Not in the platform realm, and never on a
 * support visit, as the read audit is not (tenantReadsRoute.ts). An App turns it off with `auth.tenancy.team: false`,
 * and then no route is here at all.
 */
import type { AppDef } from '../../shared/app.js';
import type { TenantAdministration } from './tenantAdministration.js';

/** The most members one team read lists: a picker's list, not a directory export. Past it the answer says `more`. */
const TEAM_MOST = 500;

export interface TenantTeamService {
  /** The tenant's active members, in a stable order: at most `limit`. */
  members(tenantId: string, limit: number): Promise<readonly { readonly membershipId: string; readonly accountId: string }[]>;
  /** Accounts' display names from the sign-in store; an account it does not know, or keeps no name for, is left out. */
  names(accountIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
}

/**
 * The team read an App's tenant host serves, or none. Read from the administration's store, so it is served where
 * the App administers its tenants' members, and not where it says members do not see each other
 * (`auth.tenancy.team: false`). The roles are a tenant's own people's: never a platform role's or a service's.
 */
export function tenantTeamService(
  app: AppDef,
  administration: Pick<TenantAdministration, 'team'> | undefined,
  profileOf: (accountId: string) => Promise<{ readonly name?: string } | null>,
): TenantTeamService | undefined {
  if (!administration || app.auth?.tenancy?.team === false) return undefined;
  const roles = Object.entries(app.auth?.roles ?? {})
    .filter(([, grant]) => grant.realm !== 'platform' && !grant.service)
    .map(([role]) => role);
  return Object.freeze({
    members: (tenantId: string, limit: number) => administration.team(tenantId, roles, limit),
    names: async (accountIds: readonly string[]) => {
      const named = new Map<string, string>();
      for (const id of accountIds) {
        try {
          /* The name alone: the address the same row holds is the administration's to say, never this read's. */
          const name = (await profileOf(id))?.name;
          if (name) named.set(id, name);
        } catch {
          /* An account the store cannot say is listed with no name: the list is never refused for it. */
        }
      }
      return named;
    },
  });
}

type Answer = { status: number; body: unknown };
const notFound: Answer = { status: 404, body: { error: 'Not found.', code: 'not_found' } };

export function tenantTeamRoute(team: TenantTeamService) {
  return {
    serves: (path: string) => path === '/api/team',
    async answer(
      principal: { roles: readonly string[]; tenantId?: unknown; accountId?: unknown },
      where: { platform: boolean; onSupport: boolean },
    ): Promise<Answer> {
      const { tenantId, accountId } = principal;
      if (where.platform || where.onSupport || typeof tenantId !== 'string' || typeof accountId !== 'string') return notFound;
      const rows = await team.members(tenantId, TEAM_MOST + 1);
      const listed = rows.slice(0, TEAM_MOST);
      const names = listed.length ? await team.names(listed.map((row) => row.accountId)) : new Map<string, string>();
      return {
        status: 200,
        body: {
          /* Built field by field: whatever else the store's row holds (its roles, its end date) is not copied here. */
          members: listed.map((row) => ({
            id: row.membershipId,
            account: row.accountId,
            name: names.get(row.accountId) ?? '',
            you: row.accountId === accountId,
          })),
          ...(rows.length > TEAM_MOST ? { more: true } : {}),
        },
      };
    },
  };
}
