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
 * names it, so two sources' `make` tables are two entries), by its key and label columns — and, where the field names a
 * column for its reader's locale (`labelColumns`), by that locale: a Spanish reader's options are not an English one's.
 */
import { createHash } from 'node:crypto';
import type { Registry } from '@mistriwork/engine/server/connections.js';
import { connectionHub, choiceTablesOf } from '../live/liveBinding.js';
import type { LiveHub, LiveTap } from '../live/liveHub.js';
import type { LiveAuthority, LiveGrant } from '../live/liveFilter.js';
import { bareTable } from '../../adapters/live/liveChange.js';
import type { CommandChoiceMatch, CommandChoiceSource, CommandChoiceTest } from '@mistriwork/engine/schema/model.js';
import type { Filter } from '@mistriwork/engine/shared/filter.js';
import { choiceOptions, type ChoiceLabel } from '../../shared/command.js';
import { choiceConditions } from '../commands/commandDefined.js';

/** At most this many rows are offered by a choice from a table (the client's SOURCED_MOST agrees). */
const CHOICE_ROWS_MOST = 200;

/** At most this many rows are served for a choice narrowed by one answer (`choiceNarrowing`'s lanes): each value of the
    column the answer is compared with given its own CHOICE_ROWS_MOST, so a form of many places is not cut to one. */
const CHOICE_SERVED_MOST = 2_000;

/** How a served choice's read is narrowed before it is cut: its `where`'s tests that read no answer, and, where every
    either-or of it compares one column with one answer, its rows laned by that column. */
interface ChoiceNarrowing {
  readonly filter?: Filter;
  readonly lanes?: { readonly by: string; readonly limit: number };
}

const readsAnswer = (test: CommandChoiceTest): boolean => test.values.some((value) => value !== null && typeof value === 'object');

/**
 * A served choice's `where` as its read can say it before any answer is given. A test that reads no answer holds for
 * every answer, so a row that fails it in every either-or is never offered: the read leaves it out, rather than the
 * page after a cut. And where every either-or reads one answer, by `column = answer`, the rows are read in lanes of
 * that column (adapter.ts lanesStatement), each value its own CHOICE_ROWS_MOST, so a value with many rows does not
 * crowd another's out of the cut; a null in that column meets no answer, so it is not read. Any other `where` is read
 * as one list, cut at CHOICE_ROWS_MOST.
 */
export function choiceNarrowing(match: CommandChoiceMatch | undefined): ChoiceNarrowing {
  if (!match?.length) return {};
  const answered = match.map((group) => group.filter(readsAnswer));
  const one = answered[0]?.[0];
  const laned =
    one &&
    answered.every(
      (tests) => tests.length === 1 && tests[0]!.operator === 'eq' && tests[0]!.values.length === 1 && tests[0]!.column === one.column,
    )
      ? one.column
      : undefined;
  const fixed = match.map((group) => [
    ...group.filter((test) => !readsAnswer(test)),
    ...(laned ? [{ column: laned, operator: 'ne' as const, values: [null] }] : []),
  ]);
  return {
    ...(fixed.every((tests) => tests.length) ? { filter: { groups: choiceConditions(fixed) } } : {}),
    ...(laned ? { lanes: { by: laned, limit: CHOICE_ROWS_MOST } } : {}),
  };
}

/** The most rows a served choice reads: one past what it serves, so a cut is known. */
export const choiceReadLimit = (narrowing: ChoiceNarrowing): number => (narrowing.lanes ? CHOICE_SERVED_MOST : CHOICE_ROWS_MOST) + 1;

interface TableChoice {
  readonly value: string | number;
  readonly label: string;
  /** The row's `where` columns, where the field narrows by other answers: the page filters by them itself. */
  readonly row?: Readonly<Record<string, string | number | boolean | null>>;
}

/** One table's choices as read: the options a form draws and their digest. A submission is judged by its own read. */
interface CachedChoices {
  readonly options: readonly TableChoice[];
  readonly etag: string;
  /** More rows were read than are served: the list is cut. */
  readonly cut: boolean;
}

/** What a choice reads: the resource its command's source resolves the field's table to, the table a write names,
    its key and label columns. */
interface ChoiceSourceRef {
  readonly resource: string;
  readonly physical: string;
  readonly by: string;
  readonly labelColumn: string;
  /** The order they are read in, when the field says one (`sort`); an entry per order, since the options are in it. */
  readonly sort?: CommandChoiceSource['sort'];
  /** The reader's locale's label column, where the field names one (`labelColumns`); an entry per locale. */
  readonly local?: ChoiceLabel;
  /** The columns its `where` compares (shared/command.ts choiceWhereColumns), served on each row; an entry per set. */
  readonly where?: readonly string[];
  /** How its read is narrowed before the cut (`choiceNarrowing`); an entry per narrowing. */
  readonly narrowing?: ChoiceNarrowing;
}

type ChoiceEntry = Pick<ChoiceSourceRef, 'resource' | 'by' | 'labelColumn' | 'sort' | 'local' | 'where' | 'narrowing'>;

/** The columns a choice reads: its key, its label, for a reader in a locale it names that locale's label, and the
    columns its `where` compares. */
export const choiceColumns = (source: { by: string; labelColumn: string; local?: ChoiceLabel; where?: readonly string[] }) => [
  ...new Set([source.by, source.labelColumn, ...(source.local ? [source.local.column] : []), ...(source.where ?? [])]),
];

/** The order a choice reads its rows in: the field's own `sort`, else the label column, ascending. */
export const choiceOrder = (source: { labelColumn: string; sort?: CommandChoiceSource['sort'] }) => [
  source.sort
    ? { column: source.sort.column, direction: source.sort.direction }
    : { column: source.labelColumn, direction: 'asc' as const },
];

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

/* The locale only where it names a column, so an unlocalized field keeps one entry for every reader. */
const localKey = (source: ChoiceEntry) => (source.local ? [source.local.locale, source.local.column] : []);

/* The `where` columns and the read's narrowing only where there are some, so a field that narrows nothing keeps the key
   it had. Two fields comparing the same columns with other values are two entries. */
const whereKey = (source: ChoiceEntry) =>
  source.where?.length
    ? [
        {
          where: source.where,
          ...(source.narrowing?.filter ? { filter: source.narrowing.filter } : {}),
          ...(source.narrowing?.lanes ? { lanes: source.narrowing.lanes } : {}),
        },
      ]
    : [];

const entryKey = (appId: string, connection: string, source: ChoiceEntry) =>
  JSON.stringify([
    appId,
    connection,
    source.resource,
    source.by,
    source.labelColumn,
    source.sort ?? null,
    ...localKey(source),
    ...whereKey(source),
  ]);

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

/* A row's `where` columns as JSON carries them: a date as its ISO text, a big number as its digits. */
const whereRow = (row: Readonly<Record<string, unknown>>, columns: readonly string[]) =>
  Object.fromEntries(
    columns.map((column) => {
      const value = row[column];
      return [
        column,
        value === undefined || value === null
          ? null
          : value instanceof Date
            ? value.toISOString()
            : typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
              ? value
              : String(value),
      ];
    }),
  ) as Record<string, string | number | boolean | null>;

/* A laned read's rows lane by lane, each lane in its read order and the lanes in one fixed order: the read gives them
   lane-number first, and rows of one number in no order between lanes, so the options (and their tag) would move
   between two reads of the same rows. The page narrows to one lane, whose order is kept. */
function byLane(rows: readonly Record<string, unknown>[], by: string): Record<string, unknown>[] {
  const lanes = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const lane = JSON.stringify(row[by] ?? null);
    const kept = lanes.get(lane);
    if (kept) kept.push(row);
    else lanes.set(lane, [row]);
  }
  return [...lanes.keys()].sort().flatMap((lane) => lanes.get(lane)!);
}

/** The choices as rows were read: each row's key its value and its label column (its reader's, where it has one) its words. */
function choicesOf(rows: readonly Record<string, unknown>[], source: ChoiceSourceRef): CachedChoices {
  const most = choiceReadLimit(source.narrowing ?? {}) - 1;
  const lanes = source.narrowing?.lanes;
  const keyed = (lanes ? byLane(rows.slice(0, most), lanes.by) : rows.slice(0, most)).filter(
    (row) => typeof row[source.by] === 'string' || typeof row[source.by] === 'number',
  );
  let options: readonly TableChoice[] = choiceOptions(keyed, source, source.local);
  if (source.where?.length) {
    /* By key, not position: a localized label reorders the options. */
    const where = source.where;
    const byKey = new Map(keyed.map((row) => [row[source.by], row]));
    options = options.map((option) => ({ ...option, row: whereRow(byKey.get(option.value) ?? {}, where) }));
  }
  const etag = createHash('sha256').update(JSON.stringify(options)).digest('base64url').slice(0, 22);
  return { options, etag, cut: rows.length > most };
}

/**
 * The choices of `source` for the App `appId` on `connection`, from the cache or read now by `read` (at most
 * `choiceReadLimit` rows, sorted by the label, or the field's `sort`). Kept only while the database's changes are heard; a read that a
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
  const choices = choicesOf(await options.read(), source);
  if (hearing && cache.tap && (cache.generations.get(physical) ?? 0) === generation) {
    cache.entries.set(key, { physical, choices });
  }
  return choices;
}

/** The choices the cache holds for `source` of the App `appId` on `connection`, or undefined; tests read it. */
export function cachedChoices(registry: Registry, connection: string, appId: string, source: ChoiceEntry): CachedChoices | undefined {
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

const tenantEntryKey = (appId: string, tenant: string, source: ChoiceEntry) =>
  JSON.stringify([
    appId,
    tenant,
    source.resource,
    source.by,
    source.labelColumn,
    source.sort ?? null,
    ...localKey(source),
    ...whereKey(source),
  ]);

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
 * tenant's visitor, at most `choiceReadLimit` rows, sorted by the label, or the field's `sort`). Kept only where `hub` hears the table's
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
  if (!hub || !options.tables.has(physical)) return choicesOf(await options.read(), source);
  const cache = tenantCache(hub, tenant);
  const key = tenantEntryKey(appId, tenant, source);
  const kept = cache.entries.get(key);
  if (kept) return kept.choices;
  const hearing = await listenTenant(hub, tenant, cache, options.tables);
  const generation = cache.generations.get(physical) ?? 0;
  const choices = choicesOf(await options.read(), source);
  if (hearing && cache.tap && (cache.generations.get(physical) ?? 0) === generation) cache.entries.set(key, { physical, choices });
  return choices;
}

/** The choices the cache holds for one tenant's `source` of the App `appId` behind `hub`, or undefined; tests read it. */
export function cachedTenantChoices(hub: LiveHub, appId: string, tenant: string, source: ChoiceEntry): CachedChoices | undefined {
  return tenantCaches
    .get(hub)
    ?.get(tenant)
    ?.entries.get(tenantEntryKey(appId, tenant, source))?.choices;
}
