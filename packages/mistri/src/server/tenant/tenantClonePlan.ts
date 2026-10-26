/**
 * What a tenant clone copies, and how each copied value is rewritten. An App marks a tenant-owned resource `clone: 'config'` (its rows are
 * always copied) or `clone: 'sample'` (only when the clone asks for samples);
 * an unmarked resource is never copied. This module is the plan alone: pure,
 * read off the App and the attested ownership snapshot, and judged at startup
 * so an App whose marks cannot be honoured is refused before anyone clones.
 *
 * The copy is one tenant's rows into a fresh tenant, and every value that
 * names a tenant-owned row is rewritten so the copy names only its own:
 *
 * - The row's tenant column becomes the new tenant. A key that includes it
 *   (`(tenant_id, number)`) is then unique as it stands, and is kept.
 * - A key that is one opaque text id is unique across tenants, so the copy's
 *   is a hash of the new tenant, the resource and the old id: stable (the
 *   same source row always maps to the same copy) and never the old id.
 * - A reference follows its target: into the target's tenant column, the new
 *   tenant; into a hashed key, the same hash; into a global or the profile,
 *   unchanged, since those are no tenant's own.
 *
 * A config row may reference only config rows, a sample row config or sample
 * rows. A reference the clone leaves behind (to an unmarked resource, or from
 * config to sample) is cleared where the column may be null, and refused
 * where it may not: copying the old value would point the sandbox at the
 * source tenant's rows, which is the one thing a clone must never do.
 * Auto-increment ids are refused outright: a copied value would collide with
 * the sequence, and a fresh one would break every reference to the row.
 */
import { createHash } from 'node:crypto';
import type { AppDef, ResourceClone } from '../../shared/app.js';
import type { ColumnMeta, TableMeta } from '@mistriwork/engine/shared/schema.js';
import type { AppTenantPolicy } from '../policy/appTenantPolicy.js';
import type { TenantOwnershipSnapshot } from './tenantOwnership.js';
import { intakeProfileKey } from './tenantIntakeModel.js';

/** A plan the App cannot honour, in words that name the resource and the fix. */
export class TenantCloneRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantCloneRefusal';
  }
}
const refuse = (message: string): never => {
  throw new TenantCloneRefusal(message);
};

/** How one column of a copied row is written. */
type CloneColumnRule =
  /** The new tenant: the row's own tenant column, or a reference into a target's. */
  | Readonly<{ kind: 'tenant' }>
  /** The hashed id of the named resource's row: its own opaque key, or a reference to one. */
  | Readonly<{ kind: 'hashed'; resource: string }>
  /** Null: a reference the clone leaves behind, or a profile column no two tenants may share. */
  | Readonly<{ kind: 'clear' }>
  | Readonly<{ kind: 'keep' }>;

export interface CloneTable {
  readonly resource: string;
  /** The physical table, quoted in the engine's spelling. */
  readonly from: string;
  /** `profile` is the platform's row for the tenant (`auth.tenancy.profile`), copied so the new tenant has one. */
  readonly copy: ResourceClone | 'profile';
  /** The column that names the tenant: its ownership column, or the profile's key. */
  readonly tenant: string;
  readonly columns: readonly string[];
  /** The key columns besides the tenant column, which identify a row within its tenant. */
  readonly keys: readonly string[];
  readonly rules: Readonly<Record<string, CloneColumnRule>>;
  /** References from this table into itself (a parent row), besides the tenant column: rows are inserted parents first. */
  readonly self: readonly Readonly<{ from: readonly string[]; to: readonly string[] }>[];
}
export interface TenantClonePlan {
  readonly appId: string;
  readonly dialect: 'sqlite' | 'postgres';
  /** Profile first, then every referenced table before the tables that reference it. */
  readonly tables: readonly CloneTable[];
}

const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;
/* Plans this module made: a clone writes only from one, never from a shape a caller assembled. */
const issued = new WeakSet<object>();
export const isTenantClonePlan = (value: unknown): value is TenantClonePlan => !!value && typeof value === 'object' && issued.has(value);

/** A copied opaque id: the same source row always maps to the same copy, UUID-shaped so a `uuid` key takes it. */
export function cloneKey(tenantId: string, resource: string, old: string): string {
  const hex = createHash('sha256').update(`mistri:clone:v1\0${tenantId}\0${resource}\0${old}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex[16], 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The App's clone plan, or undefined when it marks no resource. Refuses, with
 * a message naming the resource, what no clone could copy safely.
 */
export function tenantClonePlan(
  app: AppDef,
  owned: TenantOwnershipSnapshot,
  policy?: Pick<AppTenantPolicy, 'intake' | 'public'>,
): TenantClonePlan | undefined {
  const marked = new Map<string, ResourceClone>();
  for (const [name, resource] of Object.entries(app.resources ?? {})) if (resource.clone) marked.set(name, resource.clone);
  if (!marked.size) return undefined;
  const dialect = owned.schema.dialect === 'postgres' ? 'postgres' : 'sqlite';
  const tableOf = (id: string): TableMeta =>
    owned.schema.tables.find((table) => table.id === id) ?? refuse(`"${id}" is marked clone, and its source has no table for it.`);
  const physical = (id: string) => {
    const name = owned.resources[id];
    if (dialect === 'sqlite') return `main.${quoted(name)}`;
    const dot = name.indexOf('.');
    return `${quoted(name.slice(0, dot))}.${quoted(name.slice(dot + 1))}`;
  };
  /* Every reference out of a table, declared or read off the catalog, as column legs. */
  const legsOf = (id: string) => {
    const legs: { from: readonly string[]; to: string; toColumns: readonly string[] }[] = [];
    for (const fk of owned.schema.foreignKeys)
      if (fk.from.table === id) legs.push({ from: fk.from.columns, to: fk.to.table, toColumns: fk.to.columns });
    for (const column of tableOf(id).columns)
      if (
        column.references &&
        !legs.some((leg) => leg.from.length === 1 && leg.from[0] === column.name && leg.to === column.references!.table)
      )
        legs.push({ from: [column.name], to: column.references.table, toColumns: [column.references.column] });
    return legs;
  };
  const autoIncrement = (column: ColumnMeta) =>
    column.identity !== undefined || (column.default !== undefined && /nextval\(/i.test(column.default));

  /* Each copied table's own key: kept beside its tenant column, or hashed. */
  const strategy = new Map<string, { tenant: string; keys: readonly string[]; hashed: boolean }>();
  for (const [id, copy] of marked) {
    const rule = owned.ownership[id];
    if (rule?.kind !== 'tenant')
      refuse(
        `"${id}" is marked clone "${copy}", and the tenant policy does not make it tenant-owned: only a tenant's own rows are copied.`,
      );
    const table = tableOf(id);
    const primary = table.columns.filter((column) => column.primaryKey);
    for (const column of table.columns)
      if (autoIncrement(column))
        refuse(
          `"${id}" is marked clone "${copy}", and its column "${column.name}" is generated by the database (an identity or sequence). ` +
            'A copied value would collide with the sequence and a fresh one would break every reference to the row: ' +
            'give it an opaque text id, or a key that includes the tenant column.',
        );
    const keyed = primary.some((column) => column.name === (rule as { column: string }).column);
    strategy.set(id, {
      tenant: (rule as { column: string }).column,
      keys: primary.filter((column) => column.name !== (rule as { column: string }).column).map((column) => column.name),
      hashed: !keyed,
    });
  }

  /* What a reference into `to` is rewritten as, for a row of class `copy`; undefined where the clone leaves it behind. */
  const reached = (copy: ResourceClone, to: string, toColumn: string): CloneColumnRule | undefined => {
    const target = owned.ownership[to];
    if (!target || target.kind === 'global') return { kind: 'keep' };
    if (target.kind === 'platform') return to === owned.profile ? { kind: 'tenant' } : { kind: 'keep' };
    const into = marked.get(to);
    if (!into || (copy === 'config' && into === 'sample')) return undefined;
    const own = strategy.get(to)!;
    if (toColumn === own.tenant) return { kind: 'tenant' };
    if (own.hashed && own.keys.length === 1 && own.keys[0] === toColumn) return { kind: 'hashed', resource: to };
    return { kind: 'keep' };
  };

  const tables: CloneTable[] = [];
  const edges = new Map<string, Set<string>>();
  for (const [id, copy] of marked) {
    const table = tableOf(id);
    const own = strategy.get(id)!;
    const rules: Record<string, CloneColumnRule> = {};
    const set = (column: string, rule: CloneColumnRule, why: string) => {
      const before = rules[column];
      if (before && JSON.stringify(before) !== JSON.stringify(rule))
        refuse(`"${id}".${column} is ${why}, and also another reference the copy would rewrite differently: split the column.`);
      rules[column] = rule;
    };
    set(own.tenant, { kind: 'tenant' }, 'the tenant column');
    if (own.hashed) set(own.keys[0], { kind: 'hashed', resource: id }, 'the key');
    const after = new Set<string>();
    const self: { from: readonly string[]; to: readonly string[] }[] = [];
    for (const leg of legsOf(id)) {
      const left: string[] = [];
      leg.from.forEach((column, index) => {
        if (column === own.tenant) return;
        const rule = reached(copy, leg.to, leg.toColumns[index]);
        if (rule) set(column, rule, `a reference to "${leg.to}"`);
        else left.push(column);
      });
      if (left.length) {
        const required = left.filter((column) => !table.columns.find((candidate) => candidate.name === column)?.nullable);
        if (required.length)
          refuse(
            `"${id}" is marked clone "${copy}" and its "${required.join('", "')}" must reference "${leg.to}", which a ` +
              `${copy} clone does not copy${marked.has(leg.to) ? ` ("${leg.to}" is "${marked.get(leg.to)}")` : ''}. ` +
              `Mark "${leg.to}" clone "${copy === 'config' ? 'config' : 'sample'}", or let the column be empty.`,
          );
        for (const column of left) rules[column] = { kind: 'clear' };
      } else if (leg.to === id) {
        const pairs = leg.from.map((column, index) => [column, leg.toColumns[index]] as const).filter(([column]) => column !== own.tenant);
        self.push(Object.freeze({ from: pairs.map(([column]) => column), to: pairs.map(([, column]) => column) }));
      } else if (marked.has(leg.to)) after.add(leg.to);
    }
    for (const column of table.columns) rules[column.name] ??= { kind: 'keep' };
    edges.set(id, after);
    tables.push(
      Object.freeze({
        resource: id,
        from: physical(id),
        copy,
        tenant: own.tenant,
        columns: Object.freeze(table.columns.map((column) => column.name)),
        keys: Object.freeze([...own.keys]),
        rules: Object.freeze(rules),
        self: Object.freeze(self),
      }),
    );
  }

  /* Referenced before referencing, so every insert finds its target; a self
     reference is ordered by the rows themselves (tenantCloneEngine.ts). */
  const ordered: CloneTable[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string, path: readonly string[]) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting')
      refuse(`The tables marked clone reference each other in a cycle (${[...path, id].join(' → ')}); a copy cannot order their rows.`);
    state.set(id, 'visiting');
    for (const next of [...edges.get(id)!].sort()) visit(next, [...path, id]);
    state.set(id, 'done');
    ordered.push(tables.find((table) => table.resource === id)!);
  };
  for (const id of [...marked.keys()].sort()) visit(id, []);

  const profile = profileTable(owned, policy, physical);
  const plan: TenantClonePlan = Object.freeze({ appId: app.id, dialect, tables: Object.freeze(profile ? [profile, ...ordered] : ordered) });
  issued.add(plan);
  return plan;
}

/**
 * The platform's row for the source tenant, copied so the new tenant has one:
 * tenant rows reference it through their tenant column, and it is what names
 * the tenant. Its key becomes the new tenant; what no two tenants may share —
 * a unique column, the intake and public addresses — is cleared, so a sandbox
 * never answers a public form or a public read meant for its source.
 */
function profileTable(
  owned: TenantOwnershipSnapshot,
  policy: Pick<AppTenantPolicy, 'intake' | 'public'> | undefined,
  physical: (id: string) => string,
): CloneTable | undefined {
  if (owned.profile === undefined) return undefined;
  let key: string;
  try {
    key = intakeProfileKey(owned);
  } catch {
    return undefined;
  }
  const table = owned.schema.tables.find((candidate) => candidate.id === owned.profile)!;
  const rules: Record<string, CloneColumnRule> = { [key]: { kind: 'tenant' } };
  const shared = new Set<string>([
    ...(table.unique ?? []),
    ...(table.uniquePairs ?? []).filter((pair) => !pair.includes(key)).flat(),
    ...(policy?.intake ? [policy.intake.address] : []),
    ...(policy?.public ? [policy.public.address] : []),
  ]);
  shared.delete(key);
  for (const column of shared) {
    const meta = table.columns.find((candidate) => candidate.name === column);
    if (!meta) continue;
    if (!meta.nullable)
      refuse(
        `The profile "${owned.profile}" is copied for a clone's new tenant, and its "${column}" is one no two tenants may share ` +
          'and may not be empty: let it be null, so the copy can leave it unset.',
      );
    rules[column] = { kind: 'clear' };
  }
  for (const fk of owned.schema.foreignKeys)
    if (fk.from.table === owned.profile && owned.ownership[fk.to.table]?.kind === 'tenant')
      refuse(`The profile "${owned.profile}" references "${fk.to.table}", a tenant's own table: a clone cannot copy that reference.`);
  for (const column of table.columns) rules[column.name] ??= { kind: 'keep' };
  return Object.freeze({
    resource: owned.profile,
    from: physical(owned.profile),
    copy: 'profile' as const,
    tenant: key,
    columns: Object.freeze(table.columns.map((column) => column.name)),
    keys: Object.freeze([]),
    rules: Object.freeze(rules),
    self: Object.freeze([]),
  });
}

/* ---------- values ---------- */

/** A stored value as both engines' reads give it: text on PostgreSQL, exact on SQLite. */
export type CloneValue = string | number | bigint | Uint8Array | null;
export type CloneRow = Readonly<Record<string, CloneValue>>;

/** One value as comparable text: what a digest and a key are made of. */
export const cloneText = (value: CloneValue): string | null =>
  value === null ? null : value instanceof Uint8Array ? `x'${Buffer.from(value).toString('hex')}'` : String(value);

/** A row's identity within its tenant: its key columns besides the tenant column, as text. */
export const rowKey = (table: CloneTable, row: CloneRow): string => JSON.stringify(table.keys.map((key) => cloneText(row[key])));

/** What an import compares: every column the copy carries over, as text, never the tenant column or a cleared one. */
export function rowDigest(table: CloneTable, row: CloneRow): string {
  const carried = table.columns.filter((column) => column !== table.tenant && table.rules[column].kind !== 'clear');
  return createHash('sha256')
    .update(JSON.stringify(carried.map((column) => [column, cloneText(row[column])])))
    .digest('hex');
}

/** A source row as the new tenant's copy of it. */
export function copyRow(table: CloneTable, row: CloneRow, tenantId: string): CloneRow {
  const copy: Record<string, CloneValue> = {};
  for (const column of table.columns) {
    const rule = table.rules[column],
      value = row[column];
    copy[column] =
      rule.kind === 'tenant'
        ? tenantId
        : rule.kind === 'clear'
          ? null
          : rule.kind === 'hashed' && value !== null
            ? cloneKey(tenantId, rule.resource, cloneText(value)!)
            : value;
  }
  return Object.freeze(copy);
}
