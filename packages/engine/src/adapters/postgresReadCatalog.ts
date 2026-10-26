/** Private native read-snapshot shape owner. Locks and native catalog identity
 * are evidence of source shape, never caller authorization or an ACL fence.
 * Only PostgresAdapter supplies the snapshot runner in production. */
import { POSTGRES_STYLE, Refusal, TransactionOperations, type SqlFragment, type QueryResult } from './adapter.js';
import type { PostgresReadSnapshot } from './postgres.js';
import { snapshot } from './commands/canonicalJson.js';
import { assertScopeCatalog, captureScopeCatalog } from '../shared/scopeCatalog.js';
import type { DatabaseSchema } from '../shared/schema.js';
import { isProxy } from 'node:util/types';

export interface PostgresReadDependency {
  readonly schema: string;
  readonly name: string;
}
export interface PinnedPostgresRead {
  readonly schema: DatabaseSchema;
  assertCurrent(): void;
  execute(statement: SqlFragment, hint?: { binary?: true }): Promise<QueryResult>;
}
export interface PinnedPostgresReadOwner {
  readonly schema: DatabaseSchema;
  withSnapshot<T>(callback: (read: PinnedPostgresRead) => Promise<T>): Promise<T>;
  /** Whether a snapshot has seen these tables differ from the baseline: then
   * no later one will match, and an owner holding several may retire them all. */
  drifted(): boolean;
  retire(): Promise<void>;
}
type Runner = <T>(run: (snapshot: PostgresReadSnapshot) => Promise<T>) => Promise<T>;
const refuse = (): never => {
  throw new Refusal('The pinned PostgreSQL read snapshot is unavailable.');
};
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const id = (value: PostgresReadDependency) => JSON.stringify([value.schema, value.name]);

function dependencies(raw: readonly PostgresReadDependency[]): readonly PostgresReadDependency[] {
  const value = snapshot(raw, 65536).value;
  if (!Array.isArray(value) || !value.length || value.length > 128) return refuse();
  const captured = value
    .map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).sort().join(',') !== 'name,schema') return refuse();
      const valid = (text: unknown): text is string =>
        typeof text === 'string' && text.length > 0 && Buffer.byteLength(text) <= 63 && !/[\p{Cc}\p{Cs}]/u.test(text);
      if (!valid(item.schema) || !valid(item.name) || item.schema === 'information_schema' || item.schema.startsWith('pg_'))
        return refuse();
      return Object.freeze({ schema: item.schema, name: item.name });
    })
    .sort((a, b) => order(a.schema, b.schema) || order(a.name, b.name));
  if (new Set(captured.map(id)).size !== captured.length) return refuse();
  return Object.freeze(captured);
}

const FACTS = `SELECT n.nspname AS schema, c.relname AS name, c.oid::text AS oid,
  c.relkind::text AS kind, c.relpersistence::text AS persistence,
  c.relispartition AS partition, c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
  EXISTS (SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid) AS inheritance,
  EXISTS (SELECT 1 FROM pg_catalog.pg_rewrite r WHERE r.ev_class=c.oid) AS rules,
  EXISTS (SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid) AS policies,
  COALESCE((SELECT json_agg(json_build_object('name', a.attname, 'number', a.attnum,
    'typeOid', a.atttypid::text, 'type', t.typname, 'typeSchema', tn.nspname, 'typeKind', t.typtype,
    'modifier', a.atttypmod, 'notnull', a.attnotnull, 'dropped', a.attisdropped,
    'generated', a.attgenerated, 'identity', a.attidentity, 'collation', a.attcollation::text) ORDER BY a.attnum)
    FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_type t ON t.oid=a.atttypid
    LEFT JOIN pg_catalog.pg_namespace tn ON tn.oid=t.typnamespace
    WHERE a.attrelid=c.oid AND a.attnum>0), '[]'::json) AS columns,
  COALESCE((SELECT json_agg(json_build_object('oid', p.oid::text, 'index', p.conindid::text,
    'keys', p.conkey, 'valid', i.indisvalid, 'ready', i.indisready, 'deferrable', p.condeferrable))
    FROM pg_catalog.pg_constraint p JOIN pg_catalog.pg_index i ON i.indexrelid=p.conindid
    WHERE p.conrelid=c.oid AND p.contype='p'), '[]'::json) AS primary
 FROM unnest($1::text[], $2::text[]) AS w(schema, name)
 JOIN pg_catalog.pg_namespace n ON n.nspname=w.schema
 JOIN pg_catalog.pg_class c ON c.relnamespace=n.oid AND c.relname=w.name
 ORDER BY n.nspname COLLATE "C", c.relname COLLATE "C"`;

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : refuse();
const oid = (value: unknown) => typeof value === 'string' && /^[1-9][0-9]{0,9}(?![\s\S])/.test(value) && BigInt(value) <= 4294967295n;
const TYPES = new Set(['int2', 'int4', 'int8', 'float4', 'float8', 'text', 'varchar', 'bpchar', 'bool', 'date']);

async function capture(lease: PostgresReadSnapshot, wanted: readonly PostgresReadDependency[], current: () => void) {
  if (typeof lease.assertCurrent !== 'function') return refuse();
  const ownerCurrent = current;
  current = () => {
    ownerCurrent();
    lease.assertCurrent!();
  };
  current();
  await lease.client.query(
    `LOCK TABLE ${wanted.map((at) => `ONLY ${POSTGRES_STYLE.quote(at.schema)}.${POSTGRES_STYLE.quote(at.name)}`).join(', ')} IN ACCESS SHARE MODE`,
  );
  current();
  const rows = snapshot(
    (await lease.client.query(FACTS, [wanted.map((at) => at.schema), wanted.map((at) => at.name)])).rows,
    1048576,
  ).value;
  current();
  if (!Array.isArray(rows) || rows.length !== wanted.length) return refuse();
  const seen = new Set<string>();
  for (const value of rows) {
    const row = record(value),
      key = JSON.stringify([row.schema, row.name]);
    if (
      !wanted.some((at) => id(at) === key) ||
      seen.has(key) ||
      !oid(row.oid) ||
      row.kind !== 'r' ||
      row.persistence !== 'p' ||
      ['partition', 'rls', 'force', 'inheritance', 'rules', 'policies'].some((field) => row[field] !== false) ||
      !Array.isArray(row.columns) ||
      !row.columns.length ||
      !Array.isArray(row.primary) ||
      row.primary.length !== 1
    )
      return refuse();
    seen.add(key);
    const numbers = new Set<number>(),
      names = new Set<string>();
    for (const value of row.columns) {
      const column = record(value);
      if (
        typeof column.name !== 'string' ||
        !column.name ||
        names.has(column.name) ||
        !Number.isSafeInteger(column.number) ||
        Number(column.number) < 1 ||
        numbers.has(Number(column.number)) ||
        !oid(column.typeOid) ||
        column.typeSchema !== 'pg_catalog' ||
        column.typeKind !== 'b' ||
        typeof column.type !== 'string' ||
        !TYPES.has(column.type) ||
        column.dropped !== false ||
        // A generated column ('s' stored, 'v' virtual) is read like any other: the database computes it from the row.
        !['', 's', 'v'].includes(String(column.generated)) ||
        !['', 'a', 'd'].includes(String(column.identity)) ||
        !Number.isSafeInteger(column.modifier) ||
        typeof column.notnull !== 'boolean' ||
        typeof column.collation !== 'string' ||
        !/^(?:0|[1-9][0-9]{0,9})(?![\s\S])/.test(column.collation)
      )
        return refuse();
      names.add(column.name);
      numbers.add(Number(column.number));
    }
    const columns = row.columns;
    const primary = record(row.primary[0]);
    if (
      !oid(primary.oid) ||
      !oid(primary.index) ||
      primary.valid !== true ||
      primary.ready !== true ||
      primary.deferrable !== false ||
      !Array.isArray(primary.keys) ||
      !primary.keys.length ||
      new Set(primary.keys).size !== primary.keys.length ||
      primary.keys.some(
        (key) =>
          typeof key !== 'number' ||
          !numbers.has(key) ||
          !columns.some((value) => record(value).number === key && record(value).notnull === true),
      )
    )
      return refuse();
  }
  const described = await lease.describe();
  current();
  const selected = described.tables.filter((table) => wanted.some((at) => at.schema === table.schema && at.name === table.name));
  if (described.dialect !== 'postgres' || selected.length !== wanted.length) return refuse();
  const selectedIds = new Set(selected.map((table) => table.id));
  if (described.foreignKeys.some((fk) => selectedIds.has(fk.from.table) && !selectedIds.has(fk.to.table))) return refuse();
  const schema = captureScopeCatalog({
    ...described,
    label: 'Pinned PostgreSQL read',
    readAt: '',
    tables: selected,
    foreignKeys: described.foreignKeys.filter((fk) => selectedIds.has(fk.from.table) && selectedIds.has(fk.to.table)),
  });
  return { facts: snapshot(rows, 1048576).json, schema };
}

/** Adapter-only construction seam. Baseline is captured from that adapter's
 * native transaction, not accepted as a caller-authored schema/hash. Callback
 * code is trusted and must not await retirement of its own active operation. */
export async function createPinnedPostgresReadOwner(
  run: Runner,
  raw: readonly PostgresReadDependency[],
  assertCurrent: () => void,
): Promise<PinnedPostgresReadOwner> {
  if (typeof run !== 'function' || isProxy(run) || typeof assertCurrent !== 'function' || isProxy(assertCurrent)) return refuse();
  const wanted = dependencies(raw),
    pending = new Set<Promise<unknown>>();
  let retired = false,
    drift = false;
  const current = () => {
    if (retired) return refuse();
    assertCurrent();
    if (retired) return refuse();
  };
  current();
  const baseline = await run((lease) => capture(lease, wanted, current));
  current();
  return Object.freeze({
    schema: baseline.schema,
    withSnapshot: <T>(callback: (read: PinnedPostgresRead) => Promise<T>): Promise<T> => {
      const work = Promise.resolve().then(async () => {
        current();
        if (typeof callback !== 'function' || isProxy(callback)) return refuse();
        const result = await run(async (lease) => {
          current();
          const observed = await capture(lease, wanted, current);
          current();
          try {
            if (observed.facts !== baseline.facts) return refuse();
            assertScopeCatalog(baseline.schema, observed.schema);
          } catch (error) {
            drift = true;
            throw error;
          }
          let active = true;
          const operations = new TransactionOperations();
          const held = () => {
            current();
            if (!active || !lease.assertCurrent) return refuse();
            lease.assertCurrent();
          };
          try {
            const output = await callback(
              Object.freeze({
                schema: baseline.schema,
                assertCurrent: held,
                execute: (statement: SqlFragment, hint?: { binary?: true }) => {
                  const captured = snapshot(statement, 1048576).value as unknown as SqlFragment;
                  return operations.run(async () => {
                    held();
                    const result = await lease.execute(captured, hint?.binary ? { binary: true } : undefined);
                    held();
                    return result;
                  });
                },
              }),
            );
            held();
            await operations.finish();
            held();
            return output;
          } finally {
            active = false;
            await operations.finish();
          }
        });
        current();
        return result;
      });
      pending.add(work);
      void work.then(
        () => pending.delete(work),
        () => pending.delete(work),
      );
      return work;
    },
    drifted: () => drift,
    retire: async () => {
      retired = true;
      await Promise.allSettled([...pending]);
    },
  });
}
