import type { IncomingMessage } from 'node:http';
import type { CommandJournalAppScope } from '../../adapters/commands/commandJournalTypes.js';
import { compileAppTransitions, type AppTransitionRules } from '../app/appTransitions.js';
import { compileAppStamps, type AppStamps } from '../app/appStamps.js';
import { lookupPerson } from '../app/appMe.js';
import { isDeepStrictEqual } from 'node:util';
import type { Adapter } from '@mistriwork/engine/adapters/adapter.js';
import { snapshotScopedData } from '@mistriwork/engine/adapters/scoped/scopedReads.js';
import { defaultSourceOf, isRowPolicyApp, rowPolicyAppShape, type AppDef } from '../../shared/app.js';
import { appUsesCommands } from '../../shared/appCommandIds.js';
import { findTable, primaryKey, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { AppAccessDenied, type ResourceAccess } from '../app/appAccess.js';
import type { AppPolicyContext } from './appPolicyContext.js';
import { loadAppPolicyDeployment, type AppPolicyDeployment } from './appPolicyDeployment.js';
import { acquireAppPolicyResources } from './appPolicyResources.js';
import { AppRowPolicyDefinitionError } from './appRowPolicy.js';
import type { Identity } from '../auth/auth.js';
import type { Registry } from '@mistriwork/engine/server/connections.js';
import { defineCommands, type BusinessCommandRegistry } from '../commands/businessCommands.js';
import { appSourceConnections, type RuntimeResources } from '../app/appRuntimeResources.js';
import { indexerFor } from '../app/appSearchRuntime.js';
import { createHttpPolicyUpdates } from './appPolicyUpdates.js';
import { readRecords } from '@mistriwork/engine/server/resourceReadOperations.js';
import { getTenantHostIntent } from '../http/tenantHosts.js';
import type { CompiledComponents } from '../app/appComponents.js';
import { captureHttpPublicPlacement, createHttpPublicPlacement, type HttpPublicPlacementOptions } from '../http/publicPlacement.js';

/** Unsupported operations are refused by the route allowlist, never bound to
 * an ordinary writer. Generic grants and command grants remain independent. */
export function assertHttpRowPolicyApp(app: AppDef, commands = false): void {
  if (!isRowPolicyApp(app) || !rowPolicyAppShape(app) || (!commands && appUsesCommands(app))) {
    throw new AppRowPolicyDefinitionError();
  }
}

export interface HttpAppPolicy {
  readonly appId: string;
  readonly commands?: BusinessCommandRegistry;
  readonly updates: ReturnType<typeof createHttpPolicyUpdates>;
  writableTables(context: AppPolicyContext): string[];
  /** The fixed actions this principal runs without write, by table and label, where the table's source is writable. */
  grantedActions(context: AppPolicyContext): Record<string, string[]>;
  matches(app: AppDef): boolean;
  withContext: AppPolicyDeployment<IncomingMessage>['withContext'];
  withPublicContext: AppPolicyDeployment<IncomingMessage>['withPublicContext'];
  /** The jobs principals the policy admits (its `services`), and one attempt of one of them. */
  readonly services: readonly string[];
  withService: AppPolicyDeployment<IncomingMessage>['withService'];
  /** A notice's recipient, read for in the rows the policy gives their account (email/outbox.ts). */
  withAccount: AppPolicyDeployment<IncomingMessage>['withAccount'];
  submitPublicForm?: AppPolicyDeployment<IncomingMessage>['submitPublicForm'];
  /** After a committed scoped write, the record's search document follows it,
   * as it does after any other write (dataWriteRoutes.ts `recordedWrites`). */
  indexed(table: string, key: Record<string, unknown>): void;
  /** Suite interception before sessions; also supplies immutable first-paint metadata. */
  publicPlacement?: ReturnType<typeof createHttpPublicPlacement>;
  retire(): Promise<void>;
}

/** Server-owned deployment; the module filename and source bindings never
 * enter the public App payload. Changing the App requires retirement/restart. */
export async function loadHttpAppPolicy(options: {
  app: AppDef;
  registry: Registry;
  file: string;
  verifySession: (request: IncomingMessage) => Promise<Identity | null>;
  commands?: BusinessCommandRegistry;
  publicPlacement?: HttpPublicPlacementOptions;
  /** The App's compiled components as now loaded, for a placed form's page to draw its input components. */
  components?: () => CompiledComponents | undefined;
  /** The jobs module's principals and their roles, when the App runs jobs beside its policy. */
  services?: ReadonlyMap<string, readonly string[]>;
  /** The App's issued event source (commandHost.ts), when its commands declare events. */
  events?: CommandJournalAppScope;
}): Promise<HttpAppPolicy> {
  const app = snapshotScopedData(options.app);
  const liveApp = options.app;
  const commands = options.commands === undefined ? undefined : defineCommands(options.commands);
  assertHttpRowPolicyApp(app, commands !== undefined);
  const registry = options.registry;
  const placementConfig = options.publicPlacement && captureHttpPublicPlacement(options.publicPlacement);
  const bindings = appSourceConnections(registry, app);
  const writable = (source: string) => registry.configOf(bindings.get(source) ?? '')?.writable === true;
  /* Where a table's rows are, from the resources the deployment acquired: the
     search index re-reads a written record there, under its own authority. */
  let mapping: Pick<RuntimeResources, 'connectionFor' | 'toPhysical'> | undefined;
  const deployed = await loadAppPolicyDeployment({
    app,
    file: options.file,
    placements: placementConfig,
    verifySession: options.verifySession,
    publicPlacement: (request) => {
      const intent = getTenantHostIntent(request);
      return intent ? { appId: intent.app, tenant: intent.tenant } : null;
    },
    acquire: async (captured) => {
      const acquired = await acquireAppPolicyResources(registry, captured);
      mapping = acquired.resources;
      return acquired;
    },
    ...(commands
      ? {
          commands: {
            registry: commands,
            writableConnection: (owner) => registry.configOf(owner)?.writable === true,
            ...(options.events ? { events: options.events } : {}),
          },
        }
      : {}),
    ...(options.services ? { services: options.services } : {}),
  });
  const defaultSource = defaultSourceOf(app);
  // A row-policy App grants by role, so its resource names are exact table ids.
  const deleting = new Set(
    Object.entries(app.resources ?? {})
      .filter(([, resource]) => resource.delete)
      .map(([name]) => name),
  );
  // Resolved once per catalog: a declared transition is judged on each update and insert.
  const transitionRules = new WeakMap<DatabaseSchema, AppTransitionRules | undefined>();
  const transitions = (schema: DatabaseSchema) => {
    if (!transitionRules.has(schema)) transitionRules.set(schema, compileAppTransitions(schema, app));
    return transitionRules.get(schema);
  };
  const stampRules = new WeakMap<DatabaseSchema, AppStamps | undefined>();
  const stamps = (schema: DatabaseSchema) => {
    if (!stampRules.has(schema)) stampRules.set(schema, compileAppStamps(schema, app));
    return stampRules.get(schema);
  };
  const updates = createHttpPolicyUpdates(
    defaultSource,
    writable,
    (table) => deleting.has(table),
    transitions,
    stamps,
    (schema, who, reader) => lookupPerson(app, schema, who, reader),
  );
  let retired = false;
  let retirement: Promise<void> | undefined;
  const publicPlacement =
    placementConfig &&
    createHttpPublicPlacement({
      app,
      config: placementConfig,
      deployment: deployed,
      ...(options.components ? { components: options.components } : {}),
      current: () => {
        try {
          return !retired && isDeepStrictEqual(app, snapshotScopedData(liveApp));
        } catch {
          return false;
        }
      },
    });
  return Object.freeze({
    appId: app.id,
    updates,
    writableTables: (context: AppPolicyContext) =>
      Object.keys(context.writeFields).filter(
        (table) => context.writeFields[table].length && writable(table.includes('.') ? table.split('.')[0] : (defaultSource ?? '')),
      ),
    grantedActions: (context: AppPolicyContext) =>
      Object.fromEntries(
        [...(context.actions ?? [])]
          .filter(([table]) => writable(table.includes('.') ? table.split('.')[0] : (defaultSource ?? '')))
          .map(([table, actions]) => [table, actions.map((action) => action.id)]),
      ),
    ...(commands ? { commands } : {}),
    indexed: (table: string, key: Record<string, unknown>) => {
      if (mapping)
        indexerFor(registry).touched(
          app,
          { connection: mapping.connectionFor(table), resource: table, physical: mapping.toPhysical(table) },
          key,
        );
    },
    matches: (candidate: AppDef) => {
      try {
        return !retired && isDeepStrictEqual(app, snapshotScopedData(candidate));
      } catch {
        return false;
      }
    },
    withContext: deployed.withContext,
    withPublicContext: deployed.withPublicContext,
    services: deployed.services,
    withService: deployed.withService,
    withAccount: deployed.withAccount,
    ...(deployed.submitPublicForm ? { submitPublicForm: deployed.submitPublicForm } : {}),
    ...(publicPlacement ? { publicPlacement } : {}),
    retire: () => {
      retired = true;
      return (retirement ??= deployed.retire());
    },
  });
}

const readPosts = new Set([
  '/api/query',
  '/api/run',
  '/api/breakdown',
  '/api/breakdowns',
  '/api/view/run',
  '/api/pages/plan',
  '/api/pages/compose',
  '/api/pages/load',
  '/api/count',
  '/api/counts',
  '/api/references',
  '/api/record-history',
  '/api/record-activity',
  '/api/record-flows',
  /* A decision's suggestions on a record (http/decisionRoutes.ts): each reads the record through this facade first, so
     a record or field the reader cannot see has none. Settling writes only the decision store's own row, after that
     read, never the record: Accept and Change run the answer command through the command routes. */
  '/api/record-decisions',
  '/api/record-decisions/marks',
  '/api/record-decisions/why',
  '/api/record-decisions/settle',
  '/api/inbox',
  '/api/inbox/read',
]);
const readGets = new Set([
  '/api/runtime',
  '/api/whoami',
  '/api/schema',
  '/api/app',
  '/api/views',
  '/api/pages',
  '/api/pages/relations',
  '/api/pages/suggested',
  '/api/layouts',
  '/api/pages/saved',
  '/api/filters',
  '/api/file',
  /* Live sync's stream: its authority is this context's, its probes reads in contexts of their own (live/liveRoute.ts). */
  '/api/live',
]);

/** An allowlist makes new HTTP routes opt in to the policy review, not out. */
export function httpRowPolicyAllows(method: string | undefined, path: string, commands = false): boolean {
  return method === 'POST'
    ? readPosts.has(path) ||
        ['/api/update', '/api/insert', '/api/file/upload', '/api/delete', '/api/revert', '/api/import'].includes(path) ||
        (commands &&
          ['/api/commands/prepare', '/api/commands/execute', '/api/commands/status', '/api/commands/availability'].includes(path))
    : (method === 'GET' || method === 'HEAD') && readGets.has(path);
}

/** The existing read handlers receive only the verified, expiring read facade.
 * No raw SQL, writer, physical source adapter or estimated global count exists. */
export function httpPolicyReads(context: AppPolicyContext): { adapter: Adapter; access: ResourceAccess } {
  const data = context.data;
  return {
    adapter: Object.freeze({
      dialect: context.schema.dialect,
      introspect: async () => context.schema,
      close: async () => {
        throw new AppAccessDenied();
      },
      query: data.query,
      count: data.count,
      runView: data.runView,
      countView: data.countView,
      runBreakdown: data.runBreakdown,
      countBreakdown: data.countBreakdown,
    }),
    access: {
      readable: new Set(context.schema.tables.map((table) => table.id)),
      writable: new Set<string>(),
      fields: new Map(
        context.schema.tables.map((table) => [
          table.id,
          { read: new Set(table.columns.map((column) => column.name)), write: new Set<string>() },
        ]),
      ),
      // What the App payload keeps drawn: nothing here writes (this facade has no writer).
      ...(context.actions ? { actions: context.actions } : {}),
    },
  };
}

/** Exact-root validation is shared by the admission-only read and by callers
 * that need the admitted row. It deliberately permits neither alternate keys
 * nor an extra caller-supplied condition. */
function policyRecordRequest(schema: DatabaseSchema, tableId: string, key: unknown) {
  const table = findTable(schema, tableId);
  const columns = table && primaryKey(table);
  if (!columns?.length || !key || typeof key !== 'object' || Array.isArray(key)) throw new AppAccessDenied();
  const values = key as Record<string, unknown>;
  if (
    Object.keys(values).length !== columns.length ||
    columns.some(
      (column) =>
        !Object.hasOwn(values, column) ||
        !(typeof values[column] === 'string' || (typeof values[column] === 'number' && Number.isFinite(values[column]))),
    )
  ) {
    throw new AppAccessDenied();
  }
  return {
    table: tableId,
    columns,
    filter: { groups: [columns.map((column) => ({ column, op: '=' as const, value: values[column] as string | number }))] },
  };
}

/** Related-record endpoints must authorize their root as well as each child
 * query. A visible child alone does not authorize a guessed parent record. */
export async function requireHttpPolicyRecord(adapter: Adapter, schema: DatabaseSchema, tableId: string, key: unknown): Promise<void> {
  const request = policyRecordRequest(schema, tableId, key);
  const result = await adapter.query({ ...request, limit: 1, offset: 0 });
  if (!result.rows.length) throw new AppAccessDenied();
}

/** Read an exact, policy-admitted root once when its values are needed for a
 * related operation. The projection remains schema- and facade-validated by
 * readRecords; a missing or hidden row stays an opaque access refusal. */
export async function readHttpPolicyRecord(
  adapter: Adapter,
  schema: DatabaseSchema,
  tableId: string,
  key: unknown,
  wanted: readonly string[],
): Promise<Record<string, unknown>> {
  const request = policyRecordRequest(schema, tableId, key);
  const { result } = await readRecords(adapter, schema, {
    ...request,
    columns: [...new Set([...request.columns, ...wanted])],
    limit: 1,
    offset: 0,
  });
  if (result.rows.length !== 1) throw new AppAccessDenied();
  return result.rows[0];
}
