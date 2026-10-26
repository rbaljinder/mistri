/**
 * The shared cache of choices read from a table (`field.choice({ from, label })`): the rows a form offers, read once
 * and kept until one of them changes — never for a time. Live sync's change capture is the signal: a write to a table
 * some form offers rows of always writes its change row, `live` or not (live/liveBinding.ts captures only those
 * tables where no App follows its changes), and this cache listens on that database's hub as one more subscriber, so
 * a commit in this process (the nudge), in another process on PostgreSQL (NOTIFY) or on the same SQLite file (its
 * poll) drops the entry. The next read reads again.
 *
 * Shared only where every reader would be answered the same rows: the public principal of an ordinary App (a public
 * read is `rows: 'all'`), and a signed-in reader of an App without a row policy or tenants. A row-policy App's choices
 * are read per request under the person's own grants and never kept here. A tenant App's public form is answered its
 * choices as that tenant's visitor reads them (`auth.public`), kept per tenant (`tenantChoices` below).
 *
 * Where the capture is not on — the change store not provisioned, `--no-live`, a database that keeps none — nothing
 * is kept: a read reads every time, so a cache can never outlive a change it cannot hear of.
 *
 * The cache serves the form's GET only: the options it is drawn with. A submission never asks it: each chosen key is
 * read by its primary key in the command's own transaction (commands/commandDefined.ts `sourcedChoiceBreak`), so a row
 * deleted or hidden since — even behind the change capture's back — is refused at its field.
 *
 * An entry is the App's, on one connection, of one resolved resource (the field's table as its command's source
 * names it, so two sources' `make` tables are two entries), by its key and label columns.
 */
import { createHash } from 'node:crypto';
import type { Registry } from '@mistriwork/engine/server/connections.js';
import { connectionHub, choiceTablesOf } from '../live/liveBinding.js';
import type { LiveHub, LiveTap } from '../live/liveHub.js';
import type { LiveAuthority, LiveGrant } from '../live/liveFilter.js';
import { bareTable } from '../../adapters/live/liveChange.js';

/** At most this many rows are offered by a choice from a table (the client's SOURCED_MOST agrees). */
export const CHOICE_ROWS_MOST = 200;

interface TableChoice {
  readonly value: string | number;
  readonly label: string;
}

/** One table's choices as read: the options a form draws and their digest. A submission is judged by its own read. */
interface CachedChoices {
  readonly options: readonly TableChoice[];
  readonly etag: string;
}

/** What a choice reads: the resource its command's source resolves the field's table to, the table a write names,
    its key and label columns. */
interface ChoiceSourceRef {
  readonly resource: string;
  readonly physical: string;
  readonly by: string;
  readonly labelColumn: string;
}

interface Kept {
  /** The table bare, as the hub's deliveries name it. */
  readonly physical: string;
  readonly choices: CachedChoices;
}

/** One database's cache in one registry: its entries, the generation each table is at, and its subscription. */
interface DatabaseCache {
  readonly entries: Map<string, Kept>;
  readonly generations: Map<string, number>;
  tap?: LiveTap;
  hub?: LiveHub;
  listening?: Promise<boolean>;
}

const caches = new WeakMap<Registry, Map<string, DatabaseCache>>();

const entryKey = (appId: string, connection: string, source: Pick<ChoiceSourceRef, 'resource' | 'by' | 'labelColumn'>) =>
  JSON.stringify([appId, connection, source.resource, source.by, source.labelColumn]);

function databaseCache(registry: Registry, connection: string): DatabaseCache {
  let connections = caches.get(registry);
  if (!connections) caches.set(registry, (connections = new Map()));
  let cache = connections.get(connection);
  if (!cache) connections.set(connection, (cache = { entries: new Map(), generations: new Map() }));
  return cache;
}

/* A table's writes: its generation moves, so a read begun before is not kept, and its entries go. */
function drop(cache: Pick<DatabaseCache, 'entries' | 'generations'>, physical: string | 'all'): void {
  for (const [key, kept] of cache.entries) {
    if (physical !== 'all' && kept.physical !== physical) continue;
    cache.entries.delete(key);
  }
  if (physical === 'all')
    for (const table of cache.generations.keys()) cache.generations.set(table, (cache.generations.get(table) ?? 0) + 1);
  else cache.generations.set(physical, (cache.generations.get(physical) ?? 0) + 1);
}

class BareGrants extends Map<string, LiveGrant> {
  override get(table: string): LiveGrant | undefined {
    return super.get(table) ?? super.get(bareTable(table));
  }
}

/* Subscribed to the database's hub as one more reader, of the choice tables only, whole: what it is told is which
   tables changed, and that is all it needs. */
function listen(registry: Registry, connection: string, cache: DatabaseCache): Promise<boolean> {
  if (cache.tap) return Promise.resolve(true);
  if (cache.listening) return cache.listening;
  cache.listening = (async () => {
    const answer = await connectionHub(registry, connection);
    if (!('hub' in answer)) return false;
    const tap: LiveTap = {
      authority: async (): Promise<LiveAuthority> => {
        /* Named bare (`make`): a change row may name the table either way (`make`, `public.make`). */
        const tables = new BareGrants();
        for (const table of choiceTablesOf(registry, connection))
          tables.set(table, { id: table, key: [], columns: 'all', scope: true, fingerprint: '' });
        return { actor: '', tables, probe: async () => new Set() };
      },
      receive: (delivery) => {
        for (const table of delivery.tables.keys()) drop(cache, table);
      },
      placed: () => {},
      // Its place in the store is gone: whatever changed meanwhile is unknown, so everything goes.
      reset: () => drop(cache, 'all'),
      fail: () => {
        if (cache.tap === tap) {
          cache.tap = undefined;
          cache.hub = undefined;
        }
        drop(cache, 'all');
      },
    };
    try {
      await answer.hub.attach(tap);
    } catch {
      return false;
    }
    cache.tap = tap;
    cache.hub = answer.hub;
    return true;
  })().finally(() => {
    cache.listening = undefined;
  });
  return cache.listening;
}

/** The choices as rows were read: each row's key its value and its label column its words. */
function choicesOf(rows: readonly Record<string, unknown>[], by: string, labelColumn: string): CachedChoices {
  const options: TableChoice[] = [];
  for (const row of rows.slice(0, CHOICE_ROWS_MOST)) {
    const value = row[by];
    if (typeof value === 'string' || typeof value === 'number') options.push({ value, label: String(row[labelColumn] ?? value) });
  }
  const etag = createHash('sha256').update(JSON.stringify(options)).digest('base64url').slice(0, 22);
  return { options, etag };
}

/**
 * The choices of `source` for the App `appId` on `connection`, from the cache or read now by `read` (at most
 * CHOICE_ROWS_MOST + 1 rows, sorted by the label). Kept only while the database's changes are heard; a read that a
 * change overtook is answered but not kept.
 */
export async function sharedChoices(options: {
  registry: Registry;
  appId: string;
  connection: string;
  source: ChoiceSourceRef;
  read: () => Promise<readonly Record<string, unknown>[]>;
}): Promise<CachedChoices> {
  const { registry, appId, connection, source } = options;
  const cache = databaseCache(registry, connection);
  const key = entryKey(appId, connection, source);
  const kept = cache.entries.get(key);
  if (kept) return kept.choices;
  const hearing = choiceTablesOf(registry, connection).has(bareTable(source.physical)) && (await listen(registry, connection, cache));
  const physical = bareTable(source.physical);
  const generation = cache.generations.get(physical) ?? 0;
  const choices = choicesOf(await options.read(), source.by, source.labelColumn);
  if (hearing && cache.tap && (cache.generations.get(physical) ?? 0) === generation) {
    cache.entries.set(key, { physical, choices });
  }
  return choices;
}

/** The choices the cache holds for `source` of the App `appId` on `connection`, or undefined; tests read it. */
export function cachedChoices(
  registry: Registry,
  connection: string,
  appId: string,
  source: Pick<ChoiceSourceRef, 'resource' | 'by' | 'labelColumn'>,
): CachedChoices | undefined {
  return caches
    .get(registry)
    ?.get(connection)
    ?.entries.get(entryKey(appId, connection, source))?.choices;
}

/** For tests and a closing server: forget every entry of the registry's databases and leave every hub. */
export function clearChoiceCache(registry: Registry): void {
  for (const cache of caches.get(registry)?.values() ?? []) {
    if (cache.tap) cache.hub?.detach(cache.tap);
    cache.tap = undefined;
    cache.hub = undefined;
    drop(cache, 'all');
  }
}

/*
 * A tenant App's public forms: each tenant's choices, as that tenant's visitor reads them under `auth.public`, kept
 * apart by tenant — the tenant is in every entry's key — and dropped by that tenant's writes alone. The deployment's
 * hub (tenant/tenantLive.ts) delivers an entry of a tenant-owned table only to a subscriber of the tenant that owns the
 * row, so each tenant kept here has a subscription of its own, told of its own changes and of nobody else's: a row
 * change in one tenant leaves every other tenant's entry where it is. Only tenant-owned choice tables are kept (a
 * global table names no tenant, so no tenant would hear of its writes); any other is read every time.
 *
 * At most TENANTS_MOST tenants are kept at once, the least recently asked leaving first with its subscription.
 */
const TENANTS_MOST = 256;

interface TenantCache {
  readonly entries: Map<string, Kept>;
  readonly generations: Map<string, number>;
  tap?: LiveTap;
  listening?: Promise<boolean>;
}

const tenantCaches = new WeakMap<LiveHub, Map<string, TenantCache>>();

const tenantEntryKey = (appId: string, tenant: string, source: Pick<ChoiceSourceRef, 'resource' | 'by' | 'labelColumn'>) =>
  JSON.stringify([appId, tenant, source.resource, source.by, source.labelColumn]);

/* The tenant's cache, made the most recently asked; one past the bound sends the least recently asked away. */
function tenantCache(hub: LiveHub, tenant: string): TenantCache {
  let tenants = tenantCaches.get(hub);
  if (!tenants) tenantCaches.set(hub, (tenants = new Map()));
  let cache = tenants.get(tenant);
  if (cache) tenants.delete(tenant);
  else cache = { entries: new Map(), generations: new Map() };
  tenants.set(tenant, cache);
  while (tenants.size > TENANTS_MOST) {
    const [oldest, gone] = tenants.entries().next().value as [string, TenantCache];
    tenants.delete(oldest);
    if (gone.tap) hub.detach(gone.tap);
    gone.tap = undefined;
    drop(gone, 'all');
  }
  return cache;
}

/* Subscribed as one reader of this tenant's: the hub tells it of entries of this tenant's rows, of the choice tables. */
function listenTenant(hub: LiveHub, tenant: string, cache: TenantCache, tables: ReadonlySet<string>): Promise<boolean> {
  if (cache.tap) return Promise.resolve(true);
  if (cache.listening) return cache.listening;
  cache.listening = (async () => {
    const tap: LiveTap = {
      authority: async (): Promise<LiveAuthority> => {
        const grants = new BareGrants();
        for (const table of tables) grants.set(table, { id: table, key: [], columns: 'all', scope: true, fingerprint: '' });
        return { actor: '', tenant, tables: grants, probe: async () => new Set() };
      },
      receive: (delivery) => {
        for (const table of delivery.tables.keys()) drop(cache, table);
      },
      placed: () => {},
      reset: () => drop(cache, 'all'),
      fail: () => {
        if (cache.tap === tap) cache.tap = undefined;
        drop(cache, 'all');
      },
    };
    try {
      await hub.attach(tap);
    } catch {
      return false;
    }
    /* Sent away while it was subscribing: it leaves again at once. */
    if (tenantCaches.get(hub)?.get(tenant) !== cache) {
      hub.detach(tap);
      return false;
    }
    cache.tap = tap;
    return true;
  })().finally(() => {
    cache.listening = undefined;
  });
  return cache.listening;
}

/**
 * One tenant's choices of `source` on a tenant App's public form, from the cache or read now by `read` (as that
 * tenant's visitor, at most CHOICE_ROWS_MOST + 1 rows, sorted by the label). Kept only where `hub` hears the table's
 * writes — `tables`, the tenant-owned choice tables its writer captures — and a read that a change overtook is
 * answered but not kept.
 */
export async function tenantChoices(options: {
  hub: LiveHub | undefined;
  tables: ReadonlySet<string>;
  appId: string;
  tenant: string;
  source: ChoiceSourceRef;
  read: () => Promise<readonly Record<string, unknown>[]>;
}): Promise<CachedChoices> {
  const { hub, appId, tenant, source } = options;
  const physical = bareTable(source.physical);
  if (!hub || !options.tables.has(physical)) return choicesOf(await options.read(), source.by, source.labelColumn);
  const cache = tenantCache(hub, tenant);
  const key = tenantEntryKey(appId, tenant, source);
  const kept = cache.entries.get(key);
  if (kept) return kept.choices;
  const hearing = await listenTenant(hub, tenant, cache, options.tables);
  const generation = cache.generations.get(physical) ?? 0;
  const choices = choicesOf(await options.read(), source.by, source.labelColumn);
  if (hearing && cache.tap && (cache.generations.get(physical) ?? 0) === generation) cache.entries.set(key, { physical, choices });
  return choices;
}

/** The choices the cache holds for one tenant's `source` of the App `appId` behind `hub`, or undefined; tests read it. */
export function cachedTenantChoices(
  hub: LiveHub,
  appId: string,
  tenant: string,
  source: Pick<ChoiceSourceRef, 'resource' | 'by' | 'labelColumn'>,
): CachedChoices | undefined {
  return tenantCaches
    .get(hub)
    ?.get(tenant)
    ?.entries.get(tenantEntryKey(appId, tenant, source))?.choices;
}
