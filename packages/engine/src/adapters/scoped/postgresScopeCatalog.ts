/**
 * The scope catalog on PostgreSQL.
 *
 * SQLite reads its physical metadata inside `BEGIN IMMEDIATE`, where nothing
 * else can write, so what it attests is what the transaction will see until
 * COMMIT. PostgreSQL has no such fence: DDL from another session commits
 * under a READ COMMITTED transaction unless something holds a lock on the
 * relation it touches. So the tables this scope may write are pinned first,
 * with `LOCK TABLE … IN ROW EXCLUSIVE MODE` — the lock an UPDATE takes
 * anyway, compatible with every ordinary reader and writer and in conflict
 * with everything that would change what a write means: ALTER TABLE, CREATE
 * TRIGGER, ADD FOREIGN KEY (on either side), CREATE INDEX, ENABLE ROW LEVEL
 * SECURITY. The catalog is read *after* the pin, so drift that committed
 * before it is what the attestation compares, and drift after it waits for
 * this transaction to end.
 *
 * Only tables in the scope that the writer role may update are pinned. That
 * is not a loophole: a table outside the scope is unreadable here (`WHERE
 * 1 = 0`), and one the role cannot update cannot be written by it, locked
 * for update, or have its rows held for a parent check — so it is never in
 * `writable` and the guarantee it lacks is one it could not use.
 *
 * What is described is exactly what `introspect()` describes, on the leased
 * writer inside the transaction, so the deployed catalog and this evidence
 * differ only when the database does.
 */
import { POSTGRES_STYLE, Refusal } from '../adapter.js';
import type { DatabaseSchema } from '../../shared/schema.js';
import type { RowScope } from '../../shared/rowScope.js';
import { captureScopeCatalog } from '../../shared/scopeCatalog.js';
import type { PgQuery } from '../postgresPool.js';
import { triggerNames, type ScopeCatalog } from './scopedTransaction.js';

export interface PostgresScopeCatalog extends ScopeCatalog {
  /** Ordinary tables the writer role may UPDATE, and so lock rows in. A
   * superset of `writable`: a lockable table with a trigger is still refused
   * as a target, but its rows can be held for a parent-visibility check. */
  lockable: ReadonlySet<string>;
  /** The relations this read pinned, quoted, in order: what a later transaction under the same epoch pins before it reads the epoch. */
  pinned: readonly string[];
}

interface FactRow {
  schema: string;
  name: string;
  kind: string;
  rls: boolean;
  triggers: boolean;
  trigger_names: string[];
  rules: boolean;
  policies: boolean;
  updatable: boolean;
}

const refuse = (): never => {
  throw new Refusal('PostgreSQL scoped transactions require a complete catalog and an ordinary table the writer may update.');
};

/** The adapter's own id convention: `schema.name`, or `name` in public. */
function located(id: string): { schema: string; name: string } {
  const dot = id.indexOf('.');
  return dot === -1 ? { schema: 'public', name: id } : { schema: id.slice(0, dot), name: id.slice(dot + 1) };
}

const key = (at: { schema: string; name: string }) => `${at.schema}.${at.name}`;

/** Everything that decides whether a write to a relation means what the
 * scope assumes: its kind, row security, and the presence of triggers,
 * rules and policies — and whether this role may update it at all. */
async function facts(client: PgQuery, targets: Array<{ schema: string; name: string }>): Promise<Map<string, FactRow>> {
  const result = new Map<string, FactRow>();
  if (!targets.length) return result;
  const rows = await client.query(
    `SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS kind, c.relrowsecurity AS rls,
            EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal) AS triggers,
            ARRAY(SELECT t.tgname::text FROM pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal ORDER BY 1) AS trigger_names,
            EXISTS (SELECT 1 FROM pg_rewrite r WHERE r.ev_class = c.oid) AS rules,
            EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
            has_table_privilege(c.oid, 'UPDATE') AS updatable
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN unnest($1::text[], $2::text[]) AS wanted(schema, name) ON wanted.schema = n.nspname AND wanted.name = c.relname`,
    [targets.map((target) => target.schema), targets.map((target) => target.name)],
  );
  for (const row of rows.rows as unknown as FactRow[]) {
    if (
      typeof row.schema !== 'string' ||
      typeof row.name !== 'string' ||
      typeof row.kind !== 'string' ||
      [row.rls, row.triggers, row.rules, row.policies, row.updatable].some((value) => typeof value !== 'boolean') ||
      !Array.isArray(row.trigger_names) ||
      row.trigger_names.some((name) => typeof name !== 'string') ||
      result.has(key(row))
    )
      return refuse();
    result.set(key(row), row);
  }
  return result;
}

const lockable = (fact: FactRow | undefined): boolean => fact !== undefined && ['r', 'p'].includes(fact.kind) && fact.updatable;
const clean = (fact: FactRow): boolean => !fact.rls && !fact.triggers && !fact.rules && !fact.policies;
/** What makes a table unclean, as a refusal names it. */
const unclean = (fact: FactRow): string =>
  [fact.triggers ? triggerNames(fact.trigger_names) : '', fact.rules ? 'a rule' : '', fact.policies || fact.rls ? 'row-level security' : '']
    .filter(Boolean)
    .join(' and ');

/** Call only on the leased writer inside its transaction, before any read of
 * user data. The describe callback is the adapter's own introspection so the
 * evidence has the same shape as the catalog the permissions were bound to. */
export async function readPostgresScopeCatalog(
  client: PgQuery,
  scope: RowScope,
  describe: (client: PgQuery) => Promise<DatabaseSchema>,
): Promise<PostgresScopeCatalog> {
  try {
    const wanted = Object.keys(scope).map(located);
    const before = await facts(client, wanted);
    const pinned = wanted.filter((target) => lockable(before.get(key(target))));
    const relations = pinned.map((target) => `${POSTGRES_STYLE.quote(target.schema)}.${POSTGRES_STYLE.quote(target.name)}`);
    if (pinned.length) await client.query(`LOCK TABLE ${relations.join(', ')} IN ROW EXCLUSIVE MODE`);
    const described = await describe(client);
    const schema = captureScopeCatalog({ ...described, label: 'PostgreSQL scoped transaction', readAt: new Date().toISOString() });
    const after = facts(
      client,
      schema.tables.map((table) => ({ schema: table.schema, name: table.name })),
    );
    const held = new Set(pinned.map(key));
    const writable = new Set<string>();
    const blockedBy = new Map<string, string>();
    const locks = new Set<string>();
    for (const table of schema.tables) {
      const fact = (await after).get(key(table));
      // A relation the catalog listed a moment ago and cannot describe now
      // was dropped under this transaction; nothing here may rely on it.
      if (!fact || table.id !== key(table)) return refuse();
      if (!lockable(fact)) continue;
      locks.add(table.id);
      // Writable means pinned: a table that became clean after the pin
      // decision could be dirtied again before COMMIT, so it stays read-only.
      if (held.has(table.id) && clean(fact) && !table.isView && table.columns.some((column) => column.primaryKey)) writable.add(table.id);
      else if (!clean(fact)) blockedBy.set(table.id, unclean(fact));
    }
    return { schema, writable, ...(blockedBy.size ? { blockedBy } : {}), lockable: locks, pinned: relations };
  } catch (error) {
    if (error instanceof Refusal) throw error;
    // A lock the role may not take, a vanished relation or unknown metadata
    // cannot weaken the boundary; the failure aborts the transaction anyway.
    return refuse();
  }
}
