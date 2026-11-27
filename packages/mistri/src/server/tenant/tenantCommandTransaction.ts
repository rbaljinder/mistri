import { isPromise, isProxy } from 'node:util/types';
import {
  TransactionOperations,
  TransactionOutcomeUnknown,
  type AggregateRequest,
  type CteRequest,
  type InsertRequest,
  type QueryRequest,
  type TellRequest,
  type UpdateRequest,
  type WriteTransaction,
} from '@mistriwork/engine/adapters/adapter.js';
import { remapCteTables } from '@mistriwork/engine/shared/cte.js';
import { projectLockedBefores, trackTargetImpact } from '@mistriwork/engine/adapters/writeAhead.js';
import { canonicalCommandJson } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import type { CommandAudit, CommandJournal, CommandLinkRow } from '../../adapters/commands/commandJournalTypes.js';
import { AppAccessDenied, authorizeTransaction, markStableGrant, type ResourceAccess } from '../app/appAccess.js';
import type { BusinessCommandAuthorization } from '../commands/businessCommandAuthorization.js';
import { BusinessCommandExecutionError } from '../commands/businessCommandExecution.js';
import { PUBLIC_REMOVAL } from '../commands/commandErrors.js';
import { canonicalKey } from '../commands/commandDb.js';
import { columnKind, type ColumnKind } from '@mistriwork/engine/shared/schema.js';
import type { TenantCommandKind } from './tenantCommandKindContract.js';
import { intakeCommandKind } from './tenantCommandKindIntake.js';
import { memberCommandKind } from './tenantCommandKindMember.js';
import { platformCommandKind } from './tenantCommandKindPlatform.js';
import { platformTenantCommandKind } from './tenantCommandKindPlatformTenant.js';
import { linkCommandKind } from './tenantCommandKindLink.js';
import { serviceCommandKind } from './tenantCommandKindService.js';
import { captureTenantData, recordRefusalCause, tenantRecord } from '@mistriwork/engine/server/evidence.js';
import type { TenantOwnershipSnapshot } from './tenantOwnership.js';
import { assertStructuredReadFilter } from '@mistriwork/engine/server/resourceReadOperations.js';
import { heldFileMethods } from './tenantHeldFiles.js';
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
  linkCommandKind,
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

interface CommandTableInfo {
  readonly keys: readonly string[];
  readonly kinds: Readonly<Record<string, ColumnKind>>;
}
const commandTables = new WeakMap<TenantOwnershipSnapshot, Map<string, CommandTableInfo>>();
function tableInfoMap(ownership: TenantOwnershipSnapshot): Map<string, CommandTableInfo> {
  let map = commandTables.get(ownership);
  if (!map) {
    map = new Map();
    for (const table of ownership.schema.tables) {
      map.set(table.id, {
        keys: table.columns.filter((column) => column.primaryKey).map((column) => column.name),
        kinds: Object.fromEntries(table.columns.map((column) => [column.name, columnKind(column.type)])),
      });
    }
    commandTables.set(ownership, map);
  }
  return map;
}

const NO_VALIDATION = Object.freeze({});
const COMMAND_GRANTS = 512;
interface CachedCommandGrants {
  readonly fields: Map<string, { read: ReadonlySet<string>; write: ReadonlySet<string> }>;
  readonly txAccess: ResourceAccess;
  readonly removalAccess: ResourceAccess;
}
const commandGrants = new WeakMap<TenantOwnershipSnapshot, WeakMap<object, Map<string, CachedCommandGrants>>>();
function cachedCommandGrants(
  ownership: TenantOwnershipSnapshot,
  realm: string,
  place: ReturnType<TenantCommandKind<TenantCommandPrincipal>['place']>,
  scopeGrants: ResourceAccess,
  authorization: BusinessCommandAuthorization,
): CachedCommandGrants {
  const validation = scopeGrants.validation;
  const vKey = validation ?? NO_VALIDATION;
  let byValidation = commandGrants.get(ownership);
  if (!byValidation) commandGrants.set(ownership, (byValidation = new WeakMap()));
  let bySpec = byValidation.get(vKey);
  if (!bySpec) byValidation.set(vKey, (bySpec = new Map()));
  const hiddenOwners: string[] = [];
  if (scopeGrants.fields) {
    for (const table of ownership.schema.tables) {
      const rule = ownership.ownership[table.id];
      if (rule?.kind === 'tenant') {
        const granted = scopeGrants.fields.get(table.id)?.read;
        if (granted && !granted.has(rule.column)) hiddenOwners.push(table.id);
      }
    }
  }
  const key = JSON.stringify([
    realm,
    place.readsOwners,
    place.tenantId !== undefined,
    hiddenOwners,
    authorization.read,
    authorization.write,
  ]);
  const kept = bySpec.get(key);
  if (kept) return kept;
  const read = new Set(authorization.read),
    write = new Set(authorization.write);
  const fields = new Map(
    ownership.schema.tables.map((table) => {
      const rule = ownership.ownership[table.id],
        granted = scopeGrants.fields?.get(table.id)?.read;
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
  const txAccess = markStableGrant({ readable: read, writable: write, fields, ...(validation ? { validation } : {}) });
  // Separate readable Set so markStableGrant's WeakMap keys txAccess and removalAccess independently.
  const removalAccess = markStableGrant({
    readable: new Set(authorization.read),
    writable: write,
    ...(validation ? { validation } : {}),
  });
  const entry: CachedCommandGrants = { fields, txAccess, removalAccess };
  if (bySpec.size >= COMMAND_GRANTS) bySpec.delete(bySpec.keys().next().value!);
  bySpec.set(key, entry);
  return entry;
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
  /* `raw` is one read snapshot (an availability batch, tenantCommandAvailability.ts): every read sees one state, so
     a target row its own read already found through this transaction is not read again (`target`). */
  snapshot = false,
): Promise<T> {
  // Where this principal writes, from its kind (tenantCommandKind*.ts).
  const kind = commandKindOf(scope.principal);
  const place = kind.place(scope.principal);
  const tenantId = place.tenantId;
  const { fields, txAccess, removalAccess } = cachedCommandGrants(ownership, kind.realm, place, scope.grants, authorization);
  const tx = authorizeTransaction(ownership.schema, txAccess, raw);
  // Whole-row removal has an explicit command grant and complete normal-field
  // authority. Only this operation may remove the managed owner invariant;
  // ordinary values, reads and updates keep the field facade above. The source
  // still proves actual tenant rows and conservative non-cascading eligibility.
  let removal: ReturnType<typeof authorizeTransaction> | undefined;
  const removalTx = () => (removal ??= authorizeTransaction(ownership.schema, removalAccess, raw));
  const tables = tableInfoMap(ownership);
  /* Reads asked together start together, in the order asked (TransactionOperations.read); the writer beneath decides
     whether they leave in one flight. Anything else waits for everything asked before it, as each always did. */
  const operations = new TransactionOperations(true);
  let accepting = true,
    failure: { error: unknown } | undefined;
  const invoke = <A, R>(input: A, work: (captured: A) => Promise<R>, read = false): Promise<R> => {
    if (!accepting) return Promise.reject(new AppAccessDenied());
    let captured!: A, invalid: { error: unknown } | undefined;
    try {
      captured = captureTenantData(input);
    } catch (error) {
      invalid = { error };
    }
    const job = async (): Promise<R> => {
      if (failure) throw failure.error;
      if (invalid) throw invalid.error;
      await scope.session();
      const result = captureTenantData(await work(captured));
      await scope.session();
      return result;
    };
    return read ? operations.read(job) : operations.run(job);
  };
  const keyFor = (table: string, input: unknown): Readonly<Record<string, string | number>> => {
    tenantRecord(input);
    const info = tables.get(table) ?? deny();
    const keys = info.keys;
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
    const info = tables.get(table) ?? deny();
    return { key, kinds: info.kinds };
  };
  /** The column a row's owner is read from where this kind reads owners; undefined where it does not. */
  const ownerOf = (table: string): string | undefined => {
    const rule = ownership.ownership[table];
    return place.readsOwners && rule.kind === 'tenant' ? rule.column : undefined;
  };
  // A key that has no canonical spelling is never kept, and so is read, as before.
  const keyText = (key: Readonly<Record<string, unknown>>): string | undefined => {
    try {
      return canonicalCommandJson(key, 8192);
    } catch {
      return undefined;
    }
  };
  /* In a snapshot, the command's target rows its own reads found through this transaction, by their key, with
     their owner where this kind reads one: the read `visible` would ask, already answered in the same state. An
     availability check reads its targets and then asserts each (commandAvailability.ts); asserted by a second read,
     that was a second round trip after the first for every check on a record page. */
  const readTargets = new Map<string, string>();
  const noteFound = (table: string, rows: readonly Record<string, unknown>[]) => {
    if (!snapshot || table !== authorization.table(authorization.command.target)) return;
    const info = tables.get(table) ?? deny(),
      shape = { key: info.keys, kinds: info.kinds },
      owner = ownerOf(table);
    for (const row of rows) {
      const key = canonicalKey(shape, row),
        text = key && keyText(key),
        value = owner ? row[owner] : '';
      if (text && typeof value === 'string') readTargets.set(text, value);
    }
  };
  /** Whether the row is visible here and, where the kind reads owners, whose
   * it is: a tenant row's owner, or '' for a platform row. */
  const visible = async (reference: CommandResultReference): Promise<string> => {
    tenantRecord(reference, ['table', 'key']);
    const table = authorization.table(reference.table),
      key = keyFor(table, reference.key);
    const owner = ownerOf(table);
    /* The key and the row it names, each in its columns' one spelling (commandDb.ts canonicalKey): a record page
       reached by its address says an integer id as its digits, `{"id":"3"}`, and the row reads back 3. Compared as
       spelled, the platform's prepare on a page opened by its address was refused. */
    const shape = keyShape(table, Object.keys(key));
    const asked = canonicalKey(shape, key) ?? deny();
    const text = snapshot ? keyText(asked) : undefined,
      seen = text === undefined ? undefined : readTargets.get(text);
    if (seen !== undefined) return seen;
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
  /* Last target key verified visible since the most recent write in this transaction, avoiding duplicate result+target RTTs. */
  let verifiedTarget: string | undefined;
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
  /* A test against another table's rows (`customer_id.region` in a handler's where, Condition.within) names a table of
     the command's too: authorized and named as the table read is. Left under the handler's name, the read beneath
     knew no such table wherever the database ids it otherwise (every PostgreSQL table, by its schema), and a path
     that ran on SQLite was refused there. `any`/`no` stay as they are asked, refused beneath. */
  const named = <F extends QueryRequest['filter']>(filter: F): F =>
    filter?.groups.some((group) => group.some((condition) => condition.within !== undefined))
      ? ({
          ...filter,
          groups: filter.groups.map((group) =>
            group.map((condition) =>
              condition.within === undefined
                ? condition
                : { ...condition, within: { ...condition.within, table: authorization.table(condition.within.table) } },
            ),
          ),
        } as F)
      : filter;
  const records = Object.freeze<WriteTransaction>({
    query: (input) =>
      invoke(
        input,
        async (value) => {
          assertStructuredReadFilter(value.filter, 'column');
          const table = authorization.table(value.table);
          const result = await tx.query({ ...value, table, filter: named(value.filter) });
          noteFound(table, result.rows);
          return { ...result, sql: { text: '', params: [] } };
        },
        true,
      ),
    count: (table, filter) =>
      invoke(
        { table, filter },
        (value) => {
          assertStructuredReadFilter(value.filter, 'column');
          return tx.count(authorization.table(value.table), named(value.filter));
        },
        true,
      ),
    // Sums and groups read as `count` reads: a table of the command's footprint, the fields this kind may read.
    ...(tx.aggregate
      ? {
          aggregate: (input: AggregateRequest) =>
            invoke(
              input,
              (value) => {
                assertStructuredReadFilter(value.filter, 'column');
                return tx.aggregate!({ ...value, table: authorization.table(value.table), filter: named(value.filter) });
              },
              true,
            ),
        }
      : {}),
    ...(tx.cte
      ? {
          cte: (input: CteRequest) =>
            invoke(
              input,
              (value) => {
                for (const step of value.with) assertStructuredReadFilter(step.filter, 'column');
                assertStructuredReadFilter(value.query.filter, 'column');
                return tx.cte!(remapCteTables(value, (table) => authorization.table(table)));
              },
              true,
            ),
        }
      : {}),
    insert: (input) =>
      invoke(input, async (value) => {
        const table = authorization.table(value.table, true);
        const targetPhysical = ownership.resources[authorization.table(authorization.command.target)];
        const { value: result, preserved } =
          verifiedTarget !== undefined && targetPhysical
            ? await trackTargetImpact(targetPhysical, () => tx.insert({ ...value, table }))
            : { value: await tx.insert({ ...value, table }), preserved: false };
        if (!preserved) verifiedTarget = undefined;
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
        const targetPhysical = ownership.resources[authorization.table(authorization.command.target)];
        const { value: result, preserved } =
          verifiedTarget !== undefined && targetPhysical
            ? await trackTargetImpact(targetPhysical, () => tx.update({ ...value, table }))
            : { value: await tx.update({ ...value, table }), preserved: false };
        if (!preserved) verifiedTarget = undefined;
        return { affected: result.affected, applied: project(table, result.applied), sql: { text: '', params: [] } };
      }),
    /* A batch is its rows, each judged here as `insert` and `update` judge one (the table, a public submission's
       limits, the key), then sent down whole so the writer beneath pays its round trips once. There is no batch
       remove: removing counts each row's references, and that stays one row at a time. */
    ...(tx.insertMany && tx.updateMany
      ? {
          insertMany: (inputs: readonly InsertRequest[]) =>
            invoke(inputs, async (values) => {
              const requests = values.map((value) => ({ ...value, table: authorization.table(value.table, true) }));
              const targetPhysical = ownership.resources[authorization.table(authorization.command.target)];
              const { value: results, preserved } =
                verifiedTarget !== undefined && targetPhysical
                  ? await trackTargetImpact(targetPhysical, () => tx.insertMany!(requests))
                  : { value: await tx.insertMany!(requests), preserved: false };
              if (!preserved) verifiedTarget = undefined;
              return results.map((result, index) => {
                const table = requests[index]!.table;
                return {
                  key: project(table, result.key),
                  applied: project(table, result.applied),
                  ...(result.row ? { row: project(table, result.row) } : {}),
                  sql: { text: '', params: [] },
                };
              });
            }),
          updateMany: (inputs: readonly UpdateRequest[]) =>
            invoke(inputs, async (values) => {
              const requests = values.map((value) => {
                const table = authorization.table(value.table, true);
                if (!place.updates)
                  throw refused(`a public submission updates no ${value.table} row here: it lands with the platform, which only inserts`);
                keyFor(table, value.key);
                return { ...value, table };
              });
              const targetPhysical = ownership.resources[authorization.table(authorization.command.target)];
              const { value: results, preserved } =
                verifiedTarget !== undefined && targetPhysical
                  ? await trackTargetImpact(targetPhysical, () => tx.updateMany!(requests))
                  : { value: await tx.updateMany!(requests), preserved: false };
              if (!preserved) verifiedTarget = undefined;
              projectLockedBefores((row, index) => project(requests[index]!.table, row));
              return results.map((result, index) => ({
                affected: result.affected,
                applied: project(requests[index]!.table, result.applied),
                sql: { text: '', params: [] },
              }));
            }),
        }
      : {}),
    remove: (input) =>
      invoke(input, async (value) => {
        verifiedTarget = undefined;
        const table = authorization.table(value.table, true);
        /* Said to the visitor too, in words that name the delete and not the table: "not available to this account"
           sent a handler's author looking at grants when it was the removal that was refused (a field report).
           `mistri check` refuses a public command whose handler it sees remove a row ([public-command-remove]). */
        if (!place.removes)
          throw recordRefusalCause(
            new BusinessCommandExecutionError('forbidden', 'not_applied', undefined, undefined, PUBLIC_REMOVAL),
            `a public submission removes no ${value.table} row: it may insert, and update its tenant's declared rows`,
          );
        keyFor(table, value.key);
        const own = value.table === authorization.command.target && !creating(value.key);
        if (own) {
          const owner = await visible({ table: value.table, key: value.key });
          if (place.readsOwners) owners.set(canonicalCommandJson({ ...value.key }, 8192), owner);
        }
        const result = await removalTx().remove({ ...value, table });
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
            // Held files are kept in this place's own journal store, under the same fence as a commit.
            ...heldFileMethods(invoke, journal.stage?.bind(journal), journal.takeStaged?.bind(journal)),
            // A command's audited reads are written in this place's store too, kept or rolled back with its commit.
            ...(journal.appendReadAudit
              ? { appendReadAudit: (rows) => invoke({ rows }, (input) => journal.appendReadAudit!(input.rows)) }
              : {}),
            /* Links are this place's too: minted with the command's commit, opened and re-read under its fence, and
               revoked with a delete in the same transaction. The row is the platform's, outside the row scope. */
            ...(journal.mintLink ? { mintLink: (row: CommandLinkRow) => invoke({ row }, (input) => journal.mintLink!(input.row)) } : {}),
            ...(journal.revokeLinks
              ? {
                  revokeLinks: (appId: string, resource: string, rowKey: string, name: string | undefined, now: number) =>
                    invoke({ appId, resource, rowKey, name, now }, (input) =>
                      journal.revokeLinks!(input.appId, input.resource, input.rowKey, input.name, input.now),
                    ),
                }
              : {}),
            ...(journal.openLink
              ? {
                  openLink: (appId: string, id: string, now: number) =>
                    invoke({ appId, id, now }, (input) => journal.openLink!(input.appId, input.id, input.now)),
                }
              : {}),
            ...(journal.readLink
              ? {
                  readLink: (appId: string, id: string, now: number) =>
                    invoke({ appId, id, now }, (input) => journal.readLink!(input.appId, input.id, input.now)),
                }
              : {}),
            // A proposal is claimed and settled with the command that carries it out, kept or rolled back with it.
            ...(journal.createProposal
              ? {
                  createProposal: (...args: Parameters<NonNullable<CommandJournal['createProposal']>>) =>
                    invoke({ args }, (input) => journal.createProposal!(...input.args)),
                }
              : {}),
            ...(journal.readProposal
              ? {
                  readProposal: (...args: Parameters<NonNullable<CommandJournal['readProposal']>>) =>
                    invoke({ args }, (input) => journal.readProposal!(...input.args)),
                }
              : {}),
            ...(journal.listProposals
              ? {
                  listProposals: (...args: Parameters<NonNullable<CommandJournal['listProposals']>>) =>
                    invoke({ args }, (input) => journal.listProposals!(...input.args)),
                }
              : {}),
            ...(journal.decideProposal
              ? {
                  decideProposal: (...args: Parameters<NonNullable<CommandJournal['decideProposal']>>) =>
                    invoke({ args }, (input) => journal.decideProposal!(...input.args)),
                }
              : {}),
            ...(journal.settleProposal
              ? {
                  settleProposal: (...args: Parameters<NonNullable<CommandJournal['settleProposal']>>) =>
                    invoke({ args }, (input) => journal.settleProposal!(...input.args)),
                }
              : {}),
            ...(journal.expireProposals
              ? {
                  expireProposals: (...args: Parameters<NonNullable<CommandJournal['expireProposals']>>) =>
                    invoke({ args }, (input) => journal.expireProposals!(...input.args)),
                }
              : {}),
            ...(journal.markProvenance
              ? {
                  markProvenance: (...args: Parameters<NonNullable<CommandJournal['markProvenance']>>) =>
                    invoke({ args }, (input) => journal.markProvenance!(...input.args)),
                }
              : {}),
            ...(journal.confirmProvenance
              ? {
                  confirmProvenance: (...args: Parameters<NonNullable<CommandJournal['confirmProvenance']>>) =>
                    invoke({ args }, (input) => journal.confirmProvenance!(...input.args)),
                }
              : {}),
            ...(journal.unconfirmedProvenance
              ? {
                  unconfirmedProvenance: (...args: Parameters<NonNullable<CommandJournal['unconfirmedProvenance']>>) =>
                    invoke({ args }, (input) => journal.unconfirmedProvenance!(...input.args)),
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
        const keyText = goneKey(key);
        if (gone.has(keyText) || verifiedTarget === keyText) return;
        const owner = await visible({ table: authorization.command.target, key });
        // Canonical over a plain copy: this is the executor's audit keyJson spelling.
        if (place.readsOwners) owners.set(canonicalCommandJson({ ...key }, 8192), owner);
        verifiedTarget = keyText;
      }),
    result: (key, value) =>
      invoke({ key, value }, async ({ key, value }) => {
        if (!creating(key)) {
          const keyText = goneKey(key);
          if (!gone.has(keyText) && verifiedTarget !== keyText) {
            const owner = await visible({ table: authorization.command.target, key });
            if (place.readsOwners) owners.set(canonicalCommandJson({ ...key }, 8192), owner);
            verifiedTarget = keyText;
          }
        }
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
