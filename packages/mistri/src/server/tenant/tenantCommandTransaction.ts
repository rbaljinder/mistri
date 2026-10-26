import { isPromise, isProxy } from 'node:util/types';
import {
  TransactionOperations,
  TransactionOutcomeUnknown,
  type TellRequest,
  type WriteTransaction,
} from '@mistriwork/engine/adapters/adapter.js';
import { canonicalCommandJson } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import type { CommandAudit, CommandJournal } from '../../adapters/commands/commandJournalTypes.js';
import { AppAccessDenied, authorizeTransaction, type ResourceAccess } from '../app/appAccess.js';
import type { BusinessCommandAuthorization } from '../commands/businessCommandAuthorization.js';
import { BusinessCommandExecutionError } from '../commands/businessCommandExecution.js';
import { canonicalKey } from '../commands/commandDb.js';
import { columnKind } from '@mistriwork/engine/shared/schema.js';
import type { TenantCommandKind } from './tenantCommandKindContract.js';
import { intakeCommandKind } from './tenantCommandKindIntake.js';
import { memberCommandKind } from './tenantCommandKindMember.js';
import { platformCommandKind } from './tenantCommandKindPlatform.js';
import { platformTenantCommandKind } from './tenantCommandKindPlatformTenant.js';
import { serviceCommandKind } from './tenantCommandKindService.js';
import { captureTenantData, recordRefusalCause, tenantRecord } from '@mistriwork/engine/server/evidence.js';
import type { TenantOwnershipSnapshot } from './tenantOwnership.js';
import { assertStructuredReadFilter } from '@mistriwork/engine/server/resourceReadOperations.js';
import type { CommandResultReference } from '../commands/scopedBusinessCommandAccess.js';

const deny = (): never => {
  throw new AppAccessDenied();
};
/** A denial that tells the operator, never the visitor, which write it refused. */
const refused = (reason: string): AppAccessDenied => recordRefusalCause(new AppAccessDenied(), reason);
export interface TenantCommandRecords {
  readonly records: WriteTransaction;
  readonly journal?: CommandJournal;
  target(key: Readonly<Record<string, string | number>>): Promise<void>;
  result(key: Readonly<Record<string, string | number>>, value: unknown): Promise<void>;
}

/** The principals a command transaction runs for (tenantCommandKind*.ts). A
 * kind adds its module and one line here. */
const TENANT_COMMAND_KINDS = Object.freeze([
  memberCommandKind,
  platformCommandKind,
  platformTenantCommandKind,
  intakeCommandKind,
  serviceCommandKind,
] as const);
type TenantCommandPrincipal = Parameters<(typeof TENANT_COMMAND_KINDS)[number]['place']>[0];
/** The principal's kind, by its own `realm` data property. A tenant member's
 * evidence carries none and reads as 'tenant'. Any other realm — one no kind
 * answers, an inherited one, or one behind an accessor or a proxy — is
 * refused, never read as a member's: where a principal writes is decided
 * here, before the writer's fence could say otherwise. */
function commandKindOf(principal: TenantCommandPrincipal): TenantCommandKind<TenantCommandPrincipal> {
  if (!principal || typeof principal !== 'object' || isProxy(principal)) return deny();
  const own = Object.getOwnPropertyDescriptor(principal, 'realm');
  if (!own && 'realm' in principal) return deny();
  const realm = own ? ('value' in own ? own.value : deny()) : 'tenant';
  return (TENANT_COMMAND_KINDS.find((kind) => kind.realm === realm) ?? deny()) as unknown as TenantCommandKind<TenantCommandPrincipal>;
}

/** What a command transaction needs of its request scope: a tenant's, or the platform realm's. */
interface TenantCommandScope {
  readonly principal: TenantCommandPrincipal;
  readonly grants: ResourceAccess;
  session(): Promise<void>;
}

/** A command reads and writes its footprint as the service-level handler it
 * is: every column, whatever a role's or the resource's field rule narrows
 * for generic reads, but the ownership column where this context does not see
 * it. What reaches the actor is the command's declared output, and `initial`
 * and `availability` are given the target as the actor reads it
 * (businessCommandAuthorization.ts). Command writes derive from their
 * declaration, not generic CRUD field grants. In the platform realm the scope
 * spans tenants, a platform row's fields are writable and an owner never is,
 * and each audit row the journal commits names its target's owner as this
 * transaction read it from the row. */
export async function runTenantCommandTransaction<T>(
  ownership: TenantOwnershipSnapshot,
  scope: TenantCommandScope,
  authorization: BusinessCommandAuthorization,
  raw: WriteTransaction,
  journal: CommandJournal | undefined,
  extract: (result: unknown) => readonly CommandResultReference[],
  callback: (context: TenantCommandRecords) => T | Promise<T>,
): Promise<T> {
  // Where this principal writes, from its kind (tenantCommandKind*.ts).
  const place = commandKindOf(scope.principal).place(scope.principal);
  const tenantId = place.tenantId;
  const read = new Set(authorization.read),
    write = new Set(authorization.write);
  const fields = new Map(
    ownership.schema.tables.map((table) => {
      const rule = ownership.ownership[table.id],
        granted = scope.grants.fields?.get(table.id)?.read;
      const owner = rule?.kind === 'tenant' ? rule.column : undefined;
      return [
        table.id,
        {
          read: new Set(table.columns.map((column) => column.name).filter((column) => column !== owner || !granted || granted.has(column))),
          write: new Set(table.columns.filter((column) => place.writes(rule, column.name)).map((column) => column.name)),
        },
      ] as const;
    }),
  );
  const validation = scope.grants.validation;
  const tx = authorizeTransaction(
    ownership.schema,
    { readable: read, writable: write, fields, ...(validation ? { validation } : {}) },
    raw,
  );
  // Whole-row removal has an explicit command grant and complete normal-field
  // authority. Only this operation may remove the managed owner invariant;
  // ordinary values, reads and updates keep the field facade above. The source
  // still proves actual tenant rows and conservative non-cascading eligibility.
  const removal = authorizeTransaction(ownership.schema, { readable: read, writable: write, ...(validation ? { validation } : {}) }, raw);
  const operations = new TransactionOperations();
  let accepting = true,
    failure: { error: unknown } | undefined;
  const invoke = <A, R>(input: A, work: (captured: A) => Promise<R>): Promise<R> => {
    if (!accepting) return Promise.reject(new AppAccessDenied());
    let captured!: A, invalid: { error: unknown } | undefined;
    try {
      captured = captureTenantData(input);
    } catch (error) {
      invalid = { error };
    }
    return operations.run(async () => {
      if (failure) throw failure.error;
      if (invalid) throw invalid.error;
      await scope.session();
      const result = captureTenantData(await work(captured));
      await scope.session();
      return result;
    });
  };
  const keyFor = (table: string, input: unknown): Readonly<Record<string, string | number>> => {
    tenantRecord(input);
    const metadata = ownership.schema.tables.find((value) => value.id === table) ?? deny();
    const keys = metadata.columns.filter((column) => column.primaryKey).map((column) => column.name);
    if (
      !keys.length ||
      keys.length !== Object.keys(input).length ||
      keys.some((column) => !Object.hasOwn(input, column)) ||
      Object.values(input).some((value) => typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value)))
    )
      return deny();
    const rule = ownership.ownership[table];
    if (rule.kind === 'tenant' && tenantId !== undefined && Object.hasOwn(input, rule.column) && input[rule.column] !== tenantId)
      return deny();
    return input as Record<string, string | number>;
  };
  const keyShape = (table: string, key: readonly string[]) => {
    const columns = (ownership.schema.tables.find((value) => value.id === table) ?? deny()).columns;
    return { key, kinds: Object.fromEntries(columns.map((column) => [column.name, columnKind(column.type)])) };
  };
  /** Whether the row is visible here and, where the kind reads owners, whose
   * it is: a tenant row's owner, or '' for a platform row. */
  const visible = async (reference: CommandResultReference): Promise<string> => {
    tenantRecord(reference, ['table', 'key']);
    const table = authorization.table(reference.table),
      key = keyFor(table, reference.key);
    const rule = ownership.ownership[table],
      owner = place.readsOwners && rule.kind === 'tenant' ? rule.column : undefined;
    /* The key and the row it names, each in its columns' one spelling (commandDb.ts canonicalKey): a record page
       reached by its address says an integer id as its digits, `{"id":"3"}`, and the row reads back 3. Compared as
       spelled, the platform's prepare on a page opened by its address was refused. */
    const shape = keyShape(table, Object.keys(key));
    const asked = canonicalKey(shape, key) ?? deny();
    const result = await tx.query({
      table,
      columns: [...new Set([...Object.keys(key), ...(owner ? [owner] : [])])],
      limit: 2,
      offset: 0,
      filter: { groups: [Object.entries(asked).map(([column, value]) => ({ column, op: '=', value }))] },
    });
    const found = result.rows.length === 1 ? canonicalKey(shape, result.rows[0]) : undefined;
    if (!found || Object.entries(asked).some(([column, value]) => found[column] !== value)) return deny();
    if (!owner) return '';
    const value = result.rows[0][owner];
    return typeof value === 'string' ? value : deny();
  };
  /** The empty key of a command the authorizer made a creating one, and only that: any other empty key is refused by keyFor. */
  const creating = (key: unknown): boolean =>
    authorization.command.targets === 'none' &&
    authorization.keyColumns.length === 0 &&
    !!key &&
    typeof key === 'object' &&
    !Array.isArray(key) &&
    Object.keys(key).length === 0;
  const owners = new Map<string, string>();
  /* The command's own target, removed by this transaction (Unrelate, Remove a holiday): its ceiling is
     judged before the removal, and its owner taken then, since after it there is no row to read. */
  const gone = new Set<string>();
  const goneKey = (key: Readonly<Record<string, unknown>>) =>
    JSON.stringify(
      Object.keys(key)
        .sort()
        .map((column) => [column, String(key[column])]),
    );
  /** Each audit row's owner as this transaction read it from its target row:
   * never the handler's word, and never guessed for a key it did not read. */
  const stamped = (audit: CommandAudit | readonly CommandAudit[]): CommandAudit | readonly CommandAudit[] => {
    const owned = (entry: CommandAudit): CommandAudit => {
      const owner = owners.get(entry.keyJson);
      return owner === undefined ? deny() : { ...entry, owner };
    };
    return Array.isArray(audit) ? (audit as readonly CommandAudit[]).map(owned) : owned(audit as CommandAudit);
  };
  const project = <V>(table: string, row: Record<string, V>): Record<string, V> =>
    Object.fromEntries(Object.entries(row).filter(([column]) => fields.get(table)?.read.has(column)));
  const records = Object.freeze<WriteTransaction>({
    query: (input) =>
      invoke(input, async (value) => {
        assertStructuredReadFilter(value.filter, 'column');
        const result = await tx.query({ ...value, table: authorization.table(value.table) });
        return { ...result, sql: { text: '', params: [] } };
      }),
    count: (table, filter) =>
      invoke({ table, filter }, (value) => {
        assertStructuredReadFilter(value.filter, 'column');
        return tx.count(authorization.table(value.table), value.filter);
      }),
    insert: (input) =>
      invoke(input, async (value) => {
        const table = authorization.table(value.table, true),
          result = await tx.insert({ ...value, table });
        return {
          key: project(table, result.key),
          applied: project(table, result.applied),
          ...(result.row ? { row: project(table, result.row) } : {}),
          sql: { text: '', params: [] },
        };
      }),
    update: (input) =>
      invoke(input, async (value) => {
        const table = authorization.table(value.table, true);
        // Public triage only creates; the refusal says so to the operator's log.
        if (!place.updates)
          throw refused(`a public submission updates no ${value.table} row here: it lands with the platform, which only inserts`);
        keyFor(table, value.key);
        const result = await tx.update({ ...value, table });
        return { affected: result.affected, applied: project(table, result.applied), sql: { text: '', params: [] } };
      }),
    remove: (input) =>
      invoke(input, async (value) => {
        const table = authorization.table(value.table, true);
        if (!place.removes)
          throw refused(`a public submission removes no ${value.table} row: it may insert, and update its tenant's declared rows`);
        keyFor(table, value.key);
        const own = value.table === authorization.command.target && !creating(value.key);
        if (own) {
          const owner = await visible({ table: value.table, key: value.key });
          if (place.readsOwners) owners.set(canonicalCommandJson({ ...value.key }, 8192), owner);
        }
        const result = await removal.remove({ ...value, table });
        if (own && result.affected === 1) gone.add(goneKey(value.key));
        return { affected: result.affected, sql: { text: '', params: [] } };
      }),
    /* A flow's notice, about a record this kind may update and this transaction can see: never a public
       submission's, which updates nothing it did not place (flowCommand.ts). */
    ...(tx.tell
      ? {
          tell: (input: TellRequest) =>
            invoke(input, async (value) => {
              tenantRecord(value, ['table', 'key', 'audience', 'message']);
              const table = authorization.table(value.table, true);
              if (!place.updates) return deny();
              await visible({ table: value.table, key: value.key });
              await tx.tell!({ ...value, table });
            }),
        }
      : {}),
  });
  const context = Object.freeze<TenantCommandRecords>({
    records,
    ...(journal
      ? {
          journal: Object.freeze<CommandJournal>({
            find: (scope, expectedManifest) =>
              invoke({ scope, expectedManifest }, (input) => journal.find(input.scope, input.expectedManifest)),
            commit: (receipt, audit, eventBatch) =>
              invoke({ receipt, audit, eventBatch }, (input) =>
                journal.commit(input.receipt, place.audit(input.audit, stamped), input.eventBatch),
              ),
            ...(journal.nextNumber
              ? {
                  nextNumber: (appId: string, name: string, per: string, start: number) =>
                    invoke({ appId, name, per, start }, (input) => journal.nextNumber!(input.appId, input.name, input.per, input.start)),
                }
              : {}),
          }),
        }
      : {}),
    target: (key) =>
      invoke(key, async (key) => {
        /* A command that creates its rows (`targets: 'none'`: a signed-in
         form's, a job's at times) names no record, so there is none to read.
         Its audit row names no record either, and so no tenant's — unless its
         kind acts in one named tenant, whose audit it then is. */
        if (creating(key)) {
          if (place.readsOwners) owners.set(canonicalCommandJson({}, 8192), place.creates ?? '');
          return;
        }
        // Removed by this command, after its ceiling was judged: nothing is left to hide.
        if (gone.has(goneKey(key))) return;
        const owner = await visible({ table: authorization.command.target, key });
        // Canonical over a plain copy: this is the executor's audit keyJson spelling.
        if (place.readsOwners) owners.set(canonicalCommandJson({ ...key }, 8192), owner);
      }),
    result: (key, value) =>
      invoke({ key, value }, async ({ key, value }) => {
        if (!creating(key) && !gone.has(goneKey(key))) await visible({ table: authorization.command.target, key });
        const returned: unknown = extract(value);
        if (isPromise(returned)) {
          void Promise.prototype.then.call(returned, undefined, () => {});
          return deny();
        }
        const references = captureTenantData(returned);
        if (!Array.isArray(references) || references.length > 64) return deny();
        for (const reference of references) await visible(reference);
      }),
  });
  let result!: T;
  const completed = (value: T): T => {
    accepting = false;
    return captureTenantData(value);
  };
  try {
    const returned = callback(context);
    result = isPromise(returned)
      ? ((await Promise.prototype.then.call(returned, completed, (error: unknown) => {
          accepting = false;
          throw error;
        })) as T)
      : completed(returned);
  } catch (error) {
    failure = { error };
  }
  accepting = false;
  let drained: { error: unknown } | undefined;
  try {
    await operations.finish();
  } catch (error) {
    drained = { error };
  }
  if (
    failure?.error instanceof TransactionOutcomeUnknown ||
    (failure?.error instanceof BusinessCommandExecutionError && failure.error.outcome === 'unknown')
  )
    throw failure.error;
  if (drained) throw drained.error;
  if (failure) throw failure.error;
  return result;
}
