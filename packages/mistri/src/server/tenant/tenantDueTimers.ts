/**
 * A timer's due records on a tenant App (tenantJobs.ts sweep): the rows of
 * one resource in one machine state (an `after` timer) or matching a `when`
 * (a resource's `at`, appAtWhen.ts) since at or before a cutoff, read across
 * every active tenant and handed back with the tenant each row's owner column
 * names. The owner is read off the row by the server, never taken from a
 * caller, and the list is a plan, never authority: each run is admitted again
 * on its own tenant's row, and its command finds the record only inside that
 * tenant's scope.
 *
 * One tenant cannot starve another. Each tenant's due rows are ranked by
 * their stay (`since`, then key), and a sweep takes one band of at most
 * DUE_TIMER_CAP ranks from each tenant, interleaved rank by rank, at most
 * DUE_TIMER_PAGE rows a page. A tenant's band is the sweep's round modulo the
 * bands it has, so a tenant with one due row offers it every round while one
 * with a thousand turns through them twenty at a time; a page that comes back
 * full is followed by the next page of the same round. A record whose timer
 * ran and left it where it was (an `at` warning) is still due, and still
 * reached: every band of every tenant comes round. An `at` timer's band is
 * ranked newest instant first: its fired records keep their passed instant,
 * and a mark set a minute ago must not wait behind every one of them (the
 * job's key holds the instant, so a fired one is not run again). A platform-owned resource
 * has no owner, and pages as an App without tenants does (cli/commandHost.ts).
 */
import { captureTenantData, denyTenant, tenantIdentifier, tenantRecord } from '@mistriwork/engine/server/evidence.js';
import { parseTenantSelector } from './tenantMembership.js';
import type { TenantOwnershipSnapshot } from './tenantOwnership.js';
import { atWhenFilter } from '../../shared/appAtWhen.js';
import { ANSI_STYLE, buildWhere, POSTGRES_STYLE, type Filter } from '@mistriwork/engine/shared/filter.js';

/** The most rows one sweep of one timer reads. */
export const DUE_TIMER_PAGE = 100;
/** The most rows of one tenant in one sweep of one timer. */
export const DUE_TIMER_CAP = 20;
/** Past this a round starts again from nought; any round reaches every band. */
const ROUNDS = 2 ** 31;

/** What a sweep asks for, in the App's logical names. `cutoff` is already on
 * the clock `since` was stamped on; `round` and `offset` are the sweep's page. */
export interface DueTimersQuery {
  readonly resource: string;
  /** An `after` timer's machine column and the state it waits in. */
  readonly column?: string;
  readonly state?: string;
  /** An `at` timer's condition, in the query language over the record's own columns; compiled here against the App's catalog. */
  readonly when?: string;
  readonly since: string;
  readonly cutoff: string;
  readonly round: number;
  readonly offset: number;
  /** One tenant's due rows only: a sandbox read on its own dev clock (tenantSandboxClock.ts). Still only while it is active. */
  readonly tenant?: string;
}
/** A due record: its key, the stay it was found in, and on a tenant-owned resource its owner's tenant. */
export type DueTimer = Readonly<{ key: Readonly<Record<string, string | number>>; since: string; tenantId?: string }>;

const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;
const count = (value: unknown, ceiling: number) => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= ceiling;

/**
 * The statement and its decoding for one query, in the engine's spelling.
 * Parameters, in order: the state (or the `when`'s values), the cutoff; then, on a tenant-owned
 * resource, the active tenants (a JSON array on SQLite, a text array on
 * PostgreSQL) and the round; then the offset. Anything not of this App's
 * catalog, or a resource no tenant and not the platform owns, is refused.
 */
export function dueTimersPlan(owned: TenantOwnershipSnapshot, input: DueTimersQuery) {
  const query = captureTenantData(input);
  tenantRecord(query, ['resource', 'column', 'state', 'when', 'since', 'cutoff', 'round', 'offset', 'tenant']);
  const only = query.tenant === undefined ? undefined : parseTenantSelector([query.tenant]);
  for (const name of [query.resource, query.since]) tenantIdentifier(name, 128);
  /* Exactly one of a machine state and an `at` timer's (optional) `when`. */
  const machine = query.column !== undefined || query.state !== undefined;
  if (machine) {
    tenantIdentifier(query.column, 128);
    tenantIdentifier(query.state, 256);
    if (query.when !== undefined) return denyTenant();
  } else if (query.when !== undefined) tenantIdentifier(query.when, 2048);
  tenantIdentifier(query.cutoff, 64);
  if (!count(query.round, ROUNDS) || !count(query.offset, 1_000_000)) return denyTenant();
  const rule = Object.hasOwn(owned.ownership, query.resource) ? owned.ownership[query.resource] : undefined;
  const physical = Object.hasOwn(owned.resources, query.resource) ? owned.resources[query.resource] : undefined;
  const table = owned.schema.tables.find((candidate) => candidate.id === query.resource);
  if (!rule || rule.kind === 'global' || !physical || !table || (only !== undefined && rule.kind !== 'tenant')) return denyTenant();
  const has = (name: string) => table.columns.some((column) => column.name === name);
  const keys = table.columns.filter((column) => column.primaryKey).map((column) => column.name);
  if (!keys.length || (machine && !has(query.column as string)) || !has(query.since) || (rule.kind === 'tenant' && !has(rule.column)))
    return denyTenant();
  const postgres = owned.schema.dialect === 'postgres';
  /* A `when` the catalog does not read as the record's own conditions is refused, never run as text. */
  let when: Filter | undefined;
  if (!machine && query.when !== undefined) {
    const read = atWhenFilter(owned.schema, table, query.when, new Date());
    if (!read.filter) return denyTenant();
    when = read.filter;
  }
  let from: string;
  if (postgres) {
    const dot = physical.indexOf('.');
    if (dot < 1) return denyTenant();
    from = `${quoted(physical.slice(0, dot))}.${quoted(physical.slice(dot + 1))}`;
  } else from = `main.${quoted(physical)}`;
  /* Each value is bound where it is written, in the statement's order: SQLite's holes are positional. */
  const values: unknown[] = [];
  const TENANTS = Symbol('tenants');
  const hole = (value: unknown) => (values.push(value), postgres ? `$${values.length}` : '?');
  const selected = keys.map((key, index) => `${quoted(key)} AS k${index}`).join(', ');
  const order = keys.map((key) => quoted(key)).join(', ');
  const aliases = keys.map((_, index) => `k${index}`).join(', ');
  const integer = (value: unknown) => (postgres ? `${hole(value)}::bigint` : `CAST(${hole(value)} AS INTEGER)`);
  const since = quoted(query.since);
  let where: string;
  if (machine) where = `${quoted(query.column as string)} = ${hole(query.state)}`;
  else if (when?.groups.length) {
    const fragment = buildWhere(when, postgres ? POSTGRES_STYLE : ANSI_STYLE, values.length + 1);
    values.push(...fragment.params);
    where = `(${fragment.text.replace(/^ WHERE /, '')})`;
  } else where = '1 = 1';
  where += ` AND ${since} <= ${hole(query.cutoff)}`;
  const stay = `${since}${machine ? '' : ' DESC'}, ${order}`;
  let sql: string;
  if (rule.kind === 'platform') {
    sql = `SELECT ${selected}, ${since} AS s FROM ${from} WHERE ${where}
      ORDER BY ${stay} LIMIT ${DUE_TIMER_PAGE} OFFSET ${integer(query.offset)}`;
  } else {
    const owner = quoted(rule.column);
    const tenants = postgres
      ? `${owner}::text = ANY(${hole(TENANTS)}::text[])`
      : `${owner} IN (SELECT value FROM json_each(${hole(TENANTS)}))`;
    sql = `SELECT ${aliases}, s, t FROM (
        SELECT ${selected}, ${since} AS s, ${owner}${postgres ? '::text' : ''} AS t,
          ROW_NUMBER() OVER (PARTITION BY ${owner} ORDER BY ${stay}) AS r,
          COUNT(*) OVER (PARTITION BY ${owner}) AS n
        FROM ${from} WHERE ${where} AND ${tenants}
      ) AS due
      WHERE (r - 1) / ${DUE_TIMER_CAP} = ${integer(query.round)} % ((n + ${DUE_TIMER_CAP - 1}) / ${DUE_TIMER_CAP})
      ORDER BY r, s${machine ? '' : ' DESC'}, t, ${aliases} LIMIT ${DUE_TIMER_PAGE} OFFSET ${integer(query.offset)}`;
  }
  return Object.freeze({
    sql,
    /** Whether the statement names the active tenants: a tenant-owned resource's does. */
    tenants: rule.kind === 'tenant',
    params(active: readonly string[]): unknown[] {
      const tenants = only === undefined ? active : active.filter((id) => id === only);
      return values.map((value) => (value === TENANTS ? (postgres ? [...tenants] : JSON.stringify(tenants)) : value));
    },
    decode(rows: readonly Record<string, unknown>[]): readonly DueTimer[] {
      return Object.freeze(
        rows.map((row) => {
          const key: Record<string, string | number> = {};
          keys.forEach((name, index) => {
            const value = row[`k${index}`];
            if (typeof value === 'bigint') key[name] = String(value);
            else if (typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value))) key[name] = value;
            else denyTenant();
          });
          if (row.s === null || row.s === undefined) return denyTenant();
          return Object.freeze({
            key: Object.freeze(key),
            since: String(row.s),
            ...(rule.kind === 'tenant' ? { tenantId: parseTenantSelector([String(row.t)]) } : {}),
          });
        }),
      );
    },
  });
}
