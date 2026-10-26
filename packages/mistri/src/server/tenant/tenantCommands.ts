import { addAbortListener } from 'node:events';
import { isProxy } from 'node:util/types';
import type { WriteTransaction } from '@mistriwork/engine/adapters/adapter.js';
import { CommandTransactionFailure } from '../../adapters/commands/commandJournal.js';
import { AppAccessDenied } from '../app/appAccess.js';
import {
  registerTenantCommandEventBinding,
  type AuthorizedBusinessCommand,
  type BusinessCommandBinding,
} from '../commands/businessCommandAccess.js';
import { createBusinessCommandAuthorizer } from '../commands/businessCommandAuthorization.js';
import {
  BusinessCommandExecutionError,
  executeBusinessCommand,
  lookupBusinessCommandStatus,
  type BusinessCommandResult,
  type BusinessCommandStatus,
} from '../commands/businessCommandExecution.js';
import { validateBusinessCommandReferences } from '../commands/businessCommandLoader.js';
import {
  BusinessCommandDefinitionError,
  CommandLookupRefusal,
  defineCommands,
  type BusinessCommandRegistry,
} from '../commands/businessCommands.js';
import { assertGlobalLookups, scopedLookupReader } from '../commands/commandLookup.js';
import {
  CommandInputError,
  parseCommandPrepareRequest,
  parseCommandAvailability,
  type CommandAvailabilityResult,
} from '../commands/commandPayload.js';
import { collectTenantAvailability } from './tenantCommandAvailability.js';
import { readPreparedRecord, withPreparedAhead, type PreparedCommand } from '../commands/commandPrepare.js';
import { captureTenantData, tenantOptions, refusalCause, recordRefusalCause } from '@mistriwork/engine/server/evidence.js';
import { runTenantCommandTransaction, type TenantCommandRecords } from './tenantCommandTransaction.js';
import {
  captureTenantRequestRuntime,
  createTenantRequestRuntime,
  tenantMembershipRefused,
  type TenantRequestRuntime,
} from './tenantRequestRuntime.js';
import type { TenantWriteRuntimeOptions } from './tenantWriteRuntime.js';
import { TenantWriteFailure } from './tenantWriteSource.js';
import type { CommandResultReference } from '../commands/scopedBusinessCommandAccess.js';
import { narrowTenantInvocation, type TenantInvocationGuard } from './tenantInvocation.js';
import type { CommandFlags } from '../commands/commandFlags.js';
import { authorizedCommandFlags, commandFlagsOnce } from '../commands/commandFlagCapture.js';
import type { TenantMembershipEvidence } from './tenantMembership.js';
import { actingPrincipal } from './tenantApiRequest.js';

export interface TenantCommandOptions<Request> extends TenantWriteRuntimeOptions<Request> {
  readonly commands: {
    readonly registry: BusinessCommandRegistry;
    readonly captureFlags?: (
      principal: TenantMembershipEvidence,
      request: Request,
    ) => CommandFlags | undefined | Promise<CommandFlags | undefined>;
    readonly resultReferences: Readonly<Record<string, (result: unknown) => readonly CommandResultReference[]>>;
  };
}
export interface TenantCommandExecutionOptions {
  readonly signal?: AbortSignal;
  readonly requestId?: string;
  /** The door the handler is told: the tenant API's `api` or App MCP's `mcp`; absent, the screen. */
  readonly entry?: 'api' | 'mcp';
}
type Mode = 'availability' | 'prepare' | 'execute' | 'status';
const deny = (): never => {
  throw new AppAccessDenied();
};
function domain(error: unknown): BusinessCommandExecutionError | undefined {
  if (error instanceof BusinessCommandExecutionError) return error;
  if (error instanceof CommandTransactionFailure) {
    const cause = domain(error.cause);
    // What the refusal objected to travels with it: a field named here is the
    // only way an App author or an agent learns which part was rejected.
    return cause
      ? new BusinessCommandExecutionError(
          cause.code,
          error.outcome === 'unknown' || cause.outcome === 'unknown' ? 'unknown' : 'not_applied',
          cause.field,
          cause.key,
          cause.reason,
        )
      : undefined;
  }
  // The refusal's recorded reason travels: the operator's log names the write it refused.
  if (error instanceof AppAccessDenied) return recordRefusalCause(new BusinessCommandExecutionError('forbidden'), error);
  if (error instanceof CommandInputError) return new BusinessCommandExecutionError('invalid_input', 'not_applied', error.field);
  return undefined;
}
/** The same classification for the platform realm's commands. */
export const tenantCommandDomain = domain;
/** Capture host options without accepting replacement getters or a forged signal.
 * Handlers get an independently owned native signal, not the mutable input. */
export function captureTenantCommandExecution(input: TenantCommandExecutionOptions) {
  const raw = tenantOptions(input, ['signal', 'requestId', 'entry']);
  const requestId = captureTenantData(raw.requestId);
  if (requestId !== undefined && (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(requestId)))
    throw new CommandInputError('requestId');
  const entry = captureTenantData(raw.entry);
  if (entry !== undefined && entry !== 'api' && entry !== 'mcp') throw new CommandInputError('entry');
  const origin = raw.signal as AbortSignal | undefined,
    controller = new AbortController();
  const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
  const add = EventTarget.prototype.addEventListener,
    remove = EventTarget.prototype.removeEventListener;
  const cancel = () => {
    if (origin && aborted.call(origin)) controller.abort();
  };
  let listener: ReturnType<typeof addAbortListener> | undefined;
  if (origin !== undefined) {
    if (isProxy(origin)) throw new CommandInputError('signal');
    try {
      aborted.call(origin);
      // Node's resistant listener uses the public EventTarget methods. Delegate
      // only to native methods on the brand-checked original, never its mutable
      // getters/methods. This bridge stays private and is not a handler signal.
      const target = Object.freeze({
        get aborted() {
          return aborted.call(origin) as boolean;
        },
        addEventListener: (type: string, callback: EventListener, options: AddEventListenerOptions) =>
          add.call(origin, type, callback, options),
        removeEventListener: (type: string, callback: EventListener) => remove.call(origin, type, callback),
      });
      listener = addAbortListener(target as AbortSignal, cancel);
      cancel();
    } catch {
      listener?.[Symbol.dispose]();
      throw new CommandInputError('signal');
    }
  }
  // Node mutates native signal slots during abort; freezing the whole signal
  // would prevent cancellation. Protect only the read used by the executor.
  const signal = controller.signal;
  Object.defineProperty(signal, 'aborted', { get: () => aborted.call(signal) || (!!origin && aborted.call(origin)) });
  return {
    options: {
      signal,
      ...(requestId === undefined ? {} : { requestId }),
      ...(entry === undefined ? {} : { entry: entry as 'api' | 'mcp' }),
    },
    close: () => {
      try {
        listener?.[Symbol.dispose]();
      } catch {
        /* Cleanup cannot reclassify a settled transaction. */
      }
    },
  };
}

/** Private authenticated single-source commands. No public tenant enrollment,
 * handler journal access, generic CRUD grant or generic Undo is installed. */
export function createTenantCommands<Request>(options: TenantCommandOptions<Request>) {
  try {
    return createCommands(options);
  } catch (error) {
    // A lookup the App cannot run says why and what is allowed; anything else stays one fixed refusal.
    throw error instanceof CommandLookupRefusal
      ? error
      : new BusinessCommandDefinitionError('The tenant commands could not be configured.');
  }
}
function createCommands<Request>(options: TenantCommandOptions<Request>) {
  const raw = tenantOptions(options, [
    'app',
    'reader',
    'writer',
    'deployment',
    'roles',
    'maxLifetimeMs',
    'verifySession',
    'resolveMembershipRows',
    'resolveRows',
    'authorizeDeletedRecord',
    'now',
    'commands',
  ]);
  const runtime = createTenantRequestRuntime(
    Object.fromEntries(Object.entries(raw).filter(([key]) => key !== 'commands')) as unknown as TenantWriteRuntimeOptions<Request>,
  );
  return Object.freeze({
    ...bindTenantCommands(runtime, raw.commands as TenantCommandOptions<Request>['commands']),
    retire: runtime.retire,
  });
}

/** Internal command authority over the shared genuine request owner; no source
 * acquisition or retirement is exposed alongside the command methods. */
export function bindTenantCommands<Request>(input: TenantRequestRuntime<Request>, commands: TenantCommandOptions<Request>['commands']) {
  const runtime = captureTenantRequestRuntime(input);
  const configured = tenantOptions(commands, ['registry', 'resultReferences', 'captureFlags']);
  if (configured.captureFlags !== undefined && (typeof configured.captureFlags !== 'function' || isProxy(configured.captureFlags))) deny();
  const captureFlags = configured.captureFlags as TenantCommandOptions<Request>['commands']['captureFlags'];
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
  // The App's whole registry pins its references; only a tenant's commands run
  // here. A public command runs only through public intake (tenantIntake.ts),
  // which places it per submission, never in a member's context.
  for (const command of Object.values(registry)) {
    if (command.realm === 'platform' || command.public === true) continue;
    if (command.source !== identity.source.id || command.write.some((table) => ownership.ownership[table]?.kind !== 'tenant')) deny();
  }
  // Decided, may be revisited: a tenant's command looks up only global rows, whatever the App declares.
  assertGlobalLookups(app, registry, ownership.ownership);
  const own = (id: string) => {
    if (Object.hasOwn(registry, id) && (registry[id].realm === 'platform' || registry[id].public === true)) deny();
  };
  const declarations = tenantOptions(configured.resultReferences, Object.keys(registry));
  if (Object.keys(declarations).length !== Object.keys(registry).length) deny();
  const extractors = new Map(
    Object.entries(declarations).map(([id, value]) => {
      if (typeof value !== 'function' || isProxy(value)) return deny();
      return [id, value as (result: unknown) => readonly CommandResultReference[]] as const;
    }),
  );
  const references = validateBusinessCommandReferences(app, registry, { schema: ownership.schema });
  const operation = async (
    mode: Mode,
    request: Request,
    selectors: readonly string[],
    body: unknown,
    input: TenantCommandExecutionOptions = {},
    guard?: TenantInvocationGuard,
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
        selectors,
        async (scope) => {
          // A token's command acts under the token's own roles (tenantApiRequest.ts).
          const actor = captureTenantData({
            id: scope.principal.accountId,
            appId: app.id,
            roles: actingPrincipal(request, scope.principal).roles,
          });
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
                        // The revision, and the starting values when the command declares them, in this one transaction.
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
            const binding = registerTenantCommandEventBinding(
              runtime,
              Object.freeze<BusinessCommandBinding>({
                scoped: true,
                // A signed-in form's command names no record (`targets: 'none'`): its envelope's key is empty, as on a single App.
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
                    receiptOwner: captureTenantData({
                      storeId: identity.storeId,
                      sourceId: identity.source.id,
                      tenantId: scope.principal.tenantId,
                    }),
                    assertTarget: (records: WriteTransaction, key: Readonly<Record<string, string | number>>) =>
                      contexts.get(records)?.target(key) ?? deny(),
                    assertResult: (records: WriteTransaction, key: Readonly<Record<string, string | number>>, result: unknown) =>
                      contexts.get(records)?.result(key, result) ?? deny(),
                    commandTransaction: (run) =>
                      scope.commandTransaction(
                        (raw, journal) =>
                          runTenantCommandTransaction(ownership, scope, authorization, raw, journal, extractors.get(id)!, async (tx) => {
                            contexts.set(tx.records, tx);
                            try {
                              return await run(tx.records, tx.journal!);
                            } finally {
                              contexts.delete(tx.records);
                            }
                          }),
                        authorization.read,
                      ),
                  });
                },
              }),
            );
            const execution = { ...context!.options, flags: await authorizedCommandFlags(binding, actor, captured, flags) };
            return mode === 'status'
              ? await lookupBusinessCommandStatus(binding, actor, captured, execution)
              : await executeBusinessCommand(binding, actor, captured, execution);
            /* The refusal is kept here because the writer replaces the error on
           its way out with a value-free TenantWriteFailure; the reason it
           carries has to be kept with it for the same reason. */
          } catch (error) {
            commandError = domain(error);
            if (commandError) recordRefusalCause(commandError, refusalCause(error) ?? error);
            throw error;
          }
        },
        narrowTenantInvocation(guard, () => {
          if (context!.options.signal.aborted) throw new BusinessCommandExecutionError('cancelled');
        }),
      );
    } catch (error) {
      /* A membership that no longer holds is the answer, whatever else the
         request met: a refusal, never a database that could not answer
         (tenantRequestRuntime.ts). Its outcome stays unknown for execute and
         status, as every refusal before the receipt is read does: an earlier
         attempt with the same key may have committed. */
      const known = tenantMembershipRefused(error)
        ? recordRefusalCause(new BusinessCommandExecutionError('forbidden', 'unknown'), refusalCause(error) ?? error)
        : (commandError ?? domain(error));
      const unknown =
        mode === 'status' ||
        known?.outcome === 'unknown' ||
        (error instanceof TenantWriteFailure && error.outcome === 'unknown') ||
        (mode === 'execute' && !known);
      /* The refusal a caller hears is unchanged, and so is what travels with
         it. What the realm boundary must stop discarding is the reason: a
         replacement error with the original dropped is why an unexplained
         `temporarily_unavailable` could not be chased past this line. The
         recorded cause is symbol-keyed and non-enumerable, readable only by
         an owner holding the reader (commandErrors.ts). */
      // A cancellation replaces the refusal, so it carries neither field nor
      // key: they would describe something this answer is no longer about.
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
    availability: (
      request: Request,
      selectors: readonly string[],
      body: unknown,
      options?: TenantCommandExecutionOptions,
      guard?: TenantInvocationGuard,
    ) => operation('availability', request, selectors, body, options, guard) as Promise<CommandAvailabilityResult>,
    prepare: (
      request: Request,
      selectors: readonly string[],
      body: unknown,
      options?: TenantCommandExecutionOptions,
      guard?: TenantInvocationGuard,
    ) => operation('prepare', request, selectors, body, options, guard) as Promise<PreparedCommand>,
    execute: (
      request: Request,
      selectors: readonly string[],
      body: unknown,
      options?: TenantCommandExecutionOptions,
      guard?: TenantInvocationGuard,
    ) => operation('execute', request, selectors, body, options, guard) as Promise<BusinessCommandResult>,
    status: (
      request: Request,
      selectors: readonly string[],
      body: unknown,
      options?: TenantCommandExecutionOptions,
      guard?: TenantInvocationGuard,
    ) => operation('status', request, selectors, body, options, guard) as Promise<BusinessCommandStatus>,
  });
}
