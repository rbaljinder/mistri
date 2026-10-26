/**
 * Which adapters write live sync's change rows, and the operator's switch.
 *
 * Live sync is an App's choice: on for an App that says `live: true` and
 * whose database holds the change store, off for every other, whose pages
 * refresh on focus and after their own saves. `--no-live` is the operator's
 * switch over every App, for a deployment that cannot hold streams; then
 * nothing is captured and `/api/live` answers 204.
 *
 * Several Apps may share a connection: it is bound when any of them asks,
 * and a table is left out of the capture only where every App that asks and
 * names it says `live: false` on its resource (one that leaves it out still
 * tells nobody of it: the route serves each App only its own live tables).
 *
 * Binding rides on what is already open, and never opens anything itself.
 * Every request names its App's connections here before any route can write
 * (handler.ts, as the jobs host and the App MCP do): that only marks them,
 * with no I/O. A marked connection's adapter is bound when it is dialed for
 * any other reason (the registry's dial hook, before the adapter is published)
 * and, if it is open already, at the mark. Every App write goes through a
 * registry adapter, so none reaches a table unannounced; a tenant App's private
 * writer is bound where it is made (tenantLive.ts).
 *
 * Whether the store is there is asked lazily, once per adapter, where it first
 * matters: the first write of a transaction (the capture asks through the
 * binding, and writes no row where the answer is no) or the first subscriber.
 * The answer is kept; a no, or a database that did not answer, is asked again
 * after 30 s, never per request. A database without the store is not refused,
 * unlike history's: live sync is off there, which the startup log says.
 *
 * The hub is made once the store attests, which arms only its minute's prune;
 * its wake (LISTEN on PostgreSQL, the poll elsewhere) starts with the first
 * subscriber to `/api/live` and stops when the last one leaves (liveHub.ts).
 *
 * What a binding says beyond "capture": the tables a row scope filters, whose
 * before images the capture keeps (a row-policy App's, all of them), and on a
 * tenant App the column that names each tenant table's owner, which routes a
 * change to its tenant's subscribers alone (tenantLive.ts binds those).
 */
import type { Adapter } from '@mistriwork/engine/adapters/adapter.js';
import { bareTable, bindLiveChanges, type LiveBinding } from '../../adapters/live/liveChange.js';
import { wakeListenUrl } from '../../adapters/events/postgresCommandEventWake.js';
import { postgresPoolDefaults } from '@mistriwork/engine/adapters/postgresPool.js';
import { isFormView, isRowPolicyApp, isTenantApp, type AppDef } from '../../shared/app.js';
import { formCommands } from '../../shared/appSavedForms.js';
import { resolveConnection } from '@mistriwork/engine/server/auth/credentials.js';
import type { Registry } from '@mistriwork/engine/server/connections.js';
import type { AppHost } from '../app/apps.js';
import { appSourceConnections } from '../app/appRuntimeResources.js';
import { appEntrypoint } from '../app/appEntrypoint.js';
import { liveHubOf, type LiveHub } from './liveHub.js';
import { liveStoreOf } from './liveStore.js';

let enabled = true;

/** The operator's switch (cli/serve.ts): off for the whole process. */
export function setLiveSync(on: boolean): void {
  enabled = on;
}

/** Whether live sync runs in this process at all. */
export const liveSyncOn = (): boolean => enabled;

/** Where live sync stands on one connection, for the startup log. `pending`: nobody has needed to ask yet. */
export type LiveState =
  | { readonly state: 'on' }
  | { readonly state: 'pending' }
  | { readonly state: 'off'; readonly reason: 'switched off' | 'not asked' | 'no store' | 'unsupported' | 'unreachable' };

/** How long a no, or no answer, is kept before the store is asked again. */
const RETRY_MS = 30_000;
/** How long one look at the store may take: a write waits on it once, and a subscriber's setup is bounded by it. */
const ASK_MS = 2_000;
/** How long `/api/live` waits for a connection's hub before answering 503 and a retry. */
const HUB_MS = 5_000;

interface Readiness {
  state?: LiveState;
  at: number;
  asking?: Promise<boolean>;
}

/* By the adapter as dialed: a reconnect is a new adapter, asked afresh. */
const readiness = new WeakMap<object, Readiness>();

/** Whether this adapter's store attests, asked at most once per 30 s; never throws, never waits longer than ASK_MS. */
function readyOf(adapter: Adapter, now = Date.now()): Promise<boolean> {
  let known = readiness.get(adapter);
  if (!known) readiness.set(adapter, (known = { at: 0 }));
  const kept = known;
  if (kept.state?.state === 'on') return Promise.resolve(true);
  if (kept.asking) return kept.asking;
  if (kept.state?.state === 'off' && now - kept.at < RETRY_MS) return Promise.resolve(false);
  const store = liveStoreOf(adapter);
  if (!store) {
    kept.state = { state: 'off', reason: 'unsupported' };
    kept.at = now;
    return Promise.resolve(false);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), ASK_MS);
    timer.unref?.();
  });
  kept.asking = Promise.race([store.ready().catch(() => 'late' as const), late]).then((answer) => {
    clearTimeout(timer);
    kept.asking = undefined;
    kept.at = Date.now();
    kept.state = answer === true ? { state: 'on' } : { state: 'off', reason: answer === 'late' ? 'unreachable' : 'no store' };
    return answer === true;
  });
  return kept.asking;
}

interface AppWish {
  readonly scoped: boolean;
  /** Whether it follows its changes (`live: true`); one that does not is here only for its forms' choices. */
  readonly follows: boolean;
  /** The physical tables it names on this connection, and those of them its resources keep out (`live: false`). */
  readonly named: ReadonlySet<string>;
  readonly off: ReadonlySet<string>;
  /** The tables a form of it offers rows of as choices (`field.choice({ from })`): their writes are always captured,
      `live` or not, so the shared cache of those choices is dropped when one changes (forms/choiceCache.ts). */
  readonly choices: ReadonlySet<string>;
}
interface ConnectionLive {
  /** Each App's wish on this connection, merged into the adapter's binding. */
  readonly byApp: Map<string, AppWish>;
}

/** The logical names of an App's resources that keep out of live sync. Nothing on an App that does not ask for it. */
export function liveOffResources(app: AppDef): string[] {
  if (!app.live) return [];
  return Object.entries(app.resources ?? {})
    .filter(([, resource]) => resource.live === false)
    .map(([name]) => name);
}

/**
 * The resources an App's forms offer rows of as choices (`field.choice({ from })` on a form's command, public or
 * signed in, and a public page's command): by the name the field gives, matched to a resource by its whole id or its
 * local name — a superset at worst, which only captures a table more.
 */
export function choiceSourceResources(app: Pick<AppDef, 'views' | 'resources'>): Set<string> {
  const from = new Set<string>();
  for (const view of Object.values(app.views ?? {})) {
    if (!isFormView(view)) continue;
    for (const reference of formCommands(view))
      for (const field of reference.input ?? [])
        if ((field.type === 'choice' || field.type === 'choices') && field.source) from.add(field.source.from);
  }
  const resources = new Set<string>();
  for (const name of Object.keys(app.resources ?? {}))
    if (from.has(name) || from.has(name.slice(name.indexOf('.') + 1))) resources.add(name);
  return resources;
}

/* Each of an App's resources on `connection`, by the table a write names: its own `physical`, or its local name, in its source's schema. */
function appTables(app: AppDef, connection: string, sourceConnection: (source: string | undefined) => string | undefined): AppWish {
  const named = new Set<string>();
  const off = new Set<string>();
  const choices = new Set<string>();
  const offered = choiceSourceResources(app);
  for (const [name, resource] of Object.entries(app.resources ?? {})) {
    if (sourceConnection(resource.source) !== connection) continue;
    const bare = resource.physical ?? name.slice(name.indexOf('.') + 1);
    const schema = resource.source ? app.sources?.[resource.source]?.schema : undefined;
    const tables = schema && !bare.includes('.') ? [bare, `${schema}.${bare}`] : [bare];
    for (const table of tables) {
      named.add(table);
      if (resource.live === false) off.add(table);
      if (offered.has(name)) choices.add(bareTable(table));
    }
  }
  return { scoped: isRowPolicyApp(app), follows: Boolean(app.live), named, off, choices };
}

/** The physical tables on `connection` whose rows any App's forms offer as choices, captured whether or not the App
    follows its changes: what the choice cache hears of (forms/choiceCache.ts). Empty where live sync is off. */
export function choiceTablesOf(registry: Registry, connection: string): ReadonlySet<string> {
  if (!enabled) return new Set();
  return new Set([...(registries.get(registry)?.get(connection)?.byApp.values() ?? [])].flatMap((wish) => [...wish.choices]));
}

const registries = new WeakMap<Registry, Map<string, ConnectionLive>>();
const ensured = new WeakMap<Registry, WeakMap<object, unknown>>();

function registryLive(registry: Registry): Map<string, ConnectionLive> {
  let connections = registries.get(registry);
  if (connections) return connections;
  connections = new Map();
  registries.set(registry, connections);
  const known = connections;
  /* Told before the adapter is published, so nothing can write through it unbound. */
  registry.onAdapterDialed((connection, adapter) => {
    const live = known.get(connection);
    if (live && enabled) bind(registry, connection, adapter, live);
  });
  return connections;
}

/* Capture on every write; the store is asked at the first one, and once it attests the hub is made, for its prune. */
function bind(registry: Registry, connection: string, adapter: Adapter, live: ConnectionLive): void {
  const wishes = [...live.byApp.values()];
  const choices = new Set(wishes.flatMap((wish) => [...wish.choices]));
  /* Out of the capture only where no App that asks follows it, and no form offers its rows as choices. */
  const skip = new Set(
    wishes
      .flatMap((wish) => [...wish.off])
      .filter(
        (table) => !choices.has(bareTable(table)) && !wishes.some((wish) => wish.follows && wish.named.has(table) && !wish.off.has(table)),
      ),
  );
  /* Where no App here follows its changes, only the choice tables are captured: the cheap half of the same mechanism. */
  const following = wishes.some((wish) => wish.follows);
  const binding: LiveBinding = {
    ...(wishes.some((app) => app.scoped) ? { scoped: true as const } : {}),
    ...(skip.size ? { skip } : {}),
    ...(following ? {} : { only: choices }),
    ready: async () => {
      const ready = await readyOf(adapter);
      if (ready) void hubOf(registry, connection, adapter).catch(() => undefined);
      return ready;
    },
  };
  bindLiveChanges(adapter, binding);
}

/**
 * Mark a served App's connections as live sync's, once per load of it. No
 * database is opened, leased or asked: an adapter already open is bound now,
 * and one dialed later is bound as it is dialed, before anything can write
 * through it. Every request passes here before any route can write
 * (handler.ts), as do the jobs host and the App MCP.
 */
export function ensureAppLive(registry: Registry, host: AppHost): void {
  if (!enabled) return;
  const app = host.app.app;
  /* Its own choice: an App that does not ask marks nothing, and its pages refresh as they always did — except the
     tables its forms offer rows of as choices, whose writes drop the shared cache of them (forms/choiceCache.ts). */
  if (!app.live && !choiceSourceResources(app).size) return;
  /* A tenant App's writes go through its private writer, bound where it is made (tenantLive.ts). */
  if (isTenantApp(app)) return;
  let seen = ensured.get(registry);
  if (!seen) ensured.set(registry, (seen = new WeakMap()));
  if (seen.has(app)) return;
  const entry = appEntrypoint(host, registry);
  if (!entry) return;
  let connections: string[];
  let sourceConnection: (source: string | undefined) => string | undefined;
  try {
    const bound = app.sources ? appSourceConnections(registry, app) : undefined;
    connections = bound ? [...new Set(bound.values())] : [entry];
    sourceConnection = (source) => (bound ? (source === undefined ? undefined : bound.get(source)) : entry);
  } catch {
    /* A source that names no connection: the App's own routes refuse it, and the next request marks again. */
    return;
  }
  const live = registryLive(registry);
  for (const connection of connections) {
    const known: ConnectionLive = live.get(connection) ?? { byApp: new Map() };
    live.set(connection, known);
    known.byApp.set(app.id, appTables(app, connection, sourceConnection));
    const adapter = registry.dialedAdapter(connection);
    if (adapter) bind(registry, connection, adapter, known);
  }
  seen.set(app, true);
}

/**
 * At startup, ask the store of each marked connection that is open already,
 * so the startup log can say where live sync is off. Opens nothing; a
 * connection not open yet is asked at its first use. Not on any request.
 */
export async function settleLiveStartup(registry: Registry): Promise<void> {
  if (!enabled) return;
  await Promise.all(
    [...(registries.get(registry)?.keys() ?? [])].map(async (connection) => {
      const adapter = registry.dialedAdapter(connection);
      if (adapter && (await readyOf(adapter))) await hubOf(registry, connection, adapter).catch(() => undefined);
    }),
  );
}

/** Where live sync stands on each marked connection. */
function appLiveStates(registry: Registry): ReadonlyMap<string, LiveState> {
  if (!enabled) return new Map([['*', { state: 'off', reason: 'switched off' }]]);
  return new Map(
    [...(registries.get(registry)?.keys() ?? [])].map((connection): [string, LiveState] => {
      const adapter = registry.dialedAdapter(connection);
      return [connection, (adapter && readiness.get(adapter)?.state) || { state: 'pending' }];
    }),
  );
}

/**
 * What the startup log says of live sync, App by App: on, off because the App does not ask for it, or off by
 * `--no-live`; and for an App that asks, where its databases keep it off or have not been asked yet, and why.
 */
export function liveStartupLines(registry: Registry, apps: readonly AppDef[]): string[] {
  const states = appLiveStates(registry);
  return apps.flatMap((app) => {
    const name = `"${app.name}"`;
    if (!enabled) return [`live sync is off for ${name} (--no-live): pages refresh on focus and after their own saves`];
    if (!app.live) return [`live sync is off for ${name}: the App does not ask for it (live: true)`];
    if (isTenantApp(app)) return [`live sync is on for ${name}, on its tenants' database once the store attests`];
    let connections: string[] = [];
    try {
      const entry = registry.list().find((each) => each.id === app.connection || each.name === app.connection)?.id;
      connections = app.sources ? [...new Set(appSourceConnections(registry, app).values())] : entry ? [entry] : [...states.keys()];
    } catch {
      /* A source that names no connection is refused by the App's own startup. */
    }
    const named = (test: (live: LiveState) => boolean) =>
      connections
        .filter((connection) => test(states.get(connection) ?? { state: 'pending' }))
        .map((connection) => `"${connection}"`)
        .join(', ');
    const off = (reason: string) => named((live) => live.state === 'off' && live.reason === reason);
    const missing = off('no store');
    const unsupported = off('unsupported');
    const unreachable = off('unreachable');
    const pending = named((live) => live.state === 'pending');
    const detail = [
      ...(missing ? [`its store is not provisioned on ${missing} (mistri migrate stores up --app <dir>)`] : []),
      ...(unsupported ? [`${unsupported} is a kind of source that keeps no change store`] : []),
      ...(unreachable ? [`${unreachable} did not answer; it is asked again at first use`] : []),
      ...(pending ? [`${pending} starts at first use: not open yet`] : []),
    ];
    return [detail.length ? `live sync is asked for by ${name}, but ${detail.join('; ')}` : `live sync is on for ${name}`];
  });
}

/** Why a subscriber has no hub on a connection: live sync is off there, or its setup did not finish in time. */
type HubAnswer = { readonly hub: LiveHub } | { readonly off: true } | { readonly late: true };

/**
 * The hub of a connection whose store attests, for a subscriber: the one
 * place a request waits on live sync's setup, and never longer than HUB_MS.
 */
export async function connectionHub(registry: Registry, connection: string): Promise<HubAnswer> {
  if (!enabled || !registries.get(registry)?.has(connection)) return { off: true };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<HubAnswer>((resolve) => {
    timer = setTimeout(() => resolve({ late: true }), HUB_MS);
    timer.unref?.();
  });
  const made = (async (): Promise<HubAnswer> => {
    await registry.open(connection);
    const adapter = registry.dialedAdapter(connection);
    if (!adapter || !(await readyOf(adapter))) return { off: true };
    const hub = await hubOf(registry, connection, adapter);
    return hub ? { hub } : { off: true };
  })().catch((): HubAnswer => ({ late: true }));
  try {
    return await Promise.race([made, late]);
  } finally {
    clearTimeout(timer);
  }
}

/* The adapter's hub, made once its store attests: its prune runs from then, its wake only while someone listens. */
async function hubOf(registry: Registry, connection: string, adapter: Adapter): Promise<LiveHub | undefined> {
  return liveHubOf(adapter, { listen: await listenUrl(registry, connection, adapter) });
}

/* The URL a hub holds LISTEN on: the connection's `listen` URL behind a transaction pooler, else its own; none to poll. */
async function listenUrl(registry: Registry, connection: string, adapter: Adapter): Promise<string | undefined> {
  if (adapter.dialect !== 'postgres') return undefined;
  const config = registry.configOf(connection);
  if (!config) return undefined;
  try {
    const { url } = await resolveConnection(config.name, config.url, { secrets: true });
    const listen = config.listen ? (await resolveConnection(config.name, config.listen, { secrets: true })).url : undefined;
    return wakeListenUrl(url, postgresPoolDefaults().pooler, listen);
  } catch {
    return undefined;
  }
}
