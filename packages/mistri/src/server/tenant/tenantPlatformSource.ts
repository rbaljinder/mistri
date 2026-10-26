/**
 * A platform-only source (`sources.<name>.realm: 'platform'`): another
 * database a tenant App's platform realm reads, and nothing else does. The
 * tenant, member, command and intake owners never hold one: they are built
 * from tenantBusinessApp, whose catalog does not have it.
 *
 * It reads what the App declares and nothing more. Each declared resource is
 * one ordinary table, found by its `physical` binding or its unique name, and
 * named by its qualified logical name (`applicants.applicant`). A table the
 * App does not declare may exist in that database — it is not the App's own —
 * but it is not in this catalog, so no read, path or reference reaches it.
 *
 * Every read is one snapshot, as the tenant reader's are: a deferred BEGIN on
 * a read-only SQLite handle, or REPEATABLE READ, READ ONLY on PostgreSQL with
 * the declared relations locked ACCESS SHARE before the first query. Each
 * snapshot attests the declared tables again — the catalog, and the CREATE
 * text on SQLite or the pg_catalog description on PostgreSQL — and the first
 * difference retires the source: DDL on a declared table refuses until
 * restart. The platform membership a read is for lives in the tenant store,
 * another database, so every read first revalidates it through the
 * deployment's genuine tenant read source; the platform read runtime checks it
 * once more before it releases a result.
 */
import { realpathSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { isProxy } from 'node:util/types';
import { ANSI_STYLE, Serial, TransactionOutcomeUnknown, type ScopedReads } from '@mistriwork/engine/adapters/adapter.js';
import { PostgresAdapter, type PostgresReadSnapshot } from '@mistriwork/engine/adapters/postgres.js';
import { createScopedReads } from '@mistriwork/engine/adapters/scoped/scopedReads.js';
import { readSqliteReadCatalog } from '@mistriwork/engine/adapters/scoped/sqliteScopeCatalog.js';
import { sqliteParams, toJsonSafe, withBytes } from '@mistriwork/engine/adapters/sqlite.js';
import type { AppDef } from '../../shared/app.js';
import { snapshotRowScope, type RowScope } from '@mistriwork/engine/shared/rowScope.js';
import type { ColumnMeta, DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { assertScopeCatalog, captureScopeCatalog, mapScopeCatalog } from '@mistriwork/engine/shared/scopeCatalog.js';
import { mapAppScopedReads } from '../app/appResources.js';
import {
  captureTenantData,
  denyTenant,
  denyTenantFor,
  TenantContextError,
  tenantIdentifier,
  tenantRecord,
} from '@mistriwork/engine/server/evidence.js';
import { PLATFORM_EVIDENCE_KEYS, type PlatformMembershipEvidence } from './tenantPlatform.js';
import type { TenantOwnershipSnapshot } from './tenantOwnership.js';
import {
  attestPostgresTenantRelations,
  pinPostgresTenantRelationsStatement,
  postgresCatalogFingerprintOf,
  tenantCatalogTrust,
} from './tenantPostgresCatalog.js';
import { postgresCatalogDigestStatement } from '@mistriwork/engine/adapters/postgresCatalogDigest.js';
import { schemaMoved } from '@mistriwork/engine/adapters/postgresSchemaEpoch.js';
import { SYSTEM_SCHEMAS } from '@mistriwork/engine/adapters/postgresCatalog.js';
import { captureTenantReadSource, type TenantReadSource } from './tenantReadSource.js';

export interface TenantPlatformSourceDeclaration {
  readonly appId: string;
  /** The source's name in the App and the connection it binds. */
  readonly source: { readonly id: string; readonly connection: string };
  /** Each declared resource by its qualified name, with its `physical` binding, or null to find it by its unique name. */
  readonly resources: Readonly<Record<string, string | null>>;
}
/** Where a source's rows live, to tell two sources apart: a SQLite file by
 * path and inode, a PostgreSQL database by server and name. A server whose
 * identity cannot be read (`system` null) is taken to be any server. */
export type TenantSourceLocation =
  | { readonly kind: 'sqlite'; readonly path: string; readonly device: number; readonly inode: number }
  | { readonly kind: 'postgres'; readonly system: string | null; readonly database: string };

/** Private pinned source, never a credential or an admission. */
export interface TenantPlatformSource {
  readonly declaration: TenantPlatformSourceDeclaration;
  /** Its declared resources under their qualified names, and nothing else. */
  readonly schema: DatabaseSchema;
  readonly location: TenantSourceLocation;
  /** Reads under this source's part of the platform scope. `membership` is the
   * deployment's genuine tenant read source, which holds `evidence`'s store. */
  scopeReads(membership: TenantReadSource, evidence: PlatformMembershipEvidence, rows: RowScope): Promise<ScopedReads>;
  close(): Promise<void>;
}

const SIMPLE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const privateName = (name: string) => name.toLowerCase().startsWith('__mistri_');

function captureDeclaration(input: TenantPlatformSourceDeclaration): TenantPlatformSourceDeclaration {
  const value = captureTenantData(input);
  tenantRecord(value, ['appId', 'source', 'resources']);
  tenantIdentifier(value.appId);
  tenantRecord(value.source, ['id', 'connection']);
  tenantIdentifier(value.source.id);
  tenantIdentifier(value.source.connection, 1024);
  if (!SIMPLE.test(value.source.id)) return denyTenant();
  tenantRecord(value.resources);
  const entries = Object.entries(value.resources);
  // A platform-only source the App reads nothing from is a declaration mistake.
  if (!entries.length || entries.length > 256) return denyTenant();
  for (const [logical, physical] of entries) {
    const prefix = `${value.source.id}.`;
    if (!logical.startsWith(prefix) || !SIMPLE.test(logical.slice(prefix.length))) return denyTenant();
    if (physical !== null) tenantIdentifier(physical, 1024);
  }
  return Object.freeze({
    appId: value.appId,
    source: Object.freeze({ ...value.source }),
    resources: Object.freeze({ ...value.resources }),
  });
}

/** A platform-only source as the App declares it: its connection and every
 * resource it names. Anything that is not a platform-only source refuses. */
export function platformSourceDeclaration(app: AppDef, name: string): TenantPlatformSourceDeclaration {
  const binding = Object.hasOwn(app.sources ?? {}, name) ? app.sources![name] : undefined;
  if (!binding || binding.realm !== 'platform' || binding.default) return denyTenant();
  const resources = Object.fromEntries(
    Object.entries(app.resources ?? {})
      .filter(([, resource]) => resource.source === name)
      .map(([logical, resource]) => [logical, resource.physical ?? null]),
  );
  return captureDeclaration({ appId: app.id, source: { id: name, connection: binding.connection }, resources });
}

/**
 * The declared resources in one physical catalog: the qualified logical
 * schema, the physical subset it maps to, and the mapping. Each resource is
 * exactly one ordinary table; a missing, ambiguous, view or reserved one
 * refuses. Keys between declared tables stay; a key to or from a table the
 * App does not declare is dropped with that table, which nothing here reads.
 */
export function platformSourceCatalog(physical: DatabaseSchema, input: TenantPlatformSourceDeclaration) {
  const declaration = captureDeclaration(input);
  const captured = captureScopeCatalog(physical);
  const dialect = captured.dialect;
  if (dialect !== 'sqlite' && dialect !== 'postgres') return denyTenant();
  // SQLite's own tables are main tables named by their name; PostgreSQL's are
  // always schema-qualified. An attached database or a substituted name refuses.
  const tables = captured.tables.filter((table) =>
    dialect === 'sqlite' ? table.id === table.name && ['', 'main'].includes(table.schema) : table.id === `${table.schema}.${table.name}`,
  );
  const logicalOf = new Map<string, string>();
  for (const [logical, binding] of Object.entries(declaration.resources)) {
    const local = logical.slice(declaration.source.id.length + 1);
    const found = tables.filter((table) => (binding === null ? table.name === local : table.id === binding));
    if (found.length !== 1) return denyTenant();
    const [table] = found;
    if (table.isView || privateName(table.name) || privateName(table.id) || /^sqlite_/i.test(table.name) || logicalOf.has(table.id))
      return denyTenant();
    logicalOf.set(table.id, logical);
  }
  const declared = new Set(logicalOf.keys());
  const kept = (column: ColumnMeta): ColumnMeta => {
    if (!column.references || declared.has(column.references.table)) return column;
    const { references: _undeclared, ...rest } = column;
    return rest;
  };
  const physicalSchema = captureScopeCatalog({
    ...captured,
    tables: captured.tables.filter((table) => declared.has(table.id)).map((table) => ({ ...table, columns: table.columns.map(kept) })),
    foreignKeys: captured.foreignKeys.filter((fk) => declared.has(fk.from.table) && declared.has(fk.to.table)),
  });
  const mapped = mapScopeCatalog(physicalSchema, logicalOf);
  const schema = captureScopeCatalog({ ...mapped, tables: mapped.tables.map((table) => ({ ...table, name: table.id, schema: '' })) });
  const resources: Readonly<Record<string, string>> = Object.freeze(
    Object.fromEntries([...logicalOf].map(([id, logical]) => [logical, id])),
  );
  return { schema, physicalSchema, resources };
}

/** This source's part of the platform scope: each declared table under the
 * rule the policy gives it, and every table it does not name denied. */
export function composePlatformSourceScope(schema: DatabaseSchema, rows: RowScope): RowScope {
  const named = snapshotRowScope(schema, rows);
  return snapshotRowScope(
    schema,
    Object.fromEntries(schema.tables.map((table) => [table.id, Object.hasOwn(named, table.id) ? named[table.id] : false])),
  );
}

/** The platform realm's catalog: the App's own tables, then each platform-only
 * source's. No key crosses between them: each source's keys are its own. */
export function withPlatformSources(schema: DatabaseSchema, outside: readonly DatabaseSchema[]): DatabaseSchema {
  if (!outside.length) return schema;
  const ids = [...schema.tables, ...outside.flatMap((source) => source.tables)].map((table) => table.id);
  if (new Set(ids).size !== ids.length) return denyTenant();
  return {
    ...schema,
    tables: [...schema.tables, ...outside.flatMap((source) => source.tables)],
    foreignKeys: [...schema.foreignKeys, ...outside.flatMap((source) => source.foreignKeys)],
  };
}

/** Startup's read of a platform-only source: its declared resources, in one
 * snapshot, or a refusal. Nothing stays open. */
export async function describeTenantPlatformSource(
  where: { readonly existingPath?: string; readonly url?: string },
  declaration: TenantPlatformSourceDeclaration,
): Promise<DatabaseSchema> {
  if (where.url !== undefined) {
    const adapter = new PostgresAdapter(where.url, 'Tenant startup platform-only source');
    try {
      return await adapter.readSnapshot(async (snapshot) => platformSourceCatalog(await snapshot.describe(), declaration).schema);
    } finally {
      await adapter.close();
    }
  }
  const db = new DatabaseSync(realpathSync(where.existingPath ?? denyTenant()), { readOnly: true, enableForeignKeyConstraints: true });
  try {
    db.exec('BEGIN');
    const schema = platformSourceCatalog(readSqliteReadCatalog(db).schema, declaration).schema;
    db.exec('COMMIT');
    return schema;
  } finally {
    db.close();
  }
}

/* The same doctrine as native auth's server separation: pg_control_system()
   is executable by PUBLIC on a stock server, and a server that will not say
   leaves the identity unknown, which is treated as the same server. Each
   question is its own snapshot, so a refused one cannot abort the other. */
async function postgresLocation(adapter: PostgresAdapter): Promise<TenantSourceLocation> {
  const database = await adapter.readSnapshot(async (snapshot) =>
    String((await snapshot.client.query('SELECT pg_catalog.current_database()::text AS database')).rows[0]?.database ?? ''),
  );
  let system: string | null = null;
  try {
    const value = await adapter.readSnapshot(
      async (snapshot) =>
        (await snapshot.client.query('SELECT system_identifier::text AS system FROM pg_catalog.pg_control_system()')).rows[0]?.system,
    );
    if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) system = value;
  } catch {
    /* unknown */
  }
  if (!database) return denyTenant();
  return Object.freeze({ kind: 'postgres', system, database });
}
/** A PostgreSQL source's location, asked of its server on a connection of its own. */
export async function readPostgresSourceLocation(url: string): Promise<TenantSourceLocation> {
  const adapter = new PostgresAdapter(url, 'Tenant source location');
  try {
    return await postgresLocation(adapter);
  } finally {
    await adapter.close();
  }
}
/** A SQLite source's location: its canonical file and inode. */
export function sqliteSourceLocation(path: string): TenantSourceLocation {
  const canonical = realpathSync(path),
    info = statSync(canonical);
  if (!info.isFile()) return denyTenant();
  return Object.freeze({ kind: 'sqlite', path: canonical, device: info.dev, inode: info.ino });
}
/** A platform-only source is never the App's own database under another
 * name: not the same file or inode, and not the same database on a server
 * that is, or may be, the same. Different engines never alias. */
export function assertTenantSourcesApart(own: TenantSourceLocation, outside: readonly TenantSourceLocation[]): void {
  for (const other of outside) {
    if (
      own.kind === 'sqlite' &&
      other.kind === 'sqlite' &&
      (own.path === other.path || (own.device === other.device && own.inode === other.inode))
    )
      return denyTenant();
    if (
      own.kind === 'postgres' &&
      other.kind === 'postgres' &&
      own.database === other.database &&
      (own.system === null || other.system === null || own.system === other.system)
    )
      return denyTenant();
  }
}

const sources = new WeakSet<TenantPlatformSource>();
/** Only a factory-made source: WeakSet lookup never runs a getter or a proxy trap. */
export function captureTenantPlatformSource(input: TenantPlatformSource): TenantPlatformSource {
  if (!sources.has(input)) return denyTenant();
  return input;
}

/** Exactly the App's platform-only sources, in its order, each a genuine
 * source declared as the App declares it now. Read by own data descriptors,
 * so an accessor never runs and a copy never stands in for a source. */
export function captureTenantPlatformSources(value: unknown, app: AppDef): readonly TenantPlatformSource[] {
  const names = Object.entries(app.sources ?? {})
    .filter(([, source]) => source.realm === 'platform')
    .map(([name]) => name);
  if (value === undefined) return names.length ? denyTenant() : Object.freeze([]);
  if (!Array.isArray(value) || isProxy(value) || Object.getOwnPropertyDescriptor(value, 'length')?.value !== names.length)
    return denyTenant();
  return Object.freeze(
    names.map((name, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !('value' in descriptor)) return denyTenant();
      const source = captureTenantPlatformSource(descriptor.value as TenantPlatformSource);
      if (JSON.stringify(source.declaration) !== JSON.stringify(platformSourceDeclaration(app, name))) return denyTenant();
      return source;
    }),
  );
}

/** What a scoped read binds to: the genuine membership source and platform
 * evidence for this App, checked before the first read is compiled. */
function admitted(
  declaration: TenantPlatformSourceDeclaration,
  membership: TenantReadSource,
  evidence: PlatformMembershipEvidence,
  rows: RowScope,
) {
  const business = captureTenantReadSource(membership);
  const captured = captureTenantData({ evidence, rows });
  tenantRecord(captured.evidence, PLATFORM_EVIDENCE_KEYS);
  tenantRecord(captured.evidence.source, ['id', 'connection']);
  const owned = business.ownership;
  if (
    captured.evidence.realm !== 'platform' ||
    captured.evidence.appId !== declaration.appId ||
    owned.appId !== declaration.appId ||
    captured.evidence.source.id !== owned.source.id ||
    captured.evidence.source.connection !== owned.source.connection
  )
    return denyTenant();
  return { business, evidence: captured.evidence, rows: captured.rows };
}

/** Opens once, read-only. Every read owns a serialized snapshot on that exact
 * handle, attests the declared tables and only then reads. */
export function openSqlitePlatformReadSource(existingPath: string, input: TenantPlatformSourceDeclaration): TenantPlatformSource {
  let opened: DatabaseSync | undefined;
  try {
    const declaration = captureDeclaration(input);
    if (typeof existingPath !== 'string' || !statSync(existingPath).isFile()) return denyTenant();
    const location = sqliteSourceLocation(existingPath);
    const db = (opened = new DatabaseSync((location as { path: string }).path, { readOnly: true, enableForeignKeyConstraints: true }));
    db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 1000');
    let pinned: { catalog: ReturnType<typeof platformSourceCatalog>; definitions: Map<string, string> } | undefined;
    let changed = false;
    const attest = () => {
      if (changed) return denyTenant();
      const actual = readSqliteReadCatalog(db);
      const catalog = platformSourceCatalog(actual.schema, declaration);
      const ids = Object.values(catalog.resources);
      if (ids.some((id) => !actual.readable.has(id))) return denyTenant();
      const definitions = new Map<string, string>();
      for (const row of db.prepare("SELECT name, sql FROM main.sqlite_schema WHERE type = 'table'").all()) {
        if (typeof row.name === 'string' && ids.includes(row.name)) {
          if (typeof row.sql !== 'string') return denyTenant();
          definitions.set(row.name, row.sql);
        }
      }
      if (definitions.size !== ids.length) return denyTenant();
      if (!pinned) {
        pinned = { catalog, definitions };
        return pinned.catalog;
      }
      try {
        // Catalog authority omits collations; the CREATE text does not.
        const before = pinned.catalog;
        if (
          JSON.stringify(before.resources) !== JSON.stringify(catalog.resources) ||
          [...pinned.definitions].some(([id, sql]) => definitions.get(id) !== sql)
        )
          denyTenant();
        assertScopeCatalog(before.physicalSchema, catalog.physicalSchema);
      } catch {
        changed = true;
        return denyTenant();
      }
      return pinned.catalog;
    };
    db.exec('BEGIN');
    const catalog = attest();
    db.exec('COMMIT');
    const { schema } = catalog;
    const toPhysical = (id: string): string => (Object.hasOwn(catalog.resources, id) ? catalog.resources[id] : denyTenant());
    const physicalIds = new Map(Object.entries(catalog.resources).map(([logical, physical]) => [physical, logical]));
    const toLogical = (id: string): string => physicalIds.get(id) ?? denyTenant();

    const queue = new Serial();
    let closing = false;
    let closed: Promise<void> | undefined;
    const active = () => {
      if (closing) denyTenant();
    };
    const close = (): Promise<void> => {
      if (!closed) {
        closing = true;
        closed = queue.run(async () => {
          try {
            db.close();
          } catch {
            return denyTenant();
          }
        });
      }
      return closed;
    };
    const snapshot = async <T>(work: () => T | Promise<T>): Promise<T> => {
      active();
      if (db.isTransaction) return denyTenant();
      db.exec('BEGIN');
      try {
        attest();
        const result = await work();
        active();
        db.exec('COMMIT');
        return result;
      } finally {
        if (db.isTransaction) {
          try {
            db.exec('ROLLBACK');
          } catch {
            void close().catch(() => {});
          }
        }
      }
    };
    const invoke = <A, R>(value: A, work: (captured: A) => R | Promise<R>): Promise<R> => {
      let captured: A;
      try {
        active();
        captured = captureTenantData(value);
      } catch {
        return Promise.reject(new TenantContextError());
      }
      return queue.run(async () => {
        try {
          const result = await snapshot(() => work(captured));
          active();
          return result;
        } catch (error) {
          return denyTenantFor(error);
        }
      });
    };
    const source: TenantPlatformSource = Object.freeze({
      declaration,
      schema,
      location,
      async scopeReads(membership: TenantReadSource, evidence: PlatformMembershipEvidence, rows: RowScope): Promise<ScopedReads> {
        try {
          active();
          // Nothing is read here: every read below revalidates the membership first.
          const bound = admitted(declaration, membership, evidence, rows);
          const scope = composePlatformSourceScope(schema, bound.rows);
          const physicalScope = Object.fromEntries(Object.entries(scope).map(([id, rule]) => [toPhysical(id), rule]));
          const reads = mapAppScopedReads(
            createScopedReads(pinned!.catalog.physicalSchema, physicalScope, ANSI_STYLE, async (sql, hint) => {
              const started = performance.now();
              const statement = db.prepare(sql.text);
              statement.setReadBigInts(true);
              const found = statement.all(...sqliteParams(sql.params)) as Record<string, unknown>[];
              return {
                columns: statement.columns().map((column) => column.name),
                rows: found.map(hint?.binary ? withBytes : toJsonSafe),
                ms: Math.round(performance.now() - started),
                sql,
              };
            }),
            { schema, toPhysical, toLogical },
          );
          // Revalidate first, in the tenant store, then read in this source's own snapshot.
          const run = <A extends unknown[], R>(args: A, work: (...args: A) => Promise<R>): Promise<R> =>
            (async () => {
              await bound.business.assertPlatformCurrent(bound.evidence);
              return invoke(args, (captured) => work(...captured));
            })();
          return Object.freeze({
            query: (request) => run([request], reads.query),
            count: (table, filter, limit) => run([table, filter, limit], reads.count),
            runView: (view, offset) => run([view, offset], reads.runView),
            countView: (view, limit) => run([view, limit], reads.countView),
            runBreakdown: (breakdown, offset) => run([breakdown, offset], reads.runBreakdown),
            countBreakdown: (breakdown, limit) => run([breakdown, limit], reads.countBreakdown),
          } satisfies ScopedReads);
        } catch {
          return denyTenant();
        }
      },
      close,
    });
    sources.add(source);
    return source;
  } catch {
    try {
      opened?.close();
    } catch {
      /* Construction never publishes its handle. */
    }
    return denyTenant();
  }
}

/**
 * The PostgreSQL counterpart: a dedicated read pool, every read one
 * REPEATABLE READ, READ ONLY snapshot on one leased reader. The declared
 * relations are found once, then pinned: each later snapshot locks them
 * ACCESS SHARE before its first query — PostgreSQL takes the snapshot there —
 * and compares the catalog and the pg_catalog description with what the
 * source opened with.
 */
export async function openPostgresPlatformReadSource(
  url: string,
  input: TenantPlatformSourceDeclaration,
  trustFor: number = tenantCatalogTrust(),
): Promise<TenantPlatformSource> {
  let opened: PostgresAdapter | undefined;
  try {
    const declaration = captureDeclaration(input);
    if (typeof url !== 'string' || !/^postgres(ql)?:\/\//i.test(url) || !Number.isSafeInteger(trustFor) || trustFor < 0)
      return denyTenant();
    let reader = (opened = new PostgresAdapter(url, 'Private platform-only reader'));
    // Found once without a lock, then attested under one: the two must agree.
    const found = await reader.readSnapshot(async (snapshot) => platformSourceCatalog(await snapshot.describe(), declaration));
    // Asked once, at construction: row scopes inline on Postgres 12 and later (rowScope.ts).
    const style = await reader.scopeStyle();
    const ids = Object.values(found.resources);
    // attestPostgresTenantRelations reads `resources` and `ownership` only:
    // the declared relations, none of them with an ownership column.
    const described = (client: PostgresReadSnapshot['client'], catalog: ReturnType<typeof platformSourceCatalog>) =>
      attestPostgresTenantRelations(client, { resources: catalog.resources, ownership: {} } as unknown as TenantOwnershipSnapshot);
    let definitions: string | undefined;
    let changed = false;
    /* As the App's own source does (tenantReadSource.ts): every snapshot
       begins with the LOCK and a digest of the catalog rows the attestation
       reads, in the message that begins it, and the full attestation runs
       again only when the digest has moved since it last passed. */
    const pin = pinPostgresTenantRelationsStatement(ids) ?? denyTenant();
    // The runtime schema stays in: the tenant store attested in this snapshot is in it, and a change there must move the digest.
    const digest = postgresCatalogDigestStatement(SYSTEM_SCHEMAS);
    const prologue = `${pin}; ${digest}`;
    let attested: string | undefined;
    /* And, as there, an attestation that passed stands for the snapshots begun within `trustFor` of it, which
       take the LOCK alone: the digest walks every catalog row, and was most of the database's time read per snapshot. */
    let checked: number | undefined;
    const standing = (): string | undefined => {
      const now = Date.now();
      return attested !== undefined && checked !== undefined && now >= checked && now - checked < trustFor ? attested : undefined;
    };
    const attest = async (snapshot: PostgresReadSnapshot, stood?: string) => {
      if (changed) return denyTenant();
      if (stood !== undefined) {
        if (snapshot.prologue?.length !== 1) return denyTenant();
        if (stood === attested) return;
      } else if (snapshot.prologue?.length !== 2) return denyTenant();
      const fingerprint = postgresCatalogFingerprintOf(stood === undefined ? snapshot.prologue![1] : await snapshot.client.query(digest));
      if (fingerprint !== attested) {
        await full(snapshot);
        attested = fingerprint;
      }
      checked = Date.now();
    };
    const full = async (snapshot: PostgresReadSnapshot) => {
      const catalog = platformSourceCatalog(await snapshot.describe(), declaration);
      const description = await described(snapshot.client, catalog);
      if (definitions === undefined) {
        if (JSON.stringify(catalog.resources) !== JSON.stringify(found.resources)) return denyTenant();
        assertScopeCatalog(found.physicalSchema, catalog.physicalSchema);
        definitions = description;
        return;
      }
      try {
        if (JSON.stringify(catalog.resources) !== JSON.stringify(found.resources) || description !== definitions) denyTenant();
        assertScopeCatalog(found.physicalSchema, catalog.physicalSchema);
      } catch {
        changed = true;
        return denyTenant();
      }
    };
    await reader.readSnapshot(attest, false, prologue);
    const location = await postgresLocation(reader);
    const { schema } = found;
    const toPhysical = (id: string): string => (Object.hasOwn(found.resources, id) ? found.resources[id] : denyTenant());
    const physicalIds = new Map(Object.entries(found.resources).map(([logical, physical]) => [physical, logical]));
    const toLogical = (id: string): string => physicalIds.get(id) ?? denyTenant();

    const queue = new Serial();
    let closing = false;
    let closed: Promise<void> | undefined;
    let lent: PostgresReadSnapshot | undefined;
    const active = () => {
      if (closing) denyTenant();
    };
    const close = (): Promise<void> => {
      if (!closed) {
        closing = true;
        closed = queue.run(async () => {
          try {
            await reader.close();
          } catch {
            return denyTenant();
          }
        });
      }
      return closed;
    };
    const invoke = <A, R>(value: A, work: (captured: A) => Promise<R>): Promise<R> => {
      let captured: A;
      try {
        active();
        captured = captureTenantData(value);
      } catch {
        return Promise.reject(new TenantContextError());
      }
      return queue.run(async () => {
        try {
          active();
          const stood = standing();
          const result = await reader.readSnapshot(
            async (lease) => {
              lent = lease;
              try {
                await attest(lease, stood);
                const out = await work(captured);
                active();
                return out;
              } finally {
                lent = undefined;
              }
            },
            false,
            stood === undefined ? prologue : pin,
          );
          active();
          return result;
        } catch (error) {
          if (schemaMoved(error)) attested = checked = undefined;
          /* A ROLLBACK that could not be sent lost its connection, which the
             server ended and the pool discarded. This read is refused as the
             database's fault; the source is not. Retiring it here, as until
             rc.1, refused the platform realm's every read until a restart
             after one connection a pooler or failover ended. The pool is
             replaced instead, as the App's own reader does
             (tenantReadSource.ts), and its catalog attested in full again on
             the next read. Reads run one at a time here, so none is on the
             old pool. */
          if (error instanceof TransactionOutcomeUnknown && !closing) {
            const failed = reader;
            reader = new PostgresAdapter(url, 'Private platform-only reader');
            attested = checked = undefined;
            void failed.close().catch(() => {});
          }
          return denyTenantFor(error);
        }
      });
    };
    const source: TenantPlatformSource = Object.freeze({
      declaration,
      schema,
      location,
      async scopeReads(membership: TenantReadSource, evidence: PlatformMembershipEvidence, rows: RowScope): Promise<ScopedReads> {
        try {
          active();
          // Nothing is read here: every read below revalidates the membership first.
          const bound = admitted(declaration, membership, evidence, rows);
          const scope = composePlatformSourceScope(schema, bound.rows);
          const physicalScope = Object.fromEntries(Object.entries(scope).map(([id, rule]) => [toPhysical(id), rule]));
          const reads = mapAppScopedReads(
            createScopedReads(found.physicalSchema, physicalScope, style, async (sql, hint) => (lent ?? denyTenant()).execute(sql, hint)),
            { schema, toPhysical, toLogical },
          );
          const run = <A extends unknown[], R>(args: A, work: (...args: A) => Promise<R>): Promise<R> =>
            (async () => {
              await bound.business.assertPlatformCurrent(bound.evidence);
              return invoke(args, (captured) => work(...captured));
            })();
          return Object.freeze({
            query: (request) => run([request], reads.query),
            count: (table, filter, limit) => run([table, filter, limit], reads.count),
            runView: (view, offset) => run([view, offset], reads.runView),
            countView: (view, limit) => run([view, limit], reads.countView),
            runBreakdown: (breakdown, offset) => run([breakdown, offset], reads.runBreakdown),
            countBreakdown: (breakdown, limit) => run([breakdown, limit], reads.countBreakdown),
          } satisfies ScopedReads);
        } catch {
          return denyTenant();
        }
      },
      close,
    });
    sources.add(source);
    return source;
  } catch {
    try {
      await opened?.close();
    } catch {
      /* Construction never publishes its pool. */
    }
    return denyTenant();
  }
}
