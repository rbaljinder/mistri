import { isPromise } from 'node:util/types';
import { TransactionOperations, type Adapter, type TellRequest, type WriteTransaction } from '@mistriwork/engine/adapters/adapter.js';
import type { CommandJournal } from '../../adapters/commands/commandJournal.js';
import type { CommandJournalAppScope } from '../../adapters/commands/commandJournalTypes.js';
import { snapshotScopedData } from '@mistriwork/engine/adapters/scoped/scopedReads.js';
import { logicalResource, type AppDef } from '../../shared/app.js';
import { snapshotRowScope, type RowScope } from '@mistriwork/engine/shared/rowScope.js';
import { assertScopeCatalog, captureScopeCatalog, mapScopeCatalog } from '@mistriwork/engine/shared/scopeCatalog.js';
import { AppAccessDenied, authorizeTransaction } from '../app/appAccess.js';
import { compileAppDefinitionValidation, type AppValidationRules } from '../app/appValidation.js';
import type { RuntimeResources } from '../app/appRuntimeResources.js';
import { actorReader, bindBusinessCommands, registerScopedAppEventBinding, type BusinessCommandBinding } from './businessCommandAccess.js';
import { defineCommands, BusinessCommandDefinitionError, getCommandEvents, type BusinessCommandRegistry } from './businessCommands.js';
import { commandsOf } from '../stores/commandStores.js';

export interface CommandResultReference {
  readonly table: string;
  readonly key: Readonly<Record<string, string | number>>;
}

/** Private deployment contract, not public App metadata. The extractor declares
 * ALL non-target row dependencies of the complete stored DTO, including historic
 * values. [] explicitly attests target-only content/constants. Arbitrary aggregate
 * provenance and field-restricted command outputs are not supported. */
export interface ScopedCommandOptions {
  registry: BusinessCommandRegistry;
  writableConnection: (connection: string) => boolean;
  resultReferences: Readonly<Record<string, (result: unknown) => readonly CommandResultReference[]>>;
  /** Compiled once from the App root; command handlers cannot bypass it. */
  validation?: AppValidationRules;
  /** The App's issued event source (issueAppScopeCommandEvents), for commands
   * that declare events. Without it a registry that declares events is refused. */
  events?: CommandJournalAppScope;
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** One private deployed binding. Invocation scope is supplied only by a verified
 * policy issuer, never an HTTP body. This does not enable public policy routes. */
export function bindScopedBusinessCommands(options: ScopedCommandOptions & { app: AppDef; resources: RuntimeResources }) {
  const app = freeze(snapshotScopedData(options.app));
  const schema = captureScopeCatalog(options.resources.schema);
  const validation = options.validation ?? compileAppDefinitionValidation(schema, app);
  const registry = defineCommands(options.registry);
  const writable = options.writableConnection;
  const invalid = (): never => {
    throw new BusinessCommandDefinitionError(
      'Scoped commands require explicit journal support and complete result authorization declarations.',
    );
  };
  if (typeof writable !== 'function') invalid();
  const rawExtractors = options.resultReferences;
  if (
    !rawExtractors ||
    typeof rawExtractors !== 'object' ||
    Array.isArray(rawExtractors) ||
    ![null, Object.prototype].includes(Object.getPrototypeOf(rawExtractors))
  )
    invalid();
  /* A `public: true` command never runs on a row-policy App: its public
     form answers 503 there and no role may hold it. It needs no result
     authorization and no scoped journal, so it is left out of both checks
     below, and naming it in resultReferences is an extra entry. */
  const scopedIds = Object.keys(registry).filter((id) => registry[id].public !== true);
  const extractorKeys = Reflect.ownKeys(rawExtractors);
  if (extractorKeys.length !== scopedIds.length) invalid();
  const extractors = new Map<string, (result: unknown) => readonly CommandResultReference[]>();
  for (const key of extractorKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(rawExtractors, key)!;
    if (
      typeof key !== 'string' ||
      !scopedIds.includes(key) ||
      !descriptor.enumerable ||
      !('value' in descriptor) ||
      typeof descriptor.value !== 'function'
    )
      invalid();
    extractors.set(key as string, descriptor.value);
  }
  const connections = [...options.resources.connections];
  const owners = new Map(schema.tables.map((table) => [table.id, options.resources.connectionFor(table.id)]));
  if (
    !connections.length ||
    new Set(connections).size !== connections.length ||
    [...owners.values()].some((owner) => !connections.includes(owner))
  )
    invalid();
  const deny = (): never => {
    throw new AppAccessDenied();
  };
  const adapters = new Map(
    connections.map((owner) => {
      const source = options.resources.forConnection(owner);
      const commands = commandsOf(source);
      // Capture identities once. The legacy binder validates command declarations;
      // none of its unscoped transaction closures are exposed by this binding.
      const captured: Adapter = Object.freeze({
        dialect: source.dialect,
        introspect: async () => schema,
        close: async () => {},
        query: deny,
        count: deny,
        ...(typeof source.transaction === 'function' ? { transaction: source.transaction.bind(source) } : {}),
        ...(typeof commands.scopeCommandTransaction === 'function'
          ? { scopeCommandTransaction: commands.scopeCommandTransaction.bind(source) }
          : {}),
      });
      return [owner, captured] as const;
    }),
  );
  const resources: RuntimeResources = {
    ...options.resources,
    schema,
    connections,
    connectionFor: (resource) => owners.get(resource) ?? deny(),
    forConnection: (owner) => adapters.get(owner) ?? deny(),
  };
  /* A command's events are made from what it read and wrote in its scope, and
     are read only by the server — its effects, the jobs it starts, the
     workflows waiting on it — never served back to a reader (the API event
     feed refuses a row-policy App, apiEventFeed.ts). The base binding checks
     that each emitting command sits on the issued event source. */
  const events = options.events;
  const base = bindBusinessCommands({ app, resources, registry, writableConnection: writable, validation, ...(events ? { events } : {}) });
  for (const command of Object.values(registry)) {
    if (command.public === true) continue;
    const target = logicalResource(app, command.source, command.target);
    if (!commandsOf(resources.forConnection(resources.connectionFor(target))).scopeCommandTransaction) invalid();
  }

  return Object.freeze({
    withScope(input: RowScope, assertActive: () => void): BusinessCommandBinding {
      if (typeof assertActive !== 'function') throw new AppAccessDenied();
      assertActive();
      const rows = snapshotRowScope(schema, input);
      const scoped = Object.freeze<BusinessCommandBinding>({
        scoped: true as const,
        ...(app.track === undefined ? {} : { track: app.track }),
        // A signed-in form's command names no record (`targets: 'none'`): its envelope's key is empty, as without a policy.
        creates: (id: string): boolean => base.creates?.(id) === true,
        authorize(id, actor) {
          assertActive();
          const authorized = base.authorize(id, actor);
          const command = authorized.command;
          if (command.public === true) throw new AppAccessDenied();
          const owner = resources.connectionFor(authorized.resource);
          const source = resources.forConnection(owner);
          const logical = (local: string) => logicalResource(app, command.source, local);
          const read = new Set(command.read.map(logical));
          const write = new Set(command.write.map(logical));
          const current = () => {
            assertActive();
            if (!writable(owner)) throw new AppAccessDenied();
          };
          current();
          const policy = Object.freeze(
            Object.fromEntries(
              Object.entries(rows)
                .filter(([resource]) => owners.get(resource) === owner)
                .map(([resource, rule]) => [resource, read.has(resource) ? rule : false]),
            ),
          );
          const ids = new Map(schema.tables.filter((table) => owners.get(table.id) === owner).map((table) => [table.id, table.id]));
          const expected = mapScopeCatalog({ ...schema, dialect: source.dialect }, ids);
          const localTable = (name: string, writing = false): string => {
            if (!(writing ? command.write : command.read).includes(name)) throw new AppAccessDenied();
            return logical(name);
          };
          // Checks accept only handles issued by this authorization. Their work
          // joins the SAME fail-stop queue as records and the runtime journal.
          const checks = new WeakMap<
            WriteTransaction,
            {
              target(key: CommandResultReference['key']): Promise<void>;
              result(key: CommandResultReference['key'], result: unknown): Promise<void>;
            }
          >();
          return Object.freeze({
            command,
            actor: authorized.actor,
            resource: authorized.resource,
            keyColumns: authorized.keyColumns,
            ...(authorized.versionField ? { versionField: authorized.versionField } : {}),
            catalog: authorized.catalog,
            ...(authorized.machine ? { machine: authorized.machine } : {}),
            ...(authorized.timezone ? { timezone: authorized.timezone } : {}),
            ...(authorized.files ? { files: authorized.files } : {}),
            transaction: deny,
            readsInCommand: true,
            assertTarget: (records: WriteTransaction, key: CommandResultReference['key']) => checks.get(records)?.target(key) ?? deny(),
            assertResult: (records: WriteTransaction, key: CommandResultReference['key'], result: unknown) =>
              checks.get(records)?.result(key, result) ?? deny(),
            commandTransaction<T>(run: (records: WriteTransaction, journal: CommandJournal) => Promise<T>): Promise<T> {
              current();
              // As unscoped: only a command that declares events writes as the App's source.
              const eventSource = events && getCommandEvents(command) ? events : undefined;
              return commandsOf(source).scopeCommandTransaction!(
                policy,
                async (raw, journal, evidence) => {
                  current();
                  assertScopeCatalog(expected, evidence);
                  const tx = authorizeTransaction(
                    schema,
                    { readable: read, writable: write, validation, reader: actorReader(app, schema, authorized.actor) },
                    raw,
                  );
                  // Reads asked together go on together, in their order (TransactionOperations.read).
                  const operations = new TransactionOperations(true);
                  const accept = <A, R>(input: A, work: (snapshot: A) => Promise<R>, read = false): Promise<R> => {
                    let snapshot: A;
                    try {
                      snapshot = snapshotScopedData(input);
                    } catch (error) {
                      return operations.run(async () => {
                        throw error;
                      });
                    }
                    const job = async (): Promise<R> => {
                      current();
                      return work(snapshot);
                    };
                    return read ? operations.read(job) : operations.run(job);
                  };
                  const readResult = async <R>(work: Promise<R>): Promise<R> => {
                    const result = await work;
                    current();
                    return result;
                  };
                  const records = Object.freeze<WriteTransaction>({
                    query: (request) =>
                      accept(request, (request) => readResult(tx.query({ ...request, table: localTable(request.table) })), true),
                    count: (table, filter) =>
                      accept({ table, filter }, (request) => readResult(tx.count(localTable(request.table), request.filter)), true),
                    insert: (request) => accept(request, (request) => tx.insert({ ...request, table: localTable(request.table, true) })),
                    update: (request) => accept(request, (request) => tx.update({ ...request, table: localTable(request.table, true) })),
                    remove: (request) => accept(request, (request) => tx.remove({ ...request, table: localTable(request.table, true) })),
                    // A flow's notice is about a record its command may write (flowCommand.ts).
                    ...(tx.tell
                      ? {
                          tell: (request: TellRequest) =>
                            accept(request, (request) => tx.tell!({ ...request, table: localTable(request.table, true) })),
                        }
                      : {}),
                  });
                  const runtimeJournal = Object.freeze<CommandJournal>({
                    find: (scope, expectedManifest) =>
                      accept({ scope, expectedManifest }, (input) => readResult(journal.find(input.scope, input.expectedManifest))),
                    commit: (receipt, audit, eventBatch) =>
                      accept({ receipt, audit, eventBatch }, (input) => journal.commit(input.receipt, input.audit, input.eventBatch)),
                    // Numbered beyond the row scope on purpose: that is what a sequence is for (commandSequences.ts).
                    ...(journal.nextNumber
                      ? {
                          nextNumber: (appId: string, name: string, per: string, start: number) =>
                            accept({ appId, name, per, start }, (input) =>
                              journal.nextNumber!(input.appId, input.name, input.per, input.start),
                            ),
                        }
                      : {}),
                    ...(journal.insert
                      ? {
                          insert: (
                            receipt: Parameters<NonNullable<CommandJournal['insert']>>[0],
                            audit: Parameters<NonNullable<CommandJournal['insert']>>[1],
                          ) => accept({ receipt, audit }, (input) => journal.insert!(input.receipt, input.audit)),
                        }
                      : {}),
                    ...(journal.taken
                      ? {
                          taken: (scope: Parameters<NonNullable<CommandJournal['taken']>>[0]) =>
                            accept({ scope }, (input) => readResult(journal.taken!(input.scope))),
                        }
                      : {}),
                  });
                  const visible = async (reference: CommandResultReference) => {
                    if (
                      !reference ||
                      typeof reference !== 'object' ||
                      Array.isArray(reference) ||
                      Object.keys(reference).length !== 2 ||
                      !Object.hasOwn(reference, 'table') ||
                      !Object.hasOwn(reference, 'key')
                    )
                      deny();
                    const table = localTable(reference.table);
                    const metadata = schema.tables.find((item) => item.id === table)!;
                    const keys = metadata.columns.filter((column) => column.primaryKey).map((column) => column.name);
                    const key = reference.key;
                    if (
                      !keys.length ||
                      !key ||
                      typeof key !== 'object' ||
                      Array.isArray(key) ||
                      Object.keys(key).length !== keys.length ||
                      keys.some((column) => !Object.hasOwn(key, column)) ||
                      Object.values(key).some(
                        (value) => typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value)),
                      )
                    )
                      deny();
                    const result = await tx.query({
                      table,
                      columns: keys,
                      limit: 2,
                      offset: 0,
                      filter: { groups: [keys.map((column) => ({ column, op: '=' as const, value: key[column] }))] },
                    });
                    current();
                    if (result.rows.length !== 1) deny();
                  };
                  /* A creating command (`targets: 'none'`, granted so by the
                   authorizer) names no record: there is none to find in scope.
                   What it inserts the scoped transaction still holds to the
                   policy, and its result references are checked below. */
                  const creating = (key: unknown) =>
                    command.targets === 'none' &&
                    authorized.keyColumns.length === 0 &&
                    !!key &&
                    typeof key === 'object' &&
                    !Array.isArray(key) &&
                    Object.keys(key).length === 0;
                  checks.set(records, {
                    target: (key) =>
                      accept(key, async (key) => {
                        if (!creating(key)) await visible({ table: command.target, key });
                      }),
                    /* The target itself is not read again here: every caller
                     checks the targets right after (assertTargets), and the
                     executor skips one this transaction wrote and holds. */
                    result: (_key, result) =>
                      accept({ result }, async ({ result }) => {
                        const extracted: unknown = extractors.get(id)!(freeze(result));
                        // Consume erroneous async extractor rejections, but never
                        // await them or accept custom thenables as declarations.
                        if (isPromise(extracted)) {
                          void extracted.catch(() => {});
                          deny();
                        }
                        const references = snapshotScopedData(extracted);
                        if (!Array.isArray(references) || references.length > 64) deny();
                        for (const reference of references as CommandResultReference[]) await visible(reference);
                      }),
                  });
                  try {
                    const result = await run(records, runtimeJournal);
                    await operations.finish();
                    current();
                    return result;
                  } catch (error) {
                    await operations.finish().catch(() => {});
                    throw error;
                  }
                },
                eventSource,
              );
            },
          });
        },
      });
      return events ? registerScopedAppEventBinding(base, scoped) : scoped;
    },
  });
}
