import { isPromise, isProxy, isUint8Array } from 'node:util/types';
import {
  TransactionOperations,
  TransactionOutcomeUnknown,
  type DeleteRequest,
  type TellRequest,
  type Filter,
  type InsertRequest,
  type QueryRequest,
  type UpdateRequest,
  type WriteTransaction,
} from '@mistriwork/engine/adapters/adapter.js';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import type { CommandJournal } from '../../adapters/commands/commandJournalTypes.js';
import { captureTenantData, denyTenant, TenantContextError, tenantIdentifier, tenantRecord } from '@mistriwork/engine/server/evidence.js';
import type { TenantManagedEvidence, TenantManagedKind } from './tenantManagedKindContract.js';
import { intakeManagedKind } from './tenantManagedKindIntake.js';
import { memberManagedKind } from './tenantManagedKindMember.js';
import { platformManagedKind } from './tenantManagedKindPlatform.js';
import { platformTenantManagedKind } from './tenantManagedKindPlatformTenant.js';
import { serviceManagedKind } from './tenantManagedKindService.js';
import { supportManagedKind } from './tenantManagedKindSupport.js';
import type { TenantMembershipEvidence } from './tenantMembership.js';
import { captureTenantOwnership, type TenantOwnershipSnapshot } from './tenantOwnership.js';
import { assertStructuredReadFilter } from '@mistriwork/engine/server/resourceReadOperations.js';

/** The principals a managed transaction runs for, chosen by the evidence's own
 * `realm`; any other realm is refused. A kind adds its module and one line here. */
const TENANT_MANAGED_KINDS: readonly TenantManagedKind[] = Object.freeze([
  memberManagedKind,
  platformManagedKind,
  platformTenantManagedKind,
  intakeManagedKind,
  serviceManagedKind,
  supportManagedKind,
]);

type Scalar = string | number | boolean | null;
const scalar = (value: unknown): value is Scalar =>
  value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));

/** Runs inside an already owned, scoped SQLite transaction. This manages only
 * logical ownership fields and callback/operation lifetime, not admission,
 * physical row/FK checks, commit, rollback, history or outcome classification. */
export async function runTenantManagedTransaction<T>(
  ownership: TenantOwnershipSnapshot,
  evidence: TenantMembershipEvidence,
  records: WriteTransaction,
  run: (tx: WriteTransaction) => T | Promise<T>,
): Promise<T> {
  return runManaged(ownership, evidence, records, run);
}

/** The journal is runtime-owned and shares records' callback lifetime and
 * fail-stop queue. This is not a command grant or a receipt disclosure policy. */
export async function runTenantManagedCommandTransaction<T>(
  ownership: TenantOwnershipSnapshot,
  evidence: TenantMembershipEvidence,
  records: WriteTransaction,
  journal: CommandJournal,
  run: (tx: WriteTransaction, journal: CommandJournal) => T | Promise<T>,
): Promise<T> {
  if (typeof run !== 'function' || !journal) return denyTenant();
  return runManaged(ownership, evidence, records, (tx, owned) => run(tx, owned!), journal);
}

/** Every other kind's ordinary transaction, for a principal that is not a
 * tenant member and writes without a command: a support operator inside a
 * dealer. The kind and its rules come from the evidence's own realm, never
 * from the caller, exactly as the command variant below. */
export async function runManagedTransaction<T>(
  ownership: TenantOwnershipSnapshot,
  evidence: TenantManagedEvidence,
  records: WriteTransaction,
  run: (tx: WriteTransaction) => T | Promise<T>,
): Promise<T> {
  return runManaged(ownership, evidence, records, run);
}

/** Every other kind's command transaction (the platform realm's, public
 * intake's), with the same journal lifetime and queue. The kind and its rules
 * come from the evidence itself (tenantManagedKind*.ts), never from the caller. */
export async function runManagedCommandTransaction<T>(
  ownership: TenantOwnershipSnapshot,
  evidence: TenantManagedEvidence,
  records: WriteTransaction,
  journal: CommandJournal,
  run: (tx: WriteTransaction, journal: CommandJournal) => T | Promise<T>,
): Promise<T> {
  if (typeof run !== 'function' || !journal) return denyTenant();
  return runManaged(ownership, evidence, records, (tx, owned) => run(tx, owned!), journal);
}

async function runManaged<T>(
  ownership: TenantOwnershipSnapshot,
  evidence: TenantManagedEvidence,
  records: WriteTransaction,
  run: (tx: WriteTransaction, journal?: CommandJournal) => T | Promise<T>,
  journal?: CommandJournal,
): Promise<T> {
  const owned = captureTenantOwnership(ownership),
    member = captureTenantData(evidence);
  const realm = Object.hasOwn(member, 'realm') ? (member as { readonly realm?: unknown }).realm : 'tenant';
  const kind = TENANT_MANAGED_KINDS.find((candidate) => candidate.realm === realm) ?? denyTenant();
  tenantRecord(member, kind.keys);
  tenantRecord(member.source, ['id', 'connection']);
  if (member.appId !== owned.appId || member.source.id !== owned.source.id || member.source.connection !== owned.source.connection)
    denyTenant();
  const tenantId = kind.tenantOf(member);
  kind.identify(member);
  tenantIdentifier(member.deployment);
  if (typeof run !== 'function' || !records || typeof records !== 'object' || isProxy(records)) return denyTenant();
  // Capture trusted data-method descriptors and their exact receiver before the
  // callback/waits. Neither lockRecord nor configuration getters are evaluated.
  const method = <K extends 'query' | 'count' | 'insert' | 'update' | 'remove'>(key: K): WriteTransaction[K] => {
    const descriptor = Object.getOwnPropertyDescriptor(records, key);
    if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function') return denyTenant();
    const captured = descriptor.value;
    return ((...args: unknown[]) => Reflect.apply(captured, records, args)) as WriteTransaction[K];
  };
  const query = method('query'),
    count = method('count'),
    insert = method('insert'),
    update = method('update'),
    remove = method('remove');
  // Optional, as a flow's notify step is the one caller: present where the engine keeps notices.
  const told = Object.getOwnPropertyDescriptor(records, 'tell');
  const tell =
    told && 'value' in told && typeof told.value === 'function'
      ? (((...args: unknown[]) => Reflect.apply(told.value, records, args)) as NonNullable<WriteTransaction['tell']>)
      : undefined;
  const journalMethod = <K extends keyof CommandJournal>(name: K): CommandJournal[K] => {
    if (!journal || typeof journal !== 'object' || isProxy(journal)) return denyTenant();
    const descriptor = Object.getOwnPropertyDescriptor(journal, name);
    if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function') return denyTenant();
    const fn = descriptor.value;
    return ((...args: unknown[]) => Reflect.apply(fn, journal, args)) as CommandJournal[K];
  };
  const find = journal ? journalMethod('find') : undefined,
    commit = journal ? journalMethod('commit') : undefined;
  // Optional on a journal: present where its store keeps sequences.
  const numbering =
    journal &&
    typeof journal === 'object' &&
    !isProxy(journal) &&
    typeof Object.getOwnPropertyDescriptor(journal, 'nextNumber')?.value === 'function'
      ? journalMethod('nextNumber')
      : undefined;
  const operations = new TransactionOperations();
  let accepting = true;
  let callbackFailure: { error: unknown } | undefined;
  const target = (id: unknown): TableMeta => {
    if (typeof id !== 'string' || !Object.hasOwn(owned.resources, id) || id.toLowerCase().startsWith('__mistri_')) return denyTenant();
    return owned.schema.tables.find((table) => table.id === id) ?? denyTenant();
  };
  // A tenant writes its own rows. The platform realm writes its own rows and
  // updates a tenant's; it never inserts or removes one, except as a command
  // acting in one named tenant, which writes that tenant's rows as a member does.
  // Without a command the platform realm writes its own rows alone, and never
  // makes or ends a tenant's profile row (uncommanded).
  const ownRowsOnly = journal === undefined && kind.uncommanded === 'platform-rows';
  const writable = (id: unknown, operation: 'insert' | 'update' | 'remove'): { table: TableMeta; column: string | undefined } => {
    const table = target(id),
      rule = owned.ownership[table.id];
    if (!kind.allows(operation, member)) return denyTenant();
    if (ownRowsOnly && (rule.kind !== 'platform' || (operation !== 'update' && table.id === owned.profile))) return denyTenant();
    if (rule.kind === 'tenant' && (tenantId !== undefined || operation === 'update')) return { table, column: rule.column };
    if (rule.kind === 'platform' && (tenantId === undefined || kind.platformRows === true)) return { table, column: undefined };
    return denyTenant();
  };
  const keyColumn = (table: TableMeta, name: string): boolean =>
    table.columns.some((column) => column.name === name && column.primaryKey) ||
    owned.schema.foreignKeys.some((fk) => fk.to.table === table.id && fk.to.columns.includes(name)) ||
    owned.schema.tables.some((each) =>
      each.columns.some((column) => column.references?.table === table.id && column.references.column === name),
    );
  const known = (table: TableMeta, name: unknown): name is string =>
    typeof name === 'string' && table.columns.some((column) => column.name === name);
  /* A new row may carry a file's bytes (an upload into a file resource); an edit never does. */
  const values = (table: TableMeta, input: unknown, bytes = false): Record<string, Scalar> => {
    tenantRecord(input);
    if (Object.entries(input).some(([name, value]) => !known(table, name) || !(scalar(value) || (bytes && isUint8Array(value)))))
      return denyTenant();
    return input as Record<string, Scalar>;
  };
  const key = (table: TableMeta, column: string | undefined, input: unknown): Record<string, string | number> => {
    tenantRecord(input);
    if (
      Object.entries(input).some(
        ([name, value]) => !known(table, name) || (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))),
      )
    )
      return denyTenant();
    // The platform realm names a tenant's row by its whole key, owner included.
    if (column === undefined || tenantId === undefined) return input as Record<string, string | number>;
    if (Object.hasOwn(input, column) && input[column] !== tenantId) return denyTenant();
    // Completeness and PK-only shape remain enforced by the scoped engine.
    return {
      ...input,
      ...(table.columns.some((field) => field.name === column && field.primaryKey) ? { [column]: tenantId } : {}),
    } as Record<string, string | number>;
  };
  const filter = (table: TableMeta, input: unknown): void => {
    assertStructuredReadFilter(input, 'column');
    if (input?.groups.some((group) => group.some((condition) => !known(table, condition.column)))) denyTenant();
  };
  const invoke = <A, R>(input: A, work: (input: A) => Promise<R>): Promise<R> => {
    if (!accepting) return Promise.reject(new TenantContextError());
    let captured: A;
    let invalid: { error: unknown } | undefined;
    try {
      captured = captureTenantData(input);
    } catch (error) {
      invalid = { error };
    }
    return operations.run(async () => {
      if (callbackFailure) throw callbackFailure.error;
      if (invalid) throw invalid.error;
      return work(captured!);
    });
  };
  const tx: WriteTransaction = Object.freeze({
    query: (request: QueryRequest) =>
      invoke(request, async (value) => {
        /* `binary` keeps a row's bytes as bytes: a command's revision of a table
           with no version column is the row's digest (commandRevision.ts), read
           this way. Refused, every command on such a table failed at prepare. */
        tenantRecord(value, ['table', 'filter', 'columns', 'orderBy', 'limit', 'offset', 'binary']);
        const table = target(value.table);
        filter(table, value.filter);
        if (
          (value.binary !== undefined && value.binary !== true) ||
          typeof value.limit !== 'number' ||
          typeof value.offset !== 'number' ||
          (value.columns !== undefined && (!Array.isArray(value.columns) || value.columns.some((column) => !known(table, column)))) ||
          (value.orderBy !== undefined && !Array.isArray(value.orderBy))
        )
          return denyTenant();
        for (const order of value.orderBy ?? []) {
          tenantRecord(order, ['column', 'direction']);
          if (!known(table, order.column) || !['asc', 'desc'].includes(order.direction)) return denyTenant();
        }
        const result = await query(value);
        return { ...result, sql: { text: '', params: [] } };
      }),
    count: (table: string, input?: Filter) =>
      invoke({ table, filter: input }, (value) => {
        filter(target(value.table), value.filter);
        return count(value.table, value.filter);
      }),
    insert: (request: InsertRequest) =>
      invoke(request, (value) => {
        tenantRecord(value, ['table', 'values']);
        const { table, column } = writable(value.table, 'insert'),
          supplied = values(table, value.values, true);
        if (column !== undefined && Object.hasOwn(supplied, column)) return denyTenant();
        // Bytes are outside the JSON value union; every adapter binds them as BLOB or bytea (http/fileRows.ts).
        return insert(
          captureTenantData({
            table: table.id,
            values: column === undefined ? supplied : { ...supplied, [column]: tenantId! },
          } as InsertRequest),
        );
      }),
    update: (request: UpdateRequest) =>
      invoke(request, (value) => {
        tenantRecord(value, ['table', 'key', 'values', 'expected']);
        const { table, column } = writable(value.table, 'update'),
          supplied = values(table, value.values);
        if (column !== undefined && Object.hasOwn(supplied, column)) return denyTenant();
        // A key, or a column another row's key names, moves with a command only: an edit that moved one could carry rows with it.
        if (ownRowsOnly && Object.keys(supplied).some((name) => keyColumn(table, name))) return denyTenant();
        const completeKey = key(table, column, value.key);
        let expected: Record<string, Scalar> | undefined;
        if (value.expected !== undefined) {
          const original = values(table, value.expected);
          if (column !== undefined && tenantId !== undefined && Object.hasOwn(original, column) && original[column] !== tenantId)
            return denyTenant();
          // An exact ownership value is not a grant. Preserve the map so the
          // engine's exactly-touched-fields rule can still reject extra fields.
          expected = original;
        }
        return update(
          captureTenantData({ table: table.id, key: completeKey, values: supplied, ...(expected !== undefined ? { expected } : {}) }),
        );
      }),
    remove: (request: DeleteRequest) =>
      invoke(request, (value) => {
        tenantRecord(value, ['table', 'key']);
        const { table, column } = writable(value.table, 'remove');
        return remove(captureTenantData({ table: table.id, key: key(table, column, value.key) }));
      }),
    /* A flow's notify step tells of a record its tenant may update, found in the tenant's own rows first: the engine's
       capture reads the record beneath the scope, so the scope is asked here. */
    ...(tell
      ? {
          tell: (request: TellRequest) =>
            invoke(request, async (value) => {
              tenantRecord(value, ['table', 'key', 'audience', 'message']);
              if (typeof value.audience !== 'string' || typeof value.message !== 'string') return denyTenant();
              const { table, column } = writable(value.table, 'update');
              const completeKey = key(table, column, value.key);
              const found = await query({
                table: table.id,
                columns: Object.keys(completeKey),
                filter: { groups: [Object.entries(completeKey).map(([name, at]) => ({ column: name, op: '=' as const, value: at }))] },
                limit: 2,
                offset: 0,
              });
              if (found.rows.length !== 1) return denyTenant();
              return tell(captureTenantData({ table: table.id, key: completeKey, audience: value.audience, message: value.message }));
            }),
        }
      : {}),
  });
  let result!: T;
  const ownedJournal = journal
    ? Object.freeze<CommandJournal>({
        find: (scope, expectedManifest) => invoke({ scope, expectedManifest }, (input) => find!(input.scope, input.expectedManifest)),
        commit: (receipt, audit, eventBatch) =>
          invoke({ receipt, audit, eventBatch }, (input) => commit!(input.receipt, input.audit, input.eventBatch)),
        ...(numbering
          ? {
              nextNumber: (appId: string, name: string, per: string, start: number) =>
                invoke({ appId, name, per, start }, (input) => numbering(input.appId, input.name, input.per, input.start)),
            }
          : {}),
      })
    : undefined;
  const completed = (value: T): T => {
    accepting = false;
    return captureTenantData(value);
  };
  try {
    const returned = ownedJournal ? run(tx, ownedJournal) : run(tx);
    result = isPromise(returned)
      ? ((await Promise.prototype.then.call(returned, completed, (error: unknown) => {
          accepting = false;
          throw error;
        })) as T)
      : completed(returned);
  } catch (error) {
    callbackFailure = { error };
  }
  accepting = false;
  let drainFailure: { error: unknown } | undefined;
  try {
    await operations.finish();
  } catch (error) {
    drainFailure = { error };
  }
  // Never replace uncertainty with a callback, capture, permission or drain
  // refusal. The outer owner alone can classify actual transaction completion.
  if (callbackFailure?.error instanceof TransactionOutcomeUnknown) throw callbackFailure.error;
  if (drainFailure) throw drainFailure.error;
  if (callbackFailure) throw callbackFailure.error;
  return result;
}
