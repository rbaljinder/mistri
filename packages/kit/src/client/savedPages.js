/**
 * The pages saved for a connection, as a synchronous mirror of the server's
 * file: what the record page's page list reads (page.js) in either shell, and
 * what the Workbench's page builder (pagebuilder.js) writes. An App reads
 * none — its pages are its definition — and a public visitor has none.
 */
import { appRequestScope, ownedBy } from './requestIdentity.js';
import { api, loadJson, saveJson, state } from './core.js';
import { sessionIdentity, subscribeSessionIdentity } from './sessionIdentity.js';
import { shell } from './shellMode.js';
import { say } from './copy/record/savedPages.js';

const KEY = 'mistri.pages.saved';

/**
 * Told when a page is saved or deleted, so the record-page cache and the menu
 * can be rebuilt. A callback rather than an import: page.js reads the saved
 * pages from here, and an import back made a cycle. page.js registers itself.
 * @type {(() => void) | null}
 */
let pagesChanged = null;
/** @param {() => void} fn */
export function whenSavedPagesChange(fn) {
  pagesChanged = fn;
}

const storeKey = (connection) => `${KEY}.${connection ?? ''}`;
/** @type {Map<string, Record<string, import('@mistriwork/engine/shared/page.js').PageDef>>} */
const mirrors = new Map();
const loads = new Map();

/* Another person's pages are not this one's: a change of who is signed in forgets the mirror and any read in flight. */
subscribeSessionIdentity(() => {
  mirrors.clear();
  loads.clear();
});

function mirrorFor(connection) {
  if (!mirrors.has(connection)) mirrors.set(connection, loadJson(storeKey(connection), {}));
  return mirrors.get(connection);
}

function updateMirror(connection, pages) {
  mirrors.set(connection, pages);
  // Disk acknowledgement is authoritative; unavailable browser storage is only a cache miss.
  saveJson(storeKey(connection), pages);
}

async function writePage(id, page, connection) {
  let timer;
  try {
    await Promise.race([
      api('/api/pages/save', { id, page, ...ownedBy(connection) }),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(say('theServerDidNotConfirm'))), 30_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Pages saved for the connection in hand, read from the local mirror. */
export function savedPages(tableId) {
  const all = mirrorFor(state.activeConnection);
  const pages = Object.values(all);
  return tableId ? pages.filter((p) => p.base === tableId) : pages;
}

/**
 * Pull this connection's saved pages from the server into the mirror.
 *
 * The same arrangement record layouts have, for the same reason: the mirror
 * is what makes reads synchronous, the file is what makes the work outlive
 * this browser. A failure is silent — the mirror already holds whatever this
 * browser saved.
 */
export async function loadSavedPages() {
  // A public visitor has none to read (the shell's publicVisitor), and saved pages are
  // the database browser's: an App's pages are its definition.
  if (shell().publicVisitor() || appRequestScope() !== false) return;
  const owner = sessionIdentity();
  const connection = state.activeConnection;
  const before = mirrorFor(connection);
  const load = Symbol();
  loads.set(connection, load);
  try {
    const { pages } = await api('/api/pages/saved');
    // A late read must not undo an acknowledged write or a newer read.
    if (
      owner === sessionIdentity() &&
      pages &&
      typeof pages === 'object' &&
      !Array.isArray(pages) &&
      mirrors.get(connection) === before &&
      loads.get(connection) === load
    )
      updateMirror(connection, pages);
  } catch {
    /* Server-side pages unavailable; the mirror stands. */
  }
}

export async function savePage(page, connection = state.activeConnection) {
  const owner = sessionIdentity();
  if (!connection) throw new Error(say('noDatabaseConnectionIsSelected'));
  const saved = structuredClone(page);
  await writePage(saved.id, saved, connection);
  if (owner !== sessionIdentity()) return;
  updateMirror(connection, { ...mirrorFor(connection), [saved.id]: saved });
  /* Also tells the menu to rebuild: it was registered once at boot, so a page
     built afterwards was reachable only from the link you were already on,
     and a deleted one stayed listed as a command that opened nothing. */
  if (state.activeConnection === connection) pagesChanged?.();
}

export async function deletePage(id, connection = state.activeConnection) {
  const owner = sessionIdentity();
  if (!connection) throw new Error(say('noDatabaseConnectionIsSelected'));
  await writePage(id, null, connection);
  if (owner !== sessionIdentity()) return;
  const all = { ...mirrorFor(connection) };
  delete all[id];
  updateMirror(connection, all);
  if (state.activeConnection === connection) pagesChanged?.();
}
