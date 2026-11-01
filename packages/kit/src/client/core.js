/**
 * The parts every other client module needs: the API, the navigation stack,
 * the schema mirrors, and DOM building (dom.js, re-exported here).
 *
 * Apart from independent connection-transition, notification and DOM helpers, this
 * file depends on no other client modules. Everything else depends on it,
 * which is what keeps the module
 * graph a fan-out rather than a web — and lets a feature live in its own file
 * without reaching into the renderer.
 */

import { flushSync } from 'react-dom';
import { DEFAULT_LIMIT } from '@mistriwork/engine/shared/reads.js';
import { PAGE_HEADER } from '@mistriwork/engine/shared/pageRoutes.js';
import { quoteValue } from '@mistriwork/engine/shared/query.js';
import { connectionGeneration } from './connectionTransition.js';
import { showToast } from './toast.js';
import { scopeApiRequest } from './requestIdentity.js';
import { assertSessionCurrent, captureScopedStorage, captureSessionIdentity, sessionIdentity } from './sessionIdentity.js';
import { invalidateSession } from './sessionLifecycle.js';
import { shell } from './shellMode.js';
import { historyToken } from './historyToken.js';
import { beginWork } from './pendingWork.js';
import { composedReads, setComposedConnection } from './composedHook.js';
import { isWritePath } from './writePaths.js';
import { firstPaintRead, forgetFirstPaint } from './firstPaint.js';
import { ownWriteSent } from './ownWrites.js';
import { trailFor } from './recordTrail.js';
import { disclosure, el, svgEl, trapFocus } from './dom.js';
import {
  columnKind,
  findTable as sharedFindTable,
  labelColumn,
  labelPath as sharedLabelPath,
  looksLikeDate,
  primaryKey,
  referencesFrom,
  referencesTo,
} from '@mistriwork/engine/shared/schema.js';
import { hopName, hopsFrom as sharedHopsFrom, tableAtPrefix as sharedTableAtPrefix } from '@mistriwork/engine/shared/view.js';
import { say } from './copy/shell/core.js';
import { shellById, shellQuery, shellQueryAll, shellRoot } from './shellHost.js';
import { fetchServer } from './transport.js';
import { fileReads } from './liveReads.js';
export { andQuery, splitClauseTail } from '@mistriwork/engine/shared/query.js';
export { humanName } from '@mistriwork/engine/shared/model.js';
/* Building DOM and the popups' keyboard manners live in dom.js; re-exported
   so every caller keeps its import. */
export { disclosure, el, svgEl, trapFocus };

/** @overload @param {'query' | 'table-filter'} id @returns {HTMLInputElement} */
/** @overload @param {'querybar'} id @returns {HTMLFormElement} */
/** @overload @param {string} id @returns {HTMLElement} */
/** @param {string} id */
export function $(id) {
  return shellById(id);
}

/**
 * @type {{schema: any, stack: any[], page: number, canWrite: boolean, activeConnection?: string | null, navMode: string,
 * connections?: (import('@mistriwork/engine/shared/connection.js').AppSource & Partial<import('@mistriwork/engine/shared/connection.js').PublicConnection>)[],
 * onSwitched?: (isCurrent?: () => boolean) => void | Promise<void>}}
 *
 * `stack` is a navigation stack, and each entry is somewhere you have been —
 * a table with a filter, or one row. The breadcrumb is that stack rendered,
 * so walking back restores the filter you walked away from.
 */
export const state = { schema: null, stack: [], page: 0, canWrite: false, navMode: 'replace' };
/* A record page's composed answers (composedHook.ts) go to this connection when a request names none. */
setComposedConnection(() => state.activeConnection ?? null);

/* The server's DEFAULT_LIMIT. Small on purpose: the first page of a
   browse should be instant, and paging is one click. */
const PAGE_SIZE = DEFAULT_LIMIT;

/**
 * How many rows a page actually holds, which the reader chooses.
 *
 * `PAGE_SIZE` stays the default and stays equal to the server's
 * `DEFAULT_LIMIT` — twenty is right for a first look, and the first look is
 * what most browsing is. It was also the *only* size, which turned a
 * sixty-thousand-row table into three thousand clicks: a table you could read
 * the front of and nothing else.
 *
 * Capped at 250 rather than offering "all". The grid renders every row it is
 * given, so the honest ceiling is the one where the DOM is still the reader's
 * friend; past that the answer is a filter, a sort, or Export.
 */
export const PAGE_SIZES = [10, 15, 20, 50, 100, 250];
const PAGE_SIZE_KEY = 'mistri.page-size';
let chosenPageSize = null;

export function pageSize() {
  if (chosenPageSize === null) {
    const stored = Number(loadJson(PAGE_SIZE_KEY, PAGE_SIZE));
    /* Validated rather than trusted: the value comes from localStorage, where
       a stale build or a hand edit can leave anything at all, and a page size
       of `null` asks the server for `LIMIT NaN`. */
    chosenPageSize = PAGE_SIZES.includes(stored) ? stored : PAGE_SIZE;
  }
  return chosenPageSize;
}

export function setPageSize(size) {
  chosenPageSize = PAGE_SIZES.includes(Number(size)) ? Number(size) : PAGE_SIZE;
  saveJson(PAGE_SIZE_KEY, chosenPageSize);
  /* A page *number* means nothing once the size changes — page 40 of twenty
     is not page 40 of a hundred — so the only honest place to land is the
     front. */
  state.page = 0;
}

/* ---------- API ---------- */

/* An App's search engine did not answer, so a text filter ran on the
   database (the server's `x-mistri-search: database`). Said once per page
   load: the results are still right, only found the slower way. */
let searchFallbackSaid = false;
/** @param {Response} res */
function noteSearchFallback(res) {
  if (searchFallbackSaid || res.headers?.get('x-mistri-search') !== 'database') return;
  searchFallbackSaid = true;
  toast(say('searchIsNotAnswering'));
}

/**
 * What a reader is told when the server does not answer at all. Offline
 * comes first, because it is the one cause the reader can see and fix; a
 * server on this machine is one they started, so restarting it is theirs to
 * do; anyone else — a hosted App, a phone — can only try again.
 * @returns {string}
 */
function unansweredSentence() {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return say('problem.offline');
  const host = typeof location === 'undefined' ? '' : location.hostname;
  if (host === 'localhost' || host === '[::1]' || host.startsWith('127.')) {
    return say('tablewalkIsNotAnswering');
  }
  return say('theServerIsNotAnswering');
}

/* The GET replies the server tags for revalidation (reply.ts sendRevalidated). */
const REVALIDATED = new Set(['/api/schema', '/api/app', '/api/pages', '/api/runtime']);

/* What changes a record: a composed page's answers are forgotten when one is sent (writePaths.ts). */
/** Requests carry the tab's App ID or DB connection ID, never a server-global selection.
 * @template {string} Path
 * @param {Path} path
 * @param {import('@mistriwork/engine/shared/resourceHttp.js').ResourceClientArgs<NoInfer<Path>>} args
 * @returns {Promise<import('@mistriwork/engine/shared/resourceHttp.js').ResourceClientReply<Path>>}
 */
export async function api(path, ...args) {
  return sent(path, /** @type {Record<string, unknown> | undefined} */ (args[0]), undefined);
}

/**
 * A free-form page's own request: `api`, saying which page asks
 * (`x-mistri-page`), so the server refuses a resource or a command the
 * page did not declare. Drift protection, not the boundary: the reader's
 * grants decide the request either way.
 * @param {string} page
 * @param {string} path
 * @param {Record<string, unknown>} body
 * @returns {Promise<any>}
 */
export async function pageApi(page, path, body) {
  return sent(path, body, { [PAGE_HEADER]: page });
}

/**
 * @param {string} path
 * @param {Record<string, unknown> | undefined} body
 * @param {Record<string, string> | undefined} headers
 * @returns {Promise<any>}
 */
async function sent(path, body, headers) {
  /* Counted while it is out: a navigation keeps the screen it left until
     the room it opened has had its answers (navigationHold.ts). */
  const settled = beginWork();
  const writing = isWritePath(String(path).split('?')[0], body);
  /* Its echo on the live stream is told from a change someone else made by when it was answered (ownWrites.ts). */
  const answered = writing ? ownWriteSent() : undefined;
  try {
    return await request(path, body, headers);
  } finally {
    answered?.();
    settled();
    /* Forgotten as a write is sent (request) and again as it is answered,
       before its caller refreshes the page: a compose that left while it
       was out may have read the record before the write landed. */
    if (writing) composedReads()?.forget();
  }
}

/**
 * @param {string} path
 * @param {Record<string, unknown> | undefined} body
 * @param {Record<string, string> | undefined} headers
 * @returns {Promise<any>}
 */
async function request(path, body, headers) {
  const parsedPath = new URL(path, window.location.href);
  if (!path.startsWith('/api/') || parsedPath.hash || parsedPath.pathname !== path.split('?')[0]) {
    throw Object.assign(new Error(say('useACanonicalApi')), { outcome: 'not_applied' });
  }
  const identity = captureSessionIdentity();
  const bootstrap = parsedPath.pathname === '/api/whoami' && identity.mode === 'unknown';
  if (!bootstrap) assertSessionCurrent(identity);
  /* A read a record page's compose already asked is answered from it
     (composedReads.ts); a write makes every such answer the past. */
  const composing = composedReads();
  const writing = isWritePath(parsedPath.pathname, body);
  if (writing) forgetFirstPaint();
  if (composing && writing) composing.forget();
  else if (composing && body && composing.may(parsedPath.pathname)) {
    const composed = await composing.reply(parsedPath.pathname, /** @type {Record<string, unknown>} */ (body));
    if (composed !== undefined) {
      assertSessionCurrent(identity);
      return composed;
    }
  }
  if (identity.tenantRequired && parsedPath.pathname !== '/api/whoami' && !parsedPath.pathname.startsWith('/api/auth/')) {
    /* The tenant's lease is the shell's (shellMode.ts): a shell that installed none has no tenant to send through. */
    const tenant = shell().tenant;
    if (!tenant) throw Object.assign(new Error(say('theTenantContextIsUnavailable')), { outcome: 'not_applied' });
    if (tenant.isMutation(parsedPath.pathname)) return await tenant.mutate(path, body, state.activeConnection);
    return await tenant.read(path, body === undefined ? undefined : { ...body }, state.activeConnection);
  }
  if (
    parsedPath.pathname === '/api/revert' &&
    body &&
    'expectedId' in body &&
    body.expectedId !== undefined &&
    historyToken(body.expectedId, false) === undefined
  )
    throw Object.assign(new Error(say('invalidOrdinaryUndoIdentity')), { outcome: 'not_applied' });
  const { url, payload } = scopeApiRequest(path, body === undefined ? undefined : { ...body }, state.activeConnection);

  /* The page arrived with this answer (firstPaint.ts): taken as a reply
     would be, the account it was for held to the session as a reply's is. */
  const carried = firstPaintRead(payload ? 'POST' : 'GET', url, payload);
  if (carried) {
    if (!bootstrap) {
      assertSessionCurrent(identity);
      try {
        assertSessionCurrent(identity, carried.account ?? null);
        if (identity.mode === 'anonymous' && carried.account) throw new Error(say('theSignedInAccount'));
      } catch (error) {
        invalidateSession('account-changed');
        throw error;
      }
    }
    return carried.body;
  }

  let res;
  try {
    res = await fetchServer(url, {
      credentials: 'same-origin',
      /* The schema, the App, its pages and the runtime carry an ETag
         (reply.ts sendRevalidated): the browser may keep them, and asks
         again with If-None-Match every time, so a 304 answers an unchanged
         one. Everything else is never stored. */
      cache: !payload && REVALIDATED.has(parsedPath.pathname) ? 'no-cache' : 'no-store',
      method: payload ? 'POST' : 'GET',
      headers: {
        ...(payload ? { 'content-type': 'application/json' } : {}),
        ...(identity.mode === 'authenticated' ? { 'x-mistri-account': identity.accountId } : {}),
        ...headers,
      },
      body: payload ? JSON.stringify(payload) : undefined,
    });
  } catch {
    /* `fetch` rejects with "Failed to fetch" or "Load failed" depending on the
       browser, and neither says the one thing that is true and useful: the
       server this page came from is not answering. It is a local process, so
       that nearly always means it was stopped — and "Failed to fetch" sends
       people to look at their network. Only on this machine, though: a
       hosted App's reader, or one on a phone, cannot restart anything, and
       one who is offline needs to hear that first. */
    throw new Error(unansweredSentence());
  }

  if (!bootstrap) {
    assertSessionCurrent(identity);
    if (res.status === 401 && identity.mode === 'authenticated') {
      invalidateSession('expired');
      throw Object.assign(new Error(say('yourSessionExpiredReload')), { status: 401 });
    }
    try {
      assertSessionCurrent(identity, res.headers?.get('x-mistri-account'));
      if (identity.mode === 'anonymous' && res.headers?.get('x-mistri-account')) {
        throw new Error(say('theSignedInAccount'));
      }
    } catch (error) {
      invalidateSession('account-changed');
      throw error;
    }
  }
  noteSearchFallback(res);

  let data;
  try {
    data = await res.json();
  } catch {
    /* An answer that is not JSON is a proxy, a login page, or a crash — none
       of which the caller can do anything with, and all of which read better
       as what they are than as "Unexpected token < in JSON". */
    throw new Error(say('theServerAnsweredWithSomething', { status: res.status }) + say('somethingBetweenThisPage'));
  }

  if (!bootstrap) assertSessionCurrent(identity);
  /* A refused write answers its envelope — `errors` and a `rejected` outcome — at 422 when the App's rules or a
     value refused it and 409 when the database's keys did (server constraints.ts writeRefusalStatus). The form
     reads it as it reads any refused write, the field marked and the draft kept, so it is an answer here, not a
     failure. */
  if ((res.status === 409 || res.status === 422) && Array.isArray(data?.errors) && data.errors.length && data.outcome === 'rejected')
    return data;
  if (!res.ok) {
    /* The status travels with the message. Callers have always had to guess
       the kind of failure from the text of it, which is how "No connection is
       open." — a 409 with a specific meaning and a specific screen to show
       for it — could only be recognised by matching a sentence. */
    const said = data.message ?? data.error ?? say('common.requestFailed', { status: res.status });
    /* `cause` is sent only to the App's author at work (server
       http/refusalReport.ts): the rule, table or column behind a refusal,
       said beside the caller's sentence wherever that sentence is drawn. */
    const failure = Object.assign(
      new Error(typeof data.cause === 'string' ? say('forTheAuthor', { message: said, cause: data.cause }) : said),
      {
        status: res.status,
        signIn: undefined,
        ...(typeof data.code === 'string' ? { code: data.code } : {}),
        ...(data.outcome === 'not_applied' || data.outcome === 'unknown' ? { outcome: data.outcome } : {}),
        /* The input a command's refusal is about (`refuse(…, { field })`): its form says the sentence beside that field. */
        ...(typeof data.field === 'string' ? { field: data.field } : {}),
        /* A busy server says when to come back (server/http/reply.ts sendBusy), in seconds: kept in ms for a read's retry (components/mount.tsx). */
        ...(res.status === 503 && data.code === 'server_busy' && Number(res.headers?.get('retry-after')) > 0
          ? { retryAfter: Number(res.headers.get('retry-after')) * 1000 }
          : {}),
        /* Where this failure's trace is, while a --dev server's observer runs:
         its badge offers "Open in observer" (observe/beacon.js). */
        ...(typeof data.observe === 'string' && /^(\/[A-Za-z0-9][\w-]*)*\/_mistri\/observe\//.test(data.observe)
          ? { observe: data.observe }
          : {}),
        // The column names a refusal quotes, for a surface that says them in an App's captions.
        ...(Array.isArray(data.columns) && data.columns.every((column) => typeof column === 'string') ? { columns: data.columns } : {}),
      },
    );
    if (failure.observe) window.dispatchEvent(new CustomEvent('mistri:observe', { detail: failure.observe }));
    /* A server that signs people in answers 401 with what to draw. Told
       once, through a seam, so core does not know what a sign-in screen is. */
    /* A visitor browsing an App's public part is already in the App: a read
       past `auth.public` (a member's list or dashboard) answers 401 as
       `members_only`, and the surface that asked offers the sign-in in place
       (TableRoom's NotYours) rather than the whole page turning into it. */
    if (res.status === 401 && data.signIn) {
      failure.signIn = data.signIn;
      if (!(data.code === 'members_only' && shell().publicVisitor())) unauthorized(data.signIn);
    }
    throw failure;
  }
  fileReads(data, res.headers?.get('mistri-reads'));
  return data;
}

/**
 * Anything that has to be rebuilt when the database underneath changes.
 *
 * A connection switch is not a render: the trail is cleared, the schema is
 * replaced and every per-connection thing — layouts, saved statements, write
 * mode — is reloaded. Long-lived surfaces that are *not* inside `#content`
 * miss all of it. The SQL editor was the case that showed it: painted once
 * from the state it opened with, it went on naming the previous database
 * while the statement it ran went to the new one, and it kept offering "Run
 * as write…" after a switch to a connection the server would refuse.
 *
 * A set rather than the single `state.onSwitched` slot beside it, because the
 * second thing that needed to know would have silently replaced the first.
 */
const switchWatchers = new Set();

/** Register a rebuild. Returns the way to stop listening. */
export function whenConnectionChanges(run) {
  switchWatchers.add(run);
  return () => switchWatchers.delete(run);
}

/**
 * Say that the connection changed. Called by the two places that switch —
 * the picker and a deep link into another database — after the new schema
 * and everything keyed to it have landed, so a watcher reads the new state
 * rather than the half-swapped one.
 */
export function connectionChanged() {
  /* A copy, because a watcher may well unregister itself as its last act. */
  for (const run of [...switchWatchers]) {
    try {
      run();
    } catch (err) {
      /* One surface failing to rebuild must not stop the next one. It is
         already the wrong database on screen; making it the wrong database
         everywhere is not an improvement. */
      console.error(err);
    }
  }
}

/* ---------- schema helpers ----------

   The shared rules, with the one schema this client holds already applied:
   the browser has one connection open and keeps its schema in `state`, so a
   caller here names a table and not a schema. Each is the server's function
   under the server's name. For a long time they were copies — the client
   could not import the TypeScript — and the copies drifted: a list limit of
   eight against ten, a date used as a row's label on one side and the key on
   the other. Now there is one rule and this is where the client reaches it. */

// React roots may render once while a retired context is being unmounted.
// An absent catalog has no records or command targets, not a fallback owner.
export const findTable = (id) => (state.schema?.tables ? sharedFindTable(state.schema, id) : undefined);
export const refsTo = (id) => referencesTo(state.schema, id);
export const refsFrom = (id) => referencesFrom(state.schema, id);
export { columnKind, labelColumn, primaryKey };

/** Whether a column should be treated as a date for presentation. */
export const looksLikeDateColumn = (col) => Boolean(col) && looksLikeDate(col);

/* The zoom-aware ruler is the ui package's (packages/ui/src/internal/ruler.ts says why
   every overlay is measured with it); the client reaches it here, under the
   names it always had. */
export { viewportScale, refreshViewportScale, viewportBox, viewportSize } from '@mistriwork/ui/internal/ruler.js';

/** Where a row's name lives, as a view path — see labelPath in shared/schema.ts. */
export const labelPath = (table) => sharedLabelPath(state.schema, table, recordLabel(table));

/** An explicit record name, or false when that name is unavailable to this reader. */
export const recordLabel = (table) => shell().recordLabel(table.id);

/* ---------- paths ----------

   Every hop is derivable from the schema the page already holds, so proposing
   the next segment of a path is local and instant; asking the server per
   keystroke would make the one interaction that has to feel immediate the one
   that does not. The server still resolves every path for real before
   anything runs. */

export { hopName };
export const hopsFrom = (tableId) => sharedHopsFrom(state.schema, tableId);
/** An empty prefix is the base; a prefix that walks nowhere is null. */
export const tableAtPrefix = (baseId, prefix) => sharedTableAtPrefix(state.schema, baseId, prefix) ?? null;

/** How a row is named in a breadcrumb: the readable column, else the key. */
export function rowLabel(table, row) {
  /* The walked-to name first. A row fetched as a view carries the joined
     label under its path — `party_id.display_name` — while a plain query row
     simply lacks that key and falls through to the table's own label, then
     the primary key. One function for both, so a caller never has to know
     which kind of row it is holding. */
  const configured = recordLabel(table) !== undefined;
  for (const name of configured ? [labelPath(table)] : [labelPath(table), labelColumn(table)]) {
    const value = name != null ? row[name] : undefined;
    if (value !== null && value !== undefined && String(value) !== '') return String(value);
  }
  const values = primaryKey(table).map((c) => row[c]);
  if (configured && values.some((value) => value == null)) return '(row)';
  const pk = values.filter((value) => value != null);
  return pk.length ? pk.join('/') : '(row)';
}

/**
 * The primary key of a row, or null when this row cannot supply one.
 *
 * Null rather than a key with `undefined` in it. A projected query — `show
 * quantity`, or a child section showing four summary columns — returns rows
 * that genuinely do not carry the key, and building `{invoice_id: undefined}`
 * out of one produced a link to `~invoice_line:invoice_id=undefined` that
 * landed on "That row is no longer there." Nothing had gone missing; the
 * navigation was built from a row that never had the key to begin with.
 *
 * Callers use the null to decide whether a row is clickable at all, so a row
 * that cannot be opened does not look like one that can.
 */
export function keyOf(table, row) {
  const columns = primaryKey(table);
  if (!columns.length) return null;
  const key = {};
  for (const col of columns) {
    if (row[col] === undefined) return null;
    key[col] = row[col];
  }
  return key;
}

/** A filter matching exactly one row by its primary key. */
export function keyFilter(key) {
  return { groups: [Object.entries(key).map(([column, value]) => ({ column, op: '=', value }))] };
}

/* ---------- navigation ---------- */

let navigationGeneration = 0;
export function invalidateNavigation() {
  navigationGeneration += 1;
}

/** Capture permission for background work without starting a new navigation intent. */
export function captureNavigation() {
  const generation = navigationGeneration;
  const transition = connectionGeneration();
  const connection = state.activeConnection;
  const schema = state.schema;
  const entry = currentEntry();
  return () =>
    generation === navigationGeneration &&
    transition === connectionGeneration() &&
    connection === state.activeConnection &&
    schema === state.schema &&
    entry === currentEntry();
}

/** A later intent wins even before either request has changed the visible view. */
export function beginNavigation() {
  invalidateNavigation();
  return captureNavigation();
}

/* A paint is a tick of its own beside the walk's: the content pane
   (components/Content.tsx) writes the address bar on every paint and leaves
   the trail's room alone on a crumb correction, which only ticks the walk.
   Flushed synchronously — `render()` has always finished painting before it
   returned, and the address gate (url.js `whileApplying`) and every caller
   that reads the page straight after depend on that. */
let paintTick = 0;
export const paintVersion = () => paintTick;

/* The room is a third tick, and the one the content pane keys its room by.
   Nearly every paint starts the room over, the way a repaint always did: a
   write that repaints sees itself, another table or record is another room.
   A refinement does not. A page, a page size, or a sort or filter from a
   column header is the same table room asking a different question, and
   the room re-asks it in place (TableRoom's Query is keyed by the
   question), keeping the rows on screen until the answer lands and every
   row decoration's state with them. Only a paint made inside `refine()`
   whose table room is the one already on screen — the same connection,
   depth, table and tab — keeps it; anything else ticks. */
let roomTick = 0;
let roomOnScreen = null;
let refining = false;
export const roomVersion = () => roomTick;

/** A table view's identity as a room, or null for anything else. */
function tableRoomShape() {
  const top = currentEntry();
  if (!top || top.kind !== 'table') return null;
  return JSON.stringify([state.activeConnection ?? '', state.stack.length, top.table, top.tab ?? 'rows']);
}

/**
 * Paint a refinement of the table room on screen: a page, a page size, a
 * header's sort or filter. The address bar and the trail are written as for
 * any paint; the room is kept when it is still the same table room.
 */
export function refine(fn) {
  const was = refining;
  refining = true;
  try {
    return fn();
  } finally {
    refining = was;
  }
}

/* What happens around a paint that may start the room over: the shell
   registers the navigation hold (navigationHold.ts), which keeps the screen
   being left until the new room is complete. A seam, so core stays free of
   the DOM it holds; nothing registered, a paint is only a paint. */
let paintHold = null;
/** @param {{ before(roomChanged: boolean): void; after(): void } | null} hold */
export function setPaintHold(hold) {
  paintHold = hold;
}

export function render() {
  if (sessionIdentity().mode === 'locked') return;
  paintTick += 1;
  const shape = tableRoomShape();
  const roomChanged = !refining || shape === null || shape !== roomOnScreen;
  if (roomChanged) roomTick += 1;
  roomOnScreen = shape;
  paintHold?.before(roomChanged);
  flushSync(tellWalk);
  paintHold?.after();
}

/* The walk as something a component can watch. Every render and every
   crumb correction is one tick; a component that subscribes re-reads the
   stack. Kept as a counter rather than a copy of the stack, because the
   stack is mutated in place by design (a label arrives, a root resolves)
   and a copy would miss exactly those corrections. */
const walkListeners = new Set();
let walkTick = 0;
function tellWalk() {
  walkTick += 1;
  for (const fn of walkListeners) fn();
}
export function subscribeWalk(fn) {
  walkListeners.add(fn);
  return () => walkListeners.delete(fn);
}
export const walkVersion = () => walkTick;

/* Redrawing the trail alone, without re-running the view.
   A row restored from a link knows only its key, so its crumb starts as the
   key and is corrected once the row arrives. Calling render() for that would
   re-fetch the row that just resolved it — and loop. The crumbs are React
   and redraw from the walk's subscribers. */
export function renderCrumbs() {
  tellWalk();
}

/**
 * Move to a view and render.
 *
 *   push    — a step along a reference; the trail grows
 *   replace — the same view, re-run (a sort, an edited filter, a tab)
 *   reset   — a fresh start; the trail is discarded
 *
 * The distinction is the whole meaning of the breadcrumb. A trail is a walk:
 * every crumb should be reachable from the one before it by following a key.
 * Jumping to an unrelated table is not a step along that walk, so it starts a
 * new one rather than appending browsing history.
 */
export function go(entry, mode = 'push') {
  if (!allowMutationExit()) return;
  invalidateNavigation();
  carryView(entry, mode);
  if (mode === 'reset') state.stack = [entry];
  /* Replacing the top of an empty stack — the landing has no entry — wrote
     to index -1: a property on the array, not a member of it. The view
     painted (currentEntry reads the same slot) and the address bar did not
     (the URL walks the array), so the landing's first refinement rendered
     with nothing in the bar to send. An empty stack gains its first entry. */
  else if (mode === 'replace' && state.stack.length) state.stack[state.stack.length - 1] = entry;
  else state.stack.push(entry);
  if (mode !== 'replace') state.page = 0;
  /* How the address bar should record this. A step in the walk earns a
     history entry so the browser's Back button undoes it; a refinement of the
     view you are already on does not, or Back would spend three presses
     undoing sort toggles. */
  state.navMode = mode === 'replace' ? 'replace' : 'push';
  render();
}

/**
 * Which App view opened a room rides the walk as `view` — its key — and
 * appnav.js reads it where two views share a table. The callers that
 * refine a list (a sort, a header menu, a tab) or open one of its records
 * build a plain `tableView`/`rowView` and know nothing of views, so the
 * walk carries it for them: a same-table refinement in place, and a record
 * of that table opened from it. A caller that names a view — or names
 * none, `view: undefined` — is taken at its word; a fresh start carries
 * nothing.
 */
function carryView(entry, mode) {
  const top = state.stack[state.stack.length - 1];
  if (mode === 'reset' || !top?.view || !entry || 'view' in entry || entry.table !== top.table) return;
  if (entry.kind === 'row' || (entry.kind === 'table' && mode === 'replace')) entry.view = top.view;
}

export function backTo(index) {
  if (!allowMutationExit()) return;
  invalidateNavigation();
  state.stack.length = index + 1;
  state.page = 0;
  // Clicking a crumb is a navigation, so Back returns you to where you were.
  state.navMode = 'push';
  render();
}

/** A table view, optionally filtered. The query text is what the bar shows. */
export function tableView(tableId, query, tab) {
  return { kind: 'table', table: tableId, query: query ?? tableId, tab: tab ?? 'rows' };
}

/**
 * A breakdown: counts and sums, grouped by something.
 *
 * `table` is the base being counted, so the sidebar highlights it and the
 * crumb reads like a table's. It is deliberately not a `tab` of the table
 * view: the rows of a breakdown are groups rather than records, and a tab
 * would promise they behave like the rows beside them.
 */
export function breakdownView(tableId, query) {
  return { kind: 'breakdown', table: tableId, query };
}

/** A single row. The key is enough to re-fetch it, so nothing goes stale. */
export function rowView(tableId, key, label) {
  return { kind: 'row', table: tableId, key, label };
}

/**
 * A page, with or without a root yet.
 *
 * `table` is the page's base rather than a table being browsed, so that the
 * sidebar highlights the right thing and a page can find its way back to a
 * suggested layout when the id names no configured page.
 */
export function pageView(pageId, tableId, key, label) {
  return { kind: 'page', pageId, table: tableId, key, label };
}

export const currentEntry = () => state.stack[state.stack.length - 1];

// Registered by the draft store: core must not import the editing/rendering tree.
let recordMutationPending = () => false;
/** @param {() => boolean} probe */
export function setRecordMutationPendingProbe(probe) {
  recordMutationPending = probe;
}
// Transient editors supplement the draft/tenant guards; they never settle an
// operation merely because its dialog unmounted or the URL did not change.
const surfaceMutationProbes = new Set();
/** @param {() => boolean} probe */
export function registerSurfaceMutationPendingProbe(probe) {
  surfaceMutationProbes.add(probe);
  return () => {
    surfaceMutationProbes.delete(probe);
  };
}

/** Voluntary navigation cannot discard a tenant operation's uncertain result.
 * Forced session retirement bypasses this guard and still clears private data. */
export function allowMutationExit() {
  let pending = true;
  try {
    pending = recordMutationPending();
  } catch {
    /* An unreadable owner cannot authorize an exit. */
  }
  if (pending) {
    toast(say('waitForThePending'), 'error');
    return false;
  }
  for (const probe of surfaceMutationProbes) {
    let blocked = true;
    try {
      blocked = probe();
    } catch {
      /* An unreadable surface cannot authorize exit. */
    }
    if (blocked) {
      toast(say('aChangeIsPending'), 'error');
      return false;
    }
  }
  if (!shell().mutations.hasUnresolved() && !shell().accountBusy()) return true;
  toast(say('aChangeIsPending'), 'error');
  return false;
}

/* How a record opens, when the walk is already looking at pages.
 *
 * A page is a way of reading a record, not a place: someone who chose the
 * page view for a customer wants the invoice they clicked to open the same
 * way, and dropping them into the plain record view — and making them press
 * "As a page" again — is the walk changing shape underneath them.
 *
 * The resolver is the shell's (shellMode.ts) rather than imported because
 * core must not know about pages: `page.js` already imports this file, and
 * the preference for a saved or configured page over the suggested one lives
 * there with the rest of the page machinery. No resolver means nothing changes.
 */

/** The page a table's records read through here, or null when unavailable or
    cancelled. Current lookup failures reject; cancelled failures are ignored.
    For a deep link
    that arrives as a row while an app is on: the walk would have opened it
    as a page, and a pasted link should land where a click would. */
export async function pageFor(tableId) {
  const pageResolver = shell().resolvePage;
  if (!pageResolver || !shell().pageAffinity()) return null;
  const isCurrent = captureNavigation();
  try {
    const pageId = await pageResolver(tableId);
    return isCurrent() ? (pageId ?? null) : null;
  } catch (error) {
    if (!isCurrent()) return null;
    throw error;
  }
}

/* Whether pages are the walk's default, not just its current mode.
 *
 * The shell's answer for the same reason the resolver is: an app (appnav.js)
 * reads records through pages by design — that is what makes it an app
 * rather than a browser — but core must not know apps exist. The
 * Workbench's answer is no, and records open the way they always did. */

/** Whether records open as pages here — the sign that an app is reading. */
export function prefersPages() {
  return Boolean(shell().pageAffinity());
}

/* ---------- who is asked to sign in ---------- */

let unauthorizedShown = false;

/** What happens when the server demands a sign-in: the shell's answer (shellStart.js), once per page load. */
function unauthorized(info) {
  if (unauthorizedShown) return;
  unauthorizedShown = true;
  shell().unauthorized(info);
}

/* ---------- what may be written ---------- */

/**
 * Whether a table may be written from here, beyond the connection's own
 * flag. In the Workbench, everything the connection allows; an app answers
 * its scope — the tables its manifest names, or nothing — and every write
 * affordance asks before it appears. The server enforces the same list;
 * this is what keeps a button from promising a write the server refuses.
 */
export function writeAllowed(tableId) {
  return Boolean(shell().writeScope(tableId));
}

/* ---------- the empty word ---------- */

/**
 * What an empty value reads as. In the workbench, plain DB mode, it is
 * `null`, because that is the truth about the row and the reader is reading
 * the database. An app answers a dash: a record form full of the word `null`
 * is the schema leaking through, and "nothing here" is a form's own word for
 * it, with the truth one hover away. The shell's answer, so core never asks
 * whether an app is on.
 */
export function emptyWord() {
  return shell().emptyWord() ?? 'null';
}

/* ---------- column labels ---------- */

/**
 * The one place a column's shown name is decided, answered by whoever owns
 * the words — app mode answers the manifest's labels plus the humanized
 * fallback; the workbench, plain DB mode, shows the raw name on every
 * surface. One seam instead of a per-surface `inAppMode()` map, because
 * the surfaces that forgot the map were exactly the ones still showing
 * INVOICE_ID in an app.
 */

/**
 * What to call a column of a table right now, or null for "the raw name".
 * `column` may be a dotted label path — "account_id.name" — and the
 * source decides how that reads. `contextPath` names a related record
 * already identified by the containing field section.
 */
export function columnLabel(tableId, column, contextPath = '') {
  return shell().label(tableId, column, contextPath) ?? null;
}

/**
 * How a column's values dress — the label seam's twin, for rendering.
 * App mode answers the manifest's display rules; in the workbench every
 * value keeps the explorer's plain face. Returns a rule
 * ({ format?, currency?, tone?, bar? }) or null for "as it is".
 * @returns {any}
 */
export function columnDisplay(tableId, column) {
  return shell().display(tableId, column) ?? null;
}

/**
 * Open one record, in whichever view the walk is already in.
 *
 * Every route into a record goes through here, so the mode is sticky by
 * default and a call site that wants the record view specifically still says
 * `go(rowView(...))` — which is what the table grid and the record view's own
 * related lists do, since neither is in page view to begin with.
 */
/* How a record opens can be the app's decision — a drawer, one day a
   modal — the shell's answer, as page affinity is: core stays app-ignorant
   and asks. An opener that answers true has handled the click. Who begins
   reading a record's page ahead of the press that opens it
   (recordCompose.ts) is the shell's answer too. */

/**
 * Begin reading the page a press on this record will open, before the
 * press is over: the same page `openRecord` would choose, asked of the
 * prefetcher, which decides whether the record opens as a page at all.
 * Nothing moves and nothing is drawn; a record that opens some other way
 * asks nothing.
 */
export function prefetchRecord(tableId, key) {
  const { prefetchRecord: recordPrefetcher, resolvePage: pageResolver, pageAffinity } = shell();
  if (!recordPrefetcher || !pageResolver || !tableId || !key || typeof key !== 'object') return;
  const here = currentEntry();
  if (here?.kind === 'page' && !here.key && here.table === tableId) {
    recordPrefetcher(here.pageId, tableId, key);
    return;
  }
  if (!(here?.kind === 'page' || pageAffinity(tableId))) return;
  void Promise.resolve(pageResolver(tableId)).then(
    (pageId) => {
      if (pageId) recordPrefetcher(pageId, tableId, key);
    },
    () => {},
  );
}

/* A glance at one record without leaving the list (Space on a row), which
   peekpanel.js draws: the shell's answer, as the opener is, so core and the
   grid stay free of the drawer. */
/** Glance at a record over the list; false where the shell draws no drawer. */
export function peekRecord(tableId, key, label, records, list) {
  const recordPeeker = shell().peekRecord;
  if (!recordPeeker) return false;
  const branch = unionBranch(tableId, key);
  if (branch) recordPeeker(branch.table, branch.key, label);
  else if (branch === undefined) recordPeeker(tableId, key, label, records, list);
  return true;
}

/** A union row's own record — `{ table, key }`, null where its branch is not this reader's — or undefined for any other table's. */
function unionBranch(tableId, key) {
  const branches = findTable(tableId)?.union?.branches;
  const branch = branches?.find((b) => b.from === key?.from);
  return branches && (branch ? { table: branch.from, key: { [branch.key]: key.key } } : null);
}

export async function openRecord(tableId, key, label, how = 'push', opts = {}) {
  /* A union's row is its branch's record (appUnions.ts): opened there, without the union's list to step through. */
  const branch = unionBranch(tableId, key);
  if (branch !== undefined) return branch ? openRecord(branch.table, branch.key, label, how, { direct: opts.direct }) : undefined;
  if (!allowMutationExit()) return;
  const isCurrent = beginNavigation();
  /* `direct` is the drawer's own "Details →" declining its own answer:
     without it the opener would answer the click it just handed over. */
  /* A registered opener may either consume the click (`true`) or ask for a
     row route (`'row'`) while still taking part in the normal navigation
     fencing. The latter is used by app-owned split workspaces: their detail
     pane is a row surface, but automatic page affinity must not replace it
     with a configured page. */
  const answer = !opts.direct ? shell().openRecord(tableId, key, label, opts.records, opts.list) : false;
  /* `{ under }` is a row route that first stands a list beneath it: a split
     picked at the App's root, where the walk is empty (appnav.js). */
  const under = answer && typeof answer === 'object' ? answer.under : undefined;
  const opening = under ? 'row' : answer;
  /* The list it was opened from rides the record's entry, so the record can
     step to its neighbors (recordTrail.ts). Not in the address: a link is to
     the record, and the list it was reached from is this reader's walk. */
  const trail = trailFor(tableId, key, opts.records, opts.list);
  const trailed = (entry) => (trail ? { ...entry, trail } : entry);
  if (opening === true) return;
  /* Rooting the page you are standing on. A rootless page shows its list
     as the chooser, and choosing is not a step of the walk — the entry
     gains its key in place, or the trail reads `invoice › invoice ›
     invoice`, one hollow crumb per change of mind. */
  const here = currentEntry();
  if (here?.kind === 'page' && !here.key && here.table === tableId) {
    go({ ...here, key, label, rootBody: undefined }, 'replace');
    return;
  }
  const pageResolver = shell().resolvePage;
  if (opening !== 'row' && (here?.kind === 'page' || shell().pageAffinity(tableId)) && pageResolver) {
    try {
      const pageId = await pageResolver(tableId);
      if (!isCurrent()) return;
      if (pageId) {
        go(trailed(pageView(pageId, tableId, key, label)), how);
        return;
      }
    } catch {
      /* A page that cannot be resolved is not a reason to go nowhere. */
    }
  }
  if (!isCurrent()) return;
  /* A split's pick is its list's selection, not a step. The first pick
     stands the row on its list — the split's address is the list and then
     the key, `/thread/inbox/~2`, so the list entry stays under it —
     and every later pick replaces that row, as a rooted page gains its key in
     place above: pushed, each pick was one more crumb and one more Back
     (Crumbs.tsx draws the list and its row as one crumb). Only the split's
     own room: a record opened from anywhere else pushes. */
  const picked = opening === 'row' && here?.kind === 'row' && here.table === tableId;
  if (under && !state.stack.length) state.stack.push(under);
  go(trailed(rowView(tableId, key, label)), picked ? 'replace' : how);
}

/* ---------- chrome shared between views ---------- */

/* Whether the compiled SQL is on show. Held here rather than read off a
   button, because the control that sets it moved into a menu and the pane
   should not care which widget last toggled it. */
let explaining = false;

export const explainVisible = () => explaining;

export function setExplaining(on) {
  explaining = on;
  showExplain();
}

export function setExplain(sql) {
  $('explain').textContent = sql ?? '';
  lastExplained = sql ?? '';
  showExplain();
}

/* The pane is hidden as a whole rather than the <pre> alone, so the control
   that edits the statement cannot outlive the statement it edits. */
function showExplain() {
  const pane = $('explain-pane');
  if (pane) pane.hidden = !explaining || !$('explain').textContent;
}

/** The statement the current view compiled to, for anything that wants to run it. */
let lastExplained = '';
export const explainedSql = () => lastExplained;

export function showErrors(errors) {
  const box = $('errors');
  box.replaceChildren(...errors.map((e) => el('p', { text: e.message })));
  box.hidden = !errors.length;

  /* A query that did not run must not be saveable as a filter.
  
     The banner said `"quantitee" is not a column on invoice_line`, correctly
     and helpfully — and beside it "+ Save this filter" stayed live, so a typo
     could be given a name and kept. The clause chips stayed ordinary too,
     which is the deeper misdescription: when the query fails *none* of them
     are in effect, so a row of chips reading as the current filter is
     describing something that is not happening.

     Done here rather than where the bar is built because this is the only
     moment the app knows: the bar is drawn from the query text, before the
     answer comes back. */
  const failed = errors.length > 0;
  for (const save of shellQueryAll('.view-save')) {
    if (!(save instanceof HTMLButtonElement)) continue;
    save.disabled = failed;
    save.title = failed ? say('fixTheQueryBefore') : '';
  }
  shellQuery('.views')?.classList.toggle('not-in-effect', failed);
}

/**
 * Quote a value for the query bar, only when it needs it.
 *
 * The one place the client writes a value into the grammar, and it is the
 * server's own `quoteValue`, not a copy: the copy's rule ("word characters,
 * dots and hyphens are safe") let a slug carrying `select` through bare, and
 * the parser read it as a clause. `quoteValue` asks the parser whether the
 * bare value reads back as itself, so the two cannot disagree again.
 */
export function quote(value) {
  return quoteValue(value);
}

/** A short-lived message at the top of the content area. */
/**
 * A passing message, optionally with one thing to do about it.
 *
 * The action exists for the case where the message *is* the moment to act —
 * "Updated 2 columns" is exactly when someone realises it was the wrong row,
 * and sending them to a menu to find Undo wastes the seconds in which they
 * still remember what they did. Anything that needs more than one verb belongs
 * in a dialog rather than here.
 */
export function toast(message, tone = 'info', action) {
  const host = $('toast');
  if (!host || sessionIdentity().mode === 'locked') return;
  showToast(host, message, tone, action, prefersPages());
}

/* ---------- persistence ----------

   Every localStorage call is wrapped. It throws in Safari's private mode, it
   throws when the quota is exceeded, and it is absent entirely in some
   embedded webviews. A browser that cannot remember your saved filters should
   still let you browse the database — losing a preference is not a reason to
   lose the tool. */

export function loadJson(key, fallback) {
  try {
    const raw = captureScopedStorage(() => window.localStorage).getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    // Corrupt or unreadable: start fresh rather than breaking the page.
    return fallback;
  }
}

export function saveJson(key, value) {
  try {
    captureScopedStorage(() => window.localStorage).setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
