import { isPromise, isProxy } from 'node:util/types';
import type { DeleteRequest, Filter, WriteTransaction } from '@mistriwork/engine/adapters/adapter.js';
import { coerceForColumn, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import type { ResourceAccess } from '../app/appAccess.js';
import { journalImageMatches } from '@mistriwork/engine/server/journal.js';
import { captureTenantData, denyTenant, tenantIdentifier, tenantOptions, tenantRecord } from '@mistriwork/engine/server/evidence.js';
import { parseTenantSelector, type TenantMembershipEvidence } from './tenantMembership.js';
import { captureTenantOwnership, type TenantOwnershipSnapshot } from './tenantOwnership.js';

type Scalar = string | number | boolean | null;
export interface TenantHistoryImage {
  readonly table: string;
  readonly key: Record<string, string | number>;
  readonly row: Record<string, Scalar>;
}
export type TenantDeletedRecordPolicy = (principal: TenantMembershipEvidence, image: TenantHistoryImage) => boolean | Promise<boolean>;
export interface TenantInverseImages {
  capture(input: DeleteRequest): Promise<TenantHistoryImage | undefined>;
  visible(image: TenantHistoryImage, deleted: boolean): Promise<boolean>;
  removeCurrent(input: DeleteRequest): Promise<TenantHistoryImage>;
  removeCreated(image: TenantHistoryImage): Promise<void>;
  restoreDeleted(image: TenantHistoryImage): Promise<void>;
}
type Invoke = <A, R>(input: A, work: (captured: A) => Promise<R>) => Promise<R>;
const scalar = (value: unknown): value is Scalar =>
  value === null ||
  typeof value === 'string' ||
  typeof value === 'boolean' ||
  (typeof value === 'number' && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)));
const filter = (key: Record<string, string | number>): Filter => ({
  groups: [Object.entries(key).map(([column, value]) => ({ column, op: '=', value }))],
});

/** Pure structural gate over already captured ownership/grants. A true result
 * is not row authorization: image, policy and writer checks still run on use.
 * Keep the full physical dependency catalog, including unmapped/private edges. */
export function tenantDeleteEligible(
  owned: TenantOwnershipSnapshot,
  access: ResourceAccess,
  id: unknown,
  hasPolicy: boolean,
): TableMeta | undefined {
  const { readable, writable, fields } = access;
  const canRead = (table: string, column: string) => readable.has(table) && (fields?.get(table)?.read.has(column) ?? true);
  if (
    !hasPolicy ||
    typeof id !== 'string' ||
    !Object.hasOwn(owned.resources, id) ||
    owned.ownership[id].kind !== 'tenant' ||
    !readable.has(id) ||
    !writable.has(id)
  )
    return undefined;
  const table = owned.schema.tables.find((table) => table.id === id)!;
  const rule = owned.ownership[id];
  if (
    rule.kind !== 'tenant' ||
    table.isView ||
    !table.columns.some((column) => column.primaryKey) ||
    table.columns.some(
      (column) =>
        (column.primaryKey && !canRead(id, column.name)) ||
        (column.name !== rule.column && (!canRead(id, column.name) || !(fields?.get(id)?.write.has(column.name) ?? true))),
    )
  )
    return undefined;
  const physical = owned.resources[id];
  if (
    owned.physicalSchema.foreignKeys.some((fk) => fk.to.table === physical) ||
    owned.physicalSchema.tables.some((t) => t.columns.some((column) => column.references?.table === physical))
  )
    return undefined;
  const physicalToLogical = new Map(Object.entries(owned.resources).map(([logical, physical]) => [physical, logical]));
  const parentReadable = (target: string, columns: readonly string[]) => {
    const logical = physicalToLogical.get(target);
    return logical !== undefined && columns.every((column) => canRead(logical, column));
  };
  /* The row's own tenant, `tenant_id` → the tenancy's profile table: the
     platform stamps that column and the member never reads the profile, but
     it is the one parent every row of the tenant has, so it says nothing a
     restored row could not. Without this a tag's link row, which carries the
     key like every tenant row, could never be taken off (G58). */
  const profile = owned.profile === undefined ? undefined : owned.resources[owned.profile];
  const ownParent = (target: string, from: readonly string[]) =>
    profile !== undefined && target === profile && from.length === 1 && from[0] === rule.column;
  if (
    owned.physicalSchema.foreignKeys.some(
      (fk) => fk.from.table === physical && !ownParent(fk.to.table, fk.from.columns) && !parentReadable(fk.to.table, fk.to.columns),
    ) ||
    owned.physicalSchema.tables
      .find((t) => t.id === physical)!
      .columns.some(
        (column) =>
          column.references &&
          !ownParent(column.references.table, [column.name]) &&
          !parentReadable(column.references.table, [column.references.column]),
      )
  )
    return undefined;
  return table;
}

/** Private full-image exception for the ownership invariant only. records must
 * be the logical managed writer inside the source's existing BEGIN IMMEDIATE;
 * invoke owns capture, session checks, fail-stop/drain and retained lifetime.
 * Helpers below never invoke the queue recursively or own transaction outcome. */
export function createTenantInverseImages(
  ownership: TenantOwnershipSnapshot,
  principal: TenantMembershipEvidence,
  access: ResourceAccess,
  records: WriteTransaction,
  authorizeDeletedRecord: TenantDeletedRecordPolicy | undefined,
  invoke: Invoke,
): TenantInverseImages {
  const owned = captureTenantOwnership(ownership),
    member = captureTenantData(principal);
  tenantRecord(member, [
    'appId',
    'accountId',
    'tenantId',
    'source',
    'deployment',
    'membershipId',
    'membershipVersion',
    'tenantVersion',
    'roles',
    'verifiedAt',
    'validUntil',
  ]);
  tenantRecord(member.source, ['id', 'connection']);
  if (member.appId !== owned.appId || member.source.id !== owned.source.id || member.source.connection !== owned.source.connection)
    return denyTenant();
  parseTenantSelector([member.tenantId]);
  tenantIdentifier(member.accountId, 1024);
  tenantIdentifier(member.membershipId, 1024);
  tenantIdentifier(member.deployment);
  if (
    typeof invoke !== 'function' ||
    isProxy(invoke) ||
    (authorizeDeletedRecord !== undefined && (typeof authorizeDeletedRecord !== 'function' || isProxy(authorizeDeletedRecord)))
  )
    return denyTenant();
  const policy = authorizeDeletedRecord;
  /* `validation`, `transitions`, `creatable` and `internal` (a file's object and
     hash) ride on the access an App with write rules, a machine, per-role create
     or files is given; an inverse image puts back a before-image and reads none of them. */
  const raw = tenantOptions(access, ['readable', 'writable', 'fields', 'rows', 'validation', 'transitions', 'creatable', 'internal']);
  const strings = (input: unknown): Set<string> => {
    try {
      if (!input || typeof input !== 'object' || isProxy(input)) return denyTenant();
      const values = [...Set.prototype.values.call(input)] as unknown[];
      if (values.length > 65_536 || values.some((value) => typeof value !== 'string')) return denyTenant();
      return new Set(values as string[]);
    } catch {
      return denyTenant();
    }
  };
  const readable = strings(raw.readable),
    writable = strings(raw.writable);
  const fields = new Map<string, { read: Set<string>; write: Set<string> }>();
  if (raw.fields !== undefined) {
    try {
      if (!raw.fields || typeof raw.fields !== 'object' || isProxy(raw.fields)) return denyTenant();
      const entries = [...Map.prototype.entries.call(raw.fields)] as Array<[unknown, unknown]>;
      if (entries.length > 256) return denyTenant();
      for (const [table, input] of entries) {
        if (typeof table !== 'string') return denyTenant();
        const field = tenantOptions(input, ['read', 'write']);
        fields.set(table, { read: strings(field.read), write: strings(field.write) });
      }
    } catch {
      return denyTenant();
    }
  }
  if (!records || typeof records !== 'object' || isProxy(records)) return denyTenant();
  const method = <K extends 'query' | 'insert' | 'remove'>(name: K): WriteTransaction[K] => {
    const descriptor = Object.getOwnPropertyDescriptor(records, name);
    if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function') return denyTenant();
    const fn = descriptor.value;
    return ((...args: unknown[]) => Reflect.apply(fn, records, args)) as WriteTransaction[K];
  };
  const query = method('query'),
    insert = method('insert'),
    remove = method('remove');
  const reader = { query };
  const eligible = (id: unknown) => tenantDeleteEligible(owned, { readable, writable, fields }, id, policy !== undefined);
  const key = (table: TableMeta, input: unknown): Record<string, string | number> => {
    tenantRecord(input);
    const primary = table.columns.filter((column) => column.primaryKey);
    if (
      Object.keys(input).length !== primary.length ||
      primary.some((column) => !Object.hasOwn(input, column.name)) ||
      Object.values(input).some((value) => typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value)))
    )
      return denyTenant();
    const rule = owned.ownership[table.id];
    if (rule.kind !== 'tenant' || (Object.hasOwn(input, rule.column) && input[rule.column] !== member.tenantId)) return denyTenant();
    return input as Record<string, string | number>;
  };
  const imageFor = (table: TableMeta, row: Record<string, unknown>, givenKey?: unknown): TenantHistoryImage | undefined => {
    const rule = owned.ownership[table.id];
    if (
      rule.kind !== 'tenant' ||
      row[rule.column] !== member.tenantId ||
      Object.keys(row).length !== table.columns.length ||
      table.columns.some(
        (column) =>
          !Object.hasOwn(row, column.name) ||
          !scalar(row[column.name]) ||
          (typeof row[column.name] === 'string' && /^<\d+ bytes>$/.test(row[column.name] as string)) ||
          coerceForColumn(column.type, row[column.name] as Scalar) !== row[column.name],
      )
    )
      return undefined;
    const primary = table.columns.filter((column) => column.primaryKey);
    if (
      primary.some(
        (column) => typeof row[column.name] !== 'string' && !(typeof row[column.name] === 'number' && Number.isFinite(row[column.name])),
      )
    )
      return undefined;
    const actual = key(table, Object.fromEntries(primary.map((column) => [column.name, row[column.name]])));
    if (givenKey !== undefined) {
      const supplied = key(table, givenKey);
      if (Object.entries(actual).some(([column, value]) => supplied[column] !== value)) return undefined;
    }
    return captureTenantData({ table: table.id, key: actual, row: row as Record<string, Scalar> });
  };
  const imageInput = (input: TenantHistoryImage): TenantHistoryImage | undefined => {
    tenantRecord(input, ['table', 'key', 'row']);
    tenantRecord(input.key);
    tenantRecord(input.row);
    const table = eligible(input.table);
    return table ? imageFor(table, input.row, input.key) : undefined;
  };
  const permitted = async (image: TenantHistoryImage): Promise<boolean> => {
    const result = policy!(member, image);
    const value = isPromise(result) ? await Promise.prototype.then.call(result, captureTenantData) : captureTenantData(result);
    if (typeof value !== 'boolean') return denyTenant();
    return value;
  };
  const current = async (table: string, key: Record<string, string | number>) => query({ table, filter: filter(key), limit: 2, offset: 0 });
  const capture = async (input: DeleteRequest): Promise<TenantHistoryImage | undefined> => {
    tenantRecord(input, ['table', 'key']);
    const table = eligible(input.table);
    if (!table) return undefined;
    const supplied = key(table, input.key),
      result = await current(table.id, supplied);
    if (result.rows.length !== 1) return undefined;
    const image = imageFor(table, result.rows[0]);
    if (!image || !(await journalImageMatches(reader, table.id, image.row)) || !(await permitted(image))) return undefined;
    return image;
  };
  return Object.freeze<TenantInverseImages>({
    capture: (input) => invoke(input, capture),
    visible: (image, deleted) =>
      invoke({ image, deleted }, async (input) => {
        if (typeof input.deleted !== 'boolean') return denyTenant();
        const image = imageInput(input.image);
        if (!image || !(await permitted(image))) return false;
        if (input.deleted) return true;
        const result = await current(image.table, image.key),
          rule = owned.ownership[image.table];
        return (
          result.rows.length === 1 &&
          rule.kind === 'tenant' &&
          result.rows[0][rule.column] === member.tenantId &&
          Object.entries(image.key).every(([column, value]) => result.rows[0][column] === value)
        );
      }),
    removeCurrent: (input) =>
      invoke(input, async (input) => {
        const image = await capture(input);
        if (!image) return denyTenant();
        if ((await remove({ table: image.table, key: image.key })).affected !== 1 || !(await permitted(image))) return denyTenant();
        return image;
      }),
    removeCreated: (input) =>
      invoke(input, async (input) => {
        const image = imageInput(input);
        if (!image || !(await permitted(image)) || !(await journalImageMatches(reader, image.table, image.row))) return denyTenant();
        if ((await remove({ table: image.table, key: image.key })).affected !== 1 || !(await permitted(image))) return denyTenant();
      }),
    restoreDeleted: (input) =>
      invoke(input, async (input) => {
        const image = imageInput(input);
        if (!image || !(await permitted(image)) || (await current(image.table, image.key)).rows.length !== 0) return denyTenant();
        const rule = owned.ownership[image.table];
        if (rule.kind !== 'tenant') return denyTenant();
        const values = Object.fromEntries(Object.entries(image.row).filter(([column]) => column !== rule.column));
        await insert({ table: image.table, values });
        if (!(await journalImageMatches(reader, image.table, image.row)) || !(await permitted(image))) return denyTenant();
      }),
  });
}
