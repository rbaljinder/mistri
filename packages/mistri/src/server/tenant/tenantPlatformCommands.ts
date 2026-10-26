/**
 * The platform realm's commands: the only way the platform context changes
 * records. A command registered with `realm: 'platform'` is pinned against the
 * App's reference at startup and bound only in that realm. It writes the
 * platform's own rows and updates a tenant's by the row's key, across tenants
 * and all or nothing; it never inserts or removes a tenant's row and never
 * sets an owner. Each run is one writer transaction fenced on the platform
 * membership and the reserved `@platform` row.
 *
 * The one exception is explicit: a command that names the tenant it acts in
 * (`tenant: '<input field>'`) runs, for each request, in that one tenant. Its
 * transaction is the writer's platformTenantCommandTransaction, fenced on that
 * tenant's row as well, over the platform scope with every tenant table
 * narrowed to it; it writes that tenant's rows as a member's command would,
 * owner placed for it, and every audit row names the tenant.
 */
import { isPromise, isProxy } from 'node:util/types';
import { bindTenantFlagOwner } from './tenantFlagRuntime.js';
import { TransactionOperations, TransactionOutcomeUnknown, type WriteTransaction } from '@mistriwork/engine/adapters/adapter.js';
import { CommandTransactionFailure, type CommandJournal } from '../../adapters/commands/commandJournal.js';
import { declaredReferences, physicalBindings, resolveAppAccess, tenantAppShape, type AppDef } from '../../shared/app.js';
import type { RowScope } from '@mistriwork/engine/shared/rowScope.js';
import { assertScopeCatalog } from '@mistriwork/engine/shared/scopeCatalog.js';
import { AppAccessDenied, type ResourceAccess } from '../app/appAccess.js';
import { compileAppDefinitionValidation } from '../app/appValidation.js';
import { appResourceCatalog } from '../app/appResources.js';
import type { Identity } from '../auth/auth.js';
import type { AuthorizedBusinessCommand, BusinessCommandBinding } from '../commands/businessCommandAccess.js';
import { createBusinessCommandAuthorizer } from '../commands/businessCommandAuthorization.js';
import {
  BusinessCommandExecutionError,
  executeBusinessCommand,
  lookupBusinessCommandStatus,
  type BusinessCommandResult,
  type BusinessCommandStatus,
} from '../commands/businessCommandExecution.js';
import { validateBusinessCommandReferences } from '../commands/businessCommandLoader.js';
import { defineCommands, type AnyBusinessCommand, type BusinessCommandRegistry } from '../commands/businessCommands.js';
import { readCommandInput } from '../../shared/commandInput.js';
import { assertGlobalLookups, scopedLookupReader } from '../commands/commandLookup.js';
import { parseCommandPrepareRequest, parseCommandAvailability, type CommandAvailabilityResult } from '../commands/commandPayload.js';
import { collectTenantAvailability } from './tenantCommandAvailability.js';
import { readPreparedRecord, withPreparedAhead, type PreparedCommand } from '../commands/commandPrepare.js';
import type { CommandResultReference } from '../commands/scopedBusinessCommandAccess.js';
import { captureTenantCommandExecution, tenantCommandDomain, type TenantCommandExecutionOptions } from './tenantCommands.js';
import { runTenantCommandTransaction, type TenantCommandRecords } from './tenantCommandTransaction.js';
import {
  captureTenantData,
  denyTenant,
  tenantIdentifier,
  tenantOptions,
  tenantRecord,
  refusalCause,
  recordRefusalCause,
} from '@mistriwork/engine/server/evidence.js';
import { checkTenantInvocation, narrowTenantInvocation, revalidateTenantInvocation } from './tenantInvocation.js';
import { parseTenantSelector } from './tenantMembership.js';
import { createPlatformMembershipIssuer, type PlatformMembershipEvidence } from './tenantPlatform.js';
import type { PlatformTenantEvidence } from './tenantPlatformTenant.js';
import type { PlatformInvocationGuard } from './tenantPlatformReadRuntime.js';
import { composePlatformReadScope } from './tenantReadScope.js';
import { advisoryRecords, captureTenantReadSource, type TenantReadSource } from './tenantReadSource.js';
import { tenantRuntimeClock } from './tenantRuntimeClock.js';
import { assertTenantSourcePair } from './tenantSourceIdentity.js';
import { tenantVisibleFields } from './tenantVisibleFields.js';
import { tenantWriteFailed } from './tenantWriteKindContract.js';
import { captureTenantWriteSource, TenantWriteFailure, type TenantWriteSource } from './tenantWriteSource.js';
import { evidenceRefused, type AdmissionCache } from './tenantAdmissionCache.js';
import type { CommandFlags } from '../commands/commandFlags.js';
import { authorizedCommandFlags, commandFlagsOnce } from '../commands/commandFlagCapture.js';

/** Private host scope of one platform command request, never a handler's. */
interface PlatformRequestScope {
  readonly principal: PlatformMembershipEvidence;
  readonly rows: RowScope;
  readonly grants: ResourceAccess;
  session(): Promise<void>;
  /** The command's one transaction: the platform scope, or — with `tenant`, a
   * command that acts in one named tenant — that scope narrowed to the tenant
   * and fenced on its row. `run` is told whose principal the transaction is. */
  commandTransaction<T>(
    run: (
      records: WriteTransaction,
      journal: CommandJournal,
      principal: PlatformMembershipEvidence | PlatformTenantEvidence,
    ) => T | Promise<T>,
    read: readonly string[],
    tenant?: string,
  ): Promise<T>;
  /** The realm's ordinary transaction, for its generic edit (tenantPlatformWriteRuntime.ts): the
   * platform scope, no journal, and only the platform's own rows written (tenantManagedKindPlatform.ts). */
  transaction<T>(run: (records: WriteTransaction) => T | Promise<T>): Promise<T>;
  /** The tenant owner's advisoryReads, under the platform scope (tenantRequestRuntime.ts). */
  advisoryReads<T>(run: (records: WriteTransaction) => T | Promise<T>, read: readonly string[]): Promise<T>;
  /** The platform realm's scoped reads, outside any transaction: what a command's lookup reads through. */
  reads(): ReturnType<TenantReadSource['scopePlatformReads']>;
}
interface PlatformRequestRuntimeOptions<Request> {
  readonly app: AppDef;
  readonly reader: TenantReadSource;
  readonly writer: TenantWriteSource;
  readonly deployment: string;
  /** The platform realm's roles only. */
  readonly roles: readonly string[];
  readonly maxLifetimeMs: number;
  readonly verifySession: (request: Request) => Identity | null | Promise<Identity | null>;
  readonly resolvePlatformRows: (principal: PlatformMembershipEvidence) => RowScope | Promise<RowScope>;
  /** The App's platform-only sources by name. The owner is built on the App
   * without them (tenantBusinessApp), so it cannot read them off its own
   * declaration, and the policy's entries for their tables have to be told
   * apart from a table of this source that does not exist. */
  readonly platformSources?: readonly string[];
  readonly now?: () => number;
  /** The deployment's kept admissions (tenantAdmissionCache.ts). */
  readonly admissions?: AdmissionCache;
}
export type PlatformRequestRuntime<Request> = ReturnType<typeof bindPlatformRequestRuntime<Request>>;
interface PlatformCommandOptions<Request> {
  readonly registry: BusinessCommandRegistry;
  readonly captureFlags?: (
    principal: PlatformMembershipEvidence,
    request: Request,
  ) => CommandFlags | undefined | Promise<CommandFlags | undefined>;
  readonly resultReferences: Readonly<Record<string, (result: unknown) => readonly CommandResultReference[]>>;
}

const optionKeys = [
  'app',
  'reader',
  'writer',
  'deployment',
  'roles',
  'maxLifetimeMs',
  'verifySession',
  'resolvePlatformRows',
  'platformSources',
  'now',
  'admissions',
];
const deny = (): never => {
  throw new AppAccessDenied();
};
function delivered<T>(value: T | Promise<T>): T | Promise<T> {
  return isPromise(value)
    ? (Promise.prototype.then.call(
        value,
        (result: T) => captureTenantData(result),
        () => denyTenant(),
      ) as Promise<T>)
    : captureTenantData(value);
}

/**
 * The platform realm's command owner: the twin of bindTenantRequestRuntime,
 * kept apart so the proved tenant owner stays exactly as it is. The same
 * admission, session bracketing, one owned transaction, drain and retirement.
 * What differs is who is admitted (a platform membership holding platform
 * roles only), the scope (the platform policy's rows across every tenant) and
 * the transaction: the writer's platform transactions, fenced on the
 * platform membership and the `@platform` row — a command's, and the generic
 * edit's over the platform's own rows (tenantPlatformWriteRuntime.ts).
 */
export function bindPlatformRequestRuntime<Request>(options: PlatformRequestRuntimeOptions<Request>) {
  const raw = tenantOptions(options, optionKeys);
  const reader = captureTenantReadSource(raw.reader as TenantReadSource);
  const writer = captureTenantWriteSource(raw.writer as TenantWriteSource);
  const identity = assertTenantSourcePair(reader, writer),
    ownership = writer.ownership;
  const app = captureTenantData(raw.app as AppDef);
  if (!app || !tenantAppShape(app, ownership)) return denyTenant();
  const catalog = appResourceCatalog(
    ownership.physicalSchema,
    physicalBindings(app, ownership.source.id),
    declaredReferences(app, ownership.source.id),
  );
  assertScopeCatalog(ownership.schema, catalog.schema);
  for (const id of Object.keys(ownership.resources)) if (catalog.toPhysical(id) !== ownership.resources[id]) denyTenant();
  const validation = compileAppDefinitionValidation(ownership.schema, app);
  // Read once, from the deployment's own declaration, so a policy answered
  // later cannot decide for itself which of its entries belong elsewhere.
  const outsideSourceNames = Object.freeze([...((raw.platformSources as readonly string[] | undefined) ?? [])]);
  if (
    typeof raw.verifySession !== 'function' ||
    typeof raw.resolvePlatformRows !== 'function' ||
    (raw.now !== undefined && typeof raw.now !== 'function')
  )
    return denyTenant();
  const verify = raw.verifySession as PlatformRequestRuntimeOptions<Request>['verifySession'];
  const platformRows = raw.resolvePlatformRows as PlatformRequestRuntimeOptions<Request>['resolvePlatformRows'];
  const now = tenantRuntimeClock((raw.now ?? Date.now) as () => number);
  const issuer = createPlatformMembershipIssuer({
    ownership,
    deployment: raw.deployment as string,
    roles: raw.roles as readonly string[],
    maxLifetimeMs: raw.maxLifetimeMs as number,
    verifySession: verify,
    membership: { source: ownership.source, read: reader.readPlatformMembership },
    now,
    ...(raw.admissions === undefined ? {} : { admissions: raw.admissions as AdmissionCache }),
  });
  let retired = false,
    retirement: Promise<void> | undefined;
  const pending = new Set<Promise<void>>();
  return Object.freeze({
    app,
    ownership,
    identity,
    retire(): Promise<void> {
      if (retirement) return retirement;
      retired = true;
      retirement = (async () => {
        await issuer.retire();
        await Promise.allSettled([...pending]);
      })();
      void retirement.catch(() => {});
      return retirement;
    },
    async run<T>(request: Request, callback: (scope: PlatformRequestScope) => T | Promise<T>, guard?: PlatformInvocationGuard): Promise<T> {
      if (retired || typeof callback !== 'function' || (guard !== undefined && typeof guard !== 'function'))
        throw new TenantWriteFailure('not_applied');
      let finish!: () => void;
      const held = new Promise<void>((resolve) => {
        finish = resolve;
      });
      pending.add(held);
      let committed = false,
        accepting = true,
        attempted = false;
      const operations = new TransactionOperations();
      let principal: PlatformMembershipEvidence | undefined;
      let releaseFlags = () => {};
      try {
        let lastTime = 0;
        const guarded = () => checkTenantInvocation(guard, principal!);
        const active = () => {
          guarded();
          if (retired) return denyTenant();
          const instant = now();
          guarded();
          if (
            retired ||
            typeof instant !== 'number' ||
            !Number.isSafeInteger(instant) ||
            instant < lastTime ||
            instant >= principal!.validUntil
          )
            return denyTenant();
          lastTime = instant;
        };
        const session = async () => {
          active();
          const value = delivered(verify(request)),
            identity = isPromise(value) ? await value : value;
          active();
          tenantRecord(identity, ['id', 'who', 'role']);
          tenantIdentifier(identity.id, 1024);
          if (
            identity.id !== principal!.accountId ||
            typeof identity.who !== 'string' ||
            (identity.role !== undefined && typeof identity.role !== 'string')
          )
            return denyTenant();
          const verified = revalidateTenantInvocation(guard, principal!);
          if (isPromise(verified)) await verified;
          active();
        };
        /* As the tenant request runtime: kept evidence (tenantAdmissionCache.ts)
           that the pre-callback revalidation refuses is admitted afresh once,
           before anything has been written. */
        let rows!: RowScope, grants!: ResourceAccess;
        for (let fresh = false; ; fresh = true) {
          const admitted = await issuer.withMembership(request, (evidence, kept) => ({ evidence, kept }), { fresh });
          principal = admitted.evidence;
          lastTime = principal.verifiedAt;
          try {
            active();
            const policyResult = delivered(platformRows(principal)),
              policy = isPromise(policyResult) ? await policyResult : policyResult;
            active();
            // A command runs its transaction on this one source, so the policy's
            // entries for the App's platform-only sources — which its startup check
            // requires it to name — are narrowed away rather than refused here.
            rows = composePlatformReadScope(ownership, principal, policy, outsideSourceNames);
            // The platform realm's visible fields: a tenant row's owner readable, nothing generically writable.
            const visible = tenantVisibleFields(
              ownership,
              { ...resolveAppAccess(app, ownership.schema, [...principal.roles]), rows, writable: new Set() },
              'platform',
            ) as ResourceAccess;
            grants = validation ? { ...visible, validation } : visible;
            await session();
            await reader.assertPlatformCurrent(principal);
            active();
            break;
          } catch (error) {
            issuer.forget(request, principal);
            if (!admitted.kept || fresh || !evidenceRefused(error)) throw error;
          }
        }
        const admitted = principal;
        releaseFlags = bindTenantFlagOwner(
          request,
          admitted,
          async () => {
            await session();
            await reader.assertPlatformCurrent(admitted);
            active();
          },
          active,
        );
        let callbackFailure: { error: unknown } | undefined;
        const commandTransaction = <R>(
          run: (
            records: WriteTransaction,
            journal: CommandJournal,
            principal: PlatformMembershipEvidence | PlatformTenantEvidence,
          ) => R | Promise<R>,
          ceiling: readonly string[],
          tenant?: string,
        ): Promise<R> => {
          if (!accepting) return Promise.reject(new TenantWriteFailure('not_applied'));
          let invalid = attempted || typeof run !== 'function',
            sourceRows = rows;
          attempted = true;
          try {
            // A tenant's id, never `@platform`: the selector refuses it.
            if (tenant !== undefined) parseTenantSelector([tenant]);
            const read = captureTenantData(ceiling);
            if (
              !Array.isArray(read) ||
              !read.length ||
              read.length > 256 ||
              new Set(read).size !== read.length ||
              read.some((table) => typeof table !== 'string' || !Object.hasOwn(ownership.resources, table))
            )
              return operations.run(async () => denyTenant());
            // The command footprint intersects, never widens, the platform scope.
            sourceRows = Object.freeze(
              Object.fromEntries(Object.entries(rows).map(([table, row]) => [table, read.includes(table) ? row : false])),
            );
          } catch {
            invalid = true;
          }
          return operations.run(async () => {
            if (invalid || callbackFailure) return denyTenant();
            let workFailure: { error: unknown } | undefined;
            /* The tenant's row as it stands now, active, and `@platform` at the
               version this membership was admitted on: the writer fences both
               at these versions, so a suspension after this read refuses the write. */
            let acting: PlatformTenantEvidence | undefined;
            const work = async (records: WriteTransaction, journal: CommandJournal) => {
              await session();
              try {
                const result = await run(records, journal, acting ?? admitted);
                await session();
                return result;
              } catch (error) {
                workFailure = { error };
                throw error;
              }
            };
            try {
              if (tenant !== undefined) {
                const anchors = await reader.readServiceAnchors(tenant).catch((error: unknown) => {
                  throw tenantWriteFailed('not_applied', error);
                });
                active();
                // Nothing has been written: a tenant that is not there, or not active, is a refusal that applied nothing.
                if (anchors.tenantVersion === null || anchors.platformVersion !== admitted.platformVersion)
                  throw new TenantWriteFailure('not_applied');
                acting = Object.freeze({
                  ...admitted,
                  realm: 'platform-tenant' as const,
                  tenantId: tenant,
                  tenantVersion: anchors.tenantVersion,
                });
              }
              const result = acting
                ? await writer.platformTenantCommandTransaction(acting, sourceRows, work, active)
                : await writer.platformCommandTransaction(admitted, sourceRows, work, active);
              committed = true;
              return result;
            } catch (error) {
              throw new CommandTransactionFailure(
                workFailure?.error ?? error,
                error instanceof TenantWriteFailure ? error.outcome : 'unknown',
              );
            }
          });
        };
        /* One per request, as a command's: the platform scope whole, since a
           Save names no footprint, and the managed transaction beneath it
           writes the platform's own rows alone. */
        const transaction = <R>(run: (records: WriteTransaction) => R | Promise<R>): Promise<R> => {
          if (!accepting) return Promise.reject(new TenantWriteFailure('not_applied'));
          const invalid = attempted || typeof run !== 'function';
          attempted = true;
          return operations.run(async () => {
            if (invalid || callbackFailure) return denyTenant();
            const work = async (records: WriteTransaction) => {
              await session();
              const result = await run(records);
              await session();
              return result;
            };
            const result = await writer.platformTransaction(admitted, rows, work, active);
            committed = true;
            return result;
          });
        };
        const advisoryReads = <R>(run: (records: WriteTransaction) => R | Promise<R>, ceiling: readonly string[]): Promise<R> => {
          if (!accepting) return Promise.reject(new TenantWriteFailure('not_applied'));
          const invalid = attempted || typeof run !== 'function';
          attempted = true;
          let footprint: RowScope | undefined;
          try {
            const read = captureTenantData(ceiling);
            if (
              Array.isArray(read) &&
              read.length &&
              read.length <= 256 &&
              new Set(read).size === read.length &&
              read.every((table) => typeof table === 'string' && Object.hasOwn(ownership.resources, table))
            ) {
              footprint = Object.freeze(
                Object.fromEntries(Object.entries(rows).map(([table, row]) => [table, read.includes(table) ? row : false])),
              );
            }
          } catch {
            footprint = undefined;
          }
          return operations.run(async () => {
            if (invalid || !footprint || callbackFailure) return denyTenant();
            await session();
            const result = await reader.withPlatformReads(admitted, footprint, (reads) => run(advisoryRecords(reads)));
            active();
            await session();
            return result;
          });
        };
        let scoped: ReturnType<TenantReadSource['scopePlatformReads']> | undefined;
        const scope = Object.freeze<PlatformRequestScope>({
          principal: admitted,
          rows,
          grants,
          session,
          commandTransaction,
          transaction,
          advisoryReads,
          reads: () => {
            active();
            return (scoped ??= reader.scopePlatformReads(admitted, rows));
          },
        });
        let result!: T;
        const completed = (value: T): T => {
          accepting = false;
          return captureTenantData(value);
        };
        try {
          const returned = callback(scope);
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
        if (
          callbackFailure?.error instanceof TransactionOutcomeUnknown ||
          (callbackFailure?.error instanceof CommandTransactionFailure && callbackFailure.error.outcome === 'unknown') ||
          (callbackFailure?.error instanceof TenantWriteFailure && callbackFailure.error.outcome === 'unknown')
        )
          throw callbackFailure.error;
        if (drainFailure) throw drainFailure.error;
        if (callbackFailure) throw callbackFailure.error;
        await session();
        await reader.assertPlatformCurrent(admitted);
        active();
        return result;
      } catch (error) {
        accepting = false;
        await operations.finish().catch(() => {});
        // Evidence that met a refusal anywhere, a writer's fence included, is not kept.
        if (principal) issuer.forget(request, principal);
        const unknown =
          committed ||
          error instanceof TransactionOutcomeUnknown ||
          (error instanceof CommandTransactionFailure && error.outcome === 'unknown') ||
          (error instanceof TenantWriteFailure && error.outcome === 'unknown');
        // The same value-free refusal, with the reason kept for the owner:
        // this is where a platform write's cause used to stop.
        throw tenantWriteFailed(unknown ? 'unknown' : 'not_applied', refusalCause(error) ?? error);
      } finally {
        releaseFlags();
        pending.delete(held);
        finish();
      }
    },
  });
}

type Mode = 'availability' | 'prepare' | 'execute' | 'status';

/**
 * The platform realm's commands over its request owner: the twin of
 * bindTenantCommands. The registry is the App's whole one, so every public
 * reference is pinned against it, but only commands registered with
 * `realm: 'platform'` run here; a tenant's is refused without a word about it.
 * A platform command writes platform rows and updates a tenant's, never a
 * global one; it emits no events. Its targets may span tenants.
 */
export function bindPlatformCommands<Request>(runtime: PlatformRequestRuntime<Request>, commands: PlatformCommandOptions<Request>) {
  const configured = tenantOptions(commands, ['registry', 'resultReferences', 'captureFlags']);
  if (configured.captureFlags !== undefined && (typeof configured.captureFlags !== 'function' || isProxy(configured.captureFlags))) deny();
  const captureFlags = configured.captureFlags as PlatformCommandOptions<Request>['captureFlags'];
  if (!configured.registry || typeof configured.registry !== 'object' || isProxy(configured.registry)) deny();
  const registry = defineCommands(
    tenantOptions(configured.registry, Object.keys(Object.getOwnPropertyDescriptors(configured.registry))) as BusinessCommandRegistry,
  );
  const { app, ownership, identity } = runtime;
  const ownerFields = Object.fromEntries(
    Object.entries(ownership.ownership).flatMap(([id, rule]) => (rule.kind === 'tenant' ? [[id, rule.column]] : [])),
  );
  const authorizer = createBusinessCommandAuthorizer({
    app,
    registry,
    schema: ownership.schema,
    connectionFor: (resource) => (Object.hasOwn(ownership.resources, resource) ? identity.source.connection : deny()),
    writableConnection: (connection) => connection === identity.source.connection,
    transactionalConnection: (connection) => connection === identity.source.connection,
    managedOwnership: ownerFields,
  });
  for (const command of Object.values(registry)) {
    if (command.realm !== 'platform') continue;
    if (
      command.source !== identity.source.id ||
      command.events !== undefined ||
      command.write.some((table) => ownership.ownership[table]?.kind !== 'tenant' && ownership.ownership[table]?.kind !== 'platform')
    )
      deny();
  }
  // Decided, may be revisited: the platform realm looks up what every tenant reads, as a tenant does.
  assertGlobalLookups(app, registry, ownership.ownership);
  const declarations = tenantOptions(configured.resultReferences, Object.keys(registry));
  if (Object.keys(declarations).length !== Object.keys(registry).length) deny();
  const extractors = new Map(
    Object.entries(declarations).map(([id, value]) => {
      if (typeof value !== 'function' || isProxy(value)) return deny();
      return [id, value as (result: unknown) => readonly CommandResultReference[]] as const;
    }),
  );
  const references = validateBusinessCommandReferences(app, registry, { schema: ownership.schema });
  const own = (id: string) => {
    if (!Object.hasOwn(registry, id) || registry[id].realm !== 'platform') deny();
  };
  /* The tenant a command that acts in one names (`tenant`), read from the
     request's input by that field's own rule — the value its handler is given.
     The executor has read the whole input by then, so a field it refuses is
     refused there first, in its own words. */
  const tenantNamed = (command: AnyBusinessCommand, body: unknown): string | undefined => {
    if (command.tenant === undefined) return undefined;
    const field = command.fields.find((candidate) => candidate.name === command.tenant);
    let value: unknown;
    try {
      const input = (body as { readonly input?: Readonly<Record<string, unknown>> } | undefined)?.input;
      if (field && input && typeof input === 'object') value = readCommandInput([field], { [field.name]: input[field.name] })[field.name];
      // A tenant's id, never `@platform`: what is not one is the input's fault, said on its field.
      if (typeof value === 'string') parseTenantSelector([value]);
    } catch {
      value = undefined;
    }
    if (typeof value !== 'string') throw new BusinessCommandExecutionError('invalid_input', 'not_applied', command.tenant);
    return value;
  };
  const operation = async (
    mode: Mode,
    request: Request,
    body: unknown,
    input: TenantCommandExecutionOptions = {},
    guard?: PlatformInvocationGuard,
  ): Promise<BusinessCommandStatus | PreparedCommand | CommandAvailabilityResult> => {
    let commandError: BusinessCommandExecutionError | undefined, context: ReturnType<typeof captureTenantCommandExecution> | undefined;
    try {
      let captured: unknown;
      try {
        captured = captureTenantData(body);
        context = captureTenantCommandExecution(input);
      } catch {
        throw new BusinessCommandExecutionError('invalid_input', mode === 'prepare' ? 'not_applied' : 'unknown');
      }
      if (context.options.signal.aborted)
        throw new BusinessCommandExecutionError('cancelled', mode === 'prepare' ? 'not_applied' : 'unknown');
      return await runtime.run(
        request,
        async (scope) => {
          const actor = captureTenantData({ id: scope.principal.accountId, appId: app.id, roles: scope.principal.roles });
          const flags = commandFlagsOnce(async () => {
            await scope.session();
            const captured = await captureFlags?.(scope.principal, request);
            await scope.session();
            return captured;
          });
          try {
            if (mode === 'availability')
              return await collectTenantAvailability({
                checks: parseCommandAvailability(captured),
                ownership,
                scope,
                signal: context!.options.signal,
                requestId: context!.options.requestId,
                captureFlags: flags,
                authorize: (command) => {
                  own(command);
                  const authorization = authorizer.authorize(command, actor);
                  if (!references.has(command)) return deny();
                  return authorization;
                },
                extractor: (command) => extractors.get(command)!,
              });
            if (mode === 'prepare') {
              const prepared = parseCommandPrepareRequest(captured, { creating: (id) => authorizer.creates(id) });
              own(prepared.command);
              const authorization = authorizer.authorize(prepared.command, actor);
              if (prepared.commandVersion !== authorization.command.version)
                throw new BusinessCommandExecutionError('command_version_mismatch', 'unknown');
              if (!references.has(prepared.command)) return deny();
              const capturedFlags = await flags();
              return await withPreparedAhead(authorization.command, authorization.catalog, prepared.key, () =>
                scope.commandTransaction(
                  (raw, journal) =>
                    runTenantCommandTransaction(
                      ownership,
                      scope,
                      authorization,
                      raw,
                      journal,
                      extractors.get(prepared.command)!,
                      async (tx) => {
                        if (context!.options.signal.aborted) throw new BusinessCommandExecutionError('cancelled');
                        // A signed-in form's command names no record to check (`targets: 'none'`).
                        if (authorization.command.targets !== 'none') await tx.target(prepared.key);
                        const result = await readPreparedRecord(tx.records, {
                          command: authorization.command,
                          commandId: prepared.command,
                          actor: authorization.actor,
                          key: prepared.key,
                          catalog: authorization.catalog,
                          ...(authorization.people ? { people: authorization.people } : {}),
                          signal: context!.options.signal,
                          flags: capturedFlags,
                        });
                        if (context!.options.signal.aborted) throw new BusinessCommandExecutionError('cancelled');
                        return result;
                      },
                    ),
                  authorization.read,
                ),
              );
            }
            const binding = Object.freeze<BusinessCommandBinding>({
              scoped: true,
              /* A platform form's command names no record (`targets: 'none'`), as a tenant's does: it creates the
                 platform's rows, or the named tenant's when it acts in one. Without this its envelope never parsed. */
              creates: (id: string): boolean => authorizer.creates(id),
              authorize: (id, supplied) => {
                if (supplied !== actor) return deny();
                own(id);
                const authorization = authorizer.authorize(id, actor);
                const contexts = new WeakMap<WriteTransaction, TenantCommandRecords>();
                return Object.freeze<AuthorizedBusinessCommand>({
                  ...authorization,
                  transaction: deny,
                  ...(authorization.lookupTables ? { lookup: scopedLookupReader(authorization, () => scope.reads()) } : {}),
                  assertTarget: (records: WriteTransaction, key: Readonly<Record<string, string | number>>) =>
                    contexts.get(records)?.target(key) ?? deny(),
                  assertResult: (records: WriteTransaction, key: Readonly<Record<string, string | number>>, result: unknown) =>
                    contexts.get(records)?.result(key, result) ?? deny(),
                  // Only a run acts in a tenant: a status read finds the platform's receipt under the platform's own scope.
                  commandTransaction: (run) =>
                    scope.commandTransaction(
                      (raw, journal, principal) =>
                        runTenantCommandTransaction(
                          ownership,
                          { principal, grants: scope.grants, session: scope.session },
                          authorization,
                          raw,
                          journal,
                          extractors.get(id)!,
                          async (tx) => {
                            contexts.set(tx.records, tx);
                            try {
                              return await run(tx.records, tx.journal!);
                            } finally {
                              contexts.delete(tx.records);
                            }
                          },
                        ),
                      authorization.read,
                      mode === 'execute' ? tenantNamed(registry[id], captured) : undefined,
                    ),
                });
              },
            });
            const execution = { ...context!.options, flags: await authorizedCommandFlags(binding, actor, captured, flags) };
            return mode === 'status'
              ? await lookupBusinessCommandStatus(binding, actor, captured, execution)
              : await executeBusinessCommand(binding, actor, captured, execution);
            // As the tenant realm's: the writer's replacement error carries no
            // reason, so the reason is kept on the refusal captured here.
          } catch (error) {
            commandError = tenantCommandDomain(error);
            if (commandError) recordRefusalCause(commandError, refusalCause(error) ?? error);
            throw error;
          }
        },
        narrowTenantInvocation(guard, () => {
          if (context!.options.signal.aborted) throw new BusinessCommandExecutionError('cancelled');
        }),
      );
    } catch (error) {
      const known = commandError ?? tenantCommandDomain(error);
      const unknown =
        mode === 'status' ||
        known?.outcome === 'unknown' ||
        (error instanceof TenantWriteFailure && error.outcome === 'unknown') ||
        (mode === 'execute' && !known);
      // As the tenant realm's: the answer is unchanged, the reason is kept for
      // an owner that has to diagnose it rather than dropped at the boundary.
      // As the tenant realm's: the refusal keeps what it objected to, and a
      // cancellation carries neither field nor key.
      const cancelled = !!context?.options.signal.aborted;
      throw recordRefusalCause(
        new BusinessCommandExecutionError(
          cancelled ? 'cancelled' : (known?.code ?? 'temporarily_unavailable'),
          unknown ? 'unknown' : 'not_applied',
          cancelled ? undefined : known?.field,
          cancelled ? undefined : known?.key,
          cancelled ? undefined : known?.reason,
        ),
        refusalCause(known) ?? refusalCause(error) ?? error,
      );
    } finally {
      context?.close();
    }
  };
  return Object.freeze({
    availability: (request: Request, body: unknown, options?: TenantCommandExecutionOptions, guard?: PlatformInvocationGuard) =>
      operation('availability', request, body, options, guard) as Promise<CommandAvailabilityResult>,
    prepare: (request: Request, body: unknown, options?: TenantCommandExecutionOptions, guard?: PlatformInvocationGuard) =>
      operation('prepare', request, body, options, guard) as Promise<PreparedCommand>,
    execute: (request: Request, body: unknown, options?: TenantCommandExecutionOptions, guard?: PlatformInvocationGuard) =>
      operation('execute', request, body, options, guard) as Promise<BusinessCommandResult>,
    status: (request: Request, body: unknown, options?: TenantCommandExecutionOptions, guard?: PlatformInvocationGuard) =>
      operation('status', request, body, options, guard) as Promise<BusinessCommandStatus>,
  });
}
