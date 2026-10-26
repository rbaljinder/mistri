import { isPromise, isProxy } from 'node:util/types';
import { TransactionOutcomeUnknown, type Adapter, type ScopedReads, type WriteTransaction } from '@mistriwork/engine/adapters/adapter.js';
import { CommandTransactionFailure } from '../../adapters/commands/commandJournal.js';
import { snapshotScopedData } from '@mistriwork/engine/adapters/scoped/scopedReads.js';
import {
  appActionGrants,
  defaultSourceOf,
  resolveAppAccess,
  rowPolicyAppShape,
  type AppDef,
  type AppUpdateAction,
} from '../../shared/app.js';
import { snapshotRowScope, type RowScope } from '@mistriwork/engine/shared/rowScope.js';
import { captureScopeCatalog } from '@mistriwork/engine/shared/scopeCatalog.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { AppAccessDenied, authorizeResources } from '../app/appAccess.js';
import { compileAppDefinitionValidation } from '../app/appValidation.js';
import type { RuntimeResources } from '../app/appRuntimeResources.js';
import type { AppRowPolicy, DeletedPolicyRecord } from './appRowPolicy.js';
import type { Identity } from '../auth/auth.js';
import { compileAppStamps, sessionActorWords, stampUpdate } from '../app/appStamps.js';
import { lookupPerson, personKey } from '../app/appMe.js';
import { compileAppTransitions } from '../app/appTransitions.js';
import { whenPerson } from '../commands/commandWhen.js';
import { forbiddenBy } from '../commands/commandErrors.js';
import { clockNow } from '@mistriwork/engine/server/http/clock.js';
import {
  BusinessCommandExecutionError,
  executeBusinessCommand,
  lookupBusinessCommandStatus,
  type BusinessCommandResult,
  type BusinessCommandStatus,
} from '../commands/businessCommandExecution.js';
import { bulkCommandWhen, validateBusinessCommandReferences } from '../commands/businessCommandLoader.js';
import { defineCommands } from '../commands/businessCommands.js';
import {
  CommandInputError,
  parseCommandPrepareTargets,
  parseCommandAvailability,
  type CommandAvailabilityResult,
} from '../commands/commandPayload.js';
import { collectCommandAvailability, readCommandAvailability } from '../commands/commandAvailability.js';
import { prepareCommandTargets, type PreparedCommandTarget } from '../commands/commandTargets.js';
import { readPreparedRecord, readPreparedTargetAvailability, withPreparedAhead, type PreparedCommand } from '../commands/commandPrepare.js';
import { preparesInitial } from '../commands/commandPrepareNeeds.js';
import { bindScopedBusinessCommands, type ScopedCommandOptions } from '../commands/scopedBusinessCommandAccess.js';
import type { BusinessCommandBinding } from '../commands/businessCommandAccess.js';
import type { CommandFlags } from '../commands/commandFlags.js';
import { authorizedCommandFlags, commandFlagsOnce } from '../commands/commandFlagCapture.js';

export interface PolicyPrincipal {
  readonly id: string;
  readonly appId: string;
  readonly roles: readonly string[];
  /** The verified session's email and display name, as a command's actor carries them (never a request's). */
  readonly email?: string;
  readonly name?: string;
  /** Who this is when it is not a signed-in person. 'public': a signed-out
      visitor at an App with `auth.public`; private resolveRows is never called
      with one, and public narrowing may restrict the read grant. 'service': a
      jobs module's principal the policy's `services` names, its id
      `service:<name>`, running a job, timer, workflow step, inbound endpoint
      or integration webhook; resolveRows says the rows it runs commands in. */
  readonly kind?: 'service' | 'public';
}

type PolicyData = ScopedReads & Partial<Pick<WriteTransaction, 'insert' | 'update' | 'remove'>>;

interface PolicyCommandOptions {
  signal?: AbortSignal;
  requestId?: string;
  /** The door an execute came through, which decides what the command keeps (businessCommandExecution.ts). */
  door?: import('../commands/businessCommandExecution.js').CommandDoor;
}

/** Server-only capability, not a wire token or a bag of client-supplied grants. */
export interface AppPolicyContext {
  readonly principal: PolicyPrincipal;
  readonly sources: readonly string[];
  readonly schema: DatabaseSchema;
  readonly data: PolicyData;
  /** Generic field grants for server-side update projection and inverse capture.
   * Operations still enforce current row, source and transaction boundaries. */
  readonly writeFields: Readonly<Record<string, readonly string[]>>;
  /** The columns the database computes (generated), by table: read, never written by anyone. */
  readonly computedFields?: Readonly<Record<string, readonly string[]>>;
  /** Fixed actions this principal's roles run on tables they do not write
   * (`roles.<role>.actions`), by table id. An update there is one of these,
   * judged and stamped inside the scoped writer, or nothing. */
  readonly actions?: ReadonlyMap<string, readonly AppUpdateAction[]>;
  /** Current history authorization only: does not attest provenance or prove
   * that an absent candidate satisfies the writer's row/FK scope. */
  readonly authorizeDeletedRecord?: (record: DeletedPolicyRecord) => Promise<boolean>;
  readonly commands?: {
    availability?(raw: unknown, options?: PolicyCommandOptions): Promise<CommandAvailabilityResult>;
    prepare(raw: unknown, options?: PolicyCommandOptions): Promise<PreparedCommand | { targets: PreparedCommandTarget[] }>;
    execute(raw: unknown, options?: PolicyCommandOptions): Promise<BusinessCommandResult>;
    status(raw: unknown, options?: PolicyCommandOptions): Promise<BusinessCommandStatus>;
  };
  transaction<T>(source: string, run: (tx: WriteTransaction) => Promise<T>): Promise<T>;
  /** One source's connection read alone, under this principal's rows there: a
   * resource on any other connection is refused, never read, and no other
   * connection's reader is bound. For a request that reads one connection —
   * an App API read of a several-source App (apiSourceLanes.ts). */
  readsAt(source: string): Pick<ScopedReads, 'runView' | 'countView'>;
  /** A transaction that always rolls back: an import's check of one row. What
   * the writer refused is thrown to the caller and does not fail the context,
   * since nothing it did was committed; an uncertain rollback still does. */
  trial(source: string, run: (tx: WriteTransaction) => Promise<void>): Promise<void>;
}

/** A context's rows and resource places, for live sync's filtering alone. */
interface PolicyLiveScope {
  readonly rows: RowScope;
  toPhysical(id: string): string;
  connectionFor(id: string): string;
}
const policyLiveScopes = new WeakMap<AppPolicyContext, PolicyLiveScope>();

/** Live sync's reading of a context it was handed inside `withContext`. */
export const policyLiveScopeOf = (context: AppPolicyContext): PolicyLiveScope | undefined => policyLiveScopes.get(context);

export interface AppPolicyContextOptions<Request> {
  app: AppDef;
  resources: RuntimeResources;
  /** Resolved by the server registry, never by a request's source spelling. */
  sourceConnections: ReadonlyMap<string, string>;
  verifySession: (request: Request) => Promise<Identity | null>;
  /** Receives only verified identity. It cannot grant resources or fields. */
  resolveRows: (principal: PolicyPrincipal) => RowScope | Promise<RowScope>;
  /** Server-owned request resolution, independent of private account policy. */
  resolvePublicRows?: (request: Request) => RowScope | Promise<RowScope>;
  authorizeDeletedRecord?: AppRowPolicy['authorizeDeletedRecord'];
  /** Private deployment configuration; command grants never widen generic CRUD. */
  commands?: ScopedCommandOptions;
  /** The principal is verified; request is only a host memoization key. */
  captureFlags?: (
    principal: PolicyPrincipal,
    request: Request,
    assertCurrent: () => void,
  ) => CommandFlags | undefined | Promise<CommandFlags | undefined>;
}

function unknownOutcome(error: unknown): boolean {
  return (
    error instanceof TransactionOutcomeUnknown ||
    ((error instanceof BusinessCommandExecutionError || error instanceof CommandTransactionFailure) && error.outcome === 'unknown')
  );
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function deletedRecordSnapshot(input: DeletedPolicyRecord): DeletedPolicyRecord {
  let characters = 0;
  const bounded = (text: string) => {
    characters += text.length;
    if (characters > 1_048_576) throw new AppAccessDenied();
  };
  const ownData = (value: unknown, maximum: number): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)) throw new AppAccessDenied();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype) throw new AppAccessDenied();
    const keys = Reflect.ownKeys(value);
    if (keys.length > maximum) throw new AppAccessDenied();
    const result: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      if (typeof key !== 'string') throw new AppAccessDenied();
      bounded(key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) throw new AppAccessDenied();
      result[key] = descriptor.value;
    }
    return result;
  };
  const envelope = ownData(input, 3);
  if (
    Object.keys(envelope).length !== 3 ||
    !Object.hasOwn(envelope, 'table') ||
    !Object.hasOwn(envelope, 'key') ||
    !Object.hasOwn(envelope, 'row') ||
    typeof envelope.table !== 'string'
  )
    throw new AppAccessDenied();
  bounded(envelope.table);
  const key = ownData(envelope.key, 8192);
  const row = ownData(envelope.row, 8192);
  for (const [values, nullable] of [
    [key, false],
    [row, true],
  ] as const) {
    for (const value of Object.values(values)) {
      if (typeof value === 'string') bounded(value);
      else if (!(typeof value === 'number' && Number.isFinite(value)) && !(nullable && value === null)) {
        throw new AppAccessDenied();
      }
    }
    Object.freeze(values);
  }
  return Object.freeze({ table: envelope.table, key, row }) as DeletedPolicyRecord;
}

/** Nobody, at this App: no id to scope by and no role to grant by. The
 * policy is never called with one — `withContext` answers a visitor from
 * `auth.public` instead — and an empty id must never reach a row filter. */
const PUBLIC_VISITOR = (appId: string): PolicyPrincipal =>
  Object.freeze({ id: '', appId, roles: Object.freeze([]), kind: 'public' as const });

/** A jobs module's principal, as its receipts name it (jobAuthorization.ts
 * serviceActor): no session, no email, its roles the module's declaration. */
const servicePrincipal = (name: string, roles: readonly string[], appId: string): PolicyPrincipal =>
  Object.freeze({ id: `service:${name}`, appId, roles: Object.freeze([...roles]), kind: 'service' as const });

/** A service's run: who it is and the roles its module gives it, never a request's. */
interface ServiceCall {
  readonly name: string;
  readonly roles: readonly string[];
}

/** A call the server makes for someone, never on a request's word: a jobs
 * module's service, which runs commands in its rows, or an account the server
 * itself found (a notice's recipient, email/outbox.ts), which only reads. */
type ServerCall = { readonly service: ServiceCall } | { readonly account: Identity };

function principalFor(session: Identity | null, appId: string): PolicyPrincipal {
  const identity = snapshotScopedData(session);
  if (
    !identity ||
    typeof identity.id !== 'string' ||
    !identity.id.trim() ||
    identity.id.length > 1024 ||
    identity.id.includes('\0') ||
    typeof identity.who !== 'string' ||
    (identity.role !== undefined && typeof identity.role !== 'string')
  )
    throw new AppAccessDenied();
  const roles = [
    ...new Set(
      (identity.role ?? '')
        .split(',')
        .map((role) => role.trim())
        .filter(Boolean),
    ),
  ];
  if (roles.length > 256 || roles.some((role) => role.length > 256 || role.includes('\0'))) throw new AppAccessDenied();
  return Object.freeze({ id: identity.id, appId, roles: Object.freeze(roles), ...sessionActorWords(identity) });
}

/** Capture method identities without returning an unrestricted adapter or
 * allowing a later property replacement to redirect this deployment. Adapter
 * implementations and the session/policy functions remain trusted server code. */
function scopedAdapter(adapter: Adapter, schema: DatabaseSchema): Adapter {
  if (typeof adapter.scopeReads !== 'function') throw new AppAccessDenied();
  const deny = (): never => {
    throw new AppAccessDenied();
  };
  return Object.freeze({
    dialect: adapter.dialect,
    introspect: async () => schema,
    close: async () => {},
    query: deny,
    count: deny,
    scopeReads: adapter.scopeReads.bind(adapter),
    ...(typeof adapter.scopeTransaction === 'function' ? { scopeTransaction: adapter.scopeTransaction.bind(adapter) } : {}),
  });
}

/** One issuer per deployed authenticated App. Replacement must retire the old
 * issuer; operations never refresh/rebind its catalog or source ownership.
 * This private entry point does not install an HTTP route, journal, or tenant DSL. */
export function createAppPolicyContext<Request>(options: AppPolicyContextOptions<Request>) {
  const app = freeze(snapshotScopedData(options.app));
  const schema = captureScopeCatalog(options.resources.schema);
  const verifySession = options.verifySession;
  const resolveRows = options.resolveRows;
  const flagsDescriptor = Object.getOwnPropertyDescriptor(options, 'captureFlags');
  if (
    flagsDescriptor &&
    (!flagsDescriptor.enumerable ||
      !('value' in flagsDescriptor) ||
      typeof flagsDescriptor.value !== 'function' ||
      isProxy(flagsDescriptor.value))
  )
    throw new AppAccessDenied();
  const captureFlags = flagsDescriptor?.value as AppPolicyContextOptions<Request>['captureFlags'];
  const publicDescriptor = Object.getOwnPropertyDescriptor(options, 'resolvePublicRows');
  if (publicDescriptor && (!publicDescriptor.enumerable || !('value' in publicDescriptor) || typeof publicDescriptor.value !== 'function'))
    throw new AppAccessDenied();
  const resolvePublicRows = publicDescriptor?.value as AppPolicyContextOptions<Request>['resolvePublicRows'];
  const deletedDescriptor = Object.getOwnPropertyDescriptor(options, 'authorizeDeletedRecord');
  if (
    deletedDescriptor &&
    (!deletedDescriptor.enumerable || !('value' in deletedDescriptor) || typeof deletedDescriptor.value !== 'function')
  )
    throw new AppAccessDenied();
  const authorizeDeletedRecord = deletedDescriptor?.value as AppRowPolicy['authorizeDeletedRecord'];
  if (
    !app ||
    typeof app.id !== 'string' ||
    !app.id.trim() ||
    !rowPolicyAppShape(app) ||
    !app.sources ||
    typeof verifySession !== 'function' ||
    typeof resolveRows !== 'function'
  )
    throw new AppAccessDenied();
  // Validate inactive roles and catalog ceilings before accepting any request.
  resolveAppAccess(app, schema, []);
  const stamps = compileAppStamps(schema, app);
  const transitionRules = compileAppTransitions(schema, app);
  const sources = Object.freeze(Object.keys(app.sources));
  let bindings: Map<string, string>;
  try {
    bindings = new Map(Map.prototype.entries.call(options.sourceConnections));
  } catch {
    throw new AppAccessDenied();
  }
  const connections = [...options.resources.connections];
  /* Sources that share a connection (each scoped to a schema) are one
     owner: one database, one transaction. Every connection is some source's. */
  if (
    !sources.length ||
    sources.length !== bindings.size ||
    new Set(bindings.values()).size !== connections.length ||
    new Set(connections).size !== connections.length ||
    sources.some((source) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(source) || !bindings.has(source)) ||
    [...bindings.values()].some((owner) => typeof owner !== 'string' || !owner || !connections.includes(owner))
  ) {
    throw new AppAccessDenied();
  }
  const defaultSource = defaultSourceOf(app);
  const owners = new Map(
    schema.tables.map((table) => {
      const parts = table.id.split('.');
      // Without a default source every name is qualified: a bare one is no source's.
      const source = parts.length === 1 ? (defaultSource ?? '') : parts.length === 2 ? parts[0] : '';
      if (!bindings.has(source) || (parts.length === 2 && source === defaultSource) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(parts.at(-1)!))
        throw new AppAccessDenied();
      const owner = bindings.get(source)!;
      if (options.resources.connectionFor(table.id) !== owner) throw new AppAccessDenied();
      return [table.id, owner] as const;
    }),
  );
  const adapters = new Map(connections.map((owner) => [owner, scopedAdapter(options.resources.forConnection(owner), schema)]));
  const resources: RuntimeResources = {
    ...options.resources,
    schema,
    connections,
    adapter: scopedAdapter(options.resources.adapter, schema),
    connectionFor: (resource) => {
      const owner = owners.get(resource);
      if (owner === undefined) throw new AppAccessDenied();
      return owner;
    },
    forConnection: (owner) => {
      const adapter = adapters.get(owner);
      if (!adapter) throw new AppAccessDenied();
      return adapter;
    },
  };
  // The command binder captures its own source capabilities before any request;
  // the generic facade deliberately does not carry a journal capability.
  const commandOptions =
    options.commands === undefined ? undefined : { ...options.commands, registry: defineCommands(options.commands.registry) };
  const commands =
    commandOptions === undefined ? undefined : bindScopedBusinessCommands({ ...commandOptions, app, resources: options.resources });
  const commandReferences =
    commandOptions === undefined ? undefined : validateBusinessCommandReferences(app, commandOptions.registry, options.resources);
  let retired = false;
  const assertDeployed = () => {
    if (retired) throw new AppAccessDenied();
  };

  const withContext = async <T>(
    request: Request | undefined,
    run: (context: AppPolicyContext, commands: BusinessCommandBinding | undefined) => Promise<T>,
    publicly = false,
    server?: ServerCall,
  ): Promise<T> => {
    assertDeployed();
    const service = server && 'service' in server ? server.service : undefined;
    const account = server && 'account' in server ? server.account : undefined;
    const session = publicly || service ? null : (account ?? (await verifySession(request as Request)));
    assertDeployed();
    /* Public row narrowing intersects the existing read/field ceiling.
          A public visitor has no account roles, writer or private commands. */
    const visitor = !server && session === null && app.auth?.public !== undefined;
    /* A service is asked of the policy like a person, by its own principal; it
       runs commands in the rows it gets and nothing else — no generic writer,
       no fixed action, no transaction of its own. */
    const principal = service
      ? servicePrincipal(service.name, service.roles, app.id)
      : visitor
        ? PUBLIC_VISITOR(app.id)
        : principalFor(session, app.id);
    assertDeployed();
    const access = resolveAppAccess(app, schema, visitor ? [] : [...principal.roles], visitor ? 'public' : undefined);
    const validation = compileAppDefinitionValidation(schema, app);
    let rows: RowScope;
    if (visitor && !resolvePublicRows) {
      // Every resource the grant names, whole. A resource it does not name
      // is absent, which is the same as having no rows in it at all.
      rows = snapshotRowScope(schema, Object.fromEntries([...access.readable].map((id) => [id, true])));
    } else {
      const resolved = visitor ? resolvePublicRows!(request as Request) : resolveRows(principal);
      // A synchronous resolver transfers ownership now, before microtasks can
      // mutate its object. Native async results transfer it on delivery. Custom
      // thenables are not policy data and fail strict scope validation.
      rows = snapshotRowScope(schema, isPromise(resolved) ? await resolved : resolved);
    }
    assertDeployed();
    let active = true;
    const assertActive = () => {
      assertDeployed();
      if (!active) throw new AppAccessDenied();
    };
    const flags = commandFlagsOnce(async () => {
      assertActive();
      const reader = await captureFlags?.(principal, request as Request, assertActive);
      assertActive();
      return reader;
    });
    /* A granted fixed action is admitted by the scoped writer's own facade
         (authorizeTransaction), as an ordinary App's is: exactly the action,
         its `when` read through this principal's rows, its stamps the
         server's clock and this verified session's person. The row policy
         guards the row before and after, as for any write. A visitor runs none. */
    const granted = visitor || server ? undefined : appActionGrants(app, schema, [...principal.roles]);
    const actions = granted?.size ? granted : undefined;
    const guarded = authorizeResources(
      resources,
      {
        ...access,
        rows,
        ...(validation ? { validation } : {}),
        ...(actions
          ? {
              actions,
              /* A granted action reaches the facade as its words alone (appPolicyUpdates updateOne), so the facade
                 resolves the move's own stamps (`since`, a state's `ready_at`) after it has judged the action on them. */
              ...(transitionRules ? { transitions: transitionRules } : {}),
              me: (reader) => lookupPerson(app, schema, principal.email, reader),
              stamp: async (request, reader) =>
                actions.has(request.table) && request.restore !== true
                  ? stampUpdate(stamps, request, {
                      now: clockNow(),
                      ...(principal.email ? { who: principal.email } : {}),
                      person: () => personKey(app, schema, principal.email, reader),
                    })
                  : request,
            }
          : {}),
      },
      assertActive,
    );
    // Copy only guarded logical columns; command grants and physical-source
    // metadata must never become generic field authority.
    const writeFields = Object.freeze(
      Object.fromEntries(
        guarded.schema.tables
          .filter((table) => access.writable.has(table.id) && !table.isView)
          .map((table) => {
            const fields = access.fields?.get(table.id);
            return [
              table.id,
              Object.freeze(
                table.columns
                  /* A column the database computes (a generated column) is read like any other and written by
                     nobody: not a field to grant, so a form never offers it and a write naming it says why. */
                  .filter((column) => column.writable !== false)
                  .filter((column) => !fields || (fields.read.has(column.name) && fields.write.has(column.name)))
                  .map((column) => column.name),
              ),
            ];
          }),
      ),
    );
    const computedFields = Object.freeze(
      Object.fromEntries(
        // The App's catalog before any role's projection: there `writable: false` is the database's word alone.
        schema.tables
          .map(
            (table) =>
              [table.id, Object.freeze(table.columns.filter((column) => column.writable === false).map((column) => column.name))] as const,
          )
          .filter(([, columns]) => columns.length),
      ),
    );
    const pending = new Set<Promise<unknown>>();
    let failure: { error: unknown } | undefined;
    // Drain even unawaited operations before the owner can release its leases.
    // Any failed accepted operation makes this invocation fail, even if caught.
    // Separate writes are NOT a transaction; earlier confirmed commits remain.
    const track = <R>(work: () => Promise<R>): Promise<R> => {
      let operation: Promise<R>;
      try {
        assertActive();
        operation = Promise.resolve(work());
      } catch (error) {
        operation = Promise.reject(error);
      }
      pending.add(operation);
      void operation.then(
        () => pending.delete(operation),
        (error) => {
          if (!failure || unknownOutcome(error)) failure = { error };
          pending.delete(operation);
        },
      );
      return operation;
    };
    const adapter = guarded.adapter;
    const data = Object.freeze<PolicyData>({
      query: (request) => track(() => adapter.query(request)),
      count: (table, filter, limit) => track(() => adapter.count(table, filter, limit)),
      runView: (view, offset) => track(() => adapter.runView!(view, offset)),
      countView: (view) => track(() => adapter.countView!(view)),
      runBreakdown: (definition, offset) => track(() => adapter.runBreakdown!(definition, offset)),
      countBreakdown: (definition) => track(() => adapter.countBreakdown!(definition)),
      ...(adapter.insert && !server ? { insert: ((request) => track(() => adapter.insert!(request))) as WriteTransaction['insert'] } : {}),
      ...(adapter.update && !server ? { update: ((request) => track(() => adapter.update!(request))) as WriteTransaction['update'] } : {}),
      ...(adapter.remove && !server ? { remove: ((request) => track(() => adapter.remove!(request))) as WriteTransaction['remove'] } : {}),
    });
    /* No command is bound for a visitor, deliberately. A public form's
         command runs under the public principal, and whether that is safe
         under a row policy is a separate question from whether a visitor may
         read the catalogue — the question this path answers. Until it is
         answered, a row-policy App's public surface is reads. */
    const commandBinding = visitor || account ? undefined : commands?.withScope(rows, assertActive);
    const context: AppPolicyContext = Object.freeze({
      principal,
      sources,
      schema: captureScopeCatalog(guarded.schema),
      data,
      writeFields,
      ...(Object.keys(computedFields).length ? { computedFields } : {}),
      ...(actions ? { actions } : {}),
      ...(authorizeDeletedRecord
        ? {
            authorizeDeletedRecord: (input: DeletedPolicyRecord) =>
              track(() => {
                try {
                  const record = deletedRecordSnapshot(input);
                  const table = schema.tables.find((table) => table.id === record.table);
                  const current = guarded.schema.tables.find((table) => table.id === record.table);
                  const fields = access.fields?.get(record.table);
                  if (
                    !table ||
                    table.isView ||
                    current?.deletable !== true ||
                    !access.readable.has(table.id) ||
                    !access.writable.has(table.id) ||
                    table.columns.length !== Object.keys(record.row).length ||
                    table.columns.some(
                      (column) =>
                        !Object.hasOwn(record.row, column.name) ||
                        (fields && (!fields.read.has(column.name) || !fields.write.has(column.name))),
                    )
                  )
                    throw new AppAccessDenied();
                  const keys = table.columns.filter((column) => column.primaryKey).map((column) => column.name);
                  if (
                    !keys.length ||
                    keys.length !== Object.keys(record.key).length ||
                    keys.some((key) => !Object.hasOwn(record.key, key) || record.key[key] !== record.row[key])
                  )
                    throw new AppAccessDenied();
                  // Explicit deny needs no candidate evaluation. A filter cannot be
                  // evaluated here as a substitute for the scoped writer's checks.
                  if (rows[table.id] === false || !Object.hasOwn(rows, table.id)) return Promise.resolve(false);
                  const result = authorizeDeletedRecord(principal, record);
                  if (isPromise(result)) {
                    void Promise.prototype.then.call(result, undefined, () => {});
                    throw new AppAccessDenied();
                  }
                  if (typeof result !== 'boolean') throw new AppAccessDenied();
                  assertActive();
                  return Promise.resolve(result);
                } catch {
                  throw new AppAccessDenied();
                }
              }),
          }
        : {}),
      ...(commandBinding && !server
        ? {
            commands: Object.freeze<NonNullable<AppPolicyContext['commands']>>({
              availability: (raw, options) =>
                track(async () => {
                  try {
                    const checks = parseCommandAvailability(raw);
                    const signal = options?.signal ?? new AbortController().signal;
                    const requestId = options?.requestId;
                    if (requestId !== undefined && (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(requestId)))
                      throw new CommandInputError('requestId');
                    const result = await collectCommandAvailability(
                      checks,
                      async (check) => {
                        const authorized = commandBinding.authorize(check.command, principal);
                        if (!commandReferences!.has(check.command)) throw new AppAccessDenied();
                        const capturedFlags = await flags();
                        return await authorized.commandTransaction!((reader) =>
                          readCommandAvailability({
                            check,
                            command: authorized.command,
                            actor: authorized.actor,
                            catalog: authorized.catalog,
                            ...(authorized.people ? { people: authorized.people } : {}),
                            machine: authorized.machine,
                            reader,
                            signal,
                            flags: capturedFlags,
                            ...(requestId ? { requestId } : {}),
                            // The batch uses the same scope-filtered, current()-guarded
                            // facade as assertTarget. Complete PK/duplicate validation is
                            // performed by readCommandAvailability; no per-row requery.
                          }),
                        );
                      },
                      signal,
                    );
                    assertActive();
                    return result;
                  } catch (error) {
                    if (error instanceof CommandInputError)
                      throw new BusinessCommandExecutionError('invalid_input', 'not_applied', error.field);
                    throw error;
                  }
                }),
              prepare: (raw, options) =>
                track(async () => {
                  try {
                    const request = parseCommandPrepareTargets(raw, { creating: (id) => commandBinding.creates?.(id) === true });
                    const signal = options?.signal;
                    const requestId = options?.requestId;
                    const authorized = commandBinding.authorize(request.command, principal);
                    if (request.commandVersion !== authorized.command.version) {
                      throw new BusinessCommandExecutionError('command_version_mismatch', 'unknown');
                    }
                    const reference = commandReferences!.get(request.command);
                    if (!reference) throw new BusinessCommandExecutionError('forbidden');
                    if (request.multi && authorized.command.targets !== 'many') throw new CommandInputError('keys');
                    for (const key of request.keys) {
                      // The member, never its columns: an ownership column belongs to
                      // the platform, not the caller. See the executor's same check.
                      if (
                        authorized.keyColumns.length !== Object.keys(key).length ||
                        authorized.keyColumns.some((column) => !Object.hasOwn(key, column))
                      )
                        throw new CommandInputError('key');
                    }
                    if (requestId !== undefined && (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(requestId)))
                      throw new CommandInputError('requestId');
                    const checkCancelled = () => {
                      if (signal?.aborted) throw new BusinessCommandExecutionError('cancelled');
                    };
                    checkCancelled();
                    const capturedFlags = await flags();
                    checkCancelled();
                    assertActive();
                    // Several keys read through the same scoped reader: a row outside
                    // this principal's ceiling is simply not found, so it is listed
                    // as ineligible — execution then refuses it as forbidden.
                    const command = authorized.command;
                    if (request.multi) {
                      /* Revisions are read as execution reads its targets, in the command's
                   scoped transaction, so a row's digest covers the same columns. */
                      const prepared = await authorized.commandTransaction!((records) =>
                        prepareCommandTargets({
                          query: (query) => records.query({ ...query, table: command.target }),
                          schema,
                          table: authorized.resource,
                          keyColumns: authorized.keyColumns,
                          ...(authorized.versionField ? { versionField: authorized.versionField } : {}),
                          keys: request.keys,
                          when: bulkCommandWhen(app, request.command),
                          ...(authorized.timezone ? { zone: authorized.timezone } : {}),
                          me: () => whenPerson(records, authorized.actor, authorized.people, [bulkCommandWhen(app, request.command)]),
                          checkCancelled,
                        }),
                      );
                      if (preparesInitial(authorized.command)) {
                        prepared.targets = await authorized.commandTransaction!((records) =>
                          readPreparedTargetAvailability(records, {
                            command: authorized.command,
                            commandId: request.command,
                            actor: authorized.actor,
                            targets: prepared.targets,
                            catalog: authorized.catalog,
                            ...(authorized.people ? { people: authorized.people } : {}),
                            flags: capturedFlags,
                            ...(signal ? { signal } : {}),
                            ...(requestId ? { requestId } : {}),
                            assertTarget: (key) => authorized.assertTarget!(records, key),
                          }),
                        );
                      }
                      assertActive();
                      return prepared;
                    }
                    const [key] = request.keys;
                    // A visible explicit revision needs only the scoped reader. This
                    // keeps preparation independent of the command journal; opaque or
                    // hidden revisions still use the command's internal row projection.
                    if (
                      command.targets !== 'none' &&
                      authorized.versionField &&
                      !preparesInitial(command) &&
                      (!access.fields?.get(authorized.resource) ||
                        access.fields.get(authorized.resource)!.read.has(authorized.versionField))
                    ) {
                      const result = await adapter.query({
                        table: authorized.resource,
                        columns: [authorized.versionField],
                        limit: 2,
                        offset: 0,
                        filter: { groups: [authorized.keyColumns.map((column) => ({ column, op: '=' as const, value: key[column] }))] },
                      });
                      checkCancelled();
                      assertActive();
                      if (!result.rows.length) throw new BusinessCommandExecutionError('not_found');
                      const expectedVersion = result.rows.length === 1 ? result.rows[0][authorized.versionField] : undefined;
                      if (
                        typeof expectedVersion !== 'number' ||
                        !Number.isSafeInteger(expectedVersion) ||
                        expectedVersion < 0 ||
                        expectedVersion >= Number.MAX_SAFE_INTEGER
                      )
                        throw new BusinessCommandExecutionError('invalid_result');
                      return { expectedVersion };
                    }
                    // Starting values: the scoped command transaction. The revision is
                    // read first, through this principal's rows, so a record outside
                    // them is not found exactly as without `initial`; then the target
                    // check, then `initial`, in the same transaction. The journal is
                    // never touched.
                    /* The revision is read through the command's scoped transaction, as
                 execution reads its target — so a digest of the row covers the same
                 columns — and through this principal's rows first, so a record outside
                 them is not found. Then the target check, then any `initial`. The
                 journal is never touched. */
                    const prepared = await withPreparedAhead(command, authorized.catalog, key, () =>
                      authorized.commandTransaction!((records) =>
                        readPreparedRecord(records, {
                          command: authorized.command,
                          commandId: request.command,
                          actor: authorized.actor,
                          key,
                          catalog: authorized.catalog!,
                          ...(authorized.people ? { people: authorized.people } : {}),
                          flags: capturedFlags,
                          ...(signal ? { signal } : {}),
                          ...(requestId ? { requestId } : {}),
                          beforeInitial: () => authorized.assertTarget!(records, key),
                        }),
                      ),
                    );
                    assertActive();
                    return prepared;
                  } catch (thrown) {
                    // A refusal raised inside the command transaction arrives wrapped, as
                    // it does for execution: its cause is the answer, not "unavailable".
                    const error = thrown instanceof CommandTransactionFailure ? thrown.cause : thrown;
                    if (error instanceof BusinessCommandExecutionError) throw error;
                    if (error instanceof AppAccessDenied) throw forbiddenBy(error);
                    if (error instanceof CommandInputError)
                      throw new BusinessCommandExecutionError('invalid_input', 'not_applied', error.field);
                    throw new BusinessCommandExecutionError('temporarily_unavailable');
                  }
                }),
              execute: (raw, options) =>
                track(async () => {
                  const body = snapshotScopedData(raw);
                  const execution = {
                    signal: options?.signal,
                    requestId: options?.requestId,
                    ...(options?.door ? { door: options.door } : {}),
                  };
                  return executeBusinessCommand(commandBinding, principal, body, {
                    ...execution,
                    flags: await authorizedCommandFlags(commandBinding, principal, body, flags),
                  });
                }),
              status: (raw, options) =>
                track(async () => {
                  const body = snapshotScopedData(raw),
                    execution = { signal: options?.signal, requestId: options?.requestId };
                  return lookupBusinessCommandStatus(commandBinding, principal, body, {
                    ...execution,
                    flags: await authorizedCommandFlags(commandBinding, principal, body, flags, true),
                  });
                }),
            }),
          }
        : {}),
      /* The connection's own facade, as a transaction gets: it is anchored
           there (appSourceAdapter.ts), so a view that names a resource on
           another connection is refused before any statement runs. */
      readsAt: (source: string) => {
        const owner = bindings.get(source);
        if (owner === undefined) throw new AppAccessDenied();
        const lane = guarded.forConnection(owner);
        if (!lane.runView || !lane.countView) throw new AppAccessDenied();
        return Object.freeze<Pick<ScopedReads, 'runView' | 'countView'>>({
          runView: (view, offset) => track(() => lane.runView!(view, offset)),
          countView: (view, limit) => track(() => lane.countView!(view, limit)),
        });
      },
      transaction: <R>(source: string, callback: (tx: WriteTransaction) => Promise<R>): Promise<R> =>
        track(() => {
          const owner = bindings.get(source);
          if (owner === undefined || server) throw new AppAccessDenied();
          const transaction = guarded.forConnection(owner).transaction;
          if (!transaction) throw new AppAccessDenied();
          return transaction(callback);
        }),
      /* The failure accounting above exists so a caught refusal cannot pass
           off a half-done run of separate commits as success. A trial commits
           nothing by construction — it always ends by throwing — so its
           refusal is the row's answer, handed back rather than kept. */
      trial: (source: string, callback: (tx: WriteTransaction) => Promise<void>): Promise<void> => {
        const rolledBack = new Error('trial');
        return track(async () => {
          const owner = bindings.get(source);
          if (owner === undefined || server) throw new AppAccessDenied();
          const transaction = guarded.forConnection(owner).transaction;
          if (!transaction) throw new AppAccessDenied();
          try {
            await transaction(async (tx) => {
              await callback(tx);
              throw rolledBack;
            });
          } catch (error) {
            if (error === rolledBack) return undefined;
            if (unknownOutcome(error)) throw error;
            return { refused: error };
          }
          return undefined;
        }).then((outcome) => {
          if (outcome) throw outcome.refused;
        });
      },
    });
    /* What live sync asks of this context (server/live/liveRoute.ts): the rows it reads, and where each
       resource lives. Never a capability: a probe it runs is a read in a context of its own. */
    policyLiveScopes.set(
      context,
      Object.freeze({
        rows,
        toPhysical: (id: string) => resources.toPhysical(id),
        connectionFor: (id: string) => resources.connectionFor(id),
      }),
    );
    let result: T | undefined;
    let callbackFailure: { error: unknown } | undefined;
    try {
      result = await run(context, commandBinding);
    } catch (error) {
      callbackFailure = { error };
    } finally {
      active = false;
      await Promise.allSettled([...pending]);
    }
    // Never replace an uncertain transaction result with a lifecycle refusal.
    if (failure && unknownOutcome(failure.error)) throw failure.error;
    if (callbackFailure) throw callbackFailure.error;
    if (failure) throw failure.error;
    if (visitor) assertDeployed();
    return result as T;
  };
  return Object.freeze({
    retire(): void {
      retired = true;
    },
    withContext: <T>(request: Request, run: (context: AppPolicyContext) => Promise<T>) => withContext(request, (context) => run(context)),
    /** Explicit server-only public reader; never borrows a staff account's rows. */
    withPublicContext: <T>(request: Request, run: (context: AppPolicyContext) => Promise<T>) =>
      withContext(request, (context) => run(context), true),
    /** A jobs module's principal, with the roles its module declares: reads in
     * its rows, and the commands bound to them. The deployment says which
     * principals may ask (the policy's `services`); nothing here verifies one. */
    withService: <T>(
      name: string,
      roles: readonly string[],
      run: (context: AppPolicyContext, commands: BusinessCommandBinding | undefined) => Promise<T>,
    ) => withContext(undefined, run, false, Object.freeze({ service: Object.freeze({ name, roles: Object.freeze([...roles]) }) })),
    /** An account the server found itself, never a request's — a notice's
     * recipient by address — read for as a session of theirs would be: its rows
     * from the policy, and no writer, action or command. */
    withAccount: <T>(account: Identity, run: (context: AppPolicyContext) => Promise<T>) =>
      withContext(undefined, (context) => run(context), false, Object.freeze({ account })),
  });
}
