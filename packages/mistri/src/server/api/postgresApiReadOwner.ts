/** Private PG read response composition. Holds native business snapshot and
 * native token handoff through a trusted synchronous send. No HTTP activation,
 * cookie fallback, caller principal or promise of remote delivery/atomicity. */
import { SMALL_STORE_POOL } from '@mistriwork/engine/adapters/connectionBudget.js';
import { isAsyncFunction, isGeneratorFunction, isPromise, isProxy } from 'node:util/types';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Registry } from '@mistriwork/engine/server/connections.js';
import { PostgresAdapter, isPostgresVerifiedCommandSource } from '@mistriwork/engine/adapters/postgres.js';
import type { PinnedPostgresRead, PinnedPostgresReadOwner } from '@mistriwork/engine/adapters/postgresReadCatalog.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { throwIfCancelled, withCancellation } from '@mistriwork/engine/adapters/statementControl.js';
import type { AppHost, LoadedApp } from '../app/apps.js';
import { appProblems } from '../app/apps.js';
import { captureTenantData } from '@mistriwork/engine/server/evidence.js';
import { homeSourceOf, physicalBindings, resolveAppAccess } from '../../shared/app.js';
import { appSourceConnections, loadAppRuntimeResources } from '../app/appRuntimeResources.js';
import { mapOpenedAppRuntimeResources } from '../app/appRuntimeResourceMapping.js';
import { authorizeResources } from '../app/appAccess.js';
import { acquirePostgresApiTokenObservation, captureAppAuthRuntime, type AppAuthRuntime } from '../auth/auth.js';
import { assertAppApiContext, readApiApp } from './appApiValidation.js';
import { checkApiReadCatalog } from './apiReadCatalog.js';
import { apiReadLaneConnections, apiReadLaneOf, laneResources } from './apiSourceLanes.js';
import { postgresSnapshotReads } from './postgresSnapshotReads.js';
import { createApiReadView } from './apiReadView.js';
import { createApiCursorReadView } from './apiCursorReadView.js';
import { materializeApiReadResult } from './apiReadResult.js';
import { ApiReadFailure } from './apiReadFailure.js';
import { ApiTokenStoreUnavailable } from '../auth/apiTokenStoreFailure.js';
import { renderApiReadOpenApi } from './apiReadOpenApi.js';
import { narrowApiReadOpenApi } from './apiNarrowedReadOpenApi.js';
import { previewApiMcpReadTools } from './apiMcpReadTools.js';
import { PgConnectionManager } from '@mistriwork/engine/adapters/postgresPool.js';
import type { BusinessCommandRegistry } from '../commands/businessCommands.js';
import { storeTargetOf } from '../commands/appCommandEvents.js';
import { eventFeedAudience, eventFeedSource, parseEventFeedQuery, readPostgresEventFeed } from './apiEventFeed.js';
import { renderApiAsyncApi } from './apiAsyncApi.js';

const refuse = (): never => {
  throw new ApiReadFailure('temporarily_unavailable');
};
function data(value: object, key: string): unknown {
  if (!value || typeof value !== 'object' || isProxy(value)) return refuse();
  const property = Object.getOwnPropertyDescriptor(value, key);
  if (!property) return undefined;
  if (!('value' in property)) return refuse();
  return property.value;
}
function state(host: AppHost) {
  if (data(host, 'unavailable') || data(host, 'loadError')) return refuse();
  const loaded = data(host, 'app') as LoadedApp,
    auth = data(host, 'auth') as AppAuthRuntime;
  if (!auth) return refuse();
  return { loaded, auth, app: captureTenantData(data(loaded, 'app')) as LoadedApp['app'] };
}
type Send = (response: Readonly<{ status: 200 | 404; body: string }>) => void;
const captureNativeSnapshot = PostgresAdapter.prototype.capturePinnedReadSnapshot;
const uncertain = () => Object.freeze({ stage: 'postgres-read-response' as const, outcome: 'uncertain' as const });

export async function createPostgresApiReadOwner(
  registry: Registry,
  host: AppHost,
  integers: 'number' | 'decimal-string',
  commands?: BusinessCommandRegistry,
) {
  const acquisitions: (() => void)[] = [];
  const releaseAcquisition = () => {
    for (const release of acquisitions.splice(0)) release();
  };
  /* A lane per connection an exposed operation reads, each with its own
     pinned snapshot (apiSourceLanes.ts). A one-source App has one. */
  const snapshots = new Map<string, PinnedPostgresReadOwner>();
  let capability: Awaited<ReturnType<typeof acquirePostgresApiTokenObservation>> | undefined;
  try {
    if (isProxy(registry) || !(registry instanceof Registry) || !['number', 'decimal-string'].includes(integers)) return refuse();
    // As on SQLite: the read half of a command-exposing App, currentness
    // against the real App.
    const initial = state(host),
      app = readApiApp(initial.app),
      exposesCommands = app !== initial.app;
    assertAppApiContext(app);
    // Reads whole tables: a row-policy App's are its deployment's to narrow (policyApiOwner.ts).
    if (!app.api || app.auth?.rows !== 'all' || captureAppAuthRuntime(initial.auth).synchronous) return refuse();
    const source = app.sources ? homeSourceOf(app)! : '';
    const matches = app.connection
      ? registry.list().filter((entry) => entry.id === app.connection || entry.name === app.connection)
      : registry.list();
    const bindings = app.sources ? appSourceConnections(registry, app) : new Map([['', matches.length === 1 ? matches[0].id : '']]);
    const connection = bindings.get(source);
    if (!connection) return refuse();
    // One binding is the shape every one-source App had: mapped as it always was.
    const single = bindings.size === 1;
    const configs = new Map([...new Set(bindings.values())].map((id) => [id, registry.configOf(id)]));
    if ([...configs.values()].some((config) => !config)) return refuse();
    const configuration = JSON.stringify([...configs.values()].map((config) => captureTenantData(config))),
      definition = JSON.stringify(initial.app);
    let retired = false;
    const adapterCurrent = new Map<string, () => void>();
    const current = () => {
      try {
        const observed = state(host);
        if (
          retired ||
          observed.loaded !== initial.loaded ||
          observed.auth !== initial.auth ||
          JSON.stringify(observed.app) !== definition ||
          [...configs].some(([id, config]) => registry.configOf(id) !== config) ||
          JSON.stringify([...configs.values()].map((config) => captureTenantData(config))) !== configuration
        )
          return refuse();
        captureAppAuthRuntime(initial.auth).assertCurrent();
        for (const check of adapterCurrent.values()) check();
        /* DDL on one lane's tables retires the whole owner once that lane's
           next read sees it: an owner is one document set, and a
           document over a catalog that has moved is not served. */
        for (const pinned of snapshots.values()) if (pinned.drifted()) return refuse();
      } catch {
        retired = true;
        return refuse();
      }
    };
    current();
    const open = async (lane: string) => {
      acquisitions.push(registry.lease(lane));
      const opened = await registry.open(lane),
        physical = opened.adapter;
      if (!isPostgresVerifiedCommandSource(physical)) return refuse();
      const nativePrototype = Object.getPrototypeOf(physical);
      const adapterLifetime = registry.captureAdapterLifetime(lane, physical);
      adapterCurrent.set(lane, () => {
        adapterLifetime();
        if (Object.getPrototypeOf(physical) !== nativePrototype) return refuse();
        for (let prototype = nativePrototype; prototype; prototype = Object.getPrototypeOf(prototype)) {
          if (isProxy(prototype)) return refuse();
        }
      });
      current();
      return { opened, physical };
    };
    /* A one-source App's connection is verified before discovery, as it
       always was; with several, the home source is held for discovery and
       verified only when an exposed operation reads it. */
    const physicals = new Map<string, Awaited<ReturnType<typeof open>>>();
    if (single) physicals.set(connection, await open(connection));
    else acquisitions.push(registry.lease(connection));
    // Discovery only. Neither this introspected schema nor its mapping facade
    // is used to execute a request or authorize a final native handoff.
    const discovery = await loadAppRuntimeResources(registry, app, connection);
    current();
    const catalog = checkApiReadCatalog(app.api, app, discovery.schema);
    const lanes = single ? [connection] : apiReadLaneConnections(catalog, bindings);
    for (const lane of lanes) if (!physicals.has(lane)) physicals.set(lane, await open(lane));
    for (const [lane, { physical }] of physicals) if ((await registry.open(lane)).adapter !== physical) return refuse();
    current();
    const logical = new Set(Object.keys(app.resources ?? {}));
    if (!logical.size) for (const table of discovery.schema.tables) logical.add(table.id);
    for (const operation of catalog.operations) for (const dependency of operation.dependencies) logical.add(dependency.resource);
    for (const lane of lanes) {
      const { opened, physical } = physicals.get(lane)!;
      const selected = new Set(
        [...logical].filter((resource) => discovery.connectionFor(resource) === lane).map((resource) => discovery.toPhysical(resource)),
      );
      // Capture the whole declared table shape and outgoing FK closure. Complex
      // unsupported columns refuse even when not projected by this request.
      for (const id of selected) for (const fk of opened.schema.foreignKeys) if (fk.from.table === id) selected.add(fk.to.table);
      const dependencies = [...selected].map((id) => {
        const table = opened.schema.tables.find((table) => table.id === id);
        if (!table) return refuse();
        return { schema: table.schema, name: table.name };
      });
      snapshots.set(lane, await captureNativeSnapshot.call(physical, dependencies, current));
      current();
    }
    /* Each lane's tables as its snapshot pinned them; a connection no exposed
       operation reads is named by its opened catalog and never read. */
    const catalogs = new Map<string, DatabaseSchema>();
    for (const id of configs.keys()) catalogs.set(id, snapshots.get(id)?.schema ?? (await registry.open(id)).schema);
    current();
    const docs = lanes.includes(connection) ? connection : lanes[0];
    const map = (lane: string, read: PinnedPostgresRead) =>
      single
        ? mapOpenedAppRuntimeResources(
            app,
            connection,
            new Map([
              [
                source,
                {
                  adapter: postgresSnapshotReads(read),
                  schema: read.schema,
                  resources: physicalBindings(app, source || undefined),
                  writable: false,
                },
              ],
            ]),
            bindings,
          )
        : laneResources(app, connection, bindings, catalogs, lane, postgresSnapshotReads(read));
    await snapshots.get(docs)!.withSnapshot(async (read) => {
      const resources = map(docs, read);
      if (appProblems(initial.loaded, resources.schema).length) return refuse();
      checkApiReadCatalog(app.api!, app, resources.schema);
      capability = await acquirePostgresApiTokenObservation(initial.auth, app, resources.schema);
      current();
      read.assertCurrent();
    });
    const auth = capability;
    if (!auth) return refuse();
    current();
    releaseAcquisition();
    const pending = new Set<Promise<unknown>>(),
      cursorSecret = randomBytes(32),
      deploymentId = randomUUID();
    // The event feed reads the App's command-event store beside its data, on
    // one reader of its own for the owner's lifetime (apiEventFeed.ts).
    const feedSource = eventFeedSource(initial.app, commands, discovery, connection);
    const store = app.api.events.length ? storeTargetOf(configs.get(feedSource.connection)?.url) : undefined;
    const events =
      store && 'postgres' in store ? new PgConnectionManager(store.postgres, undefined, undefined, SMALL_STORE_POOL) : undefined;
    const run = (
      credential: unknown,
      operationId: string,
      input: { key: string } | { query: string } | { spec: true } | { tools: true } | { events: string } | { asyncapi: true },
      send: Send,
      signal?: AbortSignal,
    ) => {
      // Validate the trusted callback before acquiring even an auth transaction.
      if (typeof send !== 'function' || isProxy(send) || isAsyncFunction(send) || isGeneratorFunction(send))
        return Promise.reject(new ApiReadFailure('temporarily_unavailable'));
      let actualSendEntered = false;
      const work = Promise.resolve().then(async () => {
        let release: (() => void) | undefined;
        let answer: Readonly<{ stage: 'postgres-read-response'; outcome: 'sent' | 'uncertain' }> | undefined;
        let failed = false,
          failure: unknown;
        const requestCurrent = () => {
          if (signal) throwIfCancelled(signal);
          current();
        };
        try {
          requestCurrent();
          const spec = 'spec' in input,
            tools = 'tools' in input,
            feed = 'events' in input,
            asyncapi = 'asyncapi' in input;
          // The composed document is the command transport's, as on SQLite.
          if (spec && exposesCommands) return refuse();
          if (
            typeof operationId !== 'string' ||
            (spec
              ? operationId !== '$openapi'
              : tools
                ? operationId !== '$tools'
                : feed
                  ? operationId !== '$events'
                  : asyncapi
                    ? operationId !== '$asyncapi'
                    : 'key' in input
                      ? !operationId.startsWith('item:')
                      : !operationId.startsWith('list:') && !operationId.startsWith('view:'))
          )
            return refuse();
          // Fixed when the catalog was checked: an operation's source names its lane.
          const lane = single ? connection : (apiReadLaneOf(catalog, bindings, operationId) ?? docs);
          const pinned = snapshots.get(lane) ?? snapshots.get(docs)!;
          release = registry.lease(lane);
          // Nothing has run yet: as on SQLite, an unusable credential is the
          // one refusal a transport may answer as unauthenticated.
          let token: Readonly<object>;
          // A token store that could not answer decided nothing about the
          // credential: that is 503, not the 401 that blames the token.
          try {
            token = await auth.observe(credential);
          } catch (error) {
            throw new ApiReadFailure(error instanceof ApiTokenStoreUnavailable ? 'temporarily_unavailable' : 'unauthenticated');
          }
          requestCurrent();
          const observed = auth.inspect(token);
          if (!spec && !tools && !feed && !asyncapi && !observed.operations.includes(operationId)) throw new ApiReadFailure('forbidden');
          if (feed && events && !observed.operations.some((id) => id.startsWith('event:'))) throw new ApiReadFailure('forbidden');
          let query: ReturnType<typeof parseEventFeedQuery> | undefined;
          if (feed) {
            try {
              query = parseEventFeedQuery(input.events);
            } catch {
              throw new ApiReadFailure('invalid_request');
            }
          }
          const execute = () =>
            pinned.withSnapshot(async (read) => {
              requestCurrent();
              read.assertCurrent();
              const resources = map(lane, read);
              const response = await (async () => {
                if (spec) {
                  // Same private projection contract as the SQLite owner: fresh
                  // native operation IDs, never request roles or publicSpec as
                  // a bearer bypass. Full renderer support is required first.
                  const document = renderApiReadOpenApi(app, resources.schema, { integers }).document;
                  return Object.freeze({ status: 200 as const, body: JSON.stringify(narrowApiReadOpenApi(document, observed.operations)) });
                }
                if (feed) {
                  if (!events)
                    return Object.freeze({
                      status: 404 as const,
                      body: JSON.stringify({ error: { code: 'not_found', message: 'The API request could not be completed.' } }),
                    });
                  // The token's events, about records its roles read (apiEventFeed.ts).
                  const admit = eventFeedAudience(initial.app, resources.schema, observed);
                  const page = await events.withReadClient((client) =>
                    readPostgresEventFeed(client, initial.app, query!, admit, integers, feedSource.sourceId),
                  );
                  requestCurrent();
                  return Object.freeze({ status: 200 as const, body: JSON.stringify(page) });
                }
                if (asyncapi) {
                  const document = renderApiAsyncApi(initial.app, commands, { integers, scope: observed.operations });
                  return Object.freeze({ status: 200 as const, body: JSON.stringify(document) });
                }
                if (tools) {
                  // As on SQLite: discovery narrowed by this fresh observation.
                  const listed = previewApiMcpReadTools(
                    app,
                    resources.schema,
                    { integers },
                    { operations: [...observed.operations], roles: [...observed.roles] },
                    'owner',
                  );
                  return Object.freeze({ status: 200 as const, body: JSON.stringify({ tools: listed.tools }) });
                }
                const cursor =
                  'query' in input
                    ? createApiCursorReadView(
                        app,
                        resources.schema,
                        { operationId, query: input.query },
                        { integers },
                        {
                          secret: cursorSecret,
                          deploymentId,
                          catalogId: lane,
                          scopeFingerprint: createHash('sha256').update(JSON.stringify(observed)).digest('hex'),
                          ttlMs: 15 * 60 * 1000,
                        },
                        new Date(),
                      )
                    : undefined;
                const checked =
                  'key' in input
                    ? createApiReadView(app, resources.schema, { operationId, query: '', key: input.key }, { integers }, new Date())
                    : {
                        stage: 'checked-read-view' as const,
                        authorization: 'pending' as const,
                        execution: 'pending' as const,
                        plan: cursor!.plan,
                        view: cursor!.rows,
                      };
                // Ordinary grants use the existing resource authorizer. Native
                // lifetime is enforced by the held bridge and handoff, not the
                // policy-row-scope-only assertActive argument.
                const scoped = authorizeResources(resources, resolveAppAccess(app, resources.schema, [...observed.roles]));
                if (!scoped.adapter.runView) return refuse();
                const rows = await scoped.adapter.runView(checked.view);
                requestCurrent();
                read.assertCurrent();
                let count: number | undefined;
                if (cursor?.plan.count) {
                  if (!scoped.adapter.countView) return refuse();
                  count = await scoped.adapter.countView(cursor.count, 10001);
                  requestCurrent();
                  read.assertCurrent();
                }
                const wire = materializeApiReadResult(checked, rows, count);
                const status = wire.stage === 'item-read-result' && wire.status === 'not-found' ? (404 as const) : (200 as const);
                const body = JSON.stringify(
                  wire.stage === 'item-read-result'
                    ? wire.status === 'not-found'
                      ? { error: { code: 'not_found', message: 'The API request could not be completed.' } }
                      : wire.item
                    : {
                        items: wire.items,
                        next: wire.more ? cursor!.sealNext(wire.boundary) : null,
                        ...(wire.count ? { count: wire.count } : {}),
                      },
                );
                return Object.freeze({ status, body });
              })();
              // Both row results and spec use one bounded native handoff. No
              // unguarded document/result promise escapes for a later send.
              if (Buffer.byteLength(response.body) > 8 * 1024 * 1024) return refuse();
              requestCurrent();
              read.assertCurrent();
              const handoff = await auth.handoff(credential, token, () => {
                // Auth's callback-entered bit is NOT actual transport entry.
                requestCurrent();
                read.assertCurrent();
                auth.inspect(token);
                actualSendEntered = true;
                const returned: unknown = send(response);
                if (isPromise(returned)) void Promise.prototype.then.call(returned, undefined, () => {});
                if (returned !== undefined) return refuse();
              });
              if (!actualSendEntered) return refuse();
              return handoff.outcome;
            });
          const outcome = await (signal ? withCancellation(signal, execute) : execute());
          requestCurrent();
          answer = Object.freeze({
            stage: 'postgres-read-response' as const,
            outcome: outcome === 'complete' ? ('sent' as const) : ('uncertain' as const),
          });
        } catch (error) {
          failed = true;
          failure = error;
        } finally {
          try {
            release?.();
          } catch (error) {
            failed = true;
            failure = error;
          }
        }
        if (failed) {
          if (actualSendEntered) return uncertain();
          if (failure instanceof ApiReadFailure) throw failure;
          return refuse();
        }
        return answer ?? refuse();
      });
      pending.add(work);
      void work.then(
        () => pending.delete(work),
        () => pending.delete(work),
      );
      return work;
    };
    return Object.freeze({
      readItem: (credential: unknown, operationId: string, key: string, send: Send, signal?: AbortSignal) =>
        run(credential, operationId, { key }, send, signal),
      readList: (credential: unknown, operationId: string, query: string, send: Send, signal?: AbortSignal) =>
        run(credential, operationId, { query }, send, signal),
      readSpec: (credential: unknown, send: Send, signal?: AbortSignal) => run(credential, '$openapi', { spec: true }, send, signal),
      /** App MCP discovery: `{tools}` narrowed by a fresh native observation. */
      readTools: (credential: unknown, send: Send, signal?: AbortSignal) => run(credential, '$tools', { tools: true }, send, signal),
      /** The event feed: one page after a cursor, for this token now. */
      readEvents: (credential: unknown, query: string, send: Send, signal?: AbortSignal) =>
        run(credential, '$events', { events: query }, send, signal),
      /** The AsyncAPI document, narrowed to the token's feed events. */
      readAsyncApi: (credential: unknown, send: Send, signal?: AbortSignal) =>
        run(credential, '$asyncapi', { asyncapi: true }, send, signal),
      retire: async () => {
        retired = true;
        await Promise.allSettled([auth.retire(), ...[...snapshots.values()].map((pinned) => pinned.retire()), ...pending]);
        await events?.close().catch(() => {});
      },
    });
  } catch {
    await Promise.allSettled([capability?.retire(), ...[...snapshots.values()].map((pinned) => pinned.retire())]);
    return refuse();
  } finally {
    releaseAcquisition();
  }
}
