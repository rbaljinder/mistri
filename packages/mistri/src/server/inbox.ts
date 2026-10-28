/**
 * Notifications, the server's half: binding an App's `notify` rules to the
 * physical adapters that write them, and answering one person's inbox.
 *
 * Declaring a rule is what turns the store on, as a `history()` section does
 * for the record history: the store is provisioned once, never on startup,
 * and an App whose rules would write into a database without it does not
 * start — the refusal names the call that provisions it. An App keeps its
 * notices on one connection, the one its notifying resources live on, since
 * a notice is written in the transaction of the write that sends it.
 *
 * An inbox is read by the person it is for and nobody else: the recipient
 * is the verified session's email, never a request's. And a notice is shown
 * to its person only while it is still theirs to read — the record it opens
 * must be one they can read now, through their own grants, row policy and
 * scope (the read that opens its page), and its words are said only while
 * they may read every column the title was filled from; otherwise the
 * notice says that something changed on the record, and nothing else. A
 * notice whose record they can no longer read is not shown at all.
 */
import type { Adapter } from '@mistriwork/engine/adapters/adapter.js';
import {
  INBOX_PAGE,
  InboxUnavailable,
  type InboxMark,
  type InboxQuery,
  type NoticeBinding,
  type NoticePath,
  mentionTables,
  physicalMentions,
  physicalSend,
  type NoticeRule,
  type StoredNotice,
} from '../adapters/inbox/inbox.js';
import { appKeepsInbox, appNotifyRules, notifyRulePaths, type NotifyPath } from '../shared/appNotify.js';
import type { InboxMailStore } from '../adapters/inbox/inboxMail.js';
import { bindNotices } from './stores/writeCaptures.js';
import { storesOf } from './stores/appStores.js';
import { recordNoun, type AppDef } from '../shared/app.js';
import { findTable, primaryKey, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import type { Registry } from '@mistriwork/engine/server/connections.js';
import type { AppHost, LoadedApp } from './app/apps.js';
import { loadAppRuntimeResources, type RuntimeResources } from './app/appRuntimeResources.js';
import { appEntrypoint } from './app/appEntrypoint.js';
import { HttpError } from '@mistriwork/engine/server/http/reply.js';
import { contactEmailWording, noticeWords } from './app/noticeWords.js';

/** The store capabilities a dialect adapter's App stores add (stores/appStores.ts); none is on the public Adapter. */
interface InboxStore {
  inboxReady(): Promise<boolean>;
  readInbox(query: InboxQuery): Promise<StoredNotice[]>;
  markInboxRead(mark: InboxMark): Promise<number>;
}
const holdsInbox = (adapter: unknown): adapter is InboxStore =>
  typeof adapter === 'object' &&
  adapter !== null &&
  typeof (adapter as InboxStore).inboxReady === 'function' &&
  typeof (adapter as InboxStore).readInbox === 'function' &&
  typeof (adapter as InboxStore).markInboxRead === 'function';

export { appKeepsInbox };

/* Per registry: each connection's rules, by App, merged into the one binding
   its adapter writes by, and the adapters already found to hold the store. */
interface RegistryInbox {
  byConnection: Map<string, Map<string, NoticeBinding>>;
  attested: WeakSet<object>;
  /** App id → the one connection its notices are kept on. */
  stores: Map<string, string>;
}
const registries = new WeakMap<Registry, RegistryInbox>();

function registryInbox(registry: Registry): RegistryInbox {
  let state = registries.get(registry);
  if (state) return state;
  state = {
    byConnection: new Map(),
    attested: new WeakSet(),
    stores: new Map(),
  };
  registries.set(registry, state);
  const known = state;
  registry.onAdapterDialed((connection, adapter) => {
    const byApp = known.byConnection.get(connection);
    if (byApp) bindNotices(adapter, merged(byApp));
  });
  return state;
}

function merged(byApp: Map<string, NoticeBinding>): NoticeBinding {
  const all = new Map<string, NoticeRule[]>();
  for (const binding of byApp.values()) for (const [table, rules] of binding) all.set(table, [...(all.get(table) ?? []), ...rules]);
  return all;
}

/* The refusal names the one call that provisions the store, as the record history's does. */
function inboxUnavailable(connection: string, dialect: string): string {
  const at = `An App's resources notify people, and the notification store on connection "${connection}" is unavailable`;
  const call =
    dialect === 'sqlite'
      ? "provisionStores({ sqlite: '<the database file>' }, { only: ['inbox'] })"
      : dialect === 'postgres'
        ? "provisionStores({ postgres: '<the connection's URL>' }, { only: ['inbox'] }), as a role that may create tables"
        : dialect === 'mysql'
          ? "provisionStores({ mysql: '<the connection's URL>' }, { only: ['inbox'] }), as a user that may create tables"
          : undefined;
  if (!call) return `${at}: notifications are kept in SQLite, PostgreSQL or MySQL, and this connection is ${dialect}.`;
  return (
    `${at}: it is provisioned once, never on startup. Run \`mistri migrate stores up --app <the App's directory>\` ` +
    `with the server stopped, or ${call} from @mistriwork/mistri/maintenance, then start again.`
  );
}

/** The compiled rules in physical table ids, for the writer. */
function physicalRules(app: AppDef, resources: Pick<RuntimeResources, 'schema' | 'toPhysical' | 'connectionFor'>) {
  const { rules, problems } = appNotifyRules(app, resources.schema);
  if (problems.length) throw new Error(problems[0]);
  const byConnection = new Map<string, Map<string, NoticeRule[]>>();
  const path = (logical: NotifyPath): NoticePath => ({
    column: logical.column,
    hops: logical.hops.map((hop) => ({
      table: resources.toPhysical(hop.table),
      key: hop.key,
      column: hop.column,
    })),
  });
  /* A title said from the App's messages, per recipient (app/noticeWords.ts). */
  const sayOf = (rule: { say?: { message: string; args: Array<{ name: string; path: NotifyPath }> } }) => {
    const said =
      rule.say &&
      noticeWords(
        app,
        rule.say.message,
        rule.say.args.map((arg) => ({ name: arg.name, path: path(arg.path) })),
        { schema: resources.schema, physical: resources.toPhysical },
      );
    return said ? { say: said } : {};
  };
  for (const [resource, compiled] of rules) {
    const connection = resources.connectionFor(resource);
    // Every hop is read inside the triggering write's transaction, on its connection.
    const crossing = compiled
      .flatMap(notifyRulePaths)
      .flatMap((logical) => logical.hops)
      .map((hop) => hop.table)
      .concat(compiled.flatMap((rule) => mentionTables(rule.mentions)))
      .find((read) => resources.connectionFor(read) !== connection);
    if (crossing)
      throw new Error(
        `resources "${resource}", notify: "${crossing}" is read on another connection; a notice is written in the write's own transaction, so what it reads must live beside it.`,
      );
    const table = resources.toPhysical(resource);
    const columns = new Set(
      (findTable(resources.schema, resource) ?? findTable(resources.schema, table))?.columns.map((column) => column.name) ?? [],
    );
    const email = contactEmailWording(app, resource, columns);
    const into = byConnection.get(connection) ?? new Map<string, NoticeRule[]>();
    byConnection.set(connection, into);
    into.set(
      table,
      compiled.map((rule) =>
        Object.freeze({
          app: app.id,
          on: rule.on,
          ...(rule.when ? { when: rule.when } : {}),
          to: rule.to.map(path),
          title: rule.title.map((part) => (typeof part === 'string' || 'message' in part ? part : path(part))),
          ...sayOf(rule),
          open: rule.open,
          uses: rule.uses,
          ...(rule.email ? { email: true as const } : {}),
          ...(rule.mentions
            ? {
                mentions: physicalMentions(rule.mentions, resources.toPhysical),
              }
            : {}),
          ...(rule.send ? { send: physicalSend(rule.send, path, email) } : {}),
        }),
      ),
    );
  }
  if (byConnection.size > 1)
    throw new Error(
      `${app.name}: resources on ${byConnection.size} connections notify people; an App keeps its notifications on one connection.`,
    );
  return byConnection;
}

async function bindAppInbox(registry: Registry, loaded: Pick<LoadedApp, 'app'>, resources: RuntimeResources): Promise<void> {
  const state = registries.get(registry);
  const keeps = appKeepsInbox(loaded.app);
  if (!keeps && !state) return;
  const inbox = registryInbox(registry);
  const wanted = keeps ? physicalRules(loaded.app, resources) : new Map<string, Map<string, NoticeRule[]>>();
  const connections = new Set([
    ...wanted.keys(),
    ...[...inbox.byConnection].filter(([, byApp]) => byApp.has(loaded.app.id)).map(([id]) => id),
  ]);
  for (const connection of connections) {
    const binding = wanted.get(connection);
    const byApp = new Map(inbox.byConnection.get(connection) ?? []);
    if (binding?.size) byApp.set(loaded.app.id, binding);
    else byApp.delete(loaded.app.id);
    const { adapter } = await registry.open(connection);
    if (binding?.size) {
      if (!registry.configOf(connection)?.writable) {
        throw new Error(
          `${loaded.app.name}: resources on connection "${connection}" notify people, and the connection is read-only. A notice is written with the write that sends it; mark the connection "writable": true.`,
        );
      }
      if (!inbox.attested.has(adapter)) {
        const store = storesOf(adapter);
        if (!holdsInbox(store) || !(await store.inboxReady())) throw new InboxUnavailable(inboxUnavailable(connection, adapter.dialect));
        inbox.attested.add(adapter);
      }
    }
    inbox.byConnection.set(connection, byApp);
    bindNotices(adapter, merged(byApp));
  }
  const store = [...wanted.keys()][0];
  if (store) inbox.stores.set(loaded.app.id, store);
  else inbox.stores.delete(loaded.app.id);
}

const ensured = new WeakMap<Registry, WeakMap<AppDef, true>>();

/**
 * Bind a served App's notify rules once per load of it: at startup, and on
 * the first request after a reload changes its definition. Every request
 * passes through here before any route can write, so no write can reach a
 * notifying table before it tells its people.
 */
export async function ensureAppInbox(registry: Registry, host: AppHost): Promise<void> {
  const { app } = host.app;
  let seen = ensured.get(registry);
  if (!seen) ensured.set(registry, (seen = new WeakMap()));
  if (seen.has(app)) return;
  if (!appKeepsInbox(app) && !registries.get(registry)?.stores.has(app.id)) {
    seen.set(app, true);
    return;
  }
  const entry = appEntrypoint(host, registry);
  if (!entry) return;
  const releases: Array<() => void> = [];
  try {
    const resources = await loadAppRuntimeResources(registry, app, entry, (owner) => releases.push(registry.lease(owner)));
    await bindAppInbox(registry, host.app, resources);
  } finally {
    for (const release of releases.reverse()) release();
  }
  seen.set(app, true);
}

/* ---------- one person's inbox ---------- */

/** One notice, in its reader's terms. */
interface InboxNotice {
  id: number;
  at: string;
  title: string;
  /** The record it opens: a resource of the App, and that record's key. */
  resource: string;
  key: Record<string, string | number>;
  /** Who made the write, by name where their account has one, else their email. */
  by?: string;
  action?: string;
  read: boolean;
}

interface InboxReply {
  notices: InboxNotice[];
  unread: number;
  more?: number;
  /** In an App whose notices are emailed too: whether this reader's are. */
  email?: boolean;
}

const parseKey = (text: string): Record<string, string | number> | undefined => {
  try {
    const key = JSON.parse(text) as unknown;
    if (!key || typeof key !== 'object' || Array.isArray(key)) return undefined;
    const entries = Object.entries(key as Record<string, unknown>);
    return entries.length && entries.every(([, value]) => typeof value === 'string' || typeof value === 'number')
      ? (Object.fromEntries(entries) as Record<string, string | number>)
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Which of these notices the reader may still see, by the read that opens
 * each record's page: one query per resource for a one-column key. A
 * resource the reader's catalog does not have hides every notice on it.
 * The reads are asked at once: one after another, each was a round trip to
 * the database, and the bell's unread count reads up to UNREAD_CAP notices
 * over however many resources they name — a field report saw the inbox
 * double in time as a person's notices spread over more of them.
 */
async function visibleTo(reader: Adapter, schema: DatabaseSchema, notices: readonly StoredNotice[]): Promise<Set<number>> {
  const visible = new Set<number>();
  const byResource = new Map<string, Array<{ id: number; key: Record<string, string | number> }>>();
  for (const notice of notices) {
    const key = parseKey(notice.key);
    if (!key) continue;
    byResource.set(notice.resource, [...(byResource.get(notice.resource) ?? []), { id: notice.id, key }]);
  }
  const asked = [...byResource].map(async ([resource, items]) => {
    const table = findTable(schema, resource);
    const pk = table ? primaryKey(table) : [];
    if (!table || !pk.length) return;
    const exact = items.filter(
      (item) => Object.keys(item.key).length === pk.length && pk.every((column) => Object.hasOwn(item.key, column)),
    );
    if (pk.length === 1) {
      const [column] = pk;
      const values = [...new Set(exact.map((item) => item.key[column]))];
      if (!values.length) return;
      const found = await reader.query({
        table: resource,
        columns: [column],
        limit: values.length,
        offset: 0,
        filter: { groups: [[{ column, op: 'in' as const, value: values }]] },
      });
      const seen = new Set(found.rows.map((row) => String(row[column])));
      for (const item of exact) if (seen.has(String(item.key[column]))) visible.add(item.id);
      return;
    }
    await Promise.all(
      exact.map(async (item) => {
        const found = await reader.query({
          table: resource,
          columns: pk,
          limit: 1,
          offset: 0,
          filter: {
            groups: [
              pk.map((column) => ({
                column,
                op: '=' as const,
                value: item.key[column],
              })),
            ],
          },
        });
        if (found.rows.length === 1) visible.add(item.id);
      }),
    );
  });
  await Promise.all(asked);
  return visible;
}

/** Whether the reader's catalog serves every column a title read. */
const readsAll = (schema: DatabaseSchema, uses: readonly string[]) =>
  uses.every((use) => {
    const dot = use.lastIndexOf('.');
    const table = findTable(schema, use.slice(0, dot));
    return Boolean(table?.columns.some((column) => column.name === use.slice(dot + 1)));
  });

/* The words stand only while the reader may read every column they were filled from. */
function wordsFor(app: AppDef, schema: DatabaseSchema, row: Pick<StoredNotice, 'resource' | 'uses' | 'title'>): string {
  if (readsAll(schema, row.uses)) return row.title;
  const table = findTable(schema, row.resource);
  return `Something changed on a ${recordNoun(app.resources?.[row.resource]?.noun, table?.name ?? row.resource)}`;
}

/**
 * One notice as a reader may be told of it now — by email, after the write
 * that sent it — or undefined when its record is not theirs to read: the
 * rule the inbox reads by, for a reader the server built for the recipient.
 */
export async function noticeForReader(
  app: AppDef,
  reader: Adapter,
  schema: DatabaseSchema,
  notice: Pick<StoredNotice, 'id' | 'resource' | 'key' | 'uses' | 'title'>,
): Promise<{ title: string; key: Record<string, string | number> } | undefined> {
  const visible = await visibleTo(reader, schema, [notice as StoredNotice]);
  const key = parseKey(notice.key);
  if (!visible.has(notice.id) || !key) return undefined;
  return { title: wordsFor(app, schema, notice), key };
}

/** The connection an App's notices are kept on, once bound (ensureAppInbox); undefined before or without one. */
export const appInboxConnection = (registry: Registry, appId: string): string | undefined => registries.get(registry)?.stores.get(appId);

interface InboxOptions {
  app: AppDef;
  /** The reader's own adapter and catalog: grants, row policy and scope. */
  reader: Adapter;
  schema: DatabaseSchema;
  /** The verified session's email; absent, nobody is signed in. */
  who: string | undefined;
  /** Where the App's store is: the registry's connection it was bound on, or a tenant App's own deployment and
      the inbox its lease reads (tenant/tenantInbox.ts), whose namespace is the whole of what it reads and marks. */
  registry: Registry | { store: InboxStore; namespace: string };
}

async function storeFor(options: InboxOptions): Promise<{
  store: InboxStore;
  recipient: string;
  namespace: string;
  writable: boolean;
}> {
  const recipient = options.who?.trim().toLowerCase();
  if (!recipient) throw new HttpError(401, 'Sign in to read your notifications.');
  if (!appKeepsInbox(options.app)) throw new HttpError(404, 'This App keeps no notifications.');
  const where = options.registry;
  if ('store' in where)
    return {
      store: where.store,
      recipient,
      namespace: where.namespace,
      writable: true,
    };
  const connection = registries.get(where)?.stores.get(options.app.id);
  if (!connection) throw new HttpError(503, 'Notifications are unavailable.');
  const { adapter } = await where.open(connection);
  const store = storesOf(adapter);
  if (!holdsInbox(store)) throw new InboxUnavailable();
  return {
    store,
    recipient,
    namespace: options.app.id,
    writable: where.configOf(connection)?.writable === true,
  };
}

/** How many unread notices count at most; past it the bell says "99+". */
const UNREAD_CAP = 100;

const unreadOf = (store: InboxStore, recipient: string, namespace: string) =>
  store.readInbox({
    app: namespace,
    recipient,
    limit: UNREAD_CAP,
    unread: true,
  });

async function unreadCount(options: InboxOptions, store: InboxStore, recipient: string, namespace: string): Promise<number> {
  const unread = await unreadOf(store, recipient, namespace);
  const visible = await visibleTo(options.reader, options.schema, unread);
  return unread.filter((notice) => visible.has(notice.id)).length;
}

/** One page of the reader's own notices, newest first, and how many are unread. */
export async function readInboxFor(
  options: InboxOptions & {
    limit?: unknown;
    before?: unknown;
    unread?: unknown;
  },
): Promise<InboxReply> {
  const limit = options.limit === undefined ? 20 : options.limit;
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > INBOX_PAGE)
    throw new HttpError(400, 'Invalid notification page size.');
  if (options.before !== undefined && (typeof options.before !== 'number' || !Number.isSafeInteger(options.before) || options.before < 1)) {
    throw new HttpError(400, 'Invalid notification cursor.');
  }
  if (options.unread !== undefined && typeof options.unread !== 'boolean') throw new HttpError(400, 'Invalid notification filter.');
  const { store, recipient, namespace } = await storeFor(options);
  /* The page, the unread notices the bell counts and the email choice are three reads of the store that wait on
     nothing of each other, and whether each notice is still the reader's is asked once for both lists. */
  const [rows, unread, emailed] = await Promise.all([
    store.readInbox({
      app: namespace,
      recipient,
      limit,
      ...(options.before === undefined ? {} : { before: options.before as number }),
      ...(options.unread ? { unread: true } : {}),
    }),
    unreadOf(store, recipient, namespace),
    appRulesEmail(options.app) && holdsMail(store)
      ? store
          .inboxMail()
          .emailOff(namespace, recipient)
          .then((off) => ({ email: !off }))
      : {},
  ]);
  const visible = await visibleTo(options.reader, options.schema, [...new Map([...rows, ...unread].map((row) => [row.id, row])).values()]);
  const notices = rows
    .filter((row) => visible.has(row.id))
    .map((row): InboxNotice => {
      const title = wordsFor(options.app, options.schema, row);
      return {
        id: row.id,
        at: row.at,
        title,
        resource: row.resource,
        key: parseKey(row.key)!,
        ...(row.actorName ? { by: row.actorName } : {}),
        ...(row.action ? { action: row.action } : {}),
        read: row.readAt !== null,
      };
    });
  return {
    notices,
    unread: unread.filter((notice) => visible.has(notice.id)).length,
    ...(rows.length === limit ? { more: rows[rows.length - 1].id } : {}),
    ...emailed,
  };
}

/** Mark the reader's own notices read — these ids, or all of them — and say how many are left. */
export async function markInboxFor(options: InboxOptions & { ids?: unknown; all?: unknown }): Promise<{ unread: number }> {
  const all = options.all === true;
  const ids = options.ids;
  if (
    all === (ids !== undefined) ||
    (ids !== undefined &&
      (!Array.isArray(ids) ||
        !ids.length ||
        ids.length > INBOX_PAGE ||
        ids.some((id) => typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1)))
  ) {
    throw new HttpError(400, 'Say which notifications to mark read: { ids: [...] } or { all: true }.');
  }
  const { store, recipient, namespace, writable } = await storeFor(options);
  if (!writable) throw new HttpError(503, 'Notifications are unavailable.');
  await store.markInboxRead({
    app: namespace,
    recipient,
    at: new Date().toISOString(),
    ...(all ? {} : { ids: ids as number[] }),
  });
  return { unread: await unreadCount(options, store, recipient, namespace) };
}

const holdsMail = (adapter: unknown): adapter is { inboxMail(): InboxMailStore } =>
  typeof adapter === 'object' && adapter !== null && typeof (adapter as { inboxMail?: unknown }).inboxMail === 'function';

/**
 * Whether the reader's notices are emailed to them too, and turning that off
 * or on: `{}` asks, `{ email: false }` stops it. Their own, by the verified
 * session, as every inbox request is; the inbox itself is unchanged.
 */
export async function inboxEmailFor(options: InboxOptions & { email?: unknown }): Promise<{ email: boolean }> {
  if (options.email !== undefined && typeof options.email !== 'boolean')
    throw new HttpError(400, 'Say { email: true } or { email: false }.');
  const { store: held, recipient, namespace } = await storeFor(options);
  const where = options.registry;
  if (!appRulesEmail(options.app)) throw new HttpError(404, 'This App sends no notifications by email.');
  /* A tenant App's switch is per inbox: the lease's own, so turning email off
     in one tenant leaves the others' as they were (tenant/tenantNoticeMail.ts). */
  if ('store' in where) {
    if (!holdsMail(held)) throw new InboxUnavailable();
    const mail = held.inboxMail();
    if (options.email !== undefined) await mail.setEmailOff(namespace, recipient, !options.email, new Date().toISOString());
    return { email: !(await mail.emailOff(namespace, recipient)) };
  }
  const connection = registries.get(where)?.stores.get(options.app.id);
  if (!connection) throw new HttpError(503, 'Notifications are unavailable.');
  const { adapter } = await where.open(connection);
  const stores = storesOf(adapter);
  if (!holdsMail(stores)) throw new InboxUnavailable();
  const store = stores.inboxMail();
  if (options.email !== undefined) {
    if (!where.configOf(connection)?.writable) throw new HttpError(503, 'Notifications are unavailable.');
    await store.setEmailOff(options.app.id, recipient, !options.email, new Date().toISOString());
  }
  return { email: !(await store.emailOff(options.app.id, recipient)) };
}

const appRulesEmail = (app: AppDef) => Object.values(app.resources ?? {}).some((resource) => resource.notify?.some((rule) => rule.email));
