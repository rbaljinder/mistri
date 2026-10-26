/** Private deployment capability: a host selects an intent, policy admits its
 * rows, and the pinned writer locks eligibility through the receipt commit. */
import { isPromise } from 'node:util/types';
import type { CaptureCommandFlags } from '../commands/commandFlags.js';
import { TransactionOperations, type Adapter, type WriteTransaction } from '@mistriwork/engine/adapters/adapter.js';
import type { CommandJournal } from '../../adapters/commands/commandJournalTypes.js';
import type { PublicPlacementOwner } from '../../adapters/commands/publicPlacementTypes.js';
import { capturePublicPlacementAdmission } from '../../adapters/commands/publicPlacementTransaction.js';
import { snapshotScopedData } from '@mistriwork/engine/adapters/scoped/scopedReads.js';
import { isPublicForm, isRowPolicyApp, logicalResource, type AppDef } from '../../shared/app.js';
import { snapshotRowScope } from '@mistriwork/engine/shared/rowScope.js';
import { assertScopeCatalog, captureScopeCatalog, mapScopeCatalog } from '@mistriwork/engine/shared/scopeCatalog.js';
import { AppAccessDenied, authorizeTransaction } from '../app/appAccess.js';
import type { RuntimeResources } from '../app/appRuntimeResources.js';
import { compileAppDefinitionValidation } from '../app/appValidation.js';
import type { AuthorizedBusinessCommand, BusinessCommandBinding } from '../commands/businessCommandAccess.js';
import { createBusinessCommandAuthorizer } from '../commands/businessCommandAuthorization.js';
import { executeBusinessCommand, BusinessCommandExecutionError } from '../commands/businessCommandExecution.js';
import { validateBusinessCommandReferences } from '../commands/businessCommandLoader.js';
import { defineCommands, getCommandEvents, type BusinessCommandRegistry } from '../commands/businessCommands.js';
import { parseSubmission, publicPrincipal } from '../commands/formHttp.js';
import { CommandInputError } from '../commands/commandPayload.js';
import { captureTenantData, recordRefusalCause } from '@mistriwork/engine/server/evidence.js';
import { PublicPlacementBindingError, type createPublicPlacementBindingIssuer } from '../forms/publicPlacementBinding.js';
import { normalizeSuitePublicOrigin } from '../http/tenantHosts.js';
import { AppRowPolicyDefinitionError, defineAppRowPolicy, type AppRowPolicy, type PublicFormAdmission } from './appRowPolicy.js';
import type { PolicyReadContext } from './policyDb.js';
import { commandsOf } from '../stores/commandStores.js';

type BindingIssuer = ReturnType<typeof createPublicPlacementBindingIssuer>;
type ReceiptSource = Pick<Adapter, 'publicPlacementReceipt'>;

/** Supplied only by the private request owner, from the real-Host WeakMap and
 * captured operator origin. Never construct this from a submission body. */
export interface TrustedPublicPlacementSelection {
  readonly appId: string;
  readonly tenant: string;
  readonly host: string;
  readonly origin: string;
}

interface RecoveryOptions {
  appId: string;
  form: string;
  issuer: BindingIssuer;
  /** Exact stable identity -> retained physical receipt reader. No alias fallback.
   * The deployment owns these sources' leases until retire() drains. */
  receiptSources: ReadonlyMap<string, ReceiptSource>;
}

export interface PolicyPublicPlacementOptions {
  captureFlags?: (
    actor: Parameters<CaptureCommandFlags>[0],
    placement: { tenantId: string },
    assertCurrent: () => void,
  ) => ReturnType<CaptureCommandFlags>;
  app: AppDef;
  policy: AppRowPolicy;
  resources: RuntimeResources;
  registry: BusinessCommandRegistry;
  form: string;
  sourceConnections: ReadonlyMap<string, string>;
  /** Mandatory operator pin for the captured execution source, not its alias. */
  sourceIdentity: string;
  epoch: string;
  formRevision: string;
  issuer: BindingIssuer;
  policyContext: PolicyReadContext;
  writableConnection: (connection: string) => boolean;
  /** Retained owners in addition to the current execution source. */
  receiptSources?: ReadonlyMap<string, ReceiptSource>;
}

function deny(): never {
  throw new AppAccessDenied();
}
function unavailable(): never {
  throw new BusinessCommandExecutionError('temporarily_unavailable', 'unknown');
}
const identifier = (value: unknown, max = 256): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && value === value.trim() && !/\p{Cc}/u.test(value);

/** Proxy refusal precedes traversal; the scoped snapshot also applies the
 * smaller operation bounds. Capture synchronously, before any promise hop. */
const capture = <T>(value: T): T => captureTenantData(snapshotScopedData(captureTenantData(value)));
function record(value: unknown, fields: readonly string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(value, field))
  )
    deny();
}

/** Stop admissions synchronously; accepted operations retain their source lease
 * through driver settlement. The owner activates a replacement only after drain. */
function lifetime() {
  let retired = false,
    retirement: Promise<void> | undefined;
  const pending = new Set<Promise<unknown>>();
  const active = () => {
    if (retired) unavailable();
  };
  return {
    active,
    run<T>(work: () => T | Promise<T>): Promise<T> {
      try {
        active();
      } catch (error) {
        return Promise.reject(error);
      }
      const operation = Promise.resolve().then(() => {
        active();
        return work();
      });
      pending.add(operation);
      void operation.then(
        () => pending.delete(operation),
        () => pending.delete(operation),
      );
      return operation;
    },
    retire(): Promise<void> {
      retired = true;
      return (retirement ??= Promise.allSettled([...pending]).then(() => {}));
    },
  };
}

function publicResult(result: unknown, id: unknown, outcome: 'not_applied' | 'unknown' = 'unknown') {
  const reference =
    result && typeof result === 'object' && !Array.isArray(result)
      ? Object.getOwnPropertyDescriptor(result, 'reference')?.value
      : undefined;
  if (
    typeof reference !== 'string' ||
    !reference.trim() ||
    reference.length > 64 ||
    typeof id !== 'string' ||
    !id.trim() ||
    id.length > 128
  ) {
    throw new BusinessCommandExecutionError('invalid_result', outcome);
  }
  return Object.freeze({ reference, receipt: Object.freeze({ id, status: 'applied' as const }) });
}

/** Independent of command handlers, current command versions and eligibility.
 * A decommissioned execution form can retain this receipt-only capability. */
export function bindPolicyPublicPlacementRecovery(options: RecoveryOptions) {
  const { appId, form } = options;
  if (!identifier(appId) || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(form)) deny();
  const verify = options.issuer.verifyRecovery.bind(options.issuer);
  const sources = new Map<string, NonNullable<Adapter['publicPlacementReceipt']>>();
  for (const [identity, source] of new Map<string, ReceiptSource>(Map.prototype.entries.call(options.receiptSources))) {
    const receipt = commandsOf(source).publicPlacementReceipt;
    if (!identifier(identity) || typeof receipt !== 'function') deny();
    sources.set(identity, receipt.bind(source));
  }
  const lease = lifetime();
  return Object.freeze({
    recover(binding: unknown, submission: unknown) {
      // Authenticate before selecting an owner; claims never select an alias.
      return lease.run(async () => {
        const claims = verify(binding, submission, { appId, form });
        const reader = sources.get(claims.sourceIdentity) ?? unavailable();
        const owner: PublicPlacementOwner = Object.freeze({
          issuerId: claims.issuerId,
          sourceIdentity: claims.sourceIdentity,
          appId: claims.appId,
          form: claims.form,
          tenant: claims.tenant,
          commandId: claims.commandId,
          commandVersion: claims.commandVersion,
        });
        let receipt;
        try {
          receipt = await reader(owner, claims.submission);
        } catch (error) {
          throw recordRefusalCause(new BusinessCommandExecutionError('temporarily_unavailable', 'unknown'), error);
        }
        lease.active();
        if (!receipt) return Object.freeze({ status: 'not_found' as const });
        try {
          return publicResult(capture(JSON.parse(receipt.resultJson)), receipt.id);
        } catch (error) {
          throw recordRefusalCause(new BusinessCommandExecutionError('invalid_result', 'unknown'), error);
        }
      });
    },
    retire: lease.retire,
  });
}

/** Internal only. Own all resources and retained receipt-source leases until
 * retire settles. This factory never installs a route or reads a request. */
export function bindPolicyPublicPlacement(options: PolicyPublicPlacementOptions) {
  try {
    return bind(options);
  } catch (error) {
    throw recordRefusalCause(new AppRowPolicyDefinitionError(), error);
  }
}

function bind(options: PolicyPublicPlacementOptions) {
  const captureFlags = options.captureFlags;
  const app = capture(options.app),
    policy = defineAppRowPolicy(options.policy);
  const schema = captureScopeCatalog(options.resources.schema),
    registry = defineCommands(options.registry);
  const key = options.form,
    form = app.views[key],
    definition = policy.publicForms?.[key];
  const { sourceIdentity, epoch, formRevision } = options;
  if (
    !isRowPolicyApp(app) ||
    app.id !== policy.appId ||
    !isPublicForm(form) ||
    form.save ||
    !definition ||
    !('kind' in definition) ||
    definition.kind !== 'placement' ||
    !policy.resolvePublicRows ||
    !identifier(sourceIdentity) ||
    !identifier(epoch) ||
    !identifier(formRevision)
  )
    deny();
  const resolver = definition.resolvePlacement,
    extractor = definition.resultReferences;
  const policyContext = Object.freeze({ db: options.policyContext.db });
  const issue = options.issuer.issue.bind(options.issuer),
    verify = options.issuer.verifyExecution.bind(options.issuer);
  const writable = options.writableConnection;
  if (typeof writable !== 'function') deny();
  validateBusinessCommandReferences(app, registry, options.resources);
  const command = registry[form.command.id];
  if (
    !command ||
    command.source !== definition.source ||
    command.public !== true ||
    command.targets !== 'none' ||
    command.sources !== undefined ||
    command.lookup !== undefined ||
    command.realm !== undefined ||
    getCommandEvents(command) !== undefined ||
    !app.sources?.[definition.source] ||
    app.sources[definition.source].realm !== undefined
  )
    deny();
  const connections = new Map<string, string>(Map.prototype.entries.call(options.sourceConnections));
  const owner = connections.get(definition.source) ?? deny();
  const owners = new Map(schema.tables.map((table) => [table.id, options.resources.connectionFor(table.id)]));
  if (owners.get(logicalResource(app, command.source, command.target)) !== owner || writable(owner) !== true) deny();
  const source = options.resources.forConnection(owner);
  const commands = commandsOf(source);
  if (!commands.publicPlacementCommandTransaction || !commands.publicPlacementReceipt) deny();
  const transact = commands.publicPlacementCommandTransaction.bind(source);
  const owned = new Map(schema.tables.filter((table) => owners.get(table.id) === owner).map((table) => [table.id, table.id]));
  const expected = mapScopeCatalog({ ...schema, dialect: source.dialect }, owned);
  const enrolled = new Set(
    [...owned.keys()].filter(
      (id) => Object.hasOwn(app.resources ?? {}, id) && logicalResource(app, definition.source, id.slice(id.indexOf('.') + 1)) === id,
    ),
  );
  const authorizer = createBusinessCommandAuthorizer({
    app,
    registry,
    schema,
    connectionFor: (table) => owners.get(table) ?? deny(),
    writableConnection: writable,
    transactionalConnection: (connection) => connection === owner,
  });
  const actor = publicPrincipal(app.id, key),
    authorized = authorizer.authorize(form.command.id, actor);
  const read = new Set(authorized.read),
    write = new Set(authorized.write);
  if ([...read, ...write].some((table) => !enrolled.has(table))) deny();
  const validation = compileAppDefinitionValidation(schema, app);
  const receiptSources = new Map<string, ReceiptSource>(options.receiptSources ? Map.prototype.entries.call(options.receiptSources) : []);
  // Duplicate identities cannot redirect the current pin to a different reader.
  if (receiptSources.has(sourceIdentity) && receiptSources.get(sourceIdentity) !== source) deny();
  receiptSources.set(sourceIdentity, source);
  const recovery = bindPolicyPublicPlacementRecovery({ appId: app.id, form: key, issuer: options.issuer, receiptSources });
  const lease = lifetime();
  const active = () => {
    lease.active();
    if (writable(owner) !== true) deny();
  };
  const selection = (input: TrustedPublicPlacementSelection) => {
    try {
      const value = capture(input);
      record(value, ['appId', 'tenant', 'host', 'origin']);
      if (
        value.appId !== app.id ||
        !identifier(value.tenant, 1024) ||
        !identifier(value.host) ||
        normalizeSuitePublicOrigin(value.origin) !== value.origin ||
        new URL(value.origin).hostname !== value.host
      )
        deny();
      return Object.freeze({
        appId: app.id,
        form: key,
        commandId: form.command.id,
        commandVersion: form.command.version,
        sourceIdentity,
        epoch,
        formRevision,
        tenant: value.tenant,
        host: value.host,
        origin: value.origin,
      });
    } catch {
      throw new PublicPlacementBindingError();
    }
  };
  const resolve = (tenant: string): PublicFormAdmission | Promise<PublicFormAdmission> => {
    active();
    const snapshot = (input: PublicFormAdmission): PublicFormAdmission => {
      const value = capture(input);
      record(value, ['rows', 'anchors']);
      const rows = snapshotRowScope(schema, value.rows);
      if (!Array.isArray(value.anchors) || !value.anchors.length || value.anchors.length > 8) deny();
      const anchors = value.anchors;
      const anchorTables = new Set<string>();
      for (const anchor of anchors) {
        record(anchor, ['table', 'key', 'expected']);
        if (
          typeof anchor.table !== 'string' ||
          !enrolled.has(anchor.table) ||
          !Object.hasOwn(rows, anchor.table) ||
          rows[anchor.table] === false
        )
          deny();
        for (const [name, values] of [
          ['key', anchor.key],
          ['expected', anchor.expected],
        ] as const) {
          if (
            !values ||
            typeof values !== 'object' ||
            Array.isArray(values) ||
            !Object.keys(values).length ||
            Object.keys(values).length > 128
          )
            deny();
          for (const [column, scalar] of Object.entries(values)) {
            if (
              !identifier(column) ||
              !(
                (typeof scalar === 'string' && Buffer.byteLength(scalar) <= 8192) ||
                (typeof scalar === 'number' && Number.isFinite(scalar)) ||
                (name === 'expected' && (scalar === null || typeof scalar === 'boolean'))
              )
            )
              deny();
          }
        }
        anchorTables.add(anchor.table);
      }
      if (
        Object.keys(rows).some((table) => !enrolled.has(table) || (!read.has(table) && !anchorTables.has(table))) ||
        [...write].some((table) => !Object.hasOwn(rows, table) || rows[table] === false)
      )
        deny();
      active();
      return Object.freeze({
        rows: Object.freeze(Object.fromEntries([...owned.keys()].map((table) => [table, rows[table] ?? false]))),
        anchors,
      });
    };
    // A synchronous resolver is captured before its queued mutation can run;
    // only a native promise is awaited. Custom thenables are never assimilated.
    const result = resolver(Object.freeze({ appId: app.id, tenant }), policyContext);
    if (!isPromise(result)) return snapshot(result);
    return new Promise<PublicFormAdmission>((accept, reject) => {
      void Promise.prototype.then.call(
        result,
        (value) => {
          try {
            accept(snapshot(value));
          } catch (error) {
            reject(error);
          }
        },
        reject,
      );
    });
  };
  const bindingFor = (admission: ReturnType<typeof capturePublicPlacementAdmission>, rows: PublicFormAdmission['rows']) =>
    Object.freeze<BusinessCommandBinding>({
      scoped: true,
      authorize(id, principal) {
        active();
        if (id !== form.command.id || principal !== actor) deny();
        const checks = new WeakMap<
          WriteTransaction,
          {
            target(key: Readonly<Record<string, string | number>>): Promise<void>;
            result(key: Readonly<Record<string, string | number>>, result: unknown): Promise<void>;
          }
        >();
        return Object.freeze<AuthorizedBusinessCommand>({
          command,
          actor,
          resource: authorized.resource,
          placement: Object.freeze({ tenantId: admission.tenant }),
          keyColumns: authorized.keyColumns,
          ...(authorized.versionField ? { versionField: authorized.versionField } : {}),
          catalog: authorized.catalog,
          ...(authorized.machine ? { machine: authorized.machine } : {}),
          ...(authorized.files ? { files: authorized.files } : {}),
          transaction: deny,
          assertTarget: (records, key) => checks.get(records)?.target(key) ?? deny(),
          assertResult: (records, key, result) => checks.get(records)?.result(key, result) ?? deny(),
          commandTransaction: (run) => {
            active();
            return transact(rows, admission, async (raw, journal, evidence) => {
              active();
              assertScopeCatalog(expected, evidence);
              const tx = authorizeTransaction(schema, { readable: read, writable: write, validation }, raw);
              const operations = new TransactionOperations();
              const accept = <A, R>(input: A, work: (snapshot: A) => Promise<R>): Promise<R> => {
                let snapshot: A;
                try {
                  snapshot = capture(input);
                } catch (error) {
                  return operations.run(async () => {
                    throw error;
                  });
                }
                return operations.run(async () => {
                  active();
                  const result = await work(snapshot);
                  active();
                  return result;
                });
              };
              const records = Object.freeze<WriteTransaction>({
                query: (request) => accept(request, (request) => tx.query({ ...request, table: authorized.table(request.table) })),
                count: (table, filter) => accept({ table, filter }, (request) => tx.count(authorized.table(request.table), request.filter)),
                insert: (request) => accept(request, (request) => tx.insert({ ...request, table: authorized.table(request.table, true) })),
                update: (request) => accept(request, deny),
                remove: (request) => accept(request, deny),
              });
              const runtimeJournal = Object.freeze<CommandJournal>({
                find: (scope, manifest) => accept({ scope, manifest }, (value) => journal.find(value.scope, value.manifest)),
                commit: (receipt, audit, events) =>
                  accept({ receipt, audit, events }, (value) => journal.commit(value.receipt, value.audit, value.events)),
                ...(journal.nextNumber
                  ? {
                      nextNumber: (appId: string, name: string, per: string, start: number) =>
                        accept({ appId, name, per, start }, (value) =>
                          journal.nextNumber!(value.appId, value.name, value.per, value.start),
                        ),
                    }
                  : {}),
              });
              const emptyKey = (key: Readonly<Record<string, string | number>>) => {
                if (Object.keys(key).length) deny();
              };
              checks.set(records, {
                target: (key) =>
                  accept(key, async (key) => {
                    emptyKey(key);
                  }),
                result: (key, result) =>
                  accept({ key, result }, async (value) => {
                    emptyKey(value.key);
                    const refs: unknown = extractor(value.result);
                    if (isPromise(refs)) {
                      void Promise.prototype.then.call(refs, undefined, () => {});
                      deny();
                    }
                    const captured = capture(refs);
                    if (!Array.isArray(captured) || captured.length) deny();
                    publicResult(value.result, 'pending', 'not_applied');
                  }),
              });
              try {
                const result = await run(records, runtimeJournal);
                await operations.finish();
                active();
                return result;
              } catch (error) {
                await operations.finish().catch(() => {});
                throw error;
              }
            });
          },
        });
      },
    });
  let retirement: Promise<void> | undefined;
  return Object.freeze({
    prepare(trustedHostSelection: TrustedPublicPlacementSelection) {
      let scope: ReturnType<typeof selection>;
      try {
        active();
        scope = selection(trustedHostSelection);
      } catch (error) {
        return Promise.reject(error);
      }
      return lease.run(async () => {
        try {
          await resolve(scope.tenant);
        } catch (error) {
          active();
          throw recordRefusalCause(new BusinessCommandExecutionError('forbidden', 'unknown'), error);
        }
        active();
        const placement = issue(scope);
        active();
        return placement;
      });
    },
    submit(
      trustedHostSelection: TrustedPublicPlacementSelection,
      body: unknown,
      execution: { signal?: AbortSignal; requestId?: string } = {},
    ) {
      let scope: ReturnType<typeof selection>, submission: ReturnType<typeof parseSubmission>, binding: string;
      try {
        active();
        scope = selection(trustedHostSelection);
      } catch (error) {
        return Promise.reject(error);
      }
      try {
        const value = capture(body);
        record(value, ['input', 'submission', 'placement']);
        record(value.placement, ['version', 'binding']);
        if (value.placement.version !== 1 || typeof value.placement.binding !== 'string') throw new CommandInputError();
        binding = value.placement.binding;
        submission = parseSubmission({ input: value.input, submission: value.submission });
      } catch (error) {
        return Promise.reject(
          new BusinessCommandExecutionError('invalid_input', 'unknown', error instanceof CommandInputError ? error.field : undefined),
        );
      }
      const context = { signal: execution.signal, requestId: execution.requestId };
      return lease.run(async () => {
        const claims = verify(binding, submission.submission, scope);
        let resolved: PublicFormAdmission;
        try {
          resolved = await resolve(claims.tenant);
        } catch (error) {
          active();
          throw recordRefusalCause(new BusinessCommandExecutionError('forbidden', 'unknown'), error);
        }
        active();
        let admission: ReturnType<typeof capturePublicPlacementAdmission>;
        try {
          admission = capturePublicPlacementAdmission({
            issuerId: claims.issuerId,
            sourceIdentity: claims.sourceIdentity,
            appId: claims.appId,
            form: claims.form,
            tenant: claims.tenant,
            commandId: claims.commandId,
            commandVersion: claims.commandVersion,
            epoch: claims.epoch,
            anchors: resolved.anchors,
          });
        } catch (error) {
          throw recordRefusalCause(new BusinessCommandExecutionError('forbidden', 'unknown'), error);
        }
        const flags = await captureFlags?.(actor, { tenantId: admission.tenant }, active);
        active();
        const result = await executeBusinessCommand(
          bindingFor(admission, resolved.rows),
          actor,
          {
            command: form.command.id,
            commandVersion: form.command.version,
            key: {},
            expectedVersion: 0,
            idempotencyKey: submission.submission,
            input: submission.input,
          },
          { ...context, flags },
        );
        lease.active();
        return publicResult(result.result, result.receiptId);
      });
    },
    recover: recovery.recover,
    retire(): Promise<void> {
      if (retirement) return retirement;
      const drained = lease.retire(),
        receipts = recovery.retire();
      return (retirement = Promise.all([drained, receipts]).then(() => {}));
    },
  });
}
