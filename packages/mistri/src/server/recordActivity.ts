/**
 * A dashboard's activity feed, the server's half: the newest changes across
 * the resources one `activity()` section names, read from their record
 * history and answered for the reader in hand.
 *
 * It is record history read sideways, and answered by the same rule
 * (server/recordHistory.ts): a change is said only about a record this
 * reader can read now — through their own grants, row policy and scope, in
 * one read per resource of exactly the records the page of changes names —
 * and a field they may not read, or one `audit.redact` names, says that it
 * changed and nothing else. A record they cannot read is simply not in their
 * feed; its changes, its name and even that it changed never leave the
 * server. What the feed reads is the section's own list of resources, never a
 * list the request names: the request names the dashboard and the section.
 */
import type { Adapter } from '@mistriwork/engine/adapters/adapter.js';
import {
  historyKey,
  RecordHistoryUnavailable,
  type RecordActivityQuery,
  type StoredRecordChange,
} from '../adapters/history/recordHistory.js';
import { ACTIVITY_MAX, type AppDashSection, type AppDef } from '../shared/app.js';
import { columnCaption } from '@mistriwork/engine/shared/columnCaption.js';
import { appZone } from '../shared/appUi.js';
import { findTable, labelPath, primaryKey, type DatabaseSchema, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import type { PageDef } from '@mistriwork/engine/shared/page.js';
import { AppAccessDenied } from './app/appAccess.js';
import type { RuntimeResources } from './app/appRuntimeResources.js';
import { groupHistory, historyRules, projectFields, type HistoryEntry, type RecordHistoryStoreKey as StoreKey } from './recordHistory.js';
import { dispatchResourceReadHttp } from '@mistriwork/engine/server/resourceReadHttp.js';
import { APP_READS } from './app/appReads.js';
import { clockNow } from '@mistriwork/engine/server/http/clock.js';
import { storesOf } from './stores/appStores.js';
import { HttpError } from '@mistriwork/engine/server/http/reply.js';
import { opensTo } from '../shared/appViewRoles.js';
import { localeWeekStart } from '@mistriwork/engine/shared/weekStart.js';

/** The store capability a dialect adapter's App stores add for a feed (stores/appStores.ts); not on the public Adapter. */
interface ActivityStore {
  readRecordActivity(query: RecordActivityQuery): Promise<StoredRecordChange[]>;
}
const holdsActivity = (adapter: unknown): adapter is ActivityStore =>
  typeof adapter === 'object' && adapter !== null && typeof (adapter as ActivityStore).readRecordActivity === 'function';

/** One change in the feed, in the reader's terms: which record, by its name, and what the write did to it. */
export interface ActivityEntry extends HistoryEntry {
  /** The record's table, as the reader's catalog names it. */
  table: string;
  key: Record<string, unknown>;
  /** The record's name, read as the reader reads it. */
  label: string;
}

/* How many stored rows one read looks through: the feed is the newest changes
   the reader may read among these, so a reader who may read few of them sees
   fewer, never an older change reached by reading on. */
const LOOKED_THROUGH = 200;

/** The section a request names: a dashboard of this App the reader may open, and the index of an activity among its sections and aside. */
function sectionAt(app: AppDef, view: unknown, section: unknown, roles: readonly string[]): AppDashSection {
  const dashboard = typeof view === 'string' && Object.hasOwn(app.views, view) ? app.views[view] : undefined;
  /* A dashboard that names other roles is one this reader is never told of, so its feed answers as one that is not there. */
  if (
    !dashboard ||
    !('sections' in dashboard) ||
    !opensTo(dashboard, roles, app.auth) ||
    typeof section !== 'number' ||
    !Number.isSafeInteger(section)
  )
    throw new AppAccessDenied();
  const found = [...dashboard.sections, ...(dashboard.aside ?? [])][section];
  if (found?.kind !== 'activity') throw new AppAccessDenied();
  return found;
}

/** The periods a feed is read over, as its segmented control says them. */
const ACTIVITY_PERIODS = ['today', 'yesterday', 'week'] as const;

/* How far a zone's wall clock stands from UTC at an instant, in milliseconds. */
function zoneOffset(zone: string | undefined, at: Date): number {
  if (!zone) return -at.getTimezoneOffset() * 60_000;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const part = (type: string) => Number(parts.find((each) => each.type === type)?.value ?? 0);
  return (
    Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second')) -
    Math.floor(at.getTime() / 1000) * 1000
  );
}

/* The instant a day starts in a zone, `back` days before the day `now` is in there. */
function dayStart(zone: string | undefined, now: Date, back: number): Date {
  const wall = new Date(now.getTime() + zoneOffset(zone, now));
  const midnight = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate() - back);
  // The offset at midnight itself, which a change of clocks since may have moved.
  return new Date(midnight - zoneOffset(zone, new Date(midnight - zoneOffset(zone, now))));
}

/* The first day of a week where the App is read, Sunday at 0: Sunday in the US (the default here), Monday in most of the world. */
const weekStartsOn = (locale: string | undefined): number => localeWeekStart(locale ?? 'en-US') % 7;

/**
 * A period's bounds in the App's own day — its `ui.timezone` and the week its
 * `ui.locale` keeps — as the store writes `at`, so they compare as text. The
 * server says the day, as it does for "today" in a query, never the browser.
 */
export function activityBounds(period: unknown, ui: { timezone?: string; locale?: string }, now: Date): { from: string; to?: string } {
  if (!(ACTIVITY_PERIODS as readonly unknown[]).includes(period))
    throw new HttpError(400, `An activity's period is ${ACTIVITY_PERIODS.join(', ')}.`);
  const today = dayStart(ui.timezone, now, 0);
  if (period === 'today') return { from: today.toISOString() };
  if (period === 'yesterday') return { from: dayStart(ui.timezone, now, 1).toISOString(), to: today.toISOString() };
  const weekday = new Date(now.getTime() + zoneOffset(ui.timezone, now)).getUTCDay();
  return { from: dayStart(ui.timezone, now, (weekday - weekStartsOn(ui.locale) + 7) % 7).toISOString() };
}

/* A key as the store keeps it is its values as text; the record is read by
   them as the column's own type, so an integer key is asked as a number. */
function keyValue(table: TableMeta, column: string, text: string): string | number {
  const type = table.columns.find((candidate) => candidate.name === column)?.type ?? '';
  const n = Number(text);
  return /int|serial|numeric|decimal|number/i.test(type) && /^-?\d+$/.test(text) && Number.isSafeInteger(n) ? n : text;
}

/**
 * The records of one resource this reader can read, among `keys`, with their
 * names: one read through the reader's own adapter, the page's own read.
 */
async function readable(
  reader: Adapter,
  schema: DatabaseSchema,
  app: AppDef,
  resource: string,
  table: TableMeta,
  keys: ReadonlyMap<string, Record<string, string>>,
  storeKey?: StoreKey,
): Promise<Map<string, { key: Record<string, unknown>; label: string }>> {
  const pk = primaryKey(table);
  const found = new Map<string, { key: Record<string, unknown>; label: string }>();
  if (!pk.length || !keys.size) return found;
  const label = labelPath(
    schema,
    table,
    app.resources && Object.hasOwn(app.resources, resource) ? app.resources[resource].recordLabel : undefined,
  );
  const columns = [...new Set([...pk, ...(label ? [label] : []), ...(storeKey?.read(table.id) ?? [])])];
  // A stored key may name more than the record's key (a tenant record's owner): the record is asked by its key, once.
  const asked = new Map(
    [...keys.values()]
      .filter((key) => pk.every((column) => Object.hasOwn(key, column)))
      .map((key) => [JSON.stringify(pk.map((column) => key[column])), key]),
  );
  const groups = [...asked.values()].map((key) => pk.map((path) => ({ path, op: '=' as const, value: keyValue(table, path, key[path]) })));
  if (!groups.length) return found;
  const reply = await dispatchResourceReadHttp(
    '/api/view/run',
    {
      view: {
        id: `activity:${table.id}`,
        name: table.name,
        base: table.id,
        columns: columns.map((path) => ({ path })),
        filter: { groups },
        limit: groups.length,
      },
      count: 'none',
    },
    reader,
    schema,
    { app: APP_READS, now: clockNow },
  );
  const rows = (reply?.status === 200 ? (reply.body as { rows?: Array<Record<string, unknown>> }).rows : undefined) ?? [];
  for (const row of rows) {
    const key = Object.fromEntries(pk.map((column) => [column, row[column]]));
    const named =
      label && row[label] !== null && row[label] !== undefined && String(row[label]) !== ''
        ? String(row[label])
        : pk.map((column) => String(row[column])).join(', ');
    /* The key the store keeps this record's changes under, as the reader's
       context says it: on a tenant App, with the owner that context is, or
       the one the row read here says (tenantRecordHistoryStore.ts). A stored
       row under any other owner names a record this reader did not read. */
    found.set(historyKey(storeKey ? storeKey.key(table.id, key as Record<string, string | number>, row) : key), { key, label: named });
  }
  return found;
}

/**
 * The newest changes an activity section's resources have seen, for this
 * reader: at most fifty, over one of its periods. `reader` is the
 * reader's own adapter and `schema` their catalog; `mapping` and `open` reach
 * the physical stores, which are read before the reader's read of the records
 * the rows name, and nothing a row says is answered until that read has.
 */
export async function readRecordActivityFor(options: {
  app: AppDef;
  pages: readonly PageDef[];
  reader: Adapter;
  schema: DatabaseSchema;
  mapping: Pick<RuntimeResources, 'connectionFor' | 'toPhysical'>;
  open: (connection: string) => Promise<Adapter>;
  view: unknown;
  section: unknown;
  period: unknown;
  now: Date;
  /** The reader's roles: a dashboard naming none of them is not theirs to read (appViewRoles.ts). */
  roles: readonly string[];
  /** A tenant App's: the key a record's changes are kept under in the reader's context (record history's `storeKey`). */
  storeKey?: StoreKey;
  /** A tenant App's, in a tenant's context: the store reads that tenant's rows of its tenant-owned resources alone. */
  owners?: (physical: readonly string[]) => RecordActivityQuery['owners'];
  /** The reader's zone, where `ui.timezone` reads one (readerZone.ts): their today, their week. */
  zone?: string;
}): Promise<{ entries: ActivityEntry[] }> {
  const { app, reader, schema } = options;
  const section = sectionAt(app, options.view, options.section, options.roles);
  const { from, to } = activityBounds(options.period, { timezone: appZone(app.ui, options.zone), locale: app.ui.locale }, options.now);
  const kept = historyRules(app, options.pages);
  /* The section's resources the reader's catalog holds: one their grant leaves out has no feed for them. */
  const resources = Object.keys(section.resources ?? {}).flatMap((resource) => {
    const table = kept.has(resource) ? findTable(schema, resource) : undefined;
    return table
      ? [{ resource, table, physical: options.mapping.toPhysical(resource), connection: options.mapping.connectionFor(resource) }]
      : [];
  });
  if (!resources.length) return { entries: [] };
  const byConnection = new Map<string, typeof resources>();
  for (const each of resources) byConnection.set(each.connection, [...(byConnection.get(each.connection) ?? []), each]);
  const rows: Array<StoredRecordChange & { from: (typeof resources)[number] }> = [];
  for (const [connection, here] of byConnection) {
    const store = storesOf(await options.open(connection));
    if (!holdsActivity(store)) throw new RecordHistoryUnavailable();
    const physical = [...new Set(here.map((each) => each.physical))];
    const owners = options.owners?.(physical);
    const read = await store.readRecordActivity({
      resources: physical,
      limit: LOOKED_THROUGH,
      from,
      ...(to === undefined ? {} : { to }),
      ...(owners ? { owners } : {}),
    });
    for (const row of read) {
      const owner = here.find((each) => each.physical === row.resource);
      if (owner) rows.push({ ...row, from: owner });
    }
  }
  // Newest first across stores; within one store, the order the rows were appended.
  rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.id - a.id));
  /* One entry per record per write, as a record's own history groups them. */
  const writes = new Map<string, typeof rows>();
  for (const row of rows) {
    const id = `${row.from.connection}\u0000${row.writeId}\u0000${row.from.resource}\u0000${row.key}`;
    writes.set(id, [...(writes.get(id) ?? []), row]);
  }
  /* The records named, per resource, read as the reader reads them. */
  const named = new Map<string, Map<string, { key: Record<string, unknown>; label: string }>>();
  for (const { resource, table } of resources) {
    const keys = new Map<string, Record<string, string>>();
    for (const row of rows) {
      if (row.from.resource !== resource || keys.has(row.key)) continue;
      try {
        keys.set(row.key, JSON.parse(row.key) as Record<string, string>);
      } catch {
        /* a key that is not a document names no record */
      }
    }
    named.set(resource, await readable(reader, schema, app, resource, table, keys, options.storeKey));
  }
  const entries: ActivityEntry[] = [];
  for (const group of writes.values()) {
    const { from: source, key } = group[0];
    const record = named.get(source.resource)?.get(key);
    if (!record) continue;
    const [entry] = groupHistory(group);
    if (!entry) continue;
    const caption = (column: string) => columnCaption(app.resources ?? {}, schema, source.resource, column);
    const { changes, ...said } = entry;
    entries.push({
      ...said,
      table: source.table.id,
      key: record.key,
      label: record.label,
      fields: projectFields(changes, source.table, caption, entry.kind),
    });
    if (entries.length >= ACTIVITY_MAX) break;
  }
  return { entries };
}
