/** Private, transportless read execution owner. Construct from the serving
 * composition's original host/registry, never its request-time host clone.
 * No HTTP activation, cookie fallback, supplied roles or supplied checked plan.
 * The serving owner must retire this reader on reload and before auth close. */
import { isProxy } from 'node:util/types';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { captureTenantData } from '@mistriwork/engine/server/evidence.js';
import { Registry } from '@mistriwork/engine/server/connections.js';
import { SqliteAdapter } from '@mistriwork/engine/adapters/sqlite.js';
import { throwIfCancelled, withCancellation } from '@mistriwork/engine/adapters/statementControl.js';
import type { AppHost, LoadedApp } from '../app/apps.js';
import { appProblems } from '../app/apps.js';
import { homeSourceOf, resolveAppAccess } from '../../shared/app.js';
import { loadAppRuntimeResources, appSourceConnections } from '../app/appRuntimeResources.js';
import { authorizeResources } from '../app/appAccess.js';
import { acquireSqliteApiTokenObservation, captureAppAuthRuntime, type AppAuthRuntime } from '../auth/auth.js';
import { assertAppApiContext, readApiApp } from './appApiValidation.js';
import { createApiReadView } from './apiReadView.js';
import { materializeApiReadResult } from './apiReadResult.js';
import { createApiCursorReadView } from './apiCursorReadView.js';
import { ApiReadFailure, type ApiReadFailureCode } from './apiReadFailure.js';
import { ApiTokenStoreUnavailable } from '../auth/apiTokenStoreFailure.js';
import { renderApiReadOpenApi } from './apiReadOpenApi.js';
import { narrowApiReadOpenApi } from './apiNarrowedReadOpenApi.js';
import { previewApiMcpReadTools } from './apiMcpReadTools.js';
import { eventFeedAudience, eventFeedSource, parseEventFeedQuery, readSqliteEventFeed } from './apiEventFeed.js';
import { checkApiReadCatalog } from './apiReadCatalog.js';
import { apiReadLaneConnections, apiReadLaneOf, laneResources } from './apiSourceLanes.js';
import { apiCatalogOn } from './apiValueCodec.js';
import type { RuntimeResources } from '../app/appRuntimeResources.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { renderApiAsyncApi } from './apiAsyncApi.js';
import { storeTargetOf } from '../commands/appCommandEvents.js';
import type { BusinessCommandRegistry } from '../commands/businessCommands.js';

const refuse = (code: ApiReadFailureCode = 'temporarily_unavailable'): never => {
  throw new ApiReadFailure(code);
};
/** The token store could not be read, so nothing was decided about the
 * credential: 503, never the 401 that says the token itself is bad. */
const storeDown = (error: unknown) => error instanceof ApiTokenStoreUnavailable;
function data(object: object, key: string): unknown {
  if (isProxy(object)) return refuse();
  const property = Object.getOwnPropertyDescriptor(object, key);
  if (!property) return undefined;
  if (!Object.hasOwn(property, 'value')) return refuse();
  return property.value;
}
function state(host: AppHost) {
  if (!host || typeof host !== 'object' || data(host, 'unavailable') || data(host, 'loadError')) return refuse();
  const loaded = data(host, 'app') as LoadedApp,
    auth = data(host, 'auth') as AppAuthRuntime;
  if (!loaded || typeof loaded !== 'object' || !auth) return refuse();
  const app = captureTenantData(data(loaded, 'app')) as LoadedApp['app'];
  return { loaded, auth, app };
}

export async function createSqliteApiReadOwner(
  registry: Registry,
  host: AppHost,
  integers: 'decimal-string' | 'number',
  commands?: BusinessCommandRegistry,
) {
  const acquisitions: (() => void)[] = [];
  const releaseAcquisition = () => {
    for (const release of acquisitions.splice(0)) release();
  };
  let capability: ReturnType<typeof acquireSqliteApiTokenObservation> | undefined;
  try {
    if (isProxy(registry) || !(registry instanceof Registry) || !['decimal-string', 'number'].includes(integers)) return refuse();
    // Reads serve the read half of an App that also exposes commands; the
    // deployment is still the real App (see `definition` below).
    const initial = state(host),
      app = readApiApp(initial.app),
      exposesCommands = app !== initial.app;
    assertAppApiContext(app);
    // Reads whole tables: a row-policy App's are its deployment's to narrow (policyApiOwner.ts).
    if (!app.api || app.auth?.rows !== 'all' || !captureAppAuthRuntime(initial.auth).synchronous) return refuse();
    const matches = app.connection
      ? registry.list().filter((entry) => entry.id === app.connection || entry.name === app.connection)
      : registry.list();
    const bindings = app.sources ? appSourceConnections(registry, app) : new Map(matches.length === 1 ? [['', matches[0].id]] : []);
    const connection = bindings.get(app.sources ? homeSourceOf(app)! : '');
    if (!connection) return refuse();
    // One binding is the shape every one-source App had: read as it always was.
    const single = bindings.size === 1;
    const configs = new Map([...new Set(bindings.values())].map((id) => [id, registry.configOf(id)]));
    if ([...configs.values()].some((config) => !config)) return refuse();
    const configuration = JSON.stringify([...configs.values()].map((config) => captureTenantData(config))),
      definition = JSON.stringify(initial.app);
    let retired = false;
    let clearResults = () => {};
    const assertAdapterCurrent = new Map<string, () => void>();
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
        for (const check of assertAdapterCurrent.values()) check();
      } catch {
        retired = true;
        clearResults();
        capability?.retire();
        return refuse();
      }
    };
    current();
    const open = async (lane: string) => {
      acquisitions.push(registry.lease(lane));
      const opened = await registry.open(lane),
        physical = opened.adapter;
      if (!(physical instanceof SqliteAdapter)) return refuse();
      const adapterCurrent = registry.captureAdapterLifetime(lane, physical);
      const schemaCurrent = physical.captureSchemaLifetime(opened.schema);
      assertAdapterCurrent.set(lane, () => {
        adapterCurrent();
        schemaCurrent();
      });
      current();
      return physical;
    };
    /* A one-source App's connection is pinned before loading, as it always
       was; with several, the home source is held for loading and pinned only
       when an exposed operation reads it. */
    const physicals = new Map<string, SqliteAdapter>();
    if (single) physicals.set(connection, await open(connection));
    else acquisitions.push(registry.lease(connection));
    const resources = await loadAppRuntimeResources(registry, app, connection);
    current();
    const catalog = checkApiReadCatalog(app.api, app, resources.schema);
    const lanes = single ? [connection] : apiReadLaneConnections(catalog, bindings);
    for (const lane of lanes) if (!physicals.has(lane)) physicals.set(lane, await open(lane));
    // RuntimeResources exposes a logical mapping wrapper even for identity
    // mappings. Pin the Registry's actual adapter, not that fresh wrapper.
    for (const [lane, physical] of physicals) if ((await registry.open(lane)).adapter !== physical) return refuse();
    current();
    const reached = catalog.operations.flatMap((operation) => operation.dependencies.map((dependency) => dependency.resource));
    if (!apiCatalogOn(resources.schema, 'sqlite', reached) || appProblems(initial.loaded, resources.schema).length) return refuse();
    /* With several sources a request reads through its lane alone: every
       other connection refuses (apiSourceLanes.ts). Documents, tools and the
       feed read no business rows and use the App's whole mapping. */
    const catalogs = new Map<string, DatabaseSchema>();
    for (const id of configs.keys()) catalogs.set(id, (await registry.open(id)).schema);
    const laneReads = new Map<string, RuntimeResources>(
      single
        ? [[connection, resources]]
        : lanes.map((lane) => [lane, laneResources(app, connection, bindings, catalogs, lane, physicals.get(lane)!)]),
    );
    const feedSource = eventFeedSource(initial.app, commands, resources, connection);
    current();
    capability = acquireSqliteApiTokenObservation(initial.auth, app, resources.schema);
    const auth = capability;
    const cursorSecret = randomBytes(32),
      deploymentId = randomUUID();
    current();
    releaseAcquisition();
    const pending = new Set<Promise<unknown>>();
    type Observation = ReturnType<typeof auth.inspect>;
    const results = new Map<
      object,
      { credential: unknown; observation: Observation; status: 200 | 404; body: string; bytes: number; signal?: AbortSignal }
    >();
    let bufferedBytes = 0;
    clearResults = () => {
      results.clear();
      bufferedBytes = 0;
    };
    const forget = (handle: object) => {
      const result = results.get(handle);
      if (result) {
        bufferedBytes -= result.bytes;
        results.delete(handle);
      }
      return result;
    };
    const buffer = (credential: unknown, before: Observation, status: 200 | 404, body: string, signal?: AbortSignal) => {
      let failure: ApiReadFailureCode = 'temporarily_unavailable';
      try {
        if (signal) throwIfCancelled(signal);
        current();
        failure = 'unauthenticated';
        const finalObservation = auth.observe(credential),
          after = auth.inspect(finalObservation);
        if (JSON.stringify(before) !== JSON.stringify(after)) return refuse('forbidden');
        current();
        auth.inspect(finalObservation);
        failure = 'temporarily_unavailable';
        const bytes = Buffer.byteLength(body);
        for (const [handle, entry] of results) if (entry.observation.expiresAt <= Date.now()) forget(handle);
        if (results.size >= 16 || bufferedBytes + bytes > 8 * 1024 * 1024) return refuse();
        const handle: object = Object.freeze(Object.create(null));
        if (signal) throwIfCancelled(signal);
        results.set(handle, { credential, observation: after, status, body, bytes, signal });
        bufferedBytes += bytes;
        return handle;
      } catch (error) {
        if (error instanceof ApiReadFailure) throw error;
        return refuse(storeDown(error) ? 'temporarily_unavailable' : failure);
      }
    };
    const read = (
      credential: unknown,
      operationId: string,
      input: { key: string } | { query: string } | { spec: true } | { tools: true } | { events: string } | { asyncapi: true },
      signal?: AbortSignal,
    ) => {
      // Cancellation belongs to this read, never the shared owner's current()
      // failure path (which permanently retires auth and all sibling reads).
      const requestCurrent = () => {
        if (signal) throwIfCancelled(signal);
        current();
      };
      // Only request statements inherit this signal. In particular, shared
      // Registry acquisition does not inherit the first caller's lifetime.
      const statement = <T>(run: () => Promise<T>): Promise<T> => (signal ? withCancellation(signal, run) : run());
      // Register before any user-visible/driver await can reenter retirement.
      const work = Promise.resolve().then(async () => {
        let release: (() => void) | undefined;
        let failure: ApiReadFailureCode = 'temporarily_unavailable';
        try {
          requestCurrent();
          const item = 'key' in input;
          const spec = 'spec' in input,
            tools = 'tools' in input,
            feed = 'events' in input,
            asyncapi = 'asyncapi' in input;
          // A command-exposing App's document is composed by the command
          // transport; its read half alone would misdescribe the API.
          if (spec && exposesCommands) return refuse();
          if (
            !spec &&
            !tools &&
            !feed &&
            !asyncapi &&
            (typeof operationId !== 'string' ||
              (item ? !operationId.startsWith('item:') : !operationId.startsWith('list:') && !operationId.startsWith('view:')))
          )
            return refuse('invalid_request');
          // Fixed when the catalog was checked: an operation's source names its lane.
          const lane = single ? connection : (apiReadLaneOf(catalog, bindings, operationId) ?? lanes[0]);
          const reads = laneReads.get(lane) ?? resources,
            physical = physicals.get(lane)!;
          release = registry.lease(lane);
          failure = 'unauthenticated';
          const before = auth.inspect(auth.observe(credential));
          if (!spec && !tools && !feed && !asyncapi && !before.operations.includes(operationId)) return refuse('forbidden');
          failure = 'temporarily_unavailable';
          if ((await registry.open(lane)).adapter !== physical) return refuse();
          requestCurrent();
          if (spec) {
            const document = renderApiReadOpenApi(app, resources.schema, { integers }).document;
            const body = JSON.stringify(narrowApiReadOpenApi(document, before.operations));
            return buffer(credential, before, 200, body, signal);
          }
          if (feed) {
            // The token's events, about records its roles read (apiEventFeed.ts).
            failure = 'invalid_request';
            const query = parseEventFeedQuery(input.events);
            failure = 'temporarily_unavailable';
            const target = storeTargetOf(configs.get(feedSource.connection)?.url);
            if (!target || !('sqlite' in target) || !app.api?.events.length) {
              return buffer(
                credential,
                before,
                404,
                JSON.stringify({ error: { code: 'not_found', message: 'The API request could not be completed.' } }),
                signal,
              );
            }
            if (!before.operations.some((id) => id.startsWith('event:'))) return refuse('forbidden');
            const body = JSON.stringify(
              readSqliteEventFeed(
                target.sqlite,
                initial.app,
                query,
                eventFeedAudience(initial.app, resources.schema, before),
                integers,
                feedSource.sourceId,
              ),
            );
            requestCurrent();
            return buffer(credential, before, 200, body, signal);
          }
          if (asyncapi) {
            const document = renderApiAsyncApi(initial.app, commands, { integers, scope: before.operations });
            return buffer(credential, before, 200, JSON.stringify(document), signal);
          }
          if (tools) {
            // MCP discovery: the read tools this token may call now, narrowed
            // by this fresh native observation, never by a caller's scope.
            const listed = previewApiMcpReadTools(
              app,
              resources.schema,
              { integers },
              { operations: [...before.operations], roles: [...before.roles] },
              'owner',
            );
            return buffer(credential, before, 200, JSON.stringify({ tools: listed.tools }), signal);
          }
          failure = 'invalid_request';
          const cursor =
            'query' in input
              ? createApiCursorReadView(
                  app,
                  reads.schema,
                  { operationId, query: input.query },
                  { integers },
                  {
                    secret: cursorSecret,
                    deploymentId,
                    catalogId: lane,
                    scopeFingerprint: createHash('sha256').update(JSON.stringify(before)).digest('hex'),
                    ttlMs: 15 * 60 * 1000,
                  },
                  new Date(),
                )
              : undefined;
          const checked =
            'key' in input
              ? createApiReadView(app, reads.schema, { operationId, query: '', key: input.key }, { integers }, new Date())
              : {
                  stage: 'checked-read-view' as const,
                  authorization: 'pending' as const,
                  execution: 'pending' as const,
                  plan: cursor!.plan,
                  view: cursor!.rows,
                };
          failure = 'forbidden';
          const scoped = authorizeResources(reads, resolveAppAccess(app, reads.schema, [...before.roles]));
          failure = 'temporarily_unavailable';
          if (!scoped.adapter.runView) return refuse();
          requestCurrent();
          // SQLite checks cancellation between statements; a synchronous
          // node:sqlite statement already running is not interruptible here.
          // Never race abort against work: the lease remains held until the
          // underlying statement settles and this read's finally executes.
          const result = await statement(() => scoped.adapter.runView!(checked.view));
          requestCurrent();
          let count: number | undefined;
          if (cursor?.plan.count) {
            if (!scoped.adapter.countView) return refuse();
            count = await statement(() => scoped.adapter.countView!(cursor.count, 10001));
            requestCurrent();
          }
          if ((await registry.open(lane)).adapter !== physical) return refuse();
          requestCurrent();
          failure = 'temporarily_unavailable';
          const wire = materializeApiReadResult(checked, result, count);
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
          // Re-observe after all encoding, which can cross expiry or invoke
          // a driver-provided value boundary. Consumption observes once more.
          return buffer(credential, before, status, body, signal);
        } catch (error) {
          if (error instanceof ApiReadFailure) throw error;
          return refuse(storeDown(error) ? 'temporarily_unavailable' : failure);
        } finally {
          release?.();
        }
      });
      pending.add(work);
      void work.then(
        () => pending.delete(work),
        () => pending.delete(work),
      );
      return work;
    };
    return Object.freeze({
      readItem: (credential: unknown, operationId: string, key: string, signal?: AbortSignal) =>
        read(credential, operationId, { key }, signal),
      readList: (credential: unknown, operationId: string, query: string, signal?: AbortSignal) =>
        read(credential, operationId, { query }, signal),
      readSpec: (credential: unknown, signal?: AbortSignal) => read(credential, '$openapi', { spec: true }, signal),
      /** The event feed: one page after a cursor, for this token now. */
      readEvents: (credential: unknown, query: string, signal?: AbortSignal) => read(credential, '$events', { events: query }, signal),
      /** The AsyncAPI document, narrowed to the token's feed events. */
      readAsyncApi: (credential: unknown, signal?: AbortSignal) => read(credential, '$asyncapi', { asyncapi: true }, signal),
      /** App MCP discovery: `{tools}` narrowed by a fresh native observation. */
      readTools: (credential: unknown, signal?: AbortSignal) => read(credential, '$tools', { tools: true }, signal),
      /** Trusted HTTP wiring calls this directly beside res.end(body), without
       * an intervening await or serialization. The handle is not portable
       * authority; consumption is one-shot even when freshness fails. */
      consumeResult: (handle: unknown) => {
        let failure: ApiReadFailureCode = 'temporarily_unavailable';
        try {
          if (!handle || typeof handle !== 'object' || isProxy(handle)) return refuse();
          const result = forget(handle);
          if (!result) return refuse();
          if (result.signal) throwIfCancelled(result.signal);
          current();
          failure = 'unauthenticated';
          const observation = auth.observe(result.credential);
          if (JSON.stringify(auth.inspect(observation)) !== JSON.stringify(result.observation)) return refuse('forbidden');
          current();
          auth.inspect(observation);
          if (result.signal) throwIfCancelled(result.signal);
          return Object.freeze({ status: result.status, body: result.body });
        } catch (error) {
          if (error instanceof ApiReadFailure) throw error;
          return refuse(storeDown(error) ? 'temporarily_unavailable' : failure);
        }
      },
      /** A disconnected transport must release its buffered handoff without
       * another auth-store read. Unknown handles have no effect. */
      discardResult: (handle: unknown) => {
        if (handle && typeof handle === 'object' && !isProxy(handle)) forget(handle);
      },
      retire: async () => {
        retired = true;
        auth.retire();
        clearResults();
        await Promise.allSettled([...pending]);
      },
    });
  } catch {
    capability?.retire();
    return refuse();
  } finally {
    releaseAcquisition();
  }
}
