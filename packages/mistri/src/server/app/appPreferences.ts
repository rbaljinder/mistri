/**
 * Where an App keeps what a person picked, so it follows them across devices (an App's `choose`): the preferences
 * store beside the App's records (adapters/preferences), one row per person, tenant and key, the key `choose.<name>`
 * and the value the picked row's key as text.
 *
 * Serving never creates the store, and an App is not refused for lacking it: a database without one keeps the picks in
 * the browser, as they were kept before the store existed (the client sees no `stored` flag in the payload and holds
 * its own). What is stored is only a wish, like the header: every read of it goes through the same check as the tab's
 * (appChoices.ts readChosen), so a pick the person can no longer read is left out rather than believed.
 */
import type { Registry } from '@mistriwork/engine/server/connections.js';
import { openPostgresPreferences } from '../../adapters/preferences/postgresPreferences.js';
import { openSqlitePreferences } from '../../adapters/preferences/sqlitePreferences.js';
import type { PreferencesStore } from '../../adapters/preferences/preferences.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import type { AppDef } from '../../shared/appModel.js';
import { provenPicks } from './appChoices.js';
import { appEntrypoint } from './appEntrypoint.js';
import type { AppHost } from './apps.js';

/** The key a pick is kept under. */
const choiceKey = (name: string): string => `choose.${name}`;

/** Where the store is, as the assistant's is (assistantStores.ts): a connection's address, or a tenant source's. */
type Where = { readonly path: string } | { readonly url: string };

/* A store that did not open is asked again after this, not on every request: the operator may provision in between. */
const RETRY_MS = 30_000;
const opened = new WeakMap<object, { store: Promise<PreferencesStore | undefined>; at: number; found: boolean }>();

async function open(where: Where | undefined): Promise<PreferencesStore | undefined> {
  if (!where) return undefined;
  try {
    return 'url' in where ? await openPostgresPreferences(where.url) : openSqlitePreferences(where.path);
  } catch {
    /* No store of this layout here: the picks stay in the browser. */
    return undefined;
  }
}

function once(key: object, where: () => Where | undefined, now: number): Promise<PreferencesStore | undefined> {
  const held = opened.get(key);
  if (held && (held.found || now - held.at < RETRY_MS)) return held.store;
  const entry = { store: open(where()), at: now, found: false };
  opened.set(key, entry);
  void entry.store.then((store) => {
    entry.found = store !== undefined;
  });
  return entry.store;
}

/* MySQL keeps no runtime stores (the assistant's is refused there too), so its picks stay in the browser. */
const whereOf = (url: string | undefined): Where | undefined => {
  if (!url || /^(mysql|mariadb):\/\//i.test(url)) return undefined;
  return /^postgres(ql)?:\/\//i.test(url) ? { url } : { path: url.replace(/^sqlite:(\/\/)?/i, '') };
};

/** The App's store on the connection its entry point names, or undefined where the database holds none. */
export const preferencesFor = (registry: Registry, host: AppHost): Promise<PreferencesStore | undefined> => {
  const { app } = host.app;
  if (!app.choose) return Promise.resolve(undefined);
  return once(
    app,
    () => {
      const connection = appEntrypoint(host, registry);
      return whereOf(connection ? registry.openableUrlOf(connection) : undefined);
    },
    Date.now(),
  );
};

/** A tenant App's store: beside its tenant source, where the host's enrollment says that is. */
export const preferencesAt = (app: AppDef, where: Where): Promise<PreferencesStore | undefined> =>
  app.choose ? once(app, () => where, Date.now()) : Promise.resolve(undefined);

/* What a person's picks were read as, for a moment: every read of a request asks them (the person's row, a loader, a
   command), and a round trip to PostgreSQL for each would be paid again and again. A change made here forgets them; a
   change another process made is read after TTL_MS. */
const TTL_MS = 3000;
const recent = new Map<string, { at: number; picks: Promise<Record<string, string>> }>();
const RECENT_MOST = 2000;
const remembered = (app: string, subject: string, scope: string) => JSON.stringify([app, subject, scope]);

/** The picks this person holds in this scope, by choice name: only names the App declares, and none without a store. */
export async function storedPicks(
  app: AppDef,
  store: PreferencesStore | undefined,
  subject: string | undefined,
  scope = '',
): Promise<Record<string, string>> {
  if (!store || !subject || !app.choose) return {};
  const key = remembered(app.id, subject, scope);
  const now = Date.now();
  const held = recent.get(key);
  if (held && now - held.at < TTL_MS) return held.picks;
  const picks = store
    .read({ app: app.id, subject, scope })
    .then((rows) => {
      const found: Record<string, string> = {};
      for (const name of Object.keys(app.choose!)) {
        const value = rows[choiceKey(name)];
        if (value) found[name] = value;
      }
      return found;
    })
    .catch(() => {
      recent.delete(key);
      return {};
    });
  if (recent.size >= RECENT_MOST) recent.delete(recent.keys().next().value!);
  recent.set(key, { at: now, picks });
  return picks;
}

/** One pick kept (or cleared, null) for this person; their next read sees it at once. */
export async function storePick(
  app: AppDef,
  store: PreferencesStore,
  subject: string,
  scope: string,
  name: string,
  value: string | null,
): Promise<void> {
  await store.set({ app: app.id, subject, scope }, choiceKey(name), value);
  recent.delete(remembered(app.id, subject, scope));
}

/** What this person has stored for the App on this deployment: nothing for a visitor, an App with no `choose`, or a database with no store. */
export async function storedForPerson(
  registry: Registry,
  host: AppHost | undefined,
  account: string | undefined,
): Promise<Record<string, string>> {
  if (!host || !account || !host.app.app.choose) return {};
  return storedPicks(host.app.app, await preferencesFor(registry, host), account);
}

/**
 * The picks the App's payload tells the shell: this person's stored picks as `reader` still lets them make them, or
 * undefined where there is no store to write to (a visitor, an App with no `choose`, a database that holds none).
 */
export async function payloadPicks(
  registry: Registry,
  host: AppHost | undefined,
  account: string | undefined,
  schema: DatabaseSchema,
  reader: Parameters<typeof provenPicks>[2],
  scope = '',
): Promise<Record<string, string> | undefined> {
  if (!host || !account || !host.app.app.choose) return undefined;
  const store = await preferencesFor(registry, host);
  return store ? provenPicks(host.app.app, schema, reader, await storedPicks(host.app.app, store, account, scope)) : undefined;
}
