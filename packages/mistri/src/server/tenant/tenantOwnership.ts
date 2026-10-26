import type { ColumnMeta, DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { assertScopeCatalog, captureScopeCatalog, mapScopeCatalog } from '@mistriwork/engine/shared/scopeCatalog.js';
import { captureTenantData, denyTenant, tenantIdentifier, tenantRecord } from '@mistriwork/engine/server/evidence.js';

/** `platform` rows belong to the platform realm: never readable or writable in
 * a tenant context, read in a platform context under its own row policy. */
export type ResourceOwnership =
  | { readonly kind: 'tenant'; readonly column: string }
  | { readonly kind: 'global'; readonly access: 'read-only' }
  | { readonly kind: 'platform' };
export interface TenantOwnershipInput {
  readonly appId: string;
  readonly source: { readonly id: string; readonly connection: string };
  readonly schema: DatabaseSchema;
  readonly physicalSchema: DatabaseSchema;
  readonly resources: Readonly<Record<string, string>>;
  readonly ownership: Readonly<Record<string, ResourceOwnership>>;
  /** The platform-owned resource with one row per tenant (`auth.tenancy.profile`):
   * the one platform resource a tenant row may reference, and only through its
   * ownership column. */
  readonly profile?: string;
}
/** Deployment evidence only. This object cannot open a reader or writer. */
export type TenantOwnershipSnapshot = TenantOwnershipInput;
const simple = /^[A-Za-z_][A-Za-z0-9_]*$/;
const privateName = (name: string) => name.toLowerCase().startsWith('__mistri_');

const snapshots = new WeakSet<object>();
/** Test-only: how many ownership declarations were judged in full, and how
 * many were read back from the database and judged to compare with one. */
export const ownershipCounters = { validated: 0, attested: 0 };

/** One owned SQLite or PostgreSQL source, complete explicit logical ownership.
 * Catalog evidence does not attest SQL collations, triggers or tenant-local
 * uniqueness; the sources do. No data capability is enabled by validating this declaration. */
export function captureTenantOwnership(input: TenantOwnershipInput): TenantOwnershipSnapshot {
  /* A snapshot this function returned is frozen data that already passed every
     check below, and nothing can change it: judged again, it could only pass
     again. Every tenant request, and every read in it, used to re-copy and
     re-check the whole catalog here (G118). */
  if (input && typeof input === 'object' && snapshots.has(input)) return input;
  ownershipCounters.validated++;
  return judgeOwnership(input);
}

function judgeOwnership(input: TenantOwnershipInput): TenantOwnershipSnapshot {
  try {
    const given = captureTenantData(input);
    tenantRecord(given, ['appId', 'source', 'schema', 'physicalSchema', 'resources', 'ownership', 'profile']);
    tenantIdentifier(given.appId);
    tenantRecord(given.source, ['id', 'connection']);
    tenantIdentifier(given.source.id);
    tenantIdentifier(given.source.connection, 1024);
    if (!simple.test(given.source.id)) return denyTenant();
    const schema = captureScopeCatalog(given.schema),
      physicalSchema = captureScopeCatalog(given.physicalSchema);
    const dialect = physicalSchema.dialect;
    if (
      (dialect !== 'sqlite' && dialect !== 'postgres') ||
      schema.dialect !== dialect ||
      !schema.tables.length ||
      schema.tables.length > 256
    )
      return denyTenant();
    tenantRecord(given.resources);
    tenantRecord(given.ownership);
    const logical = new Set(schema.tables.map((table) => table.id));
    if (
      Object.keys(given.resources).length !== logical.size ||
      Object.keys(given.ownership).length !== logical.size ||
      Object.keys(given.resources).some((id) => !logical.has(id)) ||
      Object.keys(given.ownership).some((id) => !logical.has(id))
    )
      return denyTenant();
    const physical = new Map(physicalSchema.tables.map((table) => [table.id, table]));
    // SQLite's canonical IDs are main-table names; PostgreSQL's are always
    // schema-qualified. A presentation-only catalog comparison cannot attest
    // an attached database or a substituted SQL name.
    if (
      physicalSchema.tables.some((table) =>
        dialect === 'sqlite'
          ? table.id !== table.name || !['', 'main'].includes(table.schema)
          : !table.schema || table.id !== `${table.schema}.${table.name}`,
      )
    )
      return denyTenant();
    const mapped = new Map<string, string>();
    let tenants = 0;
    for (const table of schema.tables) {
      if (!simple.test(table.id) || privateName(table.id) || table.isView) return denyTenant();
      const id = given.resources[table.id];
      tenantIdentifier(id, 1024);
      const source = physical.get(id);
      if (!source || source.isView || privateName(source.name) || privateName(source.id) || mapped.has(id)) return denyTenant();
      mapped.set(id, table.id);
      const ownership = given.ownership[table.id];
      tenantRecord(ownership);
      if (ownership.kind === 'tenant') {
        tenantRecord(ownership, ['kind', 'column']);
        tenantIdentifier(ownership.column);
        const field = table.columns.find((column) => column.name === ownership.column);
        // SQLite's type-affinity precedence puts INT ahead of CHAR/CLOB/TEXT.
        // PostgreSQL admits text and varchar only: character(n) ignores
        // trailing spaces ('north ' = 'north') and citext folds case, whatever
        // the collation. The sources attest the collation is deterministic.
        if (
          !field ||
          field.nullable ||
          field.identity ||
          (dialect === 'sqlite'
            ? /INT/i.test(field.type) || !/CHAR|CLOB|TEXT/i.test(field.type)
            : field.type !== 'text' && field.type !== 'character varying')
        )
          return denyTenant();
        tenants++;
      } else if (ownership.kind === 'global') {
        tenantRecord(ownership, ['kind', 'access']);
        if (ownership.access !== 'read-only') return denyTenant();
      } else if (ownership.kind === 'platform') {
        tenantRecord(ownership, ['kind']);
      } else return denyTenant();
    }
    if (!tenants) return denyTenant();
    if (given.profile !== undefined) {
      tenantIdentifier(given.profile);
      if (!logical.has(given.profile) || given.ownership[given.profile].kind !== 'platform') return denyTenant();
    }
    assertScopeCatalog(schema, mapScopeCatalog(physicalSchema, mapped));
    // A global row is readable in every context, so it references globals
    // only. A tenant row references tenant or global rows, and a platform row
    // only as the profile through its own ownership column: any other key
    // would lead a tenant page into rows its context cannot read. A platform
    // row may reference anything; its context reads across tenants.
    const checkEdge = (from: string, to: string, columns: readonly string[]) => {
      const source = given.ownership[from],
        target = given.ownership[to];
      if (source.kind === 'global' && target.kind !== 'global') denyTenant();
      if (
        source.kind === 'tenant' &&
        target.kind === 'platform' &&
        (to !== given.profile || columns.length !== 1 || columns[0] !== source.column)
      )
        denyTenant();
    };
    for (const fk of schema.foreignKeys) checkEdge(fk.from.table, fk.to.table, fk.from.columns);
    for (const table of schema.tables)
      for (const column of table.columns) {
        if (column.references) checkEdge(table.id, column.references.table, [column.name]);
      }
    // Captured, so a later capture of a request carrying it reuses it whole (evidence.ts).
    const snapshot = captureTenantData({ ...given, schema, physicalSchema });
    snapshots.add(snapshot);
    return snapshot;
  } catch {
    return denyTenant();
  }
}

/** Revalidation cannot silently adopt another source, mapping or ownership rule. */
export function assertTenantOwnership(expected: TenantOwnershipSnapshot, actual: TenantOwnershipInput): void {
  try {
    /* `actual` is read back from the database by the caller, for exactly this
       comparison: it is new every time and judged in full every time. */
    const before = captureTenantOwnership(expected);
    ownershipCounters.attested++;
    const after = judgeOwnership(actual);
    if (
      before.appId !== after.appId ||
      before.source.id !== after.source.id ||
      before.source.connection !== after.source.connection ||
      before.profile !== after.profile
    )
      return denyTenant();
    for (const id of Object.keys(before.resources)) {
      const a = before.ownership[id],
        b = after.ownership[id];
      if (
        before.resources[id] !== after.resources[id] ||
        !b ||
        a.kind !== b.kind ||
        (a.kind === 'tenant' && (b.kind !== 'tenant' || a.column !== b.column))
      )
        return denyTenant();
    }
    assertScopeCatalog(before.schema, after.schema);
    assertScopeCatalog(before.physicalSchema, after.physicalSchema);
  } catch {
    return denyTenant();
  }
}

/* The two catalog refusals an author meets first, in words that name the
   table and the fix. Recorded on the refusal (evidence.ts), never sent: a
   caller still sees only that the tenant context could not be verified. */
export const tenantKeyRefusal = (
  table: string,
  column: string,
  primary: readonly Pick<ColumnMeta, 'name' | 'type' | 'nullable' | 'identity'>[],
): string => {
  /* The rule, the two keys that keep it, and why the one this table has does not: SQLite reports a `text primary key`
     without NOT NULL as nullable, so the opaque id an author meant is refused for a word they did not write. */
  const rule =
    ` A tenant-owned table's primary key includes its ownership column, as PRIMARY KEY ("${column}", id), or is one ` +
    'opaque text id declared NOT NULL, as `id text not null primary key`.';
  if (!primary.length) return `Table "${table}" has no primary key.${rule}`;
  const [only] = primary;
  const why =
    primary.length > 1
      ? ` Its key (${primary.map((each) => `"${each.name}"`).join(', ')}) leaves "${column}" out.`
      : only.identity || /INT|SERIAL|NUMERIC|DECIMAL|REAL|DOUBLE/i.test(only.type)
        ? ` Its key "${only.name}" is ${only.type || 'a number'}, which counts across every tenant: add "${column}" to the key, or key it by a text id.`
        : only.nullable
          ? ` Its key "${only.name}" is ${only.type || 'untyped'} and may be null (SQLite reads a primary key without NOT NULL as nullable): declare it NOT NULL.`
          : ` Its key "${only.name}" is ${only.type || 'untyped'}, not text.`;
  return `Table "${table}" is owned by tenant column "${column}", and its primary key keeps neither form.${rule}${why}`;
};
export const tenantUniqueRefusal = (table: string, index: string | undefined, column: string): string =>
  `${index ? `Unique index "${index}"` : 'A unique index'} on "${table}" does not include tenant column "${column}": ` +
  `uniqueness has to hold within one tenant, so add "${column}" to it, as UNIQUE ("${column}", …). ` +
  'Only a table keyed by one opaque text id may keep that id unique on its own.';
