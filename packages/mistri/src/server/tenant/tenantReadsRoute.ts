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
import { Refusal, type Adapter } from '@mistriwork/engine/adapters/adapter.js';
import {
  coerceForColumn,
  columnKind,
  findTable,
  primaryKey,
  referencesTo,
  tableNamed,
  type DatabaseSchema,
  type ForeignKey,
} from '@mistriwork/engine/shared/schema.js';
import type { ReadAuditQuery, ReadAuditTarget, StoredReadAudit } from '../../adapters/readAudit/readAudit.js';
import { withoutReadAudit } from '../readAudit.js';

/** One page: enough to fill a screen, few enough that naming its people stays a handful of lookups. */
const READS_PAGE = 50;

/** Maximum child rows resolved per audited child table when filtering by parent record. */
const MAX_PARENT_CHILDREN = 5_000;

/** Parent record filter on `/api/reads`: matches reads of the parent (if audited) and its 1-hop audited FK children. */
interface ReadAuditParent {
  readonly resource: string;
  readonly record: string;
}

type ResolveReadAuditParent = (
  parent: ReadAuditParent,
  options: { readonly resources: readonly string[]; readonly onlyResource?: string },
) => Promise<readonly ReadAuditTarget[]>;

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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Same key formatting as server/readAudit.ts `keyText`: single PK as string, composite PK as JSON array of strings. */
const keyText = (row: Record<string, unknown>, columns: readonly string[]): string | undefined => {
  if (!columns.length || columns.some((column) => row[column] === undefined || row[column] === null)) return undefined;
  return columns.length === 1 ? String(row[columns[0]]) : JSON.stringify(columns.map((column) => String(row[column])));
};

/** Parse a `record` string into per-column primary key texts matching `keyText`. */
function parseParentKeyParts(record: string, pkLength: number): readonly string[] | undefined {
  if (pkLength === 1) return [record];
  try {
    const parsed: unknown = JSON.parse(record);
    if (Array.isArray(parsed) && parsed.length === pkLength && parsed.every((part) => typeof part === 'string')) return parsed;
  } catch {
    /* Invalid composite key text matches no child foreign keys. */
  }
  return undefined;
}

/** Coerce a parent key string for a child FK column, returning undefined if the value cannot match that column type. */
function coerceForeignKeyValue(declaredType: string, raw: string): string | number | undefined {
  const coerced = coerceForColumn(declaredType, raw);
  if (coerced === null || typeof coerced === 'boolean') return undefined;
  if (columnKind(declaredType) === 'number') {
    if (typeof coerced === 'number') return coerced;
    return /^-?\d+$/.test(raw.trim()) ? raw.trim() : undefined;
  }
  if (/\buuid\b/i.test(declaredType) && !UUID_PATTERN.test(raw.trim())) return undefined;
  return coerced;
}

/**
 * Resolve a parent record into `(resource, records)` audit targets: the parent itself (when audited) plus every
 * readable 1-hop foreign-key child table whose reads are audited, queried under the caller's tenant/row-scoped adapter
 * without writing read-audit rows for the lookup itself.
 */
export async function resolveTenantParentAuditTargets(
  adapter: Pick<Adapter, 'query'>,
  schema: DatabaseSchema,
  parent: ReadAuditParent,
  options: { readonly resources: readonly string[]; readonly onlyResource?: string },
): Promise<readonly ReadAuditTarget[]> {
  const parentTable = findTable(schema, parent.resource) ?? tableNamed(schema, parent.resource);
  if (!parentTable) throw new Refusal(`"${parent.resource}" is not a readable resource.`);
  const parentPk = primaryKey(parentTable);
  if (!parentPk.length) throw new Refusal(`"${parent.resource}" has no primary key.`);

  const auditedByTableId = new Map<string, string>();
  for (const name of options.resources) {
    if (options.onlyResource !== undefined && name !== options.onlyResource) continue;
    const table = findTable(schema, name) ?? tableNamed(schema, name);
    if (table) auditedByTableId.set(table.id, name);
  }

  const collected = new Map<string, Set<string>>();
  const add = (resource: string, key: string) => {
    let set = collected.get(resource);
    if (!set) collected.set(resource, (set = new Set()));
    set.add(key);
  };

  const parentAudited = auditedByTableId.get(parentTable.id);
  if (parentAudited !== undefined) add(parentAudited, parent.record);

  const keyParts = parseParentKeyParts(parent.record, parentPk.length);
  if (keyParts) {
    const childFks = new Map<string, ForeignKey[]>();
    for (const fk of referencesTo(schema, parentTable.id)) {
      if (!auditedByTableId.has(fk.from.table)) continue;
      if (fk.to.columns.length !== parentPk.length || !fk.to.columns.every((col, index) => col === parentPk[index])) continue;
      let list = childFks.get(fk.from.table);
      if (!list) childFks.set(fk.from.table, (list = []));
      list.push(fk);
    }

    const lookups: Array<Promise<void>> = [];
    await withoutReadAudit(async () => {
      for (const [childTableId, fks] of childFks) {
        const childTable = findTable(schema, childTableId);
        const childResource = auditedByTableId.get(childTableId);
        if (!childTable || !childResource) continue;
        const childPk = primaryKey(childTable);
        if (!childPk.length) continue;

        const groups: Array<Array<{ column: string; op: '='; value: string | number }>> = [];
        for (const fk of fks) {
          const group: Array<{ column: string; op: '='; value: string | number }> = [];
          let valid = true;
          for (let i = 0; i < fk.from.columns.length; i++) {
            const columnName = fk.from.columns[i]!;
            const colMeta = childTable.columns.find((candidate) => candidate.name === columnName);
            if (!colMeta) {
              valid = false;
              break;
            }
            const coerced = coerceForeignKeyValue(colMeta.type, keyParts[i]!);
            if (coerced === undefined) {
              valid = false;
              break;
            }
            group.push({ column: columnName, op: '=', value: coerced });
          }
          if (valid && group.length) groups.push(group);
        }
        if (!groups.length) continue;

        lookups.push(
          adapter
            .query({
              table: childTableId,
              columns: childPk,
              filter: { groups },
              limit: MAX_PARENT_CHILDREN,
              offset: 0,
            })
            .then((result) => {
              for (const row of result.rows) {
                const key = keyText(row as Record<string, unknown>, childPk);
                if (key !== undefined) add(childResource, key);
              }
            }),
        );
      }
      await Promise.all(lookups);
    });
  }

  return [...collected.entries()].filter(([, set]) => set.size > 0).map(([resource, set]) => ({ resource, records: [...set] }));
}

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
      resolveParent?: ResolveReadAuditParent,
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
      let parent: ReadAuditParent | undefined;
      if (input.parent !== undefined) {
        if (typeof input.parent !== 'object' || input.parent === null || Array.isArray(input.parent))
          return refused("A read audit filter's parent must be { resource, record }.");
        const rawParent = input.parent as Record<string, unknown>;
        for (const key of Object.keys(rawParent))
          if (key !== 'resource' && key !== 'record') return refused(`Unknown read audit parent filter "${key}".`);
        if (typeof rawParent.resource !== 'string' || !rawParent.resource)
          return refused("A read audit parent's resource must be a non-empty string.");
        if (typeof rawParent.record !== 'string' || !rawParent.record)
          return refused("A read audit parent's record must be a non-empty string.");
        if (query.record !== undefined) return refused('Specify either record or parent, not both.');
        parent = { resource: rawParent.resource, record: rawParent.record };
      }
      if (query.resource !== undefined && !reads.resources.includes(query.resource))
        return refused(`"${query.resource}" is not a resource whose reads are audited.`);
      if (parent) {
        if (!resolveParent) return refused('Parent filtering is not available on this route.');
        let targets: readonly ReadAuditTarget[];
        try {
          targets = await resolveParent(parent, {
            resources: reads.resources,
            ...(query.resource === undefined ? {} : { onlyResource: query.resource }),
          });
        } catch (error) {
          if (error instanceof Refusal) return refused(error.message);
          throw error;
        }
        if (!targets.length) {
          return { status: 200, body: { reads: [], resources: reads.resources } };
        }
        query.targets = targets;
        delete query.resource;
      }
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
              /* What the read was granted under, beside the name: the roles, and the membership that holds a token.
                 Not `visit` (this is never served on one) nor `scope` (it names a row's key). */
              ...(row.roles === undefined ? {} : { roles: row.roles }),
              ...(row.membership === undefined ? {} : { membership: row.membership }),
              resource: row.resource,
              route: row.route,
              ...(row.command === undefined ? {} : { command: row.command }),
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
