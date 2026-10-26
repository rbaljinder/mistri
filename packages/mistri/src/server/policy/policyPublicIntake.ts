/** Binds an explicitly enrolled public form to a captured policy scope and
 * durable command executor, independently of signed-in account authority. */
import { isPromise, isProxy } from 'node:util/types';
import { TransactionOperations, type WriteTransaction } from '@mistriwork/engine/adapters/adapter.js';
import type { CommandJournal } from '../../adapters/commands/commandJournal.js';
import { snapshotScopedData } from '@mistriwork/engine/adapters/scoped/scopedReads.js';
import { isPublicForm, isRowPolicyApp, logicalResource, type AppDef } from '../../shared/app.js';
import { snapshotRowScope, type RowScope } from '@mistriwork/engine/shared/rowScope.js';
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
import type { CommandResultReference } from '../commands/scopedBusinessCommandAccess.js';
import type { CaptureCommandFlags } from '../commands/commandFlags.js';
import { commandFlagsOnce } from '../commands/commandFlagCapture.js';
import { commandsOf } from '../stores/commandStores.js';

/** Private binding for a fixed intake destination. These are deployment
 * declarations, never request fields or an extension of auth.public.
 * Dynamic routing and ownership injection require a different issuer. */
interface PolicyPublicIntakeOptions {
  app: AppDef;
  resources: RuntimeResources;
  registry: BusinessCommandRegistry;
  form: string;
  rows: RowScope;
  /** Attests the complete stored result, on first execution AND replay.
   * Only an empty list is supported: public receipts reveal no row references. */
  resultReferences: (result: unknown) => readonly CommandResultReference[];
  writableConnection: (connection: string) => boolean;
  /** Fixed public intake: no visitor identity is inferred from form or submission IDs. */
  captureFlags?: (
    actor: Parameters<CaptureCommandFlags>[0],
    placement: undefined,
    assertCurrent: () => void,
  ) => ReturnType<CaptureCommandFlags>;
}

const deny = (): never => {
  throw new AppAccessDenied();
};
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Internal only: the deployment supplies captured resources and owns their
 * leases until retire() drains. It enrolls the selected public form separately. */
export function bindPolicyPublicIntake(options: PolicyPublicIntakeOptions) {
  const app = freeze(snapshotScopedData(options.app));
  const schema = captureScopeCatalog(options.resources.schema);
  const registry = defineCommands(options.registry);
  const key = options.form;
  const form = app.views[key];
  const rows = snapshotRowScope(schema, options.rows);
  const extractor = options.resultReferences;
  const writable = options.writableConnection;
  const descriptor = Object.getOwnPropertyDescriptor(options, 'captureFlags');
  if (
    descriptor &&
    (!descriptor.enumerable || !('value' in descriptor) || typeof descriptor.value !== 'function' || isProxy(descriptor.value))
  )
    return deny();
  const captureFlags = descriptor?.value as PolicyPublicIntakeOptions['captureFlags'];
  if (!isRowPolicyApp(app) || !isPublicForm(form) || typeof extractor !== 'function' || typeof writable !== 'function') return deny();
  validateBusinessCommandReferences(app, registry, options.resources);
  const command = registry[form.command.id];
  if (
    !command ||
    command.public !== true ||
    command.targets !== 'none' ||
    command.sources !== undefined ||
    command.lookup !== undefined ||
    command.realm !== undefined ||
    getCommandEvents(command) !== undefined
  )
    deny();
  const owners = new Map(schema.tables.map((table) => [table.id, options.resources.connectionFor(table.id)]));
  const owner = owners.get(logicalResource(app, command.source, command.target)) ?? deny();
  const source = options.resources.forConnection(owner);
  const scoped = commandsOf(source).scopeCommandTransaction;
  if (!scoped) return deny();
  const transact = scoped.bind(source);
  const owned = new Map(schema.tables.filter((table) => owners.get(table.id) === owner).map((table) => [table.id, table.id]));
  const expected = mapScopeCatalog({ ...schema, dialect: source.dialect }, owned);
  const authorizer = createBusinessCommandAuthorizer({
    app,
    registry,
    schema,
    connectionFor: (table) => owners.get(table) ?? deny(),
    writableConnection: writable,
    transactionalConnection: (connection) =>
      connection === owner || !!commandsOf(options.resources.forConnection(connection)).scopeCommandTransaction,
  });
  const actor = publicPrincipal(app.id, key);
  const authorized = authorizer.authorize(form.command.id, actor);
  const read = new Set(authorized.read),
    write = new Set(authorized.write);
  // Refuse unused declarations instead of silently accepting an accidental
  // grant on another source or beyond this command's footprint.
  if (
    Object.keys(rows).some((table) => !read.has(table) || owners.get(table) !== owner) ||
    [...write].some((table) => !Object.hasOwn(rows, table) || rows[table] === false)
  )
    deny();
  const policy = Object.freeze(Object.fromEntries([...owned.keys()].map((table) => [table, rows[table] ?? false])));
  const validation = compileAppDefinitionValidation(schema, app);
  let retired = false;
  let retirement: Promise<void> | undefined;
  const pending = new Set<Promise<unknown>>();
  const active = () => {
    if (retired || writable(owner) !== true) deny();
  };
  const binding = Object.freeze<BusinessCommandBinding>({
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
          return transact(policy, async (raw, journal, evidence) => {
            active();
            assertScopeCatalog(expected, evidence);
            const tx = authorizeTransaction(schema, { readable: read, writable: write, validation }, raw);
            const operations = new TransactionOperations();
            const accept = <A, R>(input: A, work: (snapshot: A) => Promise<R>): Promise<R> => {
              let snapshot: A;
              try {
                snapshot = snapshotScopedData(input);
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
              // Queue refusals too: a handler cannot catch one and commit its
              // earlier insert after attempting a forbidden mutation.
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
                      accept({ appId, name, per, start }, (value) => journal.nextNumber!(value.appId, value.name, value.per, value.start)),
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
                  const refs: unknown = extractor(freeze(value.result));
                  if (isPromise(refs)) {
                    void refs.catch(() => {});
                    deny();
                  }
                  const captured = snapshotScopedData(refs);
                  if (!Array.isArray(captured) || captured.length) deny();
                  const reference = (value.result as { reference?: unknown } | null)?.reference;
                  // Validate before the receipt commits, not after an irreversible
                  // success that the form transport cannot present.
                  if (typeof reference !== 'string' || !reference.trim() || reference.length > 64) {
                    throw new BusinessCommandExecutionError('invalid_result');
                  }
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
  return Object.freeze({
    submit(body: unknown, execution: { signal?: AbortSignal; requestId?: string } = {}) {
      if (retired) return Promise.reject(new BusinessCommandExecutionError('temporarily_unavailable'));
      let submission: ReturnType<typeof parseSubmission>;
      try {
        submission = parseSubmission(snapshotScopedData(body));
      } catch (error) {
        return Promise.reject(
          new BusinessCommandExecutionError('invalid_input', 'not_applied', error instanceof CommandInputError ? error.field : undefined),
        );
      }
      const context = { signal: execution.signal, requestId: execution.requestId };
      // Register before running trusted code so retirement cannot release the
      // source while an accepted submission still owns a transaction.
      const operation = Promise.resolve().then(async () => {
        binding.authorize(form.command.id, actor);
        const flags = await commandFlagsOnce(() => captureFlags?.(actor, undefined, active))();
        active();
        return executeBusinessCommand(
          binding,
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
  });
}
