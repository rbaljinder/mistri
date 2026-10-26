import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { accessibleSchema, type ResourceAccess } from '../app/appAccess.js';
import type { TenantOwnershipSnapshot } from './tenantOwnership.js';

/** Which context a principal reads in: a tenant's, or the platform realm's. */
type TenantRealm = 'tenant' | 'platform';

/** Non-key managed ownership is private platform metadata. Composite owner keys
 * must remain complete and readable under the existing deployment contract;
 * never invent a smaller public key by dropping one of its components.
 *
 * In a tenant context a platform-owned table is not a resource at all: it
 * leaves the readable set whatever a role grants, one of the two independent
 * layers (the other is its `false` row scope) that keep platform rows out of
 * tenant reads, counts, references and page plans. In the platform context
 * the ownership column is readable — the realm reads across tenants and says
 * whose row it is — and only the platform's own tables are writable: a tenant's rows and global ones change through commands alone.
 *
 * `held` are the profile's columns the platform manages as it manages an
 * owner (platformHeldColumns): readable, never generically written. */
export function tenantVisibleFields(
  owned: TenantOwnershipSnapshot,
  access: ResourceAccess,
  realm: TenantRealm = 'tenant',
  held: ReadonlySet<string> = new Set(),
): ResourceAccess {
  const hidden = (id: string) => realm === 'tenant' && owned.ownership[id]?.kind === 'platform';
  const readable = new Set([...access.readable].filter((id) => !hidden(id)));
  const writable = new Set(
    [...access.writable].filter((id) => (realm === 'platform' ? owned.ownership[id]?.kind === 'platform' : !hidden(id))),
  );
  return {
    ...access,
    readable,
    writable,
    fields: new Map(
      owned.schema.tables
        .filter((table) => readable.has(table.id))
        .map((table) => {
          const rule = owned.ownership[table.id],
            allowed = access.fields?.get(table.id);
          const managed = (name: string) => rule.kind === 'tenant' && name === rule.column;
          const read = new Set(
            table.columns
              .filter(
                (column) =>
                  (realm === 'platform' || !managed(column.name) || column.primaryKey) && (allowed?.read.has(column.name) ?? true),
              )
              .map((column) => column.name),
          );
          const kept = (name: string) => table.id === owned.profile && held.has(name);
          const write = new Set(
            [...read].filter(
              (column) => writable.has(table.id) && !managed(column) && !kept(column) && (allowed?.write.has(column) ?? true),
            ),
          );
          return [table.id, { read, write }];
        }),
    ),
  };
}

/**
 * The profile's columns the platform realm manages as it manages an owner, and
 * so never writes generically: its key and whatever a tenant row's key names
 * on it — the tenant's identity, which every one of its rows carries — and the
 * addresses the deployment's policy reads off it (`intake.address`,
 * `public.address`), which place a visitor with a tenant. Rotating either is
 * a command's job, which says what it does; a Save that retyped one would
 * move a tenant's forms and pages to wherever the new text resolves.
 */
export function platformHeldColumns(owned: TenantOwnershipSnapshot, addresses: readonly (string | undefined)[]): ReadonlySet<string> {
  const profile = owned.profile === undefined ? undefined : owned.schema.tables.find((table) => table.id === owned.profile);
  if (!profile) return new Set();
  return new Set([
    ...profile.columns.filter((column) => column.primaryKey).map((column) => column.name),
    ...owned.schema.foreignKeys.filter((fk) => fk.to.table === profile.id).flatMap((fk) => fk.to.columns),
    ...owned.schema.tables.flatMap((table) =>
      table.columns.flatMap((column) => (column.references?.table === profile.id ? [column.references.column] : [])),
    ),
    ...addresses.filter((column): column is string => typeof column === 'string'),
  ]);
}

/**
 * Whether the platform realm may make a new row of `id` generically: a table
 * of its own it writes, with a readable key, never the profile — a tenant's
 * profile row is made with the tenant. Pure structure; the writer still
 * judges every row.
 */
export function platformInsertable(owned: TenantOwnershipSnapshot, access: ResourceAccess, id: string): boolean {
  const table = owned.schema.tables.find((each) => each.id === id);
  const read = access.fields?.get(id)?.read;
  return (
    table !== undefined &&
    !table.isView &&
    id !== owned.profile &&
    owned.ownership[id]?.kind === 'platform' &&
    access.writable.has(id) &&
    (access.creatable?.has(id) ?? true) &&
    table.columns.some((column) => column.primaryKey) &&
    table.columns.every((column) => !column.primaryKey || (read?.has(column.name) ?? true))
  );
}

/**
 * Whether the platform realm may remove a row of `id` generically, before any
 * row is read: a table of its own it writes in every column, keyed, never the
 * profile, and one no key anywhere refers to. That last is the tenant
 * realm's own rule (tenantDeleteEligible), and here it is also the fence a
 * cascade would otherwise cross: a platform row a tenant's row points at
 * could take that row with it.
 */
export function platformDeletable(owned: TenantOwnershipSnapshot, access: ResourceAccess, id: string): boolean {
  const table = owned.schema.tables.find((each) => each.id === id);
  if (
    table === undefined ||
    table.isView ||
    id === owned.profile ||
    owned.ownership[id]?.kind !== 'platform' ||
    !access.readable.has(id) ||
    !access.writable.has(id) ||
    !table.columns.some((column) => column.primaryKey)
  )
    return false;
  const fields = access.fields?.get(id);
  if (
    table.columns.some(
      (column) => !(fields?.read.has(column.name) ?? true) || (!column.primaryKey && !(fields?.write.has(column.name) ?? true)),
    )
  )
    return false;
  const physical = owned.resources[id];
  return !(
    owned.physicalSchema.foreignKeys.some((fk) => fk.to.table === physical) ||
    owned.physicalSchema.tables.some((each) => each.columns.some((column) => column.references?.table === physical))
  );
}

/** Validation catalog, not principal admission or a capability. It omits only
 * attested managed fields, retaining ordinary NOT NULL/default requirements.
 *
 * One realm's catalog, because authoring is judged in the realm each
 * declaration names: the tenant's (the default) leaves out the platform's
 * tables and the ownership column, and the platform's holds every table with
 * the ownership column it reads. Neither widens what a context may read —
 * that is the row scope's and the runtime's to decide; this only says which
 * catalog an authored view, page, form or nav entry is checked against. */
export function tenantAuthoringSchema(owned: TenantOwnershipSnapshot, realm: TenantRealm = 'tenant'): DatabaseSchema {
  const resources = new Set(owned.schema.tables.map((table) => table.id));
  const pruned = accessibleSchema(owned.schema, tenantVisibleFields(owned, { readable: resources, writable: resources }, realm));
  /* A key unique within the tenant, `UNIQUE (tenant_id, number)`, is an
     address in the tenant's realm (appAddress.ts naturalKeyProblems): every
     read there is one tenant's. Pruning drops a pair one of whose columns is
     hidden, and the ownership column always is, so the pair is put back,
     ownership column and all — this catalog judges declarations and admits
     no one, and the column is named by the deployment's own policy. */
  return {
    ...pruned,
    tables: pruned.tables.map((table) => {
      const rule = owned.ownership[table.id];
      const full = owned.schema.tables.find((candidate) => candidate.id === table.id);
      if (realm !== 'tenant' || rule?.kind !== 'tenant' || !full?.uniquePairs) return table;
      const readable = (name: string) => table.columns.some((column) => column.name === name);
      const pairs = full.uniquePairs.filter(
        (pair) =>
          pair.every((name) => readable(name) || name === rule.column) && pair.some((name) => readable(name) && name !== rule.column),
      );
      return pairs.length ? { ...table, uniquePairs: pairs } : table;
    }),
  };
}
