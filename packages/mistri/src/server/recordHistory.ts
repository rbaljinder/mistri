/**
 * Record history, the server's half: which of an App's tables keep a history,
 * binding that to the physical adapters that write them, and answering one
 * record's history for one reader.
 *
 * A resource keeps a history when one of the App's pages over it shows a
 * `history()` section (or it has flows, which start on its changes) — declaring the section is what turns the log on, so an
 * App never keeps a log nobody can read, and never shows one it does not
 * keep. The store is provisioned once, never on startup; an App that shows a
 * history over a database without it does not start, and the refusal names
 * the call that provisions it.
 *
 * Reading is answered for the reader in hand, never from the store's view:
 * the record must be one this reader can read now, through their own grants,
 * row policy and scope (the same read that opens its page), or the answer is
 * the opaque refusal a hidden record gets. A field the reader may not read
 * says that it changed and nothing else, as a redacted one does; its values
 * never leave the server. History belongs to the record, so a reader who can
 * see a record sees its past too — where a record moved into their scope, that
 * includes its values from before it did, as ServiceNow and Linear show them.
 * A record's key reused after a delete starts a new history (the stores read
 * only past the key's last delete).
 */
import type { Adapter } from '@mistriwork/engine/adapters/adapter.js';
import { bindRecordHistory } from './stores/writeCaptures.js';
import { storesOf } from './stores/appStores.js';
import { AppAccessDenied } from './app/appAccess.js';
import {
  RecordHistoryUnavailable,
  historyKey,
  recordHistoryBinding as recordHistoryBound,
  RECORD_HISTORY_PAGE,
  type RecordHistoryBinding,
  type RecordHistoryQuery,
  type RecordHistoryRule,
  type StoredChange,
  type StoredRecordChange,
} from '../adapters/history/recordHistory.js';
import type { WriteVia } from '@mistriwork/engine/adapters/writeAttribution.js';
import { isFormView, type AppDashSection, type AppDef } from '../shared/app.js';
import { humanName } from '@mistriwork/engine/shared/model.js';
import { tokenColumns } from '../shared/appSavedForms.js';
import { columnCaption } from '@mistriwork/engine/shared/columnCaption.js';
import { findTable, primaryKey, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import type { PageDef } from '@mistriwork/engine/shared/page.js';
import type { Registry } from '@mistriwork/engine/server/connections.js';
import type { AppHost, LoadedApp } from './app/apps.js';
import { loadAppRuntimeResources, type RuntimeResources } from './app/appRuntimeResources.js';
import { appEntrypoint } from './app/appEntrypoint.js';
import { HttpError } from '@mistriwork/engine/server/http/reply.js';
import { versionColumn } from './commands/commandRevision.js';

/** The adapter capabilities a store-holding engine adds; none is on the public Adapter. */
interface HistoryStore {
  recordHistoryReady(): Promise<boolean>;
  readRecordHistory(query: RecordHistoryQuery): Promise<StoredRecordChange[]>;
}
const holdsHistory = (adapter: unknown): adapter is HistoryStore =>
  typeof adapter === 'object' &&
  adapter !== null &&
  typeof (adapter as HistoryStore).recordHistoryReady === 'function' &&
  typeof (adapter as HistoryStore).readRecordHistory === 'function';

/** The App's resources whose record pages show a history, or a dashboard's activity reads, and what each keeps of its values. */
export function historyRules(app: AppDef, pages: readonly PageDef[]): Map<string, RecordHistoryRule> {
  const rules = new Map<string, RecordHistoryRule>();
  /* A saved form's token hashes are the server's (savedForms.ts, formLink.ts):
     the log says the resume or the claim changed, never what it held. */
  const tokens = Object.values(app.views ?? {}).flatMap((view) => (isFormView(view) ? tokenColumns(view) : []));
  const keep = (resource: string) => {
    const redact = app.resources?.[resource]?.audit?.redact;
    // A hidden column's values (and a file's object and hash, the server's) are never the App's to keep, so the log keeps only that it changed.
    const file = app.resources?.[resource]?.file;
    const hidden = [
      ...(app.resources?.[resource]?.hidden ?? []),
      ...(file?.object ? [file.object] : []),
      ...(file?.hash ? [file.hash] : []),
    ];
    rules.set(resource, { redact: redact === 'values' ? 'values' : new Set([...(redact ?? []), ...hidden, ...tokens]) });
  };
  for (const page of pages) {
    if (page.sections.some((section) => section.kind === 'history')) keep(page.base);
  }
  /* A feed of recent changes is read from the same log, so naming a resource in
     one turns its log on as a page's history() does: never a log nobody reads. */
  for (const section of activitySections(app)) for (const resource of Object.keys(section.resources ?? {})) keep(resource);
  /* Flows start on a record's changes (appFlows.ts), read from its log: a
     resource with flows keeps one, whether or not a page shows it. */
  for (const [resource, def] of Object.entries(app.resources ?? {})) if (def.flows) keep(resource);
  return rules;
}

/** Every dashboard section of the App that is an activity feed, main flow and aside alike. */
function activitySections(app: AppDef): AppDashSection[] {
  return Object.values(app.views ?? {}).flatMap((view) =>
    'sections' in view ? [...view.sections, ...(view.aside ?? [])].filter((section) => section.kind === 'activity') : [],
  );
}

/* Per registry: each connection's tables, by App, merged into the one
   binding its adapter records by, and the adapters already found to hold the
   store. A reconnect's adapter is bound as it is dialed, before anything can
   write through it. */
interface RegistryHistory {
  byConnection: Map<string, Map<string, RecordHistoryBinding>>;
  attested: WeakSet<object>;
}
const registries = new WeakMap<Registry, RegistryHistory>();

function registryHistory(registry: Registry): RegistryHistory {
  let state = registries.get(registry);
  if (state) return state;
  state = { byConnection: new Map(), attested: new WeakSet() };
  registries.set(registry, state);
  const known = state;
  registry.onAdapterDialed((connection, adapter) => {
    const byApp = known.byConnection.get(connection);
    if (byApp) bindRecordHistory(adapter, mergedBinding(byApp));
  });
  return state;
}

function mergedBinding(byApp: Map<string, RecordHistoryBinding>): RecordHistoryBinding {
  const merged = new Map<string, RecordHistoryRule>();
  for (const binding of byApp.values()) {
    for (const [table, rule] of binding) {
      const known = merged.get(table);
      // Two Apps over one table: each keeps what the stricter one keeps.
      if (!known || rule.redact === 'values') merged.set(table, rule);
      else if (known.redact !== 'values')
        merged.set(table, { redact: new Set([...known.redact, ...(rule.redact as ReadonlySet<string>)]) });
    }
  }
  return merged;
}

/**
 * What a rule is told is bookkeeping on its table. The one thing the platform
 * itself advances on a write is the table's revision column (commandRevision.ts);
 * no other column is declared as plumbing in an App, so none is assumed to be:
 * an `updated_at` is the App's to stamp (appStamps.ts) and is a change like any other.
 */
export function withBookkeeping(
  rule: RecordHistoryRule,
  table: { readonly columns: readonly { readonly name: string; readonly type: string; readonly nullable: boolean }[] } | undefined,
): RecordHistoryRule {
  const revision = versionColumn(table?.columns);
  return revision ? { ...rule, bookkeeping: new Set([revision]) } : rule;
}

const said = (binding: RecordHistoryBinding) =>
  JSON.stringify(
    [...binding]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([table, rule]) => [table, rule.redact === 'values' ? 'values' : [...rule.redact].sort(), [...(rule.bookkeeping ?? [])].sort()]),
  );

/**
 * Bind an App's history tables to the physical adapters behind its resources.
 * Idempotent and cheap when nothing changed, so it runs on every App request
 * as well as at startup: a reloaded App's new sections bind before its next
 * write. Refuses, naming the provisioning call, where the store is missing.
 */
async function bindAppRecordHistory(
  registry: Registry,
  loaded: Pick<LoadedApp, 'app' | 'pages'>,
  resources: Pick<RuntimeResources, 'connections' | 'connectionFor' | 'toPhysical' | 'schema'>,
): Promise<void> {
  const rules = historyRules(loaded.app, loaded.pages);
  const state = registries.get(registry);
  if (!rules.size && !state) return;
  const history = registryHistory(registry);
  const perConnection = new Map<string, Map<string, RecordHistoryRule>>(resources.connections.map((connection) => [connection, new Map()]));
  for (const [resource, rule] of rules)
    perConnection
      .get(resources.connectionFor(resource))
      ?.set(resources.toPhysical(resource), withBookkeeping(rule, findTable(resources.schema, resource)));
  for (const [connection, binding] of perConnection) {
    const byApp = history.byConnection.get(connection) ?? new Map<string, RecordHistoryBinding>();
    const was = byApp.get(loaded.app.id);
    if (!binding.size && !was) continue;
    const { adapter } = await registry.open(connection);
    const next = new Map(byApp);
    if (binding.size) next.set(loaded.app.id, binding);
    else next.delete(loaded.app.id);
    const merged = mergedBinding(next);
    if (merged.size && !history.attested.has(adapter)) {
      const store = storesOf(adapter);
      if (!holdsHistory(store) || !(await store.recordHistoryReady())) {
        throw new RecordHistoryUnavailable(historyUnavailable(connection, adapter.dialect));
      }
      history.attested.add(adapter);
    }
    if (was && binding.size && said(was) === said(binding) && recordHistoryBound(adapter)) continue;
    history.byConnection.set(connection, next);
    bindRecordHistory(adapter, merged);
  }
}

const ensured = new WeakMap<Registry, WeakMap<AppDef, readonly PageDef[]>>();

/**
 * Bind a served App's history tables once per load of it: at startup, and on
 * the first request after a reload changes its definition or pages. Every
 * request passes through here before any route can write, commands and
 * row-policy writes included, so none can reach a table before it records.
 */
export async function ensureAppRecordHistory(registry: Registry, host: AppHost): Promise<void> {
  const { app, pages } = host.app;
  let seen = ensured.get(registry);
  if (!seen) ensured.set(registry, (seen = new WeakMap()));
  if (seen.get(app) === pages) return;
  // Nothing to bind and nothing bound before: no reason to open a connection.
  if (!historyRules(app, pages).size && !registries.has(registry)) {
    seen.set(app, pages);
    return;
  }
  const entry = appEntrypoint(host, registry);
  if (!entry) return;
  const releases: Array<() => void> = [];
  try {
    const resources = await loadAppRuntimeResources(registry, app, entry, (owner) => releases.push(registry.lease(owner)));
    await bindAppRecordHistory(registry, host.app, resources);
  } finally {
    for (const release of releases.reverse()) release();
  }
  seen.set(app, pages);
}

/* The refusal names the one call that provisions the store, as the command
   journal's does. The URL or path is the operator's to supply — a URL carries
   a password and never belongs in a log. */
function historyUnavailable(connection: string, dialect: string): string {
  const at = `An App page shows a record history, and the record history store on connection "${connection}" is unavailable`;
  const call =
    dialect === 'sqlite'
      ? "provisionStores({ sqlite: '<the database file>' }, { only: ['record-history'] })"
      : dialect === 'postgres'
        ? "provisionStores({ postgres: '<the connection's URL>' }, { only: ['record-history'] }), as a role that may create tables"
        : dialect === 'mysql'
          ? "provisionStores({ mysql: '<the connection's URL>' }, { only: ['record-history'] }), as a user that may create tables"
          : undefined;
  if (!call) return `${at}: record history is kept in SQLite, PostgreSQL or MySQL, and this connection is ${dialect}.`;
  return (
    `${at}: it is provisioned once, never on startup. Run \`mistri migrate stores up --app <the App's directory>\` ` +
    `with the server stopped, or ${call} from @mistriwork/mistri/maintenance, then start again.`
  );
}

/* ---------- one record's history, for one reader ---------- */

/** One field in one entry, in the reader's terms. */
export interface HistoryField {
  column: string;
  before?: string | number | boolean | null;
  after?: string | number | boolean | null;
  /** Changed, and the reader may not read it: no values. */
  hidden?: true;
  /** Changed, and the App keeps no values for it (`audit.redact`). */
  redacted?: true;
  /** A value cut to the store's limit. */
  cut?: true;
  /** A caption the reader's catalog cannot give, for a field they may not read. */
  label?: string;
}

export interface HistoryEntry {
  at: string;
  kind: 'insert' | 'update';
  via: WriteVia;
  action?: string;
  /** What the person who made the write was called when they made it. Never their email: the store keeps
      the account, and no reader of a history is shown it. Absent where no name was kept ("Someone"). */
  by?: string;
  fields: HistoryField[];
}

interface HistoryReply {
  entries: HistoryEntry[];
  more?: number;
}

/** Merge a record's rows into one entry per write, newest first. Rows arrive newest first. */
export function groupHistory(rows: readonly StoredRecordChange[]): Array<Omit<HistoryEntry, 'fields'> & { changes: StoredChange[] }> {
  const groups: Array<Omit<HistoryEntry, 'fields'> & { writeId: string; changes: StoredChange[] }> = [];
  for (const row of rows) {
    if (row.kind === 'delete') continue;
    const last = groups[groups.length - 1];
    if (last && last.writeId === row.writeId) {
      // Rows of one write, read newest first: an older row supplies each field's before, a newer one its after.
      for (const older of row.changes) {
        const newer = last.changes.find((item) => item.c === older.c);
        if (!newer) last.changes.unshift(older);
        else if (!newer.r && !older.r && Object.hasOwn(older, 'b')) newer.b = older.b;
      }
      if (row.kind === 'insert') last.kind = 'insert';
      continue;
    }
    groups.push({
      writeId: row.writeId,
      at: row.at,
      kind: row.kind,
      via: row.via,
      ...(row.action ? { action: row.action } : {}),
      ...(row.actorName ? { by: row.actorName } : {}),
      changes: row.changes.map((item) => ({ ...item })),
    });
  }
  return groups.map(({ writeId: _writeId, ...entry }) => entry);
}

/**
 * The reader's view of one entry's fields: a column they cannot read says that it changed, and no more. What is
 * plumbing is not said at all: the table's revision column (commandRevision.ts), which every write advances and no
 * person sets, and, on a record's creation, the columns the reader cannot read — a creation sets every column, and
 * "Tenant changed, Caller account changed" says nothing a reader can act on.
 */
export function projectFields(
  changes: readonly StoredChange[],
  table: { readonly columns: readonly { readonly name: string; readonly type: string; readonly nullable: boolean }[] },
  caption: (column: string) => string,
  kind: HistoryEntry['kind'],
): HistoryField[] {
  const readable = new Set(table.columns.map((column) => column.name));
  /* A revision column the reader's grant leaves out is still the revision: it goes by the one name (commandRevision.ts). */
  const revision = versionColumn(table.columns) ?? (readable.has('version') ? undefined : 'version');
  const said = changes.filter((item) => item.c !== revision && (kind !== 'insert' || readable.has(item.c)));
  return said.map((item) => {
    if (!readable.has(item.c)) return { column: item.c, hidden: true as const, label: caption(item.c) };
    if (item.r) return { column: item.c, redacted: true as const };
    return {
      column: item.c,
      ...(Object.hasOwn(item, 'b') ? { before: item.b } : {}),
      ...(Object.hasOwn(item, 'a') ? { after: item.a } : {}),
      ...(item.t ? { cut: true as const } : {}),
    };
  });
}

export function exactKey(schema: DatabaseSchema, table: string, raw: unknown): Record<string, string | number> {
  const meta = findTable(schema, table);
  const columns = meta && primaryKey(meta);
  if (!columns?.length || !raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AppAccessDenied();
  const key = raw as Record<string, unknown>;
  if (
    Object.keys(key).length !== columns.length ||
    columns.some(
      (column) =>
        !Object.hasOwn(key, column) ||
        !(typeof key[column] === 'string' || (typeof key[column] === 'number' && Number.isFinite(key[column]))),
    )
  )
    throw new AppAccessDenied();
  return Object.fromEntries(columns.map((column) => [column, key[column] as string | number]));
}

/** The key a record's changes are kept under, where it is more than the
 * record's key: a tenant App's (tenant/tenantRecordHistoryStore.ts). `read`
 * names the columns the record's read must also return for `key` to say it. */
export interface RecordHistoryStoreKey {
  read(table: string): string[];
  key(table: string, key: Record<string, string | number>, row: Record<string, unknown>): Record<string, unknown>;
}

/**
 * One record's history for this reader. `reader` is the reader's own adapter
 * (grants, row policy, scope), `schema` their catalog; `mapping` and `open`
 * reach the physical store, and only after the reader has read the record.
 */
export async function readRecordHistoryFor(options: {
  app: AppDef;
  pages: readonly PageDef[];
  reader: Adapter;
  schema: DatabaseSchema;
  mapping: Pick<RuntimeResources, 'connectionFor' | 'toPhysical'>;
  open: (connection: string) => Promise<Adapter>;
  table: unknown;
  key: unknown;
  before?: unknown;
  limit?: unknown;
  /** A tenant App's store key (tenant/tenantRecordHistoryStore.ts): the columns the visibility read also
      returns, and the record's key with its owner, from the reader's context or the row it read. */
  storeKey?: RecordHistoryStoreKey;
}): Promise<HistoryReply> {
  const { app, reader, schema } = options;
  if (typeof options.table !== 'string') throw new AppAccessDenied();
  const table = options.table;
  // Only a resource whose page shows a history keeps one; the rest have none to read.
  if (!historyRules(app, options.pages).has(table) || !findTable(schema, table)) throw new AppAccessDenied();
  const key = exactKey(schema, table, options.key);
  const limit = options.limit === undefined ? 20 : options.limit;
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > RECORD_HISTORY_PAGE)
    throw new HttpError(400, 'Invalid history page size.');
  if (options.before !== undefined && (typeof options.before !== 'number' || !Number.isSafeInteger(options.before) || options.before < 1)) {
    throw new HttpError(400, 'Invalid history cursor.');
  }
  // The same read that opens the record's page: a record this reader cannot see has no history for them.
  const visible = await reader.query({
    table,
    columns: [...new Set([...Object.keys(key), ...(options.storeKey?.read(table) ?? [])])],
    limit: 1,
    offset: 0,
    filter: { groups: [Object.entries(key).map(([column, value]) => ({ column, op: '=' as const, value }))] },
  });
  if (visible.rows.length !== 1) throw new AppAccessDenied();
  const store = storesOf(await options.open(options.mapping.connectionFor(table)));
  if (!holdsHistory(store)) throw new RecordHistoryUnavailable();
  const stored = options.storeKey ? options.storeKey.key(table, key, visible.rows[0]) : key;
  const rows = await store.readRecordHistory({
    resource: options.mapping.toPhysical(table),
    key: historyKey(stored),
    limit,
    ...(options.before === undefined ? {} : { before: options.before as number }),
  });
  const meta = findTable(schema, table)!;
  const caption = (column: string) => columnCaption(app.resources ?? {}, schema, table, column);
  const entries = groupHistory(rows).map(({ changes, ...entry }) => ({
    ...entry,
    fields: projectFields(changes, meta, caption, entry.kind),
  }));
  return { entries, ...(rows.length === limit ? { more: rows[rows.length - 1].id } : {}) };
}

/* Values cross JSON and the driver: 3 and '3' are one value, null is only null. */
const sameValue = (a: unknown, b: unknown) =>
  a === null || a === undefined || b === null || b === undefined ? (a ?? null) === (b ?? null) : String(a) === String(b);

/**
 * The fixed action a Save is, by its label, so its history entry can say
 * "Close" rather than "Edited": exactly one of the resource's update actions
 * whose `set` (its words, before any stamp resolves) is what the values are,
 * with its reason beside it where it asks one. Read off the values the server
 * was sent, never a label the request names; two actions that write the same
 * thing name neither.
 */
export function updateActionLabel(app: AppDef, table: unknown, values: unknown): string | undefined {
  if (typeof table !== 'string' || !values || typeof values !== 'object' || Array.isArray(values)) return undefined;
  const given = values as Record<string, unknown>;
  const matches = (app.resources?.[table]?.actions ?? []).filter((action) => {
    if (action.command) return false;
    const set = Object.entries(action.set);
    if (!set.length || set.some(([column, value]) => !Object.hasOwn(given, column) || !sameValue(given[column], value))) return false;
    return Object.keys(given).every((column) => Object.hasOwn(action.set, column) || column === action.reason);
  });
  return matches.length === 1 ? matches[0].label : undefined;
}

/**
 * What a command's writes are called in the history: the label of the action
 * that runs it ("Approve"), else its id as words. Read off the command the
 * body names, which the executor then authorizes; a command that is refused
 * writes nothing, so its name is never recorded.
 */
export function commandActionLabel(app: AppDef, body: unknown): string | undefined {
  const id = body && typeof body === 'object' && !Array.isArray(body) ? (body as { command?: unknown }).command : undefined;
  if (typeof id !== 'string' || !id || id.length > 128) return undefined;
  for (const resource of Object.values(app.resources ?? {})) {
    const action = (resource.actions ?? []).find((candidate) => candidate.command?.id === id);
    if (action) return action.label;
  }
  return humanName(id);
}
