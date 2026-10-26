import { TransactionOperations, type TellRequest, type WriteTransaction } from '@mistriwork/engine/adapters/adapter.js';
import type { CommandJournal } from '../../adapters/commands/commandJournal.js';
import type { CommandJournalAppScope } from '../../adapters/commands/commandJournalTypes.js';
import { captureCommandEventStoreBinding, type CommandEventStoreBinding } from '../../adapters/events/commandEventSchema.js';
import type { AppDef } from '../../shared/app.js';
import { AppAccessDenied, authorizeTransaction, type ResourceAccess } from '../app/appAccess.js';
import { resolveAppAccess } from '../../shared/appAccess.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import type { AppValidationRules } from '../app/appValidation.js';
import type { RuntimeResources } from '../app/appRuntimeResources.js';
import {
  BusinessCommandDefinitionError,
  getCommandEvents,
  type AnyBusinessCommand,
  type BusinessCommandActor,
  type BusinessCommandRegistry,
} from './businessCommands.js';
import { createBusinessCommandAuthorizer, type CommandFileRule } from './businessCommandAuthorization.js';
import { keyFilter, type CommandCatalog } from './commandDb.js';
import type { CommandLookupReader } from './commandLookup.js';
import { captureTenantRequestRuntime, type TenantRequestRuntime } from '../tenant/tenantRequestRuntime.js';
import { appResourceVerifiedCommandRunner } from '../app/appResources.js';
import { appSourceVerifiedCommandRunner } from '../app/appSourceAdapter.js';
import { isProxy } from 'node:util/types';
import { commandsOf } from '../stores/commandStores.js';

export interface AuthorizedBusinessCommand {
  readonly command: AnyBusinessCommand;
  /** Public logical identity, qualified when the command targets a secondary source. */
  readonly resource: string;
  readonly actor: BusinessCommandActor;
  readonly keyColumns: readonly string[];
  /** The target's revision column when it has a non-null integer `version`, else its revision is the row's digest (commandRevision.ts). */
  readonly versionField?: string;
  /** The footprint's tables by local name: what the handler's `db` and the target's read are built on. */
  readonly catalog: CommandCatalog;
  /** The machines its writes meet (businessCommandAuthorization.ts): the executor holds each write of a state to its graph. */
  readonly machine?: import('./businessCommandAuthorization.js').CommandMachine;
  /** A row policy's scoped command (scopedBusinessCommandAccess.ts): it opens no plain transaction, so a reader that
      writes nothing (a decision's inputs, decideReads.ts) reads in its command transaction, under the same row scope. */
  readonly readsInCommand?: true;
  /** The App's `ui.timezone`, the wall clock its writes into zone-less timestamp columns are made in (UTC when absent). */
  readonly timezone?: string;
  /** The table people are rows of (`auth.me`), where the command reads it: what `me` writes to a reference to it. */
  readonly people?: Readonly<{ table: string; column: string; key: string; id: string }>;
  /** The file resources it writes, by local name: the only tables a command may put bytes in, within their cap. */
  readonly files?: ReadonlyMap<string, CommandFileRule>;
  /** Present when the command looks up: its sources' tables, read outside any transaction. */
  readonly lookup?: CommandLookupReader;
  /** Private stable namespace; never request-supplied membership/session evidence. */
  readonly receiptOwner?: Readonly<{ storeId: string; sourceId: string; tenantId: string }>;
  /** A tenant App's public intake only: where this submission lands, the
   * resolved tenant's rows or the platform's. The server's, never a request's. */
  readonly intake?: 'tenant' | 'platform';
  /** Set only by the explicitly enrolled public-placement source owner. */
  readonly placement?: Readonly<{ tenantId: string }>;
  assertTarget?(records: WriteTransaction, key: Readonly<Record<string, string | number>>): Promise<void>;
  assertResult?(records: WriteTransaction, key: Readonly<Record<string, string | number>>, result: unknown): Promise<void>;
  transaction<T>(run: (tx: WriteTransaction) => Promise<T>): Promise<T>;
  /**
   * Reads for advice — whether a command is available — under the same read
   * grants, through the source's own reads rather than its one writer: no
   * transaction, nothing written, and nothing queued behind a write. Absent
   * where a verifier owns the source (a tenant's or a row policy's), whose
   * reads go through its own transaction.
   */
  advise?<T>(run: (tx: WriteTransaction) => Promise<T>): Promise<T>;
  /** Runtime only: never pass the journal to an application handler. */
  commandTransaction?<T>(run: (tx: WriteTransaction, journal: CommandJournal) => Promise<T>): Promise<T>;
}

export interface BusinessCommandBinding {
  readonly scoped?: true;
  /** The App's `track`: what its commands keep unless one says otherwise. */
  readonly track?: 'none' | 'receipts' | 'audit';
  /** Whether a signed-in form runs the command: its envelope then names no key. Absent, nothing does. */
  creates?(id: string): boolean;
  authorize(id: string, actor: BusinessCommandActor): AuthorizedBusinessCommand;
}

const eventOwners = new WeakSet<BusinessCommandBinding>();
/** Private tenant integration only. A structural receiptOwner is insufficient:
 * the issuer must hold the genuine pinned source/request runtime. */
export function registerTenantCommandEventBinding<Request>(
  runtime: TenantRequestRuntime<Request>,
  binding: BusinessCommandBinding,
): BusinessCommandBinding {
  captureTenantRequestRuntime(runtime);
  eventOwners.add(binding);
  return binding;
}
export const hasTenantCommandEventOwner = (binding: BusinessCommandBinding): boolean => eventOwners.has(binding);

const issuedAppEvents = new WeakSet<object>();
const appEventOwners = new WeakSet<BusinessCommandBinding>();
/** The App's own event source, issued by trusted startup code for an event
 * store it provisioned. A structural lookalike is refused: only an issued
 * value lets an ordinary binding generate events. */
export function issueAppScopeCommandEvents(source: CommandEventStoreBinding): CommandJournalAppScope {
  const captured = captureCommandEventStoreBinding(source);
  const issued = Object.freeze({ scope: 'app' as const, appId: captured.appId, storeId: captured.storeId, sourceId: captured.sourceId });
  issuedAppEvents.add(issued);
  return issued;
}
/** Whether this binding was bound with an issued App-scope event source. */
export const hasAppScopeCommandEventOwner = (binding: BusinessCommandBinding): boolean => appEventOwners.has(binding);
/** A row scope's binding over one bound with the issued App source
 * (scopedBusinessCommandAccess.ts withScope) emits as that one does; only an
 * owner's own scoping can be registered, so this widens nothing. */
export function registerScopedAppEventBinding(base: BusinessCommandBinding, scoped: BusinessCommandBinding): BusinessCommandBinding {
  if (!appEventOwners.has(base)) throw new AppAccessDenied();
  appEventOwners.add(scoped);
  return scoped;
}

interface CommandAccessOptions {
  app: AppDef;
  registry: BusinessCommandRegistry;
  resources: RuntimeResources;
  /** Server-owned physical connection policy, never supplied by a request. */
  writableConnection: (connection: string) => boolean;
  validation?: AppValidationRules;
  /** From issueAppScopeCommandEvents. Without it a registry that declares
   * events is refused; with it, only commands on its source may emit. */
  events?: CommandJournalAppScope;
}

/**
 * Bind a trusted server registry to one immutable application policy. This is
 * only the authorization foundation, not a dispatcher or an audited executor.
 * The caller must obtain actors from verified server sessions on every request.
 */
export function bindBusinessCommands(options: CommandAccessOptions): BusinessCommandBinding {
  return bind(options);
}

/** Private trusted-owner integration. No request supplies the verifier, and
 * this does not admit bearer tokens or broaden the command's footprint. */
export function bindVerifiedBusinessCommands(options: CommandAccessOptions, verify: () => unknown): BusinessCommandBinding {
  if (typeof verify !== 'function' || isProxy(verify)) throw new AppAccessDenied();
  return bind(options, verify);
}

function bind(options: CommandAccessOptions, verify?: () => unknown): BusinessCommandBinding {
  const { resources, writableConnection } = options;
  const authorizer = createBusinessCommandAuthorizer({
    app: options.app,
    registry: options.registry,
    schema: resources.schema,
    connectionFor: (resource) => resources.connectionFor(resource),
    writableConnection,
    transactionalConnection: (connection) => !!resources.forConnection(connection).transaction,
  });
  const events = options.events;
  if (events !== undefined && (!issuedAppEvents.has(events) || events.appId !== options.app.id)) {
    throw new BusinessCommandDefinitionError('App-scope command events need the event source issued at startup for this App.');
  }
  for (const command of Object.values(options.registry)) {
    if (getCommandEvents(command) && (!events || command.source !== events.sourceId)) {
      throw new BusinessCommandDefinitionError("Command events require a provisioned event store on the command's own source.");
    }
  }
  const bound: BusinessCommandBinding = Object.freeze({
    ...(options.app.track === undefined ? {} : { track: options.app.track }),
    creates: (id: string): boolean => authorizer.creates(id),
    authorize(id: string, actor: BusinessCommandActor): AuthorizedBusinessCommand {
      const binding = authorizer.authorize(id, actor);
      const source = resources.forConnection(binding.connection);
      const verified = verify ? (appResourceVerifiedCommandRunner(source) ?? appSourceVerifiedCommandRunner(source)) : undefined;
      if (verify && !verified) throw new AppAccessDenied();
      const table = binding.table;
      const withRecords = async <T>(raw: WriteTransaction, run: (tx: WriteTransaction) => Promise<T>): Promise<T> => {
        if (!writableConnection(binding.connection)) throw new AppAccessDenied();
        const tx = authorizeTransaction(
          resources.schema,
          {
            readable: new Set(binding.read),
            writable: new Set(binding.write),
            ...(options.validation ? { validation: options.validation } : {}),
            reader: actorReader(options.app, resources.schema, binding.actor),
          },
          raw,
        );
        // Include facade refusals in the transaction failure state, even
        // when a trusted handler catches them before they reach an adapter.
        const operations = new TransactionOperations();
        try {
          const result = await run({
            query: (request) => operations.run(async () => tx.query({ ...request, table: table(request.table) })),
            count: (local, filter) => operations.run(async () => tx.count(table(local), filter)),
            insert: (request) => operations.run(async () => tx.insert({ ...request, table: table(request.table, true) })),
            update: (request) => operations.run(async () => tx.update({ ...request, table: table(request.table, true) })),
            remove: (request) => operations.run(async () => tx.remove({ ...request, table: table(request.table, true) })),
            ...(tx.tell
              ? { tell: (request: TellRequest) => operations.run(async () => tx.tell!({ ...request, table: table(request.table) })) }
              : {}),
          });
          await operations.finish();
          return result;
        } catch (error) {
          await operations.finish().catch(() => {});
          throw error;
        }
      };
      return Object.freeze({
        command: binding.command,
        resource: binding.resource,
        actor: binding.actor,
        keyColumns: binding.keyColumns,
        ...(binding.versionField ? { versionField: binding.versionField } : {}),
        catalog: binding.catalog,
        ...(binding.machine ? { machine: binding.machine } : {}),
        ...(binding.timezone ? { timezone: binding.timezone } : {}),
        ...(binding.people ? { people: binding.people } : {}),
        ...(binding.files ? { files: binding.files } : {}),
        // A lookup reads each declared table through its own source's adapter,
        // outside any transaction, and the target through the command's.
        ...(binding.lookupTables
          ? {
              lookup: Object.freeze<CommandLookupReader>({
                catalogs: binding.lookupTables.catalogs,
                // An App source adapter resolves App resource names itself, as the
                // command's own reads rely on; a physical name is unknown to it.
                async query(sourceName, local, request) {
                  const logical = binding.lookupTables!.logical(sourceName, local);
                  return resources.forConnection(resources.connectionFor(logical)).query({ ...request, table: logical });
                },
                async target(key) {
                  const found = await source.query({ table: binding.resource, filter: keyFilter(key), limit: 2, offset: 0 });
                  return found.rows.length === 1 ? (found.rows[0] as Readonly<Record<string, unknown>>) : undefined;
                },
              }),
            }
          : {}),
        transaction<T>(run: (tx: WriteTransaction) => Promise<T>): Promise<T> {
          if (!writableConnection(binding.connection)) throw new AppAccessDenied();
          return source.transaction!((tx) => withRecords(tx, run));
        },
        ...(verify
          ? {}
          : {
              advise<T>(run: (tx: WriteTransaction) => Promise<T>): Promise<T> {
                if (!writableConnection(binding.connection)) throw new AppAccessDenied();
                const writes = async (): Promise<never> => {
                  throw new AppAccessDenied();
                };
                return withRecords(
                  {
                    query: (request) => source.query(request),
                    count: (local, filter) => source.count(local, filter),
                    insert: writes,
                    update: writes,
                    remove: writes,
                  },
                  run,
                );
              },
            }),
        ...(commandsOf(source).commandTransaction || verified
          ? {
              commandTransaction<T>(run: (tx: WriteTransaction, journal: CommandJournal) => Promise<T>): Promise<T> {
                if (!writableConnection(binding.connection)) throw new AppAccessDenied();
                // Only a command that declares events writes as the App's source;
                // every other command keeps the unbound journal it always had.
                const eventSource = events && getCommandEvents(binding.command) ? events : undefined;
                if (verify) return verified!(verify, (tx, journal) => withRecords(tx, (records) => run(records, journal)), eventSource);
                return commandsOf(source).commandTransaction!(
                  (tx, journal) => withRecords(tx, (records) => run(records, journal)),
                  eventSource,
                );
              },
            }
          : {}),
      });
    },
  });
  if (events) appEventOwners.add(bound);
  return bound;
}

/**
 * What the person a command runs for may read, by their own grants: a refusal
 * the write layer says of a record outside the command's footprint (a line's
 * `consumes` parent) says only that. Resolved once, and only when said.
 */
export function actorReader(
  app: AppDef,
  schema: DatabaseSchema,
  actor: BusinessCommandActor,
): () => Pick<ResourceAccess, 'readable' | 'fields' | 'internal'> {
  let resolved: Pick<ResourceAccess, 'readable' | 'fields' | 'internal'> | undefined;
  return () => (resolved ??= resolveAppAccess(app, schema, actor.roles, actor.kind === 'public' ? 'public' : undefined));
}
