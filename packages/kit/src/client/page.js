/**
 * Pages, as the vanilla client reaches them.
 *
 * The page is a component (components/Page.tsx) and the room around it —
 * which definition a link names, the root, the probe, the plan, the crumb —
 * is components/PageRoom.tsx. What stays here is the registry of pages every
 * other module asks: the config's, the suggested one every table has, and
 * the ones this browser built; and how a page is spelled in a link.
 */
import { api, findTable, state } from './core.js';
import { savedPages, whenSavedPagesChange } from './savedPages.js';
import { shell } from './shellMode.js';
import { appRequestScope } from './requestIdentity.js';
import { resourceOf } from './components/appRooms.js';
import { connectionGeneration } from './connectionTransition.js';
import { say } from './copy/record/page.js';

export { rootMatches } from './components/pageModel.js';

/* ---------- lookup ---------- */

/** @typedef {{connection: string | null | undefined, schema: import('@mistriwork/engine/shared/schema.js').DatabaseSchema | null, pages?: import('@mistriwork/engine/shared/page.js').PageDef[], pending?: Promise<import('@mistriwork/engine/shared/page.js').PageDef[]>}} PageCache */
/** @type {PageCache | undefined} */
let cache;

// Cache identity is also the load generation: invalidation retires every reader of it.
function pageOwner() {
  if (!cache || cache.connection !== state.activeConnection || cache.schema !== state.schema) {
    cache = { connection: state.activeConnection, schema: state.schema };
  }
  return cache;
}

/** @param {PageCache} owner */
function assertCurrent(owner) {
  if (cache !== owner || owner.connection !== state.activeConnection || owner.schema !== state.schema) {
    throw new Error(say('theConnectionOrPage'));
  }
}

/* The configured pages asked for at start beside the schema and the App,
   not after them: adopted by the first cache of the same connection in the
   same connection generation, and dropped with the cache otherwise. The
   answer is the server's for this connection either way; asking it a round
   trip earlier changes only when it arrives. */
/** @type {{ connection: string | null | undefined, generation: number, promise: Promise<{ pages?: import('@mistriwork/engine/shared/page.js').PageDef[] }> } | undefined} */
let early;
export function prefetchPages() {
  const promise = api('/api/pages');
  promise.catch(() => {});
  early = { connection: state.activeConnection, generation: connectionGeneration(), promise };
}

/** @param {PageCache} owner */
async function configuredPages(owner) {
  assertCurrent(owner);
  if (owner.pages) return owner.pages;
  if (!owner.pending) {
    const adopted =
      early && early.connection === owner.connection && early.generation === connectionGeneration() ? early.promise : undefined;
    early = undefined;
    owner.pending = (adopted ?? api('/api/pages'))
      .then((data) => {
        assertCurrent(owner);
        /* A document is a page put on paper, reached from its record as a verb (documents.ts): never a
           page a record opens through, nor one offered beside the record's own. */
        return (owner.pages = (data.pages ?? []).filter((page) => page.document === undefined));
      })
      .finally(() => {
        owner.pending = undefined;
      });
  }
  return owner.pending;
}

// Saved layouts belong to the standalone browser, including while an App's
// payload is loading. Never even read an App's stale/malformed local mirror.
const appPagesOnly = () => Boolean(shell().app()) || appRequestScope() !== false;
const browserPages = () => (appPagesOnly() ? [] : savedPages());

/* App records use their authored page, or a suggestion only when none exists.
   The standalone browser retains its own saved-page precedence. The walk asks
   it through the shell, which names it at boot (app.js, `resolvePage`). */
/** @param {string} tableId */
export async function recordPageId(tableId) {
  const pages = await pagesFor(tableId);
  const built = new Set(browserPages().map((p) => p.id));
  const named = resourceOf(shell().app(), tableId)?.page;
  const [first] = pages;
  const chosen = first && built.has(first.id) ? first : (named && pages.find((p) => p.id === named)) || first;
  if (appPagesOnly() && chosen?.error) throw new Error(chosen.error);
  return chosen && !chosen.error ? chosen.id : `suggested:${tableId}`;
}

/** Every page for this connection; standalone Workbench includes its saved pages first. */
export async function pagesFor(tableId) {
  const owner = pageOwner();
  const pages = await configuredPages(owner);
  assertCurrent(owner);
  const all = [...browserPages(), ...pages];
  return tableId ? all.filter((p) => p.base === tableId) : all;
}

/**
 * Told when the set of pages changes, so the menu can be rebuilt. A
 * callback rather than an import: the builder announces, and whoever cares
 * listens — an import the other way made a cycle.
 */
let listener = null;

export function whenPagesChange(fn) {
  listener = fn;
}

export function forgetPages() {
  cache = undefined;
  early = undefined;
  listener?.();
}
whenSavedPagesChange(forgetPages);

export async function pageById(id, tableId) {
  const owner = pageOwner();
  const suggested = async (base) => {
    assertCurrent(owner);
    const data = await api(`/api/pages/suggested?table=${encodeURIComponent(base)}`);
    assertCurrent(owner);
    return data.page;
  };
  const mine = browserPages().find((p) => p.id === id);
  if (mine) return mine;
  if (id?.startsWith('suggested:')) {
    const base = id.slice('suggested:'.length);
    if (appPagesOnly()) {
      const authored = await recordPageId(base);
      assertCurrent(owner);
      if (authored !== id) return pageById(authored, base);
    }
    return suggested(base);
  }
  const pages = await pagesFor();
  assertCurrent(owner);
  const found = pages.find((p) => p.id === id);
  if (found) return found;

  /* A link may name the page rather than identify it — `@customer-overview`
     rather than `@saved:customer:1787509869158`. Ids are tried first. */
  const named = pages.filter((p) => pageSlug(p) === id);
  const mineFirst = named.find((p) => !tableId || p.base === tableId) ?? named[0];
  if (mineFirst) return mineFirst;

  /* Legacy bare table links use the App's page, or the browser's suggestion. */
  const asTable = findTable(id);
  if (asTable) {
    if (appPagesOnly()) {
      const authored = await recordPageId(asTable.id);
      assertCurrent(owner);
      return pageById(authored, asTable.id);
    }
    return suggested(asTable.id);
  }
  if (tableId) {
    if (appPagesOnly()) throw new Error(say('thereIsNoPage', { id }));
    return suggested(tableId);
  }
  throw new Error(say('thereIsNoPage', { id }));
}

/**
 * A page's name as it is written in a link: the readable half of an id
 * that would otherwise carry a timestamp into every pasted ticket.
 */
function pageSlug(page) {
  return String(page?.name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The token a page is written as in the hash: its slug where that names it
 * unambiguously, its id otherwise. Synchronous, because the address bar is
 * stamped during a render.
 */
export function pageToken(pageId) {
  if (!pageId) return pageId;
  if (pageId.startsWith('suggested:')) return pageId.slice('suggested:'.length);
  const known = [...browserPages(), ...(pageOwner().pages ?? [])];
  const page = known.find((p) => p.id === pageId);
  if (!page) return pageId;
  const slug = pageSlug(page);
  /* Ambiguity keeps the id: two pages called "Overview" would otherwise both
     answer to `@overview`. A table of the same name counts too. */
  const clashes = known.filter((p) => pageSlug(p) === slug).length > 1 || Boolean(findTable(slug));
  return slug && !clashes ? slug : pageId;
}
