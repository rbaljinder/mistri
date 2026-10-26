/**
 * Record templates on the client: storage, and the builder.
 *
 * A template says how a record of one table is laid out — which of its own
 * fields show and in what blocks, which references get pulled in beside them,
 * and which child tables appear underneath. It is bound to the *table*, so
 * configuring `work_order` once lays out every work order.
 *
 * The default is derived rather than blank. A blank record page is a worse
 * starting point than the layout the record view already produces, and the
 * fastest way to explain what a template is is to show someone one made of
 * their own data — the builder opens on a working layout they can subtract
 * from, rather than an empty canvas they have to fill.
 *
 * The shared model lives in packages/engine/src/shared/recordview.ts and is TypeScript, which
 * the browser cannot load, so the derivation is mirrored here. It is a mirror
 * with a test on the other side rather than a second source of truth: the
 * grouping rules and thresholds are asserted there.
 */
import { appRequestScope, ownedBy } from './requestIdentity.js';
import { createElement } from 'react';
import {
  api,
  currentEntry,
  findTable,
  loadJson,
  refsTo,
  render,
  saveJson,
  state,
  subscribeWalk,
  toast,
  whenConnectionChanges,
} from './core.js';
import {
  deriveTemplate as sharedDeriveTemplate,
  groupOwnColumns,
  listColumns,
  summaryColumns,
} from '@mistriwork/engine/shared/recordview.js';
import { mount, unmount } from './components/mount.js';
import { onDemand } from './components/onDemand.js';
import { layoutDraftRecovery } from './layoutDraftRecovery.js';
import { connectionGeneration } from './connectionTransition.js';
import { confirmFor } from './prompt.js';
import { sessionIdentity, subscribeSessionIdentity } from './sessionIdentity.js';
import { shell } from './shellMode.js';
import { say } from './copy/record/template.js';
import { addHostListener, portalRoot, removeHostListener, shellBody, shellQuery } from './shellHost.js';

/* The editor loads the first time it opens; every record reads the layouts
   here, and none of them needs the editor to do it. */
const LayoutBuilder = onDemand(() => import('./components/LayoutBuilder.js'), 'LayoutBuilder');

const STORE = 'mistri.templates.v1';

const connectionKey = () => state.activeConnection ?? 'default';
const loads = new Map();
const mirrors = new Map();

/* ---------- storage ----------

   Layouts live on the server, in a file the user can read and copy between
   machines, and are mirrored into localStorage on the way past.

   The mirror is not a cache for speed — it is what makes rendering
   synchronous. A record is drawn from its layout, and a layout that had to be
   awaited would make every record either flash the derived layout first or
   wait on a round trip to show fields the browser already had. So the server
   copy is loaded once per connection and the mirror answers every read after
   that.

   Only acknowledged layouts enter this mirror. Unsaved work has its own
   recovery document, so a failed save cannot masquerade as saved state.
   The in-memory mirror keeps acknowledged saves usable when browser storage
   is unavailable. */

function allTemplates() {
  return mirrorFor(connectionKey());
}

function mirrorFor(connection) {
  if (!mirrors.has(connection)) mirrors.set(connection, loadJson(STORE, {})[connection] ?? {});
  return mirrors.get(connection);
}

function mirror(templates, connection) {
  mirrors.set(connection, templates);
  const all = loadJson(STORE, {});
  all[connection] = templates;
  saveJson(STORE, all);
}

/**
 * Pull this connection's layouts from the server into the mirror.
 *
 * Called when a connection is opened. A failure is silent: the mirror already
 * holds whatever this browser saved, and a tool that refuses to draw a record
 * because a preferences request failed would be worse than one that draws it
 * from the copy it has.
 */
export async function loadTemplates() {
  // A public visitor has none to read (publicVisitor.ts), and layouts are the
  // database browser's: an App's records are drawn by its definition.
  if (shell().publicVisitor() || appRequestScope() !== false) return;
  const owner = sessionIdentity();
  const connection = connectionKey();
  const load = Symbol();
  loads.set(connection, load);
  try {
    const { layouts } = await api('/api/layouts');
    if (owner === sessionIdentity() && layouts && typeof layouts === 'object' && !Array.isArray(layouts) && loads.get(connection) === load)
      mirror(layouts, connection);
  } catch {
    /* Server-side layouts unavailable; the mirror stands. */
  }
}

async function writeTemplate(tableId, template, connection) {
  const owner = sessionIdentity();
  loads.delete(connection);
  const result = await api('/api/layouts', { ...ownedBy(connection), table: tableId, layout: template });
  if (owner !== sessionIdentity()) return;
  if (result?.ok !== true) throw new Error(say('theServerDidNotAcknowledge'));
  // Reads started during the write cannot replace its acknowledged result.
  loads.delete(connection);
  mirror({ ...mirrorFor(connection), [tableId]: template }, connection);
}

/** True when this table's layout has been configured rather than derived. */
export const hasSavedTemplate = (tableId) => Boolean(allTemplates()[tableId]);

/**
 * The template to render a record with: the saved one, or a derived one.
 *
 * Never null. Every table has a layout; the only question is whether anyone
 * has changed it.
 */
export function templateFor(tableId) {
  return allTemplates()[tableId] ?? deriveTemplate(tableId);
}

/* ---------- derivation ----------

   The shared derivation over the schema this client holds. It used to be a
   copy, and the copy said eight rows where the server said ten. */

export { groupOwnColumns, listColumns, summaryColumns };

/**
 * The derived layout, as the page shows it.
 *
 * The shared derivation is the server's answer to "what is on a record"; the
 * page opens it a little differently, and says so here rather than in a copy.
 * Reference blocks start switched off: pulling every related row's columns
 * into every record by default would double the length of a page nobody
 * asked to change — the point is that they are one click away and visibly
 * available, not that they are all already there. And a child list is titled
 * by the child table alone, because the Related panel names the hop itself.
 * An unknown table derives an empty layout rather than throwing.
 */
export function deriveTemplate(tableId) {
  const derived = sharedDeriveTemplate(state.schema, tableId);
  if (!derived) return { id: `derived:${tableId}`, name: tableId, base: tableId, sections: [] };
  return {
    ...derived,
    sections: derived.sections.map((section) => {
      if (section.kind === 'list') {
        const child = findTable(section.via ? refsTo(tableId).find((fk) => fk.name === section.via)?.from.table : undefined);
        return { ...section, title: child?.name ?? section.title };
      }
      return section.paths.some((path) => path.includes('.')) ? { ...section, off: true } : section;
    }),
  };
}

/** Paths the base row must supply, across every enabled field section. */
export function fieldPathsOf(template) {
  const seen = new Set();
  for (const section of template.sections) {
    if (section.kind !== 'fields' || section.off) continue;
    for (const path of section.paths) seen.add(path);
  }
  return [...seen];
}

/** Enabled list sections, in order. */
export const listSectionsOf = (template) => template.sections.filter((s) => s.kind === 'list' && !s.off);

/* ---------- the builder ---------- */

/** The saved layout for a table, or null when the record draws the derived one. */
export const savedTemplate = (tableId) => allTemplates()[tableId] ?? null;

let session = null;
let host = null;
let previewing = null;
const pending = new Set();
const parked = new Map();

const sessionKey = (connection, tableId) => JSON.stringify([connection, tableId]);
const ownsContext = (owner) =>
  owner.identity === sessionIdentity() &&
  owner.connection === connectionKey() &&
  owner.schema === state.schema &&
  owner.entry === currentEntry() &&
  owner.transition === connectionGeneration();
const isCurrent = (owner) => session === owner && ownsContext(owner);
const dirty = (owner) => JSON.stringify(owner.draft) !== owner.original;
export const activeDraft = (tableId) => (session && session.table.id === tableId && ownsContext(session) ? session.draft : null);

/**
 * The builder is `components/LayoutBuilder.tsx`, drawn into the `.tpl` panel this
 * owns. Edited on a copy, so Cancel is a real cancel rather than an undo the
 * user has to perform themselves; the record beside it reads the draft
 * through `activeDraft` on every render.
 */
export function openTemplateBuilder(tableId) {
  const table = findTable(tableId);
  if (!table) return;
  if (session && isCurrent(session) && session.table.id === tableId) return;
  if (session) detach(session);
  const connection = connectionKey();
  const key = sessionKey(connection, tableId);
  if (pending.has(key)) {
    toast(say('thisTableStillHasALayout'), 'error');
    return;
  }
  const draft = structuredClone(templateFor(tableId));
  const recovery = layoutDraftRecovery(connection, draft);
  const owner = {
    identity: sessionIdentity(),
    connection,
    key,
    table,
    schema: state.schema,
    entry: currentEntry(),
    transition: connectionGeneration(),
    draft,
    original: JSON.stringify(draft),
    recovery,
    recoveryStatus: recovery.status,
    recovered: parked.get(key) ?? recovery.recovered?.draft,
    sourceChanged: recovery.sourceChanged,
    saving: false,
    confirming: false,
    error: '',
    unsubscribe: () => {},
    unwatch: () => {},
  };
  session = owner;
  const check = () => {
    if (session === owner && !ownsContext(owner)) detach(owner);
  };
  owner.unsubscribe = subscribeWalk(check);
  owner.unwatch = whenConnectionChanges(check);
  shellBody().classList.add('editing-layout');
  addHostListener(document, 'keydown', onBuilderKey, true);
  addHostListener(window, 'beforeunload', onBeforeUnload);
  paintBuilder(owner);
  render();
}

function onBeforeUnload(e) {
  if (session && (session.saving || (dirty(session) && session.recoveryStatus !== 'stored'))) {
    e.preventDefault();
    e.returnValue = '';
  }
}

function onBuilderKey(e) {
  if (e.key !== 'Escape' || !session || shellQuery('[role="dialog"], dialog[open]')) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (session.saving) return;
  /* Not while a text field is being edited — Escape there means "undo this". */
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    return;
  }
  void cancel(session);
}

function remember(owner) {
  if (dirty(owner)) {
    owner.recoveryStatus = owner.recovery.write(owner.draft);
    parked.set(owner.key, structuredClone(owner.draft));
  } else {
    owner.recoveryStatus = owner.recovery.clear();
    parked.delete(owner.key);
  }
}

/** Recovery is immediate; only the record preview is debounced. */
function changed(owner, delayed = false) {
  if (!isCurrent(owner) || owner.saving) return;
  remember(owner);
  paintBuilder(owner);
  clearTimeout(previewing);
  if (!delayed) {
    render();
    return;
  }
  previewing = setTimeout(() => {
    previewing = null;
    if (isCurrent(owner)) render();
  }, 120);
}

function paintBuilder(owner) {
  if (!isCurrent(owner)) return;
  if (!host) {
    host = document.createElement('div');
    host.className = 'tpl';
    portalRoot().append(host);
  }
  mount(
    host,
    createElement(LayoutBuilder, {
      draft: owner.draft,
      table: owner.table,
      saving: owner.saving,
      error: owner.error,
      recoveryStatus: owner.recoveryStatus,
      hasRecovery: Boolean(owner.recovered),
      recoverySourceChanged: owner.sourceChanged,
      canEdit: () => isCurrent(owner) && !owner.saving && !owner.recovered,
      onRecover: (restore) => {
        if (!isCurrent(owner) || owner.saving) return;
        if (restore) owner.draft = structuredClone(owner.recovered);
        owner.recovered = undefined;
        changed(owner);
      },
      onPreview: () => changed(owner, true),
      onApplied: () => changed(owner),
      onReset: () => {
        if (!isCurrent(owner) || owner.saving) return;
        owner.draft = deriveTemplate(owner.table.id);
        changed(owner);
      },
      onCancel: () => void cancel(owner),
      onSave: () => void save(owner),
    }),
  );
}

async function cancel(owner) {
  if (!isCurrent(owner) || owner.saving || owner.confirming) return;
  if (dirty(owner)) {
    owner.confirming = true;
    const discard = await confirmFor({
      title: say('discardLayoutChanges'),
      body: say('theSavedLayoutWill'),
      confirmLabel: say('discardLayout'),
    });
    owner.confirming = false;
    if (!discard || !isCurrent(owner)) return;
  }
  // Closing a recovery offer is not permission to discard the offered draft.
  if (!owner.recovered) {
    owner.recovery.clear();
    parked.delete(owner.key);
  }
  detach(owner);
  render();
}

async function save(owner) {
  if (!isCurrent(owner) || owner.saving || owner.recovered) return;
  owner.draft.name = (owner.draft.name ?? '').trim() || 'Default layout';
  remember(owner);
  const saved = structuredClone(owner.draft);
  owner.saving = true;
  owner.error = '';
  pending.add(owner.key);
  paintBuilder(owner);
  try {
    await writeTemplate(owner.table.id, saved, owner.connection);
  } catch (err) {
    owner.error = say('theSaveWasNotConfirmed', { message: err.message });
    return;
  } finally {
    if (owner.identity === sessionIdentity()) pending.delete(owner.key);
    owner.saving = false;
    if (isCurrent(owner)) paintBuilder(owner);
  }
  if (owner.identity !== sessionIdentity()) return;
  owner.recovery.clear();
  parked.delete(owner.key);
  if (isCurrent(owner)) {
    detach(owner);
    render();
    toast(say('saved', { name: saved.name, table: owner.table.name }), 'ok');
  }
}

/** Detaching preserves recovery and never redraws a newer navigation. */
function detach(owner) {
  if (session !== owner) return;
  owner.unsubscribe();
  owner.unwatch();
  clearTimeout(previewing);
  previewing = null;
  if (host) {
    unmount(host);
    host.remove();
    host = null;
  }
  session = null;
  shellBody().classList.remove('editing-layout');
  removeHostListener(document, 'keydown', onBuilderKey, true);
  removeHostListener(window, 'beforeunload', onBeforeUnload);
}

subscribeSessionIdentity(() => {
  mirrors.clear();
  loads.clear();
  pending.clear();
  parked.clear();
  if (session) detach(session);
});
