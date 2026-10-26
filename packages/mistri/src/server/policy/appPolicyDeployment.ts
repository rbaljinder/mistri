import { isPromise } from 'node:util/types';
import { captureHttpCommandFlags } from '../flags/httpRuntime.js';
import { createHash } from 'node:crypto';
import type { Adapter } from '@mistriwork/engine/adapters/adapter.js';
import type { CommandJournalAppScope } from '../../adapters/commands/commandJournalTypes.js';
import { snapshotScopedData } from '@mistriwork/engine/adapters/scoped/scopedReads.js';
import { isPublicForm, isTenantApp, logicalResource, resolveAppAccess, rowPolicyAppShape, type AppDef } from '../../shared/app.js';
import { appUsesCommands } from '../../shared/appCommandIds.js';
import { captureRowScope, type RowScope } from '@mistriwork/engine/shared/rowScope.js';
import {
  assertScopeCatalog,
  captureScopeCatalog,
  mapScopeCatalog,
  scopeCatalogDifference,
} from '@mistriwork/engine/shared/scopeCatalog.js';
import { Refusal } from '@mistriwork/engine/shared/refusal.js';
import { AppAccessDenied } from '../app/appAccess.js';
import { recordRefusalCause } from '@mistriwork/engine/server/evidence.js';
import { createAppPolicyContext, type AppPolicyContext } from './appPolicyContext.js';
import {
  AppRowPolicyDefinitionError,
  policyStartupFailure,
  defineAppRowPolicy,
  loadAppRowPolicy,
  type AppRowPolicy,
  type PublicPlacementIntent,
} from './appRowPolicy.js';
import type { RuntimeResources } from '../app/appRuntimeResources.js';
import type { Identity } from '../auth/auth.js';
import { validateBusinessCommandReferences } from '../commands/businessCommandLoader.js';
import { defineCommands, type BusinessCommandRegistry } from '../commands/businessCommands.js';
import { bindPolicyPublicIntake } from './policyPublicIntake.js';
import { createPolicyDb } from './policyDb.js';
import { startSpan, withSpan } from '@mistriwork/engine/adapters/telemetry/trace.js';
import { BusinessCommandExecutionError } from '../commands/businessCommandExecution.js';
import {
  bindPolicyPublicPlacement,
  bindPolicyPublicPlacementRecovery,
  type TrustedPublicPlacementSelection,
} from './policyPublicPlacement.js';
import type { createPublicPlacementBindingIssuer } from '../forms/publicPlacementBinding.js';
import { canonicalCommandJson } from '../commands/commandPayload.js';
import { contractDigest } from '../commands/commandContracts.js';
import type { BusinessCommandBinding } from '../commands/businessCommandAccess.js';
import { commandsOf } from '../stores/commandStores.js';
import { appZone } from '../../shared/appZone.js';

/** The suite creates one issuer/epoch before starting any App. Retained readers
 * must be acquired by stable source identity, never a connection alias. */
export interface AppPolicyPlacementOptions {
  issuer: ReturnType<typeof createPublicPlacementBindingIssuer>;
  sourceIdentities: ReadonlyMap<string, string>;
  epoch: string;
  /** Digest of the captured server policy module, supplied at startup. */
  policyRevision: string;
  acquireReceiptSources?: () => Promise<{
    sources: ReadonlyMap<string, Pick<Adapter, 'publicPlacementReceipt'>>;
    release(): void | Promise<void>;
  }>;
}

/** The host acquires all source leases before returning this bundle. On an
 * acquisition failure it cleans up its own partial acquisition. Nothing here
 * owns or closes the underlying adapters, or promises distributed atomicity. */
export interface AppPolicyAcquisition {
  resources: RuntimeResources;
  sourceConnections: ReadonlyMap<string, string>;
  release: () => void | Promise<void>;
}

interface AppPolicyDeploymentOptions<Request> {
  app: AppDef;
  policy: AppRowPolicy;
  verifySession: (request: Request) => Promise<Identity | null>;
  /** Reads captured server intent, never a query/body/header-selected tenant. */
  publicPlacement?: (request: Request) => PublicPlacementIntent | null;
  placements?: AppPolicyPlacementOptions;
  acquire: (app: AppDef) => Promise<AppPolicyAcquisition>;
  commands?: {
    registry: BusinessCommandRegistry;
    writableConnection: (connection: string) => boolean;
    /** The App's issued event source, when its commands declare events (appCommandEvents.ts). */
    events?: CommandJournalAppScope;
  };
  /** The jobs module's principals and the roles it gives each: every one must be
   * a service the policy names, or the deployment does not start. */
  services?: ReadonlyMap<string, readonly string[]>;
}

export interface AppPolicyDeployment<Request> {
  withContext<T>(request: Request, run: (context: AppPolicyContext) => Promise<T>): Promise<T>;
  withPublicContext<T>(request: Request, run: (context: AppPolicyContext) => Promise<T>): Promise<T>;
  /** The policy's `services`, as it declared them. */
  readonly services: readonly string[];
  /** One attempt of a jobs principal the deployment started with: its reads and
   * its commands, in the rows the policy gives `service:<name>`. Drained on retirement. */
  withService<T>(name: string, run: (context: AppPolicyContext, commands: BusinessCommandBinding | undefined) => Promise<T>): Promise<T>;
  /** A read for an account the server found itself (a notice's recipient), in
   * the rows the policy gives that account: no writer, action or command. Drained on retirement. */
  withAccount<T>(account: Identity, run: (context: AppPolicyContext) => Promise<T>): Promise<T>;
  submitPublicForm?: (
    form: string,
    ...args: Parameters<ReturnType<typeof bindPolicyPublicIntake>['submit']>
  ) => ReturnType<ReturnType<typeof bindPolicyPublicIntake>['submit']>;
  placedPublicForm?(form: string): boolean;
  preparePublicPlacement?: (
    form: string,
    selection: TrustedPublicPlacementSelection,
  ) => ReturnType<ReturnType<typeof bindPolicyPublicPlacement>['prepare']>;
  submitPublicPlacement?: (
    form: string,
    ...args: Parameters<ReturnType<typeof bindPolicyPublicPlacement>['submit']>
  ) => ReturnType<ReturnType<typeof bindPolicyPublicPlacement>['submit']>;
  recoverPublicPlacement?: (
    form: string,
    binding: unknown,
    submission: unknown,
  ) => ReturnType<ReturnType<typeof bindPolicyPublicPlacementRecovery>['recover']>;
  /** Refuse immediately, then drain invocations and release source leases once.
   * Called by the owning host, not awaited from inside its own invocation. */
  retire(): Promise<void>;
}

/* Startup's proof that each writer sees the catalog the App was checked against. Refused, it names where the two
   part: "could not be verified" alone sent a skill run's author bisecting the App by hand for twenty minutes. */
function assertDeployedCatalog(
  expected: Parameters<typeof assertScopeCatalog>[0],
  evidence: Parameters<typeof assertScopeCatalog>[1],
): void {
  try {
    assertScopeCatalog(expected, evidence);
  } catch (error) {
    const where = scopeCatalogDifference(expected, evidence);
    if (!where) throw error;
    throw new Refusal(
      `The scoped catalog could not be verified: ${where}. The App's catalog is the database's as the App reads it; ` +
        'refresh it (restart) after a schema change, and report a difference the App itself declared as a mistri defect.',
      { cause: error },
    );
  }
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Capture capabilities before startup awaits, not only before requests. A
 * later replacement must create a new deployment, never rebind an old handle. */
function captureResources(input: RuntimeResources): RuntimeResources {
  const schema = captureScopeCatalog(input.schema);
  const connections = [...input.connections];
  const owners = new Map(schema.tables.map((table) => [table.id, input.connectionFor(table.id)]));
  const deny = (): never => {
    throw new AppAccessDenied();
  };
  const capture = (source: Adapter): Adapter => {
    const commands = commandsOf(source);
    return Object.freeze({
      dialect: source.dialect,
      introspect: async () => schema,
      close: async () => {},
      query: deny,
      count: deny,
      ...(source.scopeReads ? { scopeReads: source.scopeReads.bind(source) } : {}),
      ...(source.scopeTransaction ? { scopeTransaction: source.scopeTransaction.bind(source) } : {}),
      ...(commands.scopeCommandTransaction ? { scopeCommandTransaction: commands.scopeCommandTransaction.bind(source) } : {}),
      ...(commands.publicPlacementCommandTransaction
        ? { publicPlacementCommandTransaction: commands.publicPlacementCommandTransaction.bind(source) }
        : {}),
      ...(commands.publicPlacementReceipt ? { publicPlacementReceipt: commands.publicPlacementReceipt.bind(source) } : {}),
      ...(source.transaction ? { transaction: source.transaction.bind(source) } : {}),
    });
  };
  const adapters = new Map(connections.map((owner) => [owner, capture(input.forConnection(owner))]));
  return {
    ...input,
    schema,
    connections,
    adapter: capture(input.adapter),
    connectionFor: (resource) => owners.get(resource) ?? deny(),
    forConnection: (owner) => adapters.get(owner) ?? deny(),
  };
}

/** Restart-only, server-owned deployment boundary. HTTP enrollment consumes
 * the private scoped capabilities only through its reviewed route allowlist. */
export async function createAppPolicyDeployment<Request>(
  options: AppPolicyDeploymentOptions<Request>,
): Promise<AppPolicyDeployment<Request>> {
  let release: (() => void | Promise<void>) | undefined;
  let releaseReceipts: (() => void | Promise<void>) | undefined;
  let issuer: ReturnType<typeof createAppPolicyContext<Request>> | undefined;
  const intakes = new Map<string, ReturnType<typeof bindPolicyPublicIntake>>();
  const placed = new Map<string, ReturnType<typeof bindPolicyPublicPlacement>>();
  try {
    // Capture definitions and function identities before acquiring any sources.
    const app = freeze(snapshotScopedData(options.app));
    /* Each startup refusal records the rule it enforces (evidence.ts), for the
       operator; the error that leaves startup stays one sentence. */
    const refuse = (reason: string): never => {
      throw recordRefusalCause(new AppAccessDenied(), reason);
    };
    // What the policy module itself says wrong: blamed on it, as its loader blames it (policyStartupFailure).
    const refusePolicy = (reason: string): never => {
      throw recordRefusalCause(new AppRowPolicyDefinitionError(), reason);
    };
    if (isTenantApp(app)) refuse('A tenant App starts under its tenant policy, not a row policy.');
    const policy = defineAppRowPolicy(options.policy);
    const verify = options.verifySession;
    const publicPlacement = options.publicPlacement;
    const placements = capturePlacements(options.placements);
    if (publicPlacement !== undefined && typeof publicPlacement !== 'function') throw new AppAccessDenied();
    const acquire = options.acquire;
    const registry = options.commands && defineCommands(options.commands.registry);
    const writable = options.commands?.writableConnection;
    if (app?.id !== policy.appId) refusePolicy(`The row policy is for App "${policy.appId}", and this App is "${app?.id}".`);
    if (!rowPolicyAppShape(app)) refuse("The App is not a row-policy App: it needs auth.rows: 'policy' and roles.");
    if (typeof verify !== 'function' || typeof acquire !== 'function' || (registry && typeof writable !== 'function'))
      throw new AppAccessDenied();
    if (!registry && appUsesCommands(app)) refuse('The App declares commands; start it with --commands <file> beside --policy.');
    if (!registry && (policy.resultReferences !== undefined || policy.publicForms !== undefined)) {
      refusePolicy('The row policy declares resultReferences or publicForms, which serve commands; start with --commands <file>.');
    }
    /* The commands the policy speaks for are the ones that run under it: a `public: true` command runs on no
       row-policy App (its form answers 503), so it needs no function and naming one is refused. Each refusal names
       what to write, so that writing it starts the App (field report R9: "one function per command" was followed to
       the letter, the public one too, and refused again in words that blamed the App's connections). */
    if (registry) {
      const quoted = (ids: readonly string[]) => ids.map((id) => `"${id}"`).join(', ');
      const scoped = Object.keys(registry).filter((id) => registry[id].public !== true);
      const open = Object.keys(registry).filter((id) => registry[id].public === true);
      const needless = open.length
        ? ` ${quoted(open)} ${open.length === 1 ? 'is' : 'are'} public: true and ${open.length === 1 ? 'needs' : 'need'} none.`
        : '';
      if (policy.resultReferences === undefined) {
        refusePolicy(
          scoped.length
            ? `With --commands, the row policy must declare resultReferences: one function for each of ${quoted(scoped)}, ` +
                `saying which rows its result names.${needless}`
            : `With --commands, the row policy must declare resultReferences, here {}:${needless}`,
        );
      }
      const named = Object.keys(policy.resultReferences!);
      const missing = scoped.filter((id) => !named.includes(id));
      const publicNamed = named.filter((id) => open.includes(id));
      const unknown = named.filter((id) => !Object.hasOwn(registry, id));
      if (missing.length || publicNamed.length || unknown.length) {
        refusePolicy(
          [
            `The row policy's resultReferences has ${scoped.length ? `one function for each of ${quoted(scoped)} and no other` : 'no function'}:`,
            ...(missing.length ? [`add ${quoted(missing)};`] : []),
            ...(publicNamed.length
              ? [
                  `leave out ${quoted(publicNamed)}, which ${publicNamed.length === 1 ? 'is public: true and runs' : 'are public: true and run'} on no row-policy App;`,
                ]
              : []),
            ...(unknown.length ? [`leave out ${quoted(unknown)}, which the commands module does not register;`] : []),
          ]
            .join(' ')
            .replace(/;$/, '.'),
        );
      }
    }
    /* The roles are the module's, captured now: a running attempt names only
       its principal, so nothing it carries can widen what the policy is asked. */
    const services = new Map<string, readonly string[]>();
    for (const [name, roles] of options.services ?? new Map<string, readonly string[]>()) {
      if (!policy.services?.includes(name))
        refuse(
          `[policy-service-unnamed] The jobs run as "${name}", which the row policy's services do not name: add it to services, or the jobs it runs run nothing.`,
        );
      services.set(name, Object.freeze([...roles]));
    }

    const acquired = await acquire(app);
    // Capture cleanup before validating the rest, including malformed catalogs.
    // An accessor is never a valid lease release function.
    const descriptor = acquired && Object.getOwnPropertyDescriptor(acquired, 'release');
    if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function') throw new AppAccessDenied();
    const cleanup = descriptor.value as AppPolicyAcquisition['release'];
    release = () => Reflect.apply(cleanup, acquired, []);
    // Read before capture: the captured resources refuse a plain read, and
    // the policy's own reads are the one plain read this deployment makes.
    const policyContext = Object.freeze({ db: createPolicyDb(acquired.resources, appZone(app.ui)) });
    const resources = captureResources(acquired.resources);
    const sourceConnections = new Map(Map.prototype.entries.call(acquired.sourceConnections));
    const receiptSources = new Map<string, Pick<Adapter, 'publicPlacementReceipt'>>();
    if (placements) {
      if (placements.acquireReceiptSources) {
        const retained = await placements.acquireReceiptSources();
        const descriptor = Object.getOwnPropertyDescriptor(retained, 'release');
        if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function') throw new AppAccessDenied();
        releaseReceipts = descriptor.value.bind(retained);
        for (const [identity, reader] of new Map<string, Pick<Adapter, 'publicPlacementReceipt'>>(
          Map.prototype.entries.call(retained.sources),
        )) {
          const receipt = commandsOf(reader).publicPlacementReceipt;
          if (!placementIdentifier(identity) || typeof receipt !== 'function') throw new AppAccessDenied();
          receiptSources.set(identity, Object.freeze({ publicPlacementReceipt: receipt.bind(reader) }));
        }
      }
      for (const [name, identity] of placements.sourceIdentities) {
        const connection = sourceConnections.get(name);
        if (!connection || !app.sources?.[name] || receiptSources.has(identity)) throw new AppAccessDenied();
        const reader = resources.forConnection(connection);
        if (!commandsOf(reader).publicPlacementReceipt) throw new AppAccessDenied();
        receiptSources.set(identity, reader);
      }
    }
    const commands = registry
      ? {
          registry,
          resultReferences: policy.resultReferences!,
          writableConnection: (owner: string) => {
            try {
              return writable!(owner) === true;
            } catch {
              throw new AppAccessDenied();
            }
          },
          ...(options.commands?.events ? { events: options.commands.events } : {}),
        }
      : undefined;
    issuer = createAppPolicyContext({
      app,
      resources,
      sourceConnections,
      commands,
      captureFlags: (principal, _request, assertCurrent) => captureHttpCommandFlags(principal, undefined, assertCurrent),
      ...(policy.resolvePublicRows
        ? {
            resolvePublicRows: (request: Request) => {
              try {
                const intent = snapshotScopedData(publicPlacement?.(request) ?? null);
                if (
                  intent !== null &&
                  (Object.keys(intent).length !== 2 ||
                    intent.appId !== app.id ||
                    typeof intent.tenant !== 'string' ||
                    !intent.tenant.trim() ||
                    intent.tenant !== intent.tenant.trim() ||
                    intent.tenant.length > 1024 ||
                    /\p{Cc}/u.test(intent.tenant))
                )
                  throw new AppAccessDenied();
                const rows = policy.resolvePublicRows!(intent === null ? null : Object.freeze(intent), policyContext);
                const capture = (value: RowScope) => {
                  try {
                    return captureRowScope(value);
                  } catch {
                    throw new AppAccessDenied();
                  }
                };
                return isPromise(rows)
                  ? rows.then(capture, () => {
                      throw new AppAccessDenied();
                    })
                  : capture(rows);
              } catch {
                throw new AppAccessDenied();
              }
            },
          }
        : {}),
      ...(policy.authorizeDeletedRecord === undefined ? {} : { authorizeDeletedRecord: policy.authorizeDeletedRecord }),
      verifySession: async (request: Request) => {
        try {
          const session = verify(request);
          return snapshotScopedData(isPromise(session) ? await session : session);
        } catch {
          throw new AppAccessDenied();
        }
      },
      resolveRows: (principal) => {
        // Keep synchronous transfer synchronous: deferring it permits mutation
        // in a queued microtask before the issuer snapshots the returned policy.
        try {
          // A span of its own, so the observer shows the statements a policy
          // ran as the policy's, apart from the request's reads. Ended on a
          // native promise's settling only: a custom thenable is never called.
          const span = startSpan('mistri.policy.rows', { childOnly: true });
          let rows: ReturnType<typeof policy.resolveRows>;
          try {
            rows = withSpan(span, () => policy.resolveRows(principal, policyContext));
          } finally {
            if (!isPromise(rows!)) span.end();
          }
          if (isPromise(rows))
            void Promise.prototype.then.call(
              rows,
              () => span.end(),
              () => span.end(),
            );
          const capture = (value: RowScope) => {
            try {
              return captureRowScope(value);
            } catch {
              throw new AppAccessDenied();
            }
          };
          return isPromise(rows)
            ? rows.then(capture, () => {
                throw new AppAccessDenied();
              })
            : capture(rows);
        } catch {
          throw new AppAccessDenied();
        }
      },
    });
    if (registry) validateBusinessCommandReferences(app, registry, resources);
    for (const [form, definition] of Object.entries(policy.publicForms ?? {})) {
      if ('kind' in definition) {
        const sourceIdentity = placements?.sourceIdentities.get(definition.source);
        if (!placements || !sourceIdentity)
          throw recordRefusalCause(
            new AppRowPolicyDefinitionError(),
            `Placed public form "${form}" requires a configured placement issuer and pinned source owner at deployment startup.`,
          );
        const view = app.views[form];
        if (!isPublicForm(view) || !registry?.[view.command.id]) throw new AppAccessDenied();
        const command = registry[view.command.id];
        const formRevision = createHash('sha256')
          .update(
            canonicalCommandJson(
              {
                appId: app.id,
                form: view,
                enrollment: { kind: definition.kind, source: definition.source },
                policyRevision: placements.policyRevision,
                contract: contractDigest(app, command),
                read: command.read,
                write: command.write,
              },
              1 << 22,
            ),
          )
          .digest('hex');
        placed.set(
          form,
          bindPolicyPublicPlacement({
            app,
            policy,
            resources,
            registry,
            form,
            sourceConnections,
            captureFlags: captureHttpCommandFlags,
            sourceIdentity,
            epoch: placements.epoch,
            formRevision,
            issuer: placements.issuer,
            policyContext,
            writableConnection: commands!.writableConnection,
            receiptSources,
          }),
        );
        continue;
      }
      intakes.set(
        form,
        bindPolicyPublicIntake({
          app,
          resources,
          registry: registry!,
          form,
          captureFlags: captureHttpCommandFlags,
          rows: definition.rows,
          resultReferences: definition.resultReferences,
          writableConnection: commands!.writableConnection,
        }),
      );
    }

    // Test advertised writer support for every role before activation, not just
    // whichever account happens to connect first. No resolver/handler runs here.
    const grants = resolveAppAccess(app, resources.schema, Object.keys(app.auth!.roles!));
    const genericOwners = new Set([...grants.writable].map((resource) => resources.connectionFor(resource)));
    const commandOwners = new Set(
      Object.values(registry ?? {}).map((command) => resources.connectionFor(logicalResource(app, command.source, command.target))),
    );
    for (const owner of new Set([...genericOwners, ...commandOwners])) {
      const source = resources.forConnection(owner);
      const ids = new Map(
        resources.schema.tables.filter((table) => resources.connectionFor(table.id) === owner).map((table) => [table.id, table.id]),
      );
      const expected = mapScopeCatalog({ ...resources.schema, dialect: source.dialect }, ids);
      const rows = Object.freeze(Object.fromEntries([...ids.keys()].map((id) => [id, false])));
      if (genericOwners.has(owner)) {
        if (!source.scopeTransaction) throw new AppAccessDenied();
        await source.scopeTransaction(rows, async (_records, evidence) => {
          assertDeployedCatalog(expected, evidence);
        });
      }
      if (commandOwners.has(owner)) {
        const transact = commandsOf(source).scopeCommandTransaction;
        if (!transact) throw new AppAccessDenied();
        await transact.call(source, rows, async (_records, _journal, evidence) => {
          assertDeployedCatalog(expected, evidence);
        });
      }
    }

    const deployed = issuer;
    const releaseSources = release;
    const pending = new Set<Promise<unknown>>();
    let retired = false;
    let retirement: Promise<void> | undefined;
    // Register before verifier/policy reentry so retirement drains every reader.
    const tracked = <T>(start: () => Promise<T>): Promise<T> => {
      if (retired) return Promise.reject(new AppAccessDenied());
      const operation = Promise.resolve().then(start);
      pending.add(operation);
      void operation.then(
        () => pending.delete(operation),
        () => pending.delete(operation),
      );
      return operation;
    };
    const withContext = <T>(request: Request, run: (context: AppPolicyContext) => Promise<T>, publicly: boolean): Promise<T> =>
      tracked(() => (publicly ? deployed.withPublicContext(request, run) : deployed.withContext(request, run)));
    return Object.freeze<AppPolicyDeployment<Request>>({
      services: policy.services ?? [],
      withService<T>(
        name: string,
        run: (context: AppPolicyContext, commands: BusinessCommandBinding | undefined) => Promise<T>,
      ): Promise<T> {
        const roles = services.get(name);
        if (!roles) return Promise.reject(new AppAccessDenied());
        return tracked(() => deployed.withService(name, roles, run));
      },
      withAccount: <T>(account: Identity, run: (context: AppPolicyContext) => Promise<T>) =>
        tracked(() => deployed.withAccount(account, run)),
      ...(placements
        ? {
            placedPublicForm: (form: string) => placed.has(form),
            preparePublicPlacement: (form: string, selection: TrustedPublicPlacementSelection) => {
              const intake = placed.get(form);
              if (retired || !intake) return Promise.reject(new BusinessCommandExecutionError('temporarily_unavailable', 'unknown'));
              return intake.prepare(selection);
            },
            submitPublicPlacement: (form: string, ...args: Parameters<ReturnType<typeof bindPolicyPublicPlacement>['submit']>) => {
              const intake = placed.get(form);
              if (retired || !intake) return Promise.reject(new BusinessCommandExecutionError('temporarily_unavailable', 'unknown'));
              return intake.submit(...args);
            },
            recoverPublicPlacement: (form: string, binding: unknown, submission: unknown) => {
              if (retired) return Promise.reject(new BusinessCommandExecutionError('temporarily_unavailable', 'unknown'));
              // No unbounded per-form cache; this owner needs neither a current form
              // declaration nor its handler. The deployment retains the read lease.
              const operation = Promise.resolve().then(async () => {
                if (retired) throw new BusinessCommandExecutionError('temporarily_unavailable', 'unknown');
                const reader = bindPolicyPublicPlacementRecovery({ appId: app.id, form, issuer: placements.issuer, receiptSources });
                try {
                  const result = await reader.recover(binding, submission);
                  if (retired) throw new BusinessCommandExecutionError('temporarily_unavailable', 'unknown');
                  return result;
                } finally {
                  await reader.retire();
                }
              });
              pending.add(operation);
              void operation.then(
                () => pending.delete(operation),
                () => pending.delete(operation),
              );
              return operation;
            },
          }
        : {}),
      ...(intakes.size
        ? {
            submitPublicForm: (form: string, ...args: Parameters<ReturnType<typeof bindPolicyPublicIntake>['submit']>) => {
              const intake = intakes.get(form);
              if (retired || !intake) return Promise.reject(new BusinessCommandExecutionError('temporarily_unavailable'));
              return intake.submit(...args);
            },
          }
        : {}),
      withContext<T>(request: Request, run: (context: AppPolicyContext) => Promise<T>): Promise<T> {
        return withContext(request, run, false);
      },
      withPublicContext<T>(request: Request, run: (context: AppPolicyContext) => Promise<T>): Promise<T> {
        return withContext(request, run, true);
      },
      retire(): Promise<void> {
        if (retirement) return retirement;
        retired = true;
        deployed.retire();
        const intakeRetirements = [...intakes.values(), ...placed.values()].map((intake) => intake.retire());
        retirement = (async () => {
          await Promise.allSettled([...pending, ...intakeRetirements]);
          const released = await Promise.allSettled([
            Promise.resolve().then(releaseSources),
            Promise.resolve().then(() => releaseReceipts?.()),
          ]);
          if (released.some((result) => result.status === 'rejected')) throw new AppRowPolicyDefinitionError();
        })();
        return retirement;
      },
    });
  } catch (error) {
    issuer?.retire();
    await Promise.allSettled([...intakes.values(), ...placed.values()].map((intake) => intake.retire()));
    try {
      await releaseReceipts?.();
    } catch {
      /* Private cleanup errors must not escape startup. */
    }
    try {
      await release?.();
    } catch {
      /* Private cleanup errors must not escape startup. */
    }
    // The reason stays with the refusal for the operator (evidence.ts); it
    // never becomes the message, which says whose part refused.
    throw policyStartupFailure(error);
  }
}

/** Explicit trusted module loading; never imported into public App payloads. */
export async function loadAppPolicyDeployment<Request>(
  options: Omit<AppPolicyDeploymentOptions<Request>, 'policy'> & { file: string },
): Promise<AppPolicyDeployment<Request>> {
  try {
    const app = freeze(snapshotScopedData(options.app));
    const file = options.file;
    const acquire = options.acquire;
    const verifySession = options.verifySession;
    const publicPlacement = options.publicPlacement;
    const placements = capturePlacements(options.placements);
    const commands = options.commands && {
      registry: defineCommands(options.commands.registry),
      writableConnection: options.commands.writableConnection,
      ...(options.commands.events ? { events: options.commands.events } : {}),
    };
    const services = options.services && new Map(options.services);
    const policy = await loadAppRowPolicy(file);
    return await createAppPolicyDeployment({ app, policy, acquire, verifySession, commands, publicPlacement, placements, services });
  } catch (error) {
    throw policyStartupFailure(error);
  }
}

const placementIdentifier = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 && value === value.trim() && !/\p{Cc}/u.test(value);

function capturePlacements(input: AppPolicyPlacementOptions | undefined): AppPolicyPlacementOptions | undefined {
  if (input === undefined) return undefined;
  if (!placementIdentifier(input.epoch) || !placementIdentifier(input.policyRevision)) throw new AppRowPolicyDefinitionError();
  const sourceIdentities = new Map<string, string>(Map.prototype.entries.call(input.sourceIdentities));
  const identities = new Set<string>();
  for (const [source, identity] of sourceIdentities) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(source) || !placementIdentifier(identity) || identities.has(identity))
      throw new AppRowPolicyDefinitionError();
    identities.add(identity);
  }
  const issuer = Object.freeze({
    issue: input.issuer.issue.bind(input.issuer),
    verifyExecution: input.issuer.verifyExecution.bind(input.issuer),
    verifyRecovery: input.issuer.verifyRecovery.bind(input.issuer),
  });
  const acquireReceiptSources = input.acquireReceiptSources;
  if (acquireReceiptSources !== undefined && typeof acquireReceiptSources !== 'function') throw new AppRowPolicyDefinitionError();
  return Object.freeze({ issuer, sourceIdentities, epoch: input.epoch, policyRevision: input.policyRevision, acquireReceiptSources });
}
