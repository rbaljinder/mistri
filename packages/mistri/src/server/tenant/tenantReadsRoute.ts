/**
 * A tenant's read audit, read by its own admins on its own lease (tenantHttp.ts): who opened or listed which of an
 * audited resource's rows, newest first, a page at a time. `mistri audit reads` is the operator's; this is the
 * organization's, so an owner can answer "who looked at this record" without asking the platform (a field report).
 *
 * The tenant is the lease's and nothing else: the body names filters only, and the deployment's read takes the tenant
 * as its own argument, which wins over any query (tenantDeployment.ts). Not in the platform realm, and never on a
 * support visit: a support operator's reads are in this log, and the log is not theirs to read. A member who is not
 * one of the tenant's admins (the roles that edit its domains or branding) is refused; the room is not drawn for them.
 */
import { Refusal } from '@mistriwork/engine/adapters/adapter.js';
import type { ReadAuditQuery, StoredReadAudit } from '../../adapters/readAudit/readAudit.js';

/** One page: enough to fill a screen, few enough that naming its people stays a handful of lookups. */
const READS_PAGE = 50;

export interface TenantReadsService {
  /** The tenant roles that may read the audit: the domains editors, else the branding editors. */
  readonly editors: readonly string[];
  /** The audited resources, for the room's filter. */
  readonly resources: readonly string[];
  read(tenantId: string, query: Omit<ReadAuditQuery, 'tenant' | 'app'>): Promise<readonly StoredReadAudit[]>;
  /** Accounts' names from the sign-in store; an account it does not know is left out. */
  people(accountIds: readonly string[]): Promise<ReadonlyMap<string, { readonly name?: string; readonly email: string | null }>>;
}

type Answer = { status: number; body: unknown };

const FILTERS = ['actor', 'resource', 'record', 'since', 'until'] as const;

/** The account a row's actor names, when it names a person: their own id, or the one an assistant read for. A
    signed-out visitor (`public`), a support operator, a service and an API token name no one here. */
const actorAccount = (actor: string): string | undefined =>
  actor.startsWith('assistant:')
    ? actor.slice('assistant:'.length) || undefined
    : actor === 'public' || /^[a-z-]+:/.test(actor)
      ? undefined
      : actor;

export function tenantReadsRoute(reads: TenantReadsService) {
  return {
    serves: (path: string) => path === '/api/reads',
    /** Whether the shell offers the Reads section: exactly where answer() reads rather than refuses. */
    offered: (principal: { roles: readonly string[]; tenantId?: unknown }, where: { platform: boolean; onSupport: boolean }) =>
      !where.platform &&
      !where.onSupport &&
      typeof principal.tenantId === 'string' &&
      principal.roles.some((role) => reads.editors.includes(role)),
    async answer(
      input: Record<string, unknown>,
      principal: { roles: readonly string[] },
      where: { platform: boolean; onSupport: boolean },
    ): Promise<Answer> {
      const tenantId = (principal as { tenantId?: unknown }).tenantId;
      if (where.platform || where.onSupport || typeof tenantId !== 'string')
        return { status: 404, body: { error: 'Not found.', code: 'not_found' } };
      if (!principal.roles.some((role) => reads.editors.includes(role)))
        return {
          status: 403,
          body: { error: "Only this organization's admins may read who saw its records.", code: 'forbidden', outcome: 'not_applied' },
        };
      const query: { -readonly [K in keyof ReadAuditQuery]?: ReadAuditQuery[K] } = { limit: READS_PAGE + 1 };
      for (const key of FILTERS) {
        const value = input[key];
        if (value === undefined || value === '') continue;
        if (typeof value !== 'string') return refused(`A read audit filter's ${key} must be text.`);
        query[key] = value;
      }
      if (input.before !== undefined) {
        if (typeof input.before !== 'number') return refused("A read audit page's before must be a row's id.");
        query.before = input.before;
      }
      if (query.resource !== undefined && !reads.resources.includes(query.resource))
        return refused(`"${query.resource}" is not a resource whose reads are audited.`);
      let rows: readonly StoredReadAudit[];
      try {
        rows = await reads.read(tenantId, query as Omit<ReadAuditQuery, 'tenant' | 'app'>);
      } catch (error) {
        if (error instanceof Refusal) return refused(error.message);
        throw error;
      }
      const page = rows.slice(0, READS_PAGE);
      const accounts = [...new Set(page.map((row) => actorAccount(row.actor)).filter((id): id is string => id !== undefined))];
      const people = accounts.length ? await reads.people(accounts) : new Map();
      return {
        status: 200,
        body: {
          reads: page.map((row) => {
            const account = actorAccount(row.actor);
            const who = account === undefined ? undefined : people.get(account);
            return {
              id: row.id,
              at: row.at,
              actor: row.actor,
              ...(who?.name || who?.email ? { person: (who.name || who.email)! } : {}),
              resource: row.resource,
              route: row.route,
              ...(row.record === undefined ? { kind: 'listed', count: row.count } : { kind: 'opened', record: row.record }),
            };
          }),
          ...(rows.length > READS_PAGE ? { next: page.at(-1)!.id } : {}),
          resources: reads.resources,
        },
      };
    },
  };
}

const refused = (error: string): Answer => ({ status: 422, body: { error, code: 'reads_refused', outcome: 'not_applied' } });
