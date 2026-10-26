/**
 * Deep links: the stateful half.
 *
 * Reads and writes `window.location`, and decides when. The serialisation
 * itself is in deeplink.js, which touches neither the DOM nor app state.
 */
import {
  allowMutationExit,
  api,
  captureNavigation,
  invalidateNavigation,
  labelPath,
  primaryKey,
  render,
  renderCrumbs,
  rowLabel,
  state,
} from './core.js';
import { equalityFilter, pathEqualityFilter } from './resourceRequests.js';
import { pageToken } from './page.js';
import { connectionFromHash, fromHash, hashFor, publicPathFor } from './deeplink.js';
import { looksLikeBreakdown } from '@mistriwork/engine/shared/breakdowntext.js';
import { connectionTransitionPending } from './connectionTransition.js';
import { sessionIdentity } from './sessionIdentity.js';
import { shell } from './shellMode.js';
import { herePath, hereSearch, shown } from './addressMount.js';
import { navPush, navReplace, navState } from './shellHost.js';

/** Rebuilding the URL while reacting to one would loop. */
let applying = false;

/**
 * Nothing writes the address bar until boot says the incoming link has been
 * read.
 *
 * Boot renders once before applying the link — it has to, because the empty
 * state is what a plain visit should see — and that render called `syncHash`,
 * which wrote *the state it had* over the link that had not been applied yet.
 * Usually the link was re-applied a moment later and the bar corrected
 * itself; sometimes the reader was left on the wrong connection, and always
 * there was a window in which the address bar said something nobody asked
 * for. Opening an agent-supplied link in a fresh tab is exactly the case this
 * tool exists to serve, so it is exactly the case that must not race.
 */
let settled = false;
export function allowSync() {
  settled = true;
}

export { connectionFromHash, fromHash, hashFor };

/* An App's addresses and a tenant's links are the shell's (shellMode.ts):
   the Workbench has neither, and reads and writes the walk's own form. */
const inAppMode = () => shell().inApp();
/** @param {string} trail @param {{ appId: string, tenantId: string }} tenant */
const qualifyTenantLink = (trail, tenant) => shell().tenantLinks?.qualify(trail, tenant.appId, tenant.tenantId) ?? trail;
/** @param {string} hash @param {string} appId */
function parseTenantLink(hash, appId) {
  /* A tenant's session has its links (app.js installs them with the tenant's
     flows); a link read without them names no tenant, and so is never taken
     as this one's. */
  return shell().tenantLinks?.parse(hash, appId) ?? { pathname: hash, search: '', tenantId: null };
}
/** @param {string} key @param {string} search */
const viewEntryFromAddress = (key, search) => shell().addresses?.viewEntry(key, search) ?? null;
/** @param {{ table: string, query: string, view?: string }} entry */
const listParams = (entry) => shell().addresses?.listParams(entry);

/** The whole walk, as the tool writes a link — the page half by name where
    the name identifies it (`pageToken`). The Workbench's address, and every
    App walk's history state. */
function trailHash() {
  return hashFor(state.activeConnection, state.stack, { pageToken });
}

/* A signed-out visitor to an App's public side reads the same canonical
   addresses as staff, with a record's name after its id where the App
   asks for a slug. A tenant's walk is never a public one. */
function publicAddress(owner) {
  return !owner.tenant && shell().publicVisitor();
}

/* The walk as history state keeps it: the tool's own whole-walk form, which
   reads back exactly. A tenant's carries its selector, as its address does. */
function walkState(owner) {
  const trail = trailHash();
  /* The names the crumbs showed ride beside it: the trail's own form holds
     keys, and a page entry read back from it would otherwise say "300"
     where the reader saw a name, until something asked again. */
  const labels = state.stack.map((entry) => (typeof entry.label === 'string' ? entry.label : null));
  /* …and a natural key's value, which the trail's form (the primary key) cannot say. */
  const addresses = state.stack.map((entry) => (typeof entry.address === 'string' ? entry.address : null));
  return { trail: owner.tenant ? qualifyTenantLink(trail, owner.tenant) : trail, labels, addresses };
}

/** The walk read back from history state, with the names its crumbs had and its natural keys. */
function withLabels(parsed) {
  const { labels, addresses } = navState() ?? {};
  if (!parsed) return parsed;
  parsed.stack.forEach((entry, i) => {
    if (Array.isArray(labels) && labels.length === parsed.stack.length && typeof labels[i] === 'string' && labels[i])
      entry.label = labels[i];
    if (Array.isArray(addresses) && addresses.length === parsed.stack.length && typeof addresses[i] === 'string')
      entry.address = addresses[i];
  });
  return parsed;
}

/**
 * The address bar's text for the walk as it stands.
 *
 * In an App it is the one thing on screen, canonically: `/compass/leads/127`,
 * `/compass/sales-dashboard?period=last-30-days`, `/compass/leads?tab=working`
 * (publicAddress.ts). Following a reference opens the target's own address
 * rather than growing a path, and the walk rides in history state
 * (`syncHash`), so Back and the crumbs know it and a shared link is clean.
 * What has no address in words — a breakdown, a list no view shows — is the
 * last entry in the walk's own form. A tenant's address is the same, its
 * `tenant=` or `realm=platform` selector after the App's own parameters
 * (tenantLink.ts). The Workbench is the database and keeps the whole
 * walk in the query language.
 */
export function toHash() {
  const owner = sessionIdentity();
  const path = inAppMode() ? appPath(state.activeConnection, state.stack) : trailHash();
  return owner.tenant ? qualifyTenantLink(path, owner.tenant) : path;
}

/** An App walk's address, before a tenant's selector: its canonical one, else its last entry in the walk's own form. */
function appPath(connection, stack) {
  return shell().addresses?.address(connection, stack) ?? publicPathFor(connection, stack, { pageToken, listParams });
}

/**
 * Fetch readable names for every row in a restored trail.
 *
 * Only the last entry in a stack is rendered, so on a fresh load the earlier
 * crumbs would keep their raw keys — a shared link reading
 * `employee › 2 › invoice sold_by = 2` where the sender saw
 * `employee › Rina Petrova › …`. The trail is the thing being shared, so it
 * should arrive legible.
 *
 * One small query per row, in parallel, and only on restore. Failures are
 * ignored: a crumb showing its key is worse than one showing a name, and far
 * better than a page that fails to load because a label could not be read.
 */
export async function resolveLabels(stack, findTableById) {
  const isCurrent = captureNavigation();
  const rows = stack.filter((entry) => entry.kind === 'row');
  if (!rows.length) return;
  await Promise.allSettled(
    rows.map(async (entry) => {
      const table = findTableById(entry.table);
      if (!table) return;
      /* As a view rather than a plain query when the name lives a hop away —
       `party_id.display_name` — because a plain row cannot carry a joined
       column, and a restored trail through such a table read as keys. */
      const path = labelPath(table);
      /* …and when it is computed (`$label`, a record label template), which a
       plain row does not carry either. */
      const result =
        path && (path.includes('.') || path.startsWith('$'))
          ? await api('/api/view/run', {
              view: {
                id: `crumb:${entry.table}`,
                name: table.name,
                base: entry.table,
                columns: [...new Set([...primaryKey(table), path])].map((p) => ({ path: p })),
                filter: pathEqualityFilter(entry.key),
                limit: 1,
              },
            })
          : await api('/api/query', {
              table: entry.table,
              filter: equalityFilter(entry.key),
              limit: 1,
              offset: 0,
            });
      if (!isCurrent()) return;
      const row = result.rows?.[0];
      if (!row) return;
      const readable = rowLabel(table, row);
      if (readable) entry.label = readable;
    }),
  );
  if (isCurrent()) renderCrumbs();
}

/**
 * Write the current state into the address bar.
 *
 * Whether it adds a history entry depends on how you got here. A step in the
 * walk pushes, so the browser's Back button undoes it; a refinement of the
 * view you are already on — a sort toggle, a tab, a re-run of the same query
 * — replaces, so Back does not spend three presses undoing sorts.
 *
 * This started as replaceState for everything, on the reasoning that the
 * trail is already a back stack with its own affordance. That was wrong in a
 * way only using it revealed: with no history entries at all, pressing Back
 * leaves tablewalk entirely and takes the whole trail with it. Avoiding a
 * little history noise is not worth destroying someone's work.
 *
 * A public address carries its parameters in the search and the walk in
 * history state, so both are compared and written. An App's signed-in
 * address says its lists' parameters in the search too.
 */
export function syncHash() {
  if (applying || !settled) return;
  const owner = sessionIdentity();
  if (owner.tenantRequired && !owner.tenant) return;
  const next = toHash();
  const open = publicAddress(owner);
  const app = inAppMode();
  /* Tenant selectors are part of the walk's ownership. Ordinary development
     cache-busting queries are not navigation state and remain ignored in the
     Workbench; in an App the search is a list's question or a dashboard's window. */
  /* Compared in the inside form (addressMount.js): the bar may say the
     address under a base path, or without the App's id. */
  const here = herePath();
  const current = owner.tenant ? here + hereSearch() + window.location.hash : app || open ? here + hereSearch() : here;
  const walk = app || open ? walkState(owner) : null;
  writeAddress(next, current, walk);
  if (open) canonicalLink(next);
  const natural = shell().addresses?.needsNaturalKey(state.stack[state.stack.length - 1]);
  if (natural) void fillNaturalKey(state.stack[state.stack.length - 1], natural);
}

/** Push or replace the address, or — the same address — only the walk it stands for. */
function writeAddress(next, current, walk) {
  if (next === current) {
    // One address can stand for a longer walk (a list, then its record): keep the walk current.
    if (
      walk &&
      (navState()?.trail !== walk.trail ||
        JSON.stringify(navState()?.labels) !== JSON.stringify(walk.labels) ||
        JSON.stringify(navState()?.addresses) !== JSON.stringify(walk.addresses))
    )
      navReplace(shown(next), walk);
    return;
  }
  if (state.navMode === 'push') navPush(shown(next), walk);
  else navReplace(shown(next), walk);
  // Anything that renders without going through go() is a refinement.
  state.navMode = 'replace';
}

/**
 * A public page names its canonical address for whoever indexes it: the
 * server writes it into the page it serves, and the walk keeps it current.
 */
function canonicalLink(path) {
  let link = document.head.querySelector('link[rel="canonical"]');
  if (!link) {
    link = document.createElement('link');
    link.setAttribute('rel', 'canonical');
    document.head.append(link);
  }
  link.setAttribute('href', new URL(shown(path), window.location.origin).href);
}

/**
 * A record whose address is a natural key (`address: 'sku'`) opened by its
 * primary key — a click, a reference — is first written by that key, named
 * (`id=12`), which reads back without doubt; its natural value is read once
 * and the address rewritten in place. Never a history step of its own.
 */
// Request ownership must not ride along when a row becomes a page entry: a
// spread copy would inherit a pending marker that only the old request clears.
const naturalPending = new WeakSet();
async function fillNaturalKey(entry, { table, column }) {
  if (naturalPending.has(entry)) return;
  naturalPending.add(entry);
  const isCurrent = captureNavigation();
  try {
    const result = await api('/api/query', { table, filter: equalityFilter(entry.key), limit: 1, offset: 0 });
    const value = result.rows?.[0]?.[column];
    if (!isCurrent() || value === undefined || value === null || state.stack[state.stack.length - 1] !== entry) return;
    entry.address = String(value);
    state.navMode = 'replace';
    syncHash();
  } catch {
    // The primary-key address stands; it opens the same record.
  } finally {
    naturalPending.delete(entry);
  }
}

/** Rewrite the address in place: a record's name arrived, and a public page's slug is written from it. */
export function readdress() {
  if (!inAppMode() || !publicAddress(sessionIdentity())) return;
  state.navMode = 'replace';
  syncHash();
}

/**
 * Apply a hash to the app. Used on load and when someone edits the address
 * bar or uses the browser's Back button.
 */
export function applyHash(hash, { findTableById, selectConnection, walk = false }) {
  if (!allowMutationExit()) {
    navReplace(shown(toHash()));
    return false;
  }
  const owner = sessionIdentity();
  if (owner.tenantRequired) {
    if (!owner.tenant) return false;
    const link = parseTenantLink(hash, owner.tenant.appId);
    // A URL suggests a tenant; only verified explicit selection establishes it.
    // The host owns re-entry. Never parse its record under the previous schema.
    if (link.tenantId !== owner.tenant.tenantId) return 'tenant-selection';
    // The App's own address, its parameters included: the selector is not one of them.
    hash = link.search ? `${link.pathname}?${link.search}` : link.pathname;
  }
  /* The connection is read first and separately. Parsing the trail needs the
     schema it was written against — a link into another database names tables
     the current one has never heard of, so every row segment fails to resolve
     and is silently dropped. Switch first, parse second. */
  const target = connectionFromHash(hash);
  if (target && state.activeConnection && (target !== state.activeConnection || connectionTransitionPending())) {
    invalidateNavigation();
    // Handed the raw hash, not a parsed stack: it can only be parsed once
    // the new schema is loaded.
    void selectConnection(target, hash);
    /* Not `true`. The switch is asynchronous and renders the target itself
       when it lands; a caller that renders in the meantime paints the
       *outgoing* connection — which on a cold tab is whatever another tab left
       active on the server — into the address bar for a frame. That frame is a
       `/other-db` URL that can be copied or bookmarked, and it is exactly what
       the cold-link guarantee forbids. The sentinel tells the caller the
       render is not theirs to do. */
    return 'switching';
  }

  const parsed = readAddress(hash, findTableById, walk);
  if (!parsed) return false;
  invalidateNavigation();
  applying = true;
  try {
    state.stack = parsed.stack;
    state.page = 0;
    // Restoring from the address bar must not itself add an entry, or Back
    // would need two presses to get past the state it just restored.
    state.navMode = 'replace';
    render();
    void resolveLabels(parsed.stack, findTableById);
    return true;
  } finally {
    applying = false;
  }
}

/**
 * An address read into a walk. In an App, its canonical address first
 * (publicAddress.ts); anything else — a query-language path, the walk's
 * `@page~id` and `~id` forms, a list's `view:query` — the older way, which
 * every link written before still opens, and syncHash then rewrites to the
 * canonical one. `walk` is history state's own whole-walk form, read as
 * written. A reload keeps history state: the walk it holds is kept when it
 * ends where the address does, so the crumbs survive F5.
 */
export function readAddress(hash, findTableById, walk = false) {
  const older = (text) => fromHash(text, findTableById, { isBreakdown: looksLikeBreakdown, viewEntry: viewEntryFromAddress });
  if (walk) return withLabels(older(hash));
  if (!inAppMode()) return older(hash);
  const read = shell().addresses?.stackFrom(hash) ?? older(hash);
  if (!read) return read;
  const owner = sessionIdentity();
  let trail = navState()?.trail;
  if (typeof trail === 'string' && owner.tenant) {
    try {
      trail = parseTenantLink(trail, owner.tenant.appId).pathname;
    } catch {
      trail = undefined;
    }
  }
  const walked = typeof trail === 'string' ? withLabels(older(trail)) : null;
  /* Compared as written, so an address with no words of its own — a drill
     into a table no view shows — keeps its walk through a reload too. */
  if (
    walked?.stack.length &&
    walked.connection === read.connection &&
    appPath(walked.connection, unnamed(walked.stack)) === appPath(read.connection, unnamed(read.stack))
  )
    return walked;
  return read;
}

/* A walk compared by what it addresses, not by what its last record is
   called: a public slug is a name, and one side may not know it yet. */
const unnamed = (stack) => stack.map((entry, i) => (i === stack.length - 1 ? { ...entry, label: undefined } : entry));

/** Suppress hash writes while a caller rebuilds state from one. */
export function whileApplying(fn) {
  applying = true;
  try {
    return fn();
  } finally {
    applying = false;
  }
}
