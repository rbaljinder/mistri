/**
 * The view composer: build a multi-table result by picking related tables and
 * their fields, rather than by writing a join.
 *
 * The whole thing is a visual editor for **reference paths** — the dot-walked
 * chains defined in shared/view.ts. `customer_id.name` means "follow
 * invoice.customer_id to customer, then take name", and because the foreign
 * key graph is already in the browser every hop can be proposed rather than
 * typed. Adding a related table adds paths; ticking a field adds a path;
 * filtering across a walk is a condition on a path. One idea, three panels.
 *
 * It is deliberately not a query builder with a JOIN dropdown. Nobody thinks
 * "left join customer on customer.id = invoice.customer_id"; they think "and
 * show me the customer's country". So the suggestions are phrased from the
 * key — *each invoice has one customer* — and the join is a consequence you
 * can go and read in the SQL panel if you want to.
 *
 * ## Self-attaching
 *
 * composerEntry.js adds its entry point to the top bar and hooks navigation
 * through the existing hash scheme rather than through app.js, and loads this
 * module the first time a view is opened: the composer is the Workbench's,
 * and an App's first page carries only the entry.
 *
 * ## Where a view lives in the URL
 *
 * A composer session is a *tab on a table*, exactly like Rows, Definition and
 * Diagram — so `/demo/invoice!view:sales-by-country` needs no second URL
 * format and no change to deeplink.js. The serialisation already carries the
 * tab; the id after the colon names the saved view, and a bare `!view` is a
 * fresh composer on that table.
 *
 * ## Where a view is stored
 *
 * Saved views are per connection in localStorage, like saved filters: they are
 * one person's working set, and `orders` on staging is not `orders` on
 * production. Views defined in `tablewalk.json` come from the server, are
 * marked as such, and cannot be edited from here — a page silently rewriting a
 * file someone checked into a repo is a surprise nobody asked for.
 */
import { createElement } from 'react';
import {
  $,
  api,
  currentEntry,
  el,
  findTable,
  go,
  labelColumn,
  loadJson,
  looksLikeDateColumn,
  primaryKey,
  quote,
  refsFrom,
  saveJson,
  state,
  tableView,
  toast,
  /* Aliased rather than renamed at every call site: `hopsOut(customer)` reads
     as a question about one table, where `hopsFrom` reads as half of a call
     that has lost its schema argument. */
  hopName as hopLabel,
  hopsFrom as hopsOut,
  tableAtPrefix as tableAt,
  viewportBox,
} from './core.js';
import { toHash } from './url.js';
import { viewTabOf } from './composerTab.js';
import { confirmFor, promptFor } from './prompt.js';
import { mount, unmount } from './components/mount.js';
import { surfaceOf } from './surfaces.js';
import { MAX_PATH_DEPTH, resolveAggregate } from '@mistriwork/engine/shared/view.js';
import { plural as pluralCount } from './locale.js';
import { say } from './copy/workbench/composer.js';
import { shown } from './addressMount.js';
import { navReplace, portalRoot, shellBody, shellQuery } from './shellHost.js';

/* The panel is the Workbench's, registered by app.js (surfaces.js) and loaded
   the first time it opens. The draft,
   the paths and the phrasing stay here, where the agreement suite reads them. */

/* Mirrors MAX_PATH_DEPTH in shared/view.ts. The cap is not decoration:
   work_order.parent_id points at work_order, so the path space is infinite
   and any breadth-first walk of it runs forever. */
export const MAX_DEPTH = MAX_PATH_DEPTH;

const STORE = 'mistri.composer.v1';

/* ---------- module state ---------- */

/** The overlay, or null when the composer is closed. */
let root = null;
/**
 * What the overlay is currently showing, as `base|viewId`.
 *
 * The base table is part of the identity and not an afterthought: two fresh
 * composers both have an empty view id, so keying on the id alone means
 * moving from `/db/invoice!view` to `/db/work_order!view` looks like no
 * change at all and the panel keeps showing the old table.
 */
let openFor = null;
/** The view being edited. */
let draft = null;
/** Path prefixes whose table has been added — the joins, in tree form. */
let opened = new Set();
/** The prefix added by the last click, so the checklist can point at it. */
let justAdded = null;
/** Config-defined views for this connection, fetched once per open. */
let fromConfig = [];
/** The last preview response, kept so the SQL toggle needs no round trip. */
let preview = null;
let previewError = null;
let showSql = false;
/** The text panel, and what has been typed into it but not yet applied. */
let showText = false;
let textEdit = null;
let running = false;
let runToken = 0;

/* ---------- the store the drawing reads ----------

   `components/Composer.tsx` draws whatever these say and calls the actions below;
   every mutation here ends in `tell()`, which is what `redraw()` now means. */

let version = 0;
const listeners = new Set();
function tell() {
  version += 1;
  for (const fn of listeners) fn();
}
export const composerVersion = () => version;
export function subscribeComposer(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function composerState() {
  return {
    draft,
    opened,
    justAdded,
    fromConfig,
    preview,
    previewError,
    showSql,
    showText,
    textEdit,
    running,
    savedViews: savedViews(),
    pinned: pinnedIds(),
  };
}

/* ---------- paths ----------

   The mirror of shared/view.ts these are built on lives in core.js, where the
   layout builder can reach it too — it used to walk the same prefixes with a
   copy of its own, and disagreed with this one about whether a constraint
   name is a legal path segment. */

/** A path's final column, or null if any segment does not resolve.

   Deliberately stricter than resolvePath in shared/view.ts, which also
   accepts a case-insensitive column name and refuses a path deeper than
   MAX_PATH_DEPTH. Both differences can only ever withhold a suggestion the
   server would have accepted; neither can propose one it would refuse. */
export function columnAt(baseId, path) {
  const cut = path.lastIndexOf('.');
  const table = tableAt(baseId, cut === -1 ? '' : path.slice(0, cut));
  if (!table) return null;
  const name = path.slice(cut + 1);
  return table.columns.find((c) => c.name === name) ?? null;
}

const depthOf = (path) => (path ? path.split('.').length : 0);

/* ---------- plain language ----------

   The phrasing is generated from the key, not written per table, and says the
   two things a foreign key actually tells you: the direction, and whether the
   other row has to exist. "may have one" versus "has one" is the difference
   between a column that will show nulls and one that will not. */

export function phraseOne(fromTable, hop) {
  const target = findTable(hop.target);
  const subject = fromTable.name;
  const object = target ? target.name : hop.target;
  const verb = hop.optional ? say('mayHaveOne') : say('hasOne');
  const self = target && target.id === fromTable.id;
  return self ? say('eachParent', { subject, verb, object }) : say('relationPhrase', { subject, verb, object });
}

export function phraseMany(toTable, fk) {
  const child = findTable(fk.from.table);
  return say('eachHasMany', { name: toTable.name, values: plural(child ? child.name : fk.from.table) });
}

/* "each country has many customer" is the kind of almost-English that makes a
   generated sentence read as generated. Three rules cover every table name
   anyone actually writes, and a name they do not cover is still a real word
   with an s on the end. */
export function plural(name) {
  if (/(?:s|x|z|ch|sh)$/i.test(name)) return `${name}es`;
  if (/[^aeiou]y$/i.test(name)) return `${name.slice(0, -1)}ies`;
  return `${name}s`;
}

/* ---------- storage ---------- */

const connectionKey = () => state.activeConnection ?? 'default';

/**
 * Everything stored for one connection: the views, and which ids are pinned.
 *
 * Pins live beside the views rather than on them because a view defined in
 * `tablewalk.json` can be pinned too, and that view is not ours to write to.
 * A list of ids covers both without the config half needing a copy kept here
 * that could drift from the file.
 *
 * An earlier shape stored the array directly. It is read rather than
 * discarded: someone who saved three views before this existed should not
 * find them gone.
 */
function bucket() {
  const stored = loadJson(STORE, {})[connectionKey()];
  if (Array.isArray(stored)) return { views: stored, pinned: [] };
  return { views: stored?.views ?? [], pinned: stored?.pinned ?? [] };
}

function savedViews() {
  return bucket().views;
}

const pinnedIds = () => bucket().pinned;
const isPinned = (id) => pinnedIds().includes(id);

function writeBucket(next) {
  const all = loadJson(STORE, {});
  all[connectionKey()] = next;
  if (!saveJson(STORE, all)) {
    toast(say('couldNotSaveThisBrowser'), 'error');
    return false;
  }
  return true;
}

function writeSaved(list) {
  return writeBucket({ ...bucket(), views: list });
}

function togglePin(id) {
  const current = bucket();
  const pinned = current.pinned.includes(id) ? current.pinned.filter((p) => p !== id) : [...current.pinned, id];
  if (writeBucket({ ...current, pinned })) redraw();
}

function newId() {
  /* Time plus a little noise. Ids end up in URLs, so they stay in the
     character set the hash scheme already treats as opaque. */
  return `v${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

/* ---------- the draft ---------- */

function blankView(baseId) {
  const table = findTable(baseId);
  const label = table ? labelColumn(table) : null;
  const key = table ? primaryKey(table) : [];
  /* A brand new view opens with the row's key and its readable column ticked.
     An empty grid is a worse starting point than a small correct one: it
     gives you nothing to recognise your data by while you build. */
  const columns = [...new Set([...key, label].filter(Boolean))].map((path) => ({ path }));
  return { id: '', name: '', base: baseId, columns, aggregates: [], query: '', orderBy: [], limit: 20 };
}

const selected = () => draft.columns.map((c) => c.path);
const isSelected = (path) => draft.columns.some((c) => c.path === path);

function toggleField(path) {
  draft.columns = isSelected(path) ? draft.columns.filter((c) => c.path !== path) : [...draft.columns, { path }];
  changed();
}

function addJoin(prefix) {
  opened.add(prefix);
  /* A join with nothing showing through it is a join you cannot see: the SQL
     does not even emit it, because no path uses it, so "Add" appears to do
     nothing at all. One field comes along — the readable one where there is
     one — so the click has a visible consequence in the grid as well as in
     the checklist. */
  const table = tableAt(draft.base, prefix);
  const field = table ? defaultField(table, prefix) : null;
  if (field) draft.columns.push({ path: `${prefix}.${field}` });
  justAdded = prefix;
  changed();
}

/** The one field worth showing by default from a newly joined table. */
function defaultField(table, prefix) {
  const free = (name) => name && !isSelected(`${prefix}.${name}`);
  const label = labelColumn(table);
  if (free(label)) return label;
  const text = table.columns.find((c) => !c.primaryKey && /char|text|varchar|string/i.test(c.type));
  if (free(text?.name)) return text.name;
  const key = primaryKey(table)[0];
  if (free(key)) return key;
  return table.columns.map((c) => c.name).find(free) ?? null;
}

function removeJoin(prefix) {
  // Everything reached *through* this table goes with it, or the view keeps
  // paths whose join has just been taken away.
  for (const open of [...opened]) {
    if (open === prefix || open.startsWith(`${prefix}.`)) opened.delete(open);
  }
  draft.columns = draft.columns.filter((c) => !c.path.startsWith(`${prefix}.`));
  draft.orderBy = (draft.orderBy ?? []).filter((o) => !o.path.startsWith(`${prefix}.`));
  changed();
}

/** Rebase onto another table, discarding paths that no longer mean anything. */
function setBase(baseId) {
  draft = { ...blankView(baseId), id: draft.id, name: draft.name };
  opened = new Set();
  claim();
  changed();
}

/** Record what is on screen and make the address bar agree with it. */
function claim() {
  const tab = tabForDraft();
  openFor = `${draft.base}|${viewTabOf({ kind: 'table', tab })}`;
  linkTo(tab);
}

/**
 * One edit: redraw the panels, then re-run the preview.
 *
 * Kept as a pair rather than folded into `redraw`, because `redraw` also runs
 * when nothing about the *view* changed — opening the overlay, toggling the
 * SQL panel — and re-querying for those would put a round trip behind a
 * button that only reveals text.
 */
function changed() {
  redraw();
  schedulePreview();
}

/* ---------- the view sent to the server ---------- */

function payload() {
  return {
    id: draft.id,
    name: draft.name,
    base: draft.base,
    columns: draft.columns,
    aggregates: draft.aggregates ?? [],
    /* Carried, and not only when the box is empty. A view defined in
       `tablewalk.json` holds its filter as a structure, and leaving it out
       here was a bug with the worst possible shape: the view ran, returned
       rows, and returned the wrong ones — an "Australian work orders" view
       quietly listing New Zealand. */
    filter: draft.filter,
    orderBy: draft.orderBy ?? [],
    limit: draft.limit,
  };
}

/* ---------- a filter, written back as text ----------

   A structural filter that does not appear in the box is a filter you cannot
   see, edit or argue with — the composer would be applying a condition the
   screen denies exists. Rendering it back into the language closes that gap
   and makes the box the single thing the view's filter *is*. */

const OP_TEXT = {
  '=': '=',
  '!=': '!=',
  '<': '<',
  '<=': '<=',
  '>': '>',
  '>=': '>=',
  contains: 'contains',
  startsWith: 'startswith',
  endsWith: 'endswith',
  like: 'like',
};

function filterToText(filter) {
  if (!filter?.groups?.length) return '';
  return filter.groups
    .map((group) => group.map(conditionToText).filter(Boolean).join(' and '))
    .filter(Boolean)
    .map((text, _, all) => (all.length > 1 ? `(${text})` : text))
    .join(' or ');
}

function conditionToText(condition) {
  const { path, op, value } = condition;
  if (op === 'isNull') return `${path} is empty`;
  if (op === 'isNotNull') return `${path} is not empty`;
  if (op === 'in') {
    const list = (Array.isArray(value) ? value : [value]).map(valueToText).join(', ');
    return `${path} in (${list})`;
  }
  const word = OP_TEXT[op];
  return word ? `${path} ${word} ${valueToText(value)}` : '';
}

function valueToText(value) {
  /* Quoted whenever a bare word would not survive the round trip. The parser
     treats an explicit quote as "this is text", which is exactly right for a
     value that came out of a config file already typed.
  
     This kept its own copy with a slightly wider bare-word set (`$`), so the
     same value written here and in the query bar could come out differently.
     A `$` now gets quoted instead of passing bare, which the grammar reads
     identically — one rule beats two nearly-identical ones. */
  return quote(String(value ?? ''));
}

/* ---------- preview ----------

   Debounced, and every response carries the token of the request that asked
   for it. Without that, a slow query started three keystrokes ago lands after
   a fast one and the grid shows an answer to a question nobody is asking any
   more — the classic race, and invisible when it happens. */

let previewTimer = null;

function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => void runPreview(), 220);
}

async function runPreview() {
  if (!draft || (!draft.columns.length && !aggregates().length)) {
    preview = null;
    previewError = null;
    paintPreview();
    return;
  }
  const token = ++runToken;
  running = true;
  paintPreview();
  try {
    const data = await api('/api/view/run', {
      view: payload(),
      query: draft.query,
      limit: draft.limit,
    });
    if (token !== runToken) return;
    if (data.errors && data.errors.length) {
      preview = null;
      previewError = data.errors;
    } else {
      preview = data;
      previewError = null;
      /* The text form only exists once the view has run, so this is where an
         unsaved composer becomes a link worth copying. Stamped rather than
         navigated: `go()` would repaint the whole app underneath the overlay,
         and a network round trip per keystroke is exactly what a live preview
         must not cost. */
      stampHash();
      if (showText) textEdit = null;
    }
  } catch (err) {
    if (token !== runToken) return;
    preview = null;
    previewError = [{ message: err.message }];
  } finally {
    if (token === runToken) {
      running = false;
      paintPreview();
    }
  }
}

/* ---------- open / close ---------- */

/* The hash is one segment of a `/`-separated path, and deeplink.js finds the
   tab by the last `!` in it. Neither may appear in the payload, and
   encodeURIComponent leaves `!` alone. */
const encodeText = (text) => encodeURIComponent(text).replace(/!/g, '%21');

/** Above this the URL stops being pasteable, so the link degrades to the base. */
const MAX_LINK_TEXT = 1200;

function tabForDraft() {
  if (draft.id) return `view:${draft.id}`;
  const text = preview?.text;
  if (text) {
    const encoded = encodeText(text);
    if (encoded.length <= MAX_LINK_TEXT) return `view+${encoded}`;
  }
  return 'view';
}

function closeComposer() {
  if (!root) return;
  unmount(root);
  root.remove();
  root = null;
  openFor = null;
  draft = null;
  preview = null;
  previewError = null;
  shellBody().classList.remove('composing');
}

async function openComposer(baseId, viewId) {
  const base = findTable(baseId) ? baseId : likeliestBase();
  if (!base) return;

  openFor = `${base}|${viewId}`;
  showSql = false;
  draft = blankView(base);
  opened = new Set();

  if (!root) {
    root = el('div', { class: 'composer', role: 'dialog', 'aria-modal': 'false', 'aria-label': say('viewComposer') });
    portalRoot().append(root);
    shellBody().classList.add('composing');
    positionRoot();
    mount(root, createElement(surfaceOf('composer')));
  }
  redraw();

  /* Config views are fetched rather than cached across opens: they can change
     when the connection does, and the request is one small GET. */
  try {
    const data = await api('/api/views');
    fromConfig = data.views ?? [];
  } catch {
    // A server that cannot list config views is not a reason to refuse to
    // compose one. The saved list still works.
    fromConfig = [];
  }

  if (viewId && viewId.startsWith('+')) {
    /* The link carries the view itself. Parsed by the server, because the
       grammar lives there — the same call the text panel makes. */
    try {
      const data = await api('/api/view/run', { text: decodeURIComponent(viewId.slice(1)) });
      if (data.errors?.length) {
        previewError = data.errors;
      } else if ('view' in data) {
        loadView({ ...data.view, id: '', name: draft.name });
        preview = data;
      }
    } catch (err) {
      previewError = [{ message: err.message }];
    }
    redraw();
    return;
  }

  if (viewId) {
    const found = [...savedViews(), ...fromConfig].find((v) => v.id === viewId);
    if (found) {
      loadView(found);
      /* A saved view carries its own base table, which need not be the one
         named in the link that opened it. Correcting the address bar keeps a
         copied URL truthful rather than merely functional. */
      claim();
    } else {
      toast(say('noSavedViewCalled', { viewId }), 'error');
    }
  }
  redraw();
  schedulePreview();
}

function loadView(view) {
  draft = {
    id: view.id,
    name: view.name ?? '',
    base: view.base,
    columns: (view.columns ?? []).map((c) => (typeof c === 'string' ? { path: c } : { ...c })),
    aggregates: (view.aggregates ?? []).map((a) => ({ ...a })),
    /* Shown in the box, so the condition a config view applies is visible and
       editable rather than invisible and authoritative. The structure is kept
       alongside as the authority until the box is touched, so a filter that
       does not survive the round trip exactly still runs exactly. */
    query: view.query ?? filterToText(view.filter),
    filter: view.filter,
    orderBy: view.orderBy ?? [],
    limit: view.limit ?? 20,
    source: view.source,
  };
  /* Every prefix a path walks through is a join that must be open, or the
     tables panel would show a view whose own columns are not in it. */
  opened = new Set();
  for (const col of draft.columns) {
    const parts = col.path.split('.');
    for (let i = 1; i < parts.length; i++) opened.add(parts.slice(0, i).join('.'));
  }
}

/* ---------- rendering ---------- */

/**
 * Sit below the app's own top bar rather than over it.
 *
 * Covering the whole window would be simpler and would also hide the
 * connection label and the schema button — the two things that tell you
 * *which* database you are composing against. Measuring is a line; guessing a
 * height in the stylesheet is a line that goes wrong the first time the bar
 * wraps on a narrow window.
 */
export function positionRoot() {
  if (!root) return;
  const bar = shellQuery('.topbar');
  root.style.top = bar ? `${Math.round(viewportBox(bar).bottom)}px` : '0px';
}

/** Every mutation ends here: the component redraws from the store. */
function redraw() {
  if (!root || !draft) return;
  positionRoot();
  tell();
}

/* ---------- summaries of the many side ---------- */

const aggregates = () => draft.aggregates ?? [];

function resolvedAggregate(spec, base = draft?.base) {
  // Saved drafts may be invalid or still use an unambiguous constraint name.
  // Resolve against the same parent/prefix and precedence as the server.
  try {
    return resolveAggregate(state.schema, base, spec);
  } catch {
    return undefined;
  }
}

function aggregateReference(spec, base) {
  const resolved = resolvedAggregate(spec, base);
  return resolved ? `${resolved.child.id}.${resolved.fk.from.columns.join('+')}` : spec.via;
}

export function sameAggregate(a, b, base = draft?.base) {
  return (
    a.fn === b.fn &&
    (a.on ?? '') === (b.on ?? '') &&
    (a.column ?? '') === (b.column ?? '') &&
    aggregateReference(a, base) === aggregateReference(b, base)
  );
}

function addAggregate(next) {
  if (aggregates().some((a) => sameAggregate(a, next))) return;
  draft.aggregates = [...aggregates(), next];
  changed();
}

function removeAggregate(target) {
  draft.aggregates = aggregates().filter((a) => !sameAggregate(a, target));
  changed();
}

/** How a summary reads in a sentence: "a count of work_order_parts". */
export function aggregateLabel(spec) {
  const child = resolvedAggregate(spec)?.child;
  const name = child ? child.name : spec.via;
  const where = spec.on ? say('on', { on: spec.on }) : '';
  return spec.fn === 'count'
    ? say('aCount', { names: plural(name), where })
    : say('the', { fn: spec.fn, name, column: spec.column, where });
}

/**
 * One level of the join tree, and recursively the levels below it.
 *
 * Hops are grouped by the table they land on. `work_order` reaches `employee`
 * three ways — raised_by, assigned_to, approved_by — and listing them as three
 * sentences that differ only in a trailing column name is a list you have to
 * read word by word rather than scan. Grouped, the question becomes the one
 * actually being asked: *which* employee.
 *
 * A table reachable exactly one way keeps its full sentence, because a header
 * plus a single row underneath is ceremony around one fact.
 */
function startFromChild(fk) {
  const child = findTable(fk.from.table);
  if (!child) return;
  draft = { ...blankView(child.id), id: draft.id, name: draft.name };
  opened = new Set();
  claim();
  const hop = hopsOut(child.id).find((h) => h.fk.name === fk.name);
  if (hop) addJoin(hop.name);
  else changed();
}

/** The chip's text: `count(work_order_part)`, matching the column header. */
export function shortAggregate(spec) {
  const child = resolvedAggregate(spec)?.child;
  const name = `${spec.on ? `${spec.on}.` : ''}${child ? child.name : spec.via}`;
  return `${spec.fn}(${name}${spec.column ? `.${spec.column}` : ''})`;
}

/* ---------- path-aware autocomplete ----------

   complete.js does this for the query bar and is left alone: it completes
   *columns*, and a path is a different shape — the useful suggestion after
   `customer_id.` is the next table's columns, which needs the key graph
   walked. Same keyboard contract, different candidate set. */

const CLAUSES = ['sort', 'show', 'limit'];
const JOINERS = ['and', 'or'];
const OPERATORS = ['=', '!=', '>', '>=', '<', '<=', 'contains', 'startswith', 'endswith', 'like', 'in'];
const NULL_CHECKS = ['is empty', 'is not empty'];
const DATE_VALUES = ['today', 'yesterday', 'this week', 'last week', 'this month', 'last month', 'last 7 days', 'last 30 days'];
const EXPECTS_FIELD = new Set(['and', 'or', 'where', 'filter', 'show', 'select', 'sort', 'by', '']);

function wordAt(text, caret) {
  const before = text.slice(0, caret);
  const start = Math.max(before.lastIndexOf(' '), before.lastIndexOf(',')) + 1;
  return { word: before.slice(start), start };
}

/** Paths reachable from a typed prefix: this table's columns, and its hops. */
function pathCandidates(word) {
  const cut = word.lastIndexOf('.');
  const prefix = cut === -1 ? '' : word.slice(0, cut);
  const fragment = (cut === -1 ? word : word.slice(cut + 1)).toLowerCase();
  const table = tableAt(draft.base, prefix);
  if (!table) return [];
  const lead = prefix ? `${prefix}.` : '';
  const out = [];

  for (const column of table.columns) {
    if (fragment && !column.name.toLowerCase().startsWith(fragment)) continue;
    out.push({
      value: `${lead}${column.name}`,
      label: `${lead}${column.name}`,
      detail: `${column.type.toLowerCase()}${column.primaryKey ? say('key') : ''}`,
      kind: 'value',
    });
  }
  /* Hops end in a dot and do not close the token, so accepting one leaves the
     caret mid-path with the next table's columns already listed. That chaining
     is the whole reason dot-walking is pleasant to type. */
  if (depthOf(prefix) < MAX_DEPTH) {
    for (const hop of hopsOut(table.id)) {
      if (fragment && !hop.name.toLowerCase().startsWith(fragment)) continue;
      const target = findTable(hop.target);
      out.push({
        value: `${lead}${hop.name}.`,
        label: `${lead}${hop.name}.`,
        detail: `→ ${target ? target.name : hop.target}`,
        kind: 'table',
        partial: true,
      });
    }
  }
  return out;
}

function completionsFor(text, caret) {
  const { word, start } = wordAt(text, caret);
  const previous = text.slice(0, start).trim().split(/\s+/).pop()?.toLowerCase() ?? '';
  const lower = word.toLowerCase();
  const matches = (list) => list.filter((s) => !lower || s.value.toLowerCase().startsWith(lower));

  if (word.includes('.')) return pathCandidates(word);

  const previousColumn = previous ? columnAt(draft.base, previous) : null;
  if (previousColumn) {
    /* Was a fourth copy of the date test, and the narrowest: its name pattern
       had lost `datetime`, `timestamp` and `deleted`, so `event_timestamp`
       got `=` and nothing else in the composer while the query bar offered it
       the relative-date phrases — the language's best feature, missing on the
       columns it exists for. */
    const isDate = looksLikeDateColumn(previousColumn);
    const dates = isDate ? DATE_VALUES.map((v) => ({ value: `= ${v}`, label: `= ${v}`, detail: say('dateRange'), kind: 'value' })) : [];
    return matches([
      ...dates,
      ...OPERATORS.map((o) => ({ value: o, label: o, detail: 'operator', kind: 'op' })),
      ...NULL_CHECKS.map((o) => ({ value: o, label: o, detail: say('nullCheck'), kind: 'op' })),
    ]);
  }

  if (EXPECTS_FIELD.has(previous)) return pathCandidates(word);

  return matches([
    ...JOINERS.map((j) => ({ value: j, label: j, detail: 'combine', kind: 'kw' })),
    ...CLAUSES.map((c) => ({ value: c, label: c, detail: 'clause', kind: 'kw' })),
    ...pathCandidates(word),
  ]);
}

/* ---------- panel: the view, written down ----------

   A view built by clicking is UI state: it can be saved and loaded, and that
   is all. Everything else in tablewalk holds that the *text* is the source of
   truth — it is why sorting edits the query, why a link carries the walk, why
   a filter composes into the bar. A view that could only be clicked could not
   be hand-edited, diffed in a config file, or pasted to someone who does not
   have the composer open.

   So the panel is editable, and applying it replaces the draft. The grammar
   is `viewtext.ts` on the server: one language, parsed once, rather than a
   second one here that would drift. */

async function applyText(value) {
  const text = String(value ?? '').trim();
  if (!text) return;
  running = true;
  paintPreview();
  try {
    const data = await api('/api/view/run', { text, limit: draft.limit });
    if (data.errors?.length || !('view' in data)) {
      previewError = data.errors;
      running = false;
      paintPreview();
      return;
    }
    // The name and the identity are the composer's, not the text's: retyping
    // the body of a saved view should still be that saved view.
    loadView({ ...data.view, id: draft.id, name: draft.name });
    preview = data;
    previewError = null;
    textEdit = null;
    running = false;
    claim();
    redraw();
  } catch (err) {
    previewError = [{ message: err.message }];
    running = false;
    paintPreview();
  }
}

/**
 * Give a column its own name.
 *
 * Applies to summaries as well as fields — `count(work_order_part)` is a
 * worse column heading than `parts` in exactly the same way.
 *
 * Matching is by output name rather than by index. The result's column order
 * is produced by the compiler, and tying a rename to a position would break
 * the moment a field is ticked above it.
 */
async function renameColumn(meta, fallbackName) {
  const current = meta?.name ?? fallbackName;
  const chosen = await promptFor({
    title: say('renameColumn'),
    label: say('shownAs'),
    value: current,
    hint: meta?.aggregate
      ? say('aggregateOver', { aggregate: meta.aggregate, shortTable: shortTable(meta.table) })
      : (meta?.path ?? fallbackName),
    confirmLabel: say('common.rename'),
  });
  if (chosen === null) return;
  const alias = chosen.trim();

  if (meta?.aggregate) {
    const list = aggregates();
    const hit = list.find((a) => (a.alias ?? '') === current || aggregateOutputName(a) === current);
    if (hit) hit.alias = alias || undefined;
  } else if (meta?.path) {
    const hit = draft.columns.find((c) => c.path === meta.path);
    // Clearing the box removes the alias rather than setting an empty one,
    // so the column goes back to naming itself.
    if (hit) hit.alias = alias && alias !== meta.path ? alias : undefined;
  }
  claim();
  void runPreview();
}

/** What an aggregate is called when it has no alias of its own. */
function aggregateOutputName(spec) {
  return resolvedAggregate(spec)?.name ?? spec.alias ?? shortAggregate(spec);
}

function paintPreview() {
  tell();
}

const shortTable = (id) => findTable(id)?.name ?? id;

function sortByPath(path) {
  const current = (draft.orderBy ?? []).find((o) => o.path === path);
  // Click sorts ascending, click again reverses, a third clears — the same
  // three states the results grid has, so the gesture transfers.
  if (!current) draft.orderBy = [{ path, direction: 'asc' }];
  else if (current.direction === 'asc') draft.orderBy = [{ path, direction: 'desc' }];
  else draft.orderBy = [];
  changed();
}

function openSaved(view) {
  loadView(view);
  claim();
  changed();
}

async function removeSaved(view) {
  const ok = await confirmFor({
    title: say('removeName', { name: view.name }),
    body: say('theViewIsOnly'),
    confirmLabel: say('common.remove'),
  });
  if (!ok) return;
  if (!writeSaved(savedViews().filter((v) => v.id !== view.id))) return;
  if (draft.id === view.id) {
    /* The draft stays on screen — losing your work because you tidied the
       list would be a rude surprise — but it is no longer *that* view, and
       the link has to stop claiming it is or reloading would 404 it. */
    draft.id = '';
    claim();
  }
  redraw();
}

/* ---------- saving ---------- */

async function saveDraft() {
  if (!draft.columns.length && !aggregates().length) {
    toast(say('pickAtLeastOneField'), 'error');
    return;
  }
  if (draft.source === 'config') {
    toast(say('thisViewComesFromTablewalk'), 'error');
    return;
  }
  if (!draft.name.trim() || !draft.id) return saveAs();

  const list = savedViews().map((v) => (v.id === draft.id ? snapshot(draft.id) : v));
  if (!list.some((v) => v.id === draft.id)) list.push(snapshot(draft.id));
  if (!writeSaved(list)) return;
  toast(say('saved', { name: draft.name.trim() }), 'ok');
  claim();
  redraw();
}

async function saveAs() {
  if (!draft.columns.length && !aggregates().length) {
    toast(say('pickAtLeastOneField'), 'error');
    return;
  }
  const name = await promptFor({
    title: say('saveThisView'),
    label: say('common.name'),
    value: draft.name.trim() || suggestName(),
    hint: `${draft.base} · ${say('countFields', { count: draft.columns.length })} · ${say('countRelatedTables', { count: opened.size })}`,
    placeholder: say('eGAustralianWork'),
  });
  if (!name) return;

  draft.name = name;
  draft.source = undefined;
  const id = newId();
  draft.id = id;
  // A repeated name replaces rather than duplicating: two entries reading
  // "Open" that do different things is worse than losing the older one.
  const list = savedViews().filter((v) => v.name !== name);
  list.push(snapshot(id));
  if (!writeSaved(list)) return;
  toast(say('saved', { name }), 'ok');
  claim();
  redraw();
}

function snapshot(id) {
  return {
    id,
    name: draft.name.trim(),
    base: draft.base,
    columns: draft.columns.map((c) => ({ path: c.path, alias: c.alias })),
    aggregates: draft.aggregates ?? [],
    query: draft.query,
    filter: draft.filter,
    orderBy: draft.orderBy ?? [],
    limit: draft.limit,
  };
}

function suggestName() {
  const table = findTable(draft.base);
  const extras = [...opened].map((p) => {
    const joined = tableAt(draft.base, p);
    return joined ? joined.name : p;
  });
  const head = table ? table.name : draft.base;
  return extras.length ? say('headWithExtras', { head, extras: extras.slice(0, 2).join(' and ') }) : head;
}

/* ---------- navigation ----------

   A composer session is a tab on a table, which is why none of this needs a
   second URL format: the hash already carries a tab, deeplink.js already
   round-trips it, and the app underneath renders the base table — so closing
   the composer leaves you somewhere sensible rather than on a blank page. */

function linkTo(tab) {
  const entry = currentEntry();
  if (entry && entry.kind === 'table' && entry.table === draft.base) {
    go({ ...entry, tab }, 'replace');
  } else {
    // Rebasing rewrites the crumb rather than adding one: choosing a
    // different starting table is editing this view, not a step in a walk.
    go(tableView(draft.base, draft.base, tab), entry ? 'replace' : 'reset');
  }
}

/**
 * Update the address bar without re-rendering the app beneath.
 *
 * `go()` is the right call when the *position* changes; here only the label
 * on the position changes, and putting a full render behind every edit would
 * re-run the base table's query each time a checkbox moved.
 */
function stampHash() {
  const entry = currentEntry();
  const tab = tabForDraft();
  if (!entry || entry.kind !== 'table' || entry.table !== draft.base) return;
  if (entry.tab === tab) return;
  entry.tab = tab;
  openFor = `${draft.base}|${viewTabOf(entry)}`;
  navReplace(shown(toHash()));
}

function leave() {
  const entry = currentEntry();
  closeComposer();
  if (entry && entry.kind === 'table') go({ ...entry, tab: 'rows' }, 'replace');
}

/**
 * Where to start when nothing is selected.
 *
 * Not the first table alphabetically: on the demo that is `country`, a
 * two-column lookup with no outgoing keys, so the composer opens with an
 * empty "related tables" panel and appears to do nothing. The table with the
 * most references out of it is the one where the idea explains itself.
 */
function likeliestBase() {
  const tables = state.schema.tables.filter((t) => !t.isView);
  const ranked = (tables.length ? tables : state.schema.tables)
    .map((t) => ({ id: t.id, out: refsFrom(t.id).length }))
    .sort((a, b) => b.out - a.out);
  return ranked[0]?.id;
}

export function openFromTopbar() {
  const entry = currentEntry();
  const base = entry?.table ?? likeliestBase();
  if (!base) {
    toast(say('thisConnectionHasNoTables'), 'error');
    return;
  }
  if (entry && entry.kind === 'table') go({ ...entry, tab: 'view' }, 'replace');
  else go(tableView(base, base, 'view'), 'reset');
  sync();
}

/**
 * Reconcile the overlay with wherever the app now is.
 *
 * Called after anything that could have navigated. It is a no-op unless the
 * *view identity* changed, so clicking around inside the composer — which
 * also produces clicks — cannot reset the draft underneath your hands.
 */
export function sync() {
  if (!state.schema) return;
  const entry = currentEntry();
  const id = viewTabOf(entry);
  if (id === null) {
    closeComposer();
    return;
  }
  if (root && openFor === `${entry.table}|${id}`) return;
  void openComposer(entry.table, id);
}

/* ---------- actions ---------- */

export const composerActions = {
  setName: (name) => {
    draft.name = name;
    tell();
  },
  toggleText: () => {
    showText = !showText;
    textEdit = null;
    redraw();
  },
  toggleSql: () => {
    showSql = !showSql;
    redraw();
  },
  saveDraft,
  saveAs,
  leave,
  setBase,
  toggleField,
  addJoin,
  removeJoin,
  addAggregate,
  removeAggregate,
  startFromChild,
  setQuery: (text) => {
    draft.query = text;
    /* The moment the box is edited it becomes the filter, entirely. */
    draft.filter = undefined;
    tell();
    schedulePreview();
  },
  setLimit: (n) => {
    draft.limit = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 1000) : 20;
    schedulePreview();
  },
  setTextEdit: (text) => {
    textEdit = text;
    tell();
  },
  applyText,
  sortByPath,
  renameColumn,
  togglePin,
  openSaved,
  removeSaved,
  completionsFor,
  /** The fresh group has been scrolled to; the mark comes off without a redraw. */
  consumeJustAdded: () => {
    justAdded = null;
  },
};

/** Escape leaves the field, then the composer. */
export function escapeComposer() {
  if (!root || shellQuery('dialog[open]')) return;
  const inside = root.contains(document.activeElement);
  if (inside && document.activeElement instanceof HTMLElement) document.activeElement.blur();
  else leave();
}
