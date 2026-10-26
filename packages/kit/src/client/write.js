/**
 * Write mode.
 *
 * Workbench defaults to read-only; apps enable editing on writable connections.
 * The connection the browsing path uses remains read-only, so looking
 * around cannot write, even after editing is enabled. Editing goes through a
 * separate connection that the server opens lazily, the first time it is
 * actually asked to write.
 *
 * Editing preferences are remembered separately per connection and workspace.
 * Workbench enabling still requires explicit confirmation.
 * It never grants server permission or carries from one database to another.
 *
 * The real guard is on the server, not here. This file makes the state
 * obvious and asks for confirmation; the server independently refuses any
 * update whose WHERE clause does not match exactly one row.
 */
import { ownedBy } from './requestIdentity.js';
import {
  api,
  captureNavigation,
  columnLabel,
  currentEntry,
  el,
  loadJson,
  prefersPages,
  render,
  saveJson,
  setRecordMutationPendingProbe,
  state,
  toast,
} from './core.js';
import { ask, confirmFor } from './prompt.js';
import { WriteConfirmDialog } from './components/WriteConfirm.js';
import { booleanChoices, canEditRow } from './rowEditing.js';
import { captureSessionIdentity, sessionIdentity, subscribeSessionIdentity } from './sessionIdentity.js';
import { updateAttempts, updateOwnerKey } from './updateAttempts.js';
import { createRecordDrafts, draftSchemaKey } from './recordDrafts.js';
import { shell } from './shellMode.js';
import { validateRecordEdits } from './recordEditValidation.js';
import { captureRecordWriteRefresh } from './recordWriteRefresh.js';
import { connectionGeneration } from './connectionTransition.js';
import { plural } from './locale.js';
import { say } from './copy/record/write.js';
import { isJsonType } from '@mistriwork/engine/shared/schema.js';
import { addHostListener, portalRoot, shellBody } from './shellHost.js';

setRecordMutationPendingProbe(recordAutosavePending);

/* Write mode is remembered per connection.
   Per connection, not globally: switching from the demo to production must
   not silently inherit permission to edit it. Each database is opted into
   separately, and the choice sticks until it is turned off. */
const WRITE_KEY = 'mistri.write.v1';
const APP_WRITE_KEY = 'mistri.app-editing.v1';

const connectionKey = () => state.activeConnection ?? 'default';
const writableConnection = () => Boolean(state.connections?.find((c) => c.id === state.activeConnection)?.writable);

function rememberedWrite() {
  if (prefersPages()) return writableConnection() && loadJson(APP_WRITE_KEY, {})[connectionKey()] !== false;
  return loadJson(WRITE_KEY, {})[connectionKey()] === true;
}

function rememberWrite(on) {
  const storageKey = prefersPages() ? APP_WRITE_KEY : WRITE_KEY;
  const all = loadJson(storageKey, {});
  all[connectionKey()] = on;
  saveJson(storageKey, all);
}

export function initWriteMode() {
  // Restored without asking again: the confirmation was given for this
  // database and has not been withdrawn.
  setWriteMode(rememberedWrite(), { remember: false });
}

/** Mode changes must not hide pending work or interrupt an acknowledged save. */
export async function prepareEditingExit() {
  if (shell().mutations.hasUnresolved()) {
    toast(say('resolveThePendingOrUnconfirmed'), 'error');
    return false;
  }
  if (applyingStaged()) {
    toast(say('waitForThePending'), 'error');
    return false;
  }
  const connection = state.activeConnection;
  const schema = state.schema;
  const entry = currentEntry();
  const mode = prefersPages();
  const captured = staged;
  if (
    pendingCount() &&
    !(await confirmFor({
      title: say('discardPendingRecordChanges'),
      body: say('theseFieldChangesHaveNotBeen'),
      confirmLabel: say('discardChanges'),
    }))
  )
    return false;
  if (
    connection !== state.activeConnection ||
    schema !== state.schema ||
    entry !== currentEntry() ||
    mode !== prefersPages() ||
    captured !== staged ||
    applyingStaged() ||
    shell().mutations.hasUnresolved()
  )
    return false;
  discardStaged();
  return true;
}

export async function toggleWriteMode() {
  if (state.canWrite) {
    if (await prepareEditingExit()) setWriteMode(false);
    return;
  }
  const connection = state.activeConnection;
  const schema = state.schema;
  const app = prefersPages();
  if (app && !writableConnection()) {
    toast(say('thisConnectionIsRead'), 'error');
    return;
  }
  if ((app || (await confirmWrite())) && connection === state.activeConnection && schema === state.schema && app === prefersPages())
    setWriteMode(true);
}

/** Re-evaluate on connection switch, since the setting is per database. */
export function syncWriteMode() {
  setWriteMode(rememberedWrite(), { remember: false });
}

function setWriteMode(on, { remember = true } = {}) {
  state.canWrite = on;
  if (remember) rememberWrite(on);
  /* The indicator is on <body> rather than the button, so it can colour the
     window frame. Being in write mode should be visible from across the room,
     not something you have to go looking for. */
  shellBody().classList.toggle('write-mode', on && !prefersPages());
  // Explicit mode exits discard above; automatic connection changes retain drafts.
  if (!on && remember) discardStaged();
  render();
}

/**
 * A real confirmation, naming the database — `components/WriteConfirm.tsx`.
 * "Are you sure?" teaches nothing; the name of the thing you are about to
 * be able to change does.
 */
function confirmWrite() {
  return ask(WriteConfirmDialog, { label: state.schema.label });
}

/* ---------- staged edits ----------

   Every submission captures the whole draft as one update. An opted-in App
   can submit on an owned blur; Workbench keeps explicit review and apply.

   Staging is keyed by table and row, so walking away and back does not
   silently carry pending edits onto a different row. */

const drafts = createRecordDrafts();
const emptyDraft = () => ({
  connection: null,
  table: '',
  key: {},
  schemaKey: '',
  needsReview: false,
  manualSaveRequired: false,
  values: {},
  originals: {},
  inputs: {},
});
let staged = emptyDraft();
subscribeSessionIdentity(() => {
  cancelRecordAutosave();
  drafts.clear();
  staged = emptyDraft();
  tell();
});

export function activateDraft(table, key) {
  const next = drafts.acquire({ connection: state.activeConnection ?? null, table: table.id, key }, draftSchemaKey(table));
  if (next === staged) return staged;
  staged = next;
  tell();
  return staged;
}

export function suspendDraft(draft) {
  const retained = draft === staged && prefersPages() && Object.keys(draft.values).length > 0 && !updateAttempts.get(draft);
  if (draft === staged) cancelRecordAutosave();
  drafts.suspend(draft);
  feedback.delete(draft);
  if (draft === staged) staged = emptyDraft();
  if (retained) toast(say('unsavedChangesWereRetained'), 'info');
}

/**
 * The record the reader has an unsaved draft of, for live sync (liveInvalidate.ts): a change another person made to
 * it does not reach the form, it is said beside it (components/LiveNotice.tsx).
 * @returns {{ table: string, key: Record<string, unknown>, originals: Record<string, unknown>, values: Record<string, unknown> } | undefined}
 */
export const dirtyDraft = () =>
  staged.connection === (state.activeConnection ?? null) && Object.keys(staged.values).length ? staged : undefined;

/**
 * Take another person's value for one field of the draft: the form shows it, and Save checks against it.
 * @param {string} column
 * @param {unknown} value
 */
export function takeTheirs(column, value) {
  if (!Object.keys(staged.values).length) return;
  staged.values[column] = value;
  staged.originals[column] = value;
  tell();
}

export const draftNeedsReview = (table, key) => sameRow(table, key) && staged.needsReview;
export const draftRequiresManualSave = (table, key) => sameRow(table, key) && staged.manualSaveRequired;
export const draftSchemaChanged = (table) => staged.schemaKey !== draftSchemaKey(table);
export const retainedValues = () => ({ ...staged.values });
export const stagedOriginal = (column) => (staged.needsReview ? undefined : staged.originals[column]);

export function resumeDraft(table, key) {
  if (!sameRow(table.id, key) || draftSchemaChanged(table) || !canEditRow(table, key) || stagedAttempt(table.id, key)) return;
  staged.needsReview = false;
  tell();
}

addHostListener(window, 'beforeunload', (event) => {
  if (!drafts.hasPending()) return;
  event.preventDefault();
  event.returnValue = '';
});

export function pendingCount() {
  return staged.connection === (state.activeConnection ?? null) ? Object.keys(staged.values).length : 0;
}

/**
 * Whether what is staged belongs to the row on screen.
 *
 * The connection is part of the answer. Keyed by table and key alone, an edit
 * staged against staging's `customer:4` showed as pending on production's
 * `customer:4` — the same table name and the same id, a different database,
 * and one click from being written to the wrong one.
 */
function sameRow(table, key) {
  return updateOwnerKey(staged) === updateOwnerKey({ connection: state.activeConnection ?? null, table, key });
}

export function discardStaged() {
  cancelRecordAutosave();
  editErrors.delete(staged);
  clearServerErrors(staged);
  discards.set(staged, (discards.get(staged) ?? 0) + 1);
  if (staged.connection === (state.activeConnection ?? null)) {
    staged.values = {};
    staged.originals = {};
    staged.needsReview = false;
    staged.manualSaveRequired = false;
    feedback.delete(staged);
  } else staged = emptyDraft();
  tell();
}

/* A flag's two stored values and whether a row may be edited live in
   rowEditing.js, where a grid's cell asks them too; re-exported for the
   record editors that have always asked here. */
export { booleanChoices, canEditRow };

/* The editor and the pending bar are components (components/Editable.tsx); they
   read this store and tick with it. */
const listeners = new Set();
const feedback = new WeakMap();
const discards = new WeakMap();
/** @type {WeakMap<import('./recordDrafts.js').RecordDraft, Readonly<Record<string, string>>>} */
const editErrors = new WeakMap();
/* The fields a refused save named, marked on the record until each is edited.
   Kept apart from the preflight's errors, which are recomputed from the draft
   on every edit and would otherwise wipe a mark the reader has not touched. */
/** @type {WeakMap<import('./recordDrafts.js').RecordDraft, Readonly<Record<string, string>>>} */
const serverErrors = new WeakMap();
/** @type {WeakMap<Readonly<Record<string, string>>, { client: Readonly<Record<string, string>>, errors: Readonly<Record<string, string>> }>} */
const mergedErrors = new WeakMap();
/* The first field a refused explicit Save marked. Its editor may not be drawn
   yet — an unopened field opens because it is marked — so the editor takes
   the focus when it is, once. */
/** @type {{ draft: import('./recordDrafts.js').RecordDraft, field: string } | null} */
let fieldFocus = null;
const noEditErrors = Object.freeze({});
let version = 0;
function tell() {
  version += 1;
  for (const fn of listeners) fn();
}
export function subscribeStaged(fn) {
  listeners.add(fn);
  const unsubscribe = updateAttempts.subscribe(fn);
  return () => {
    listeners.delete(fn);
    unsubscribe();
  };
}
export const stagedVersion = () => version + updateAttempts.version();
export const stagedAttempt = (table, key) => updateAttempts.get({ connection: state.activeConnection ?? null, table, key });
export const stagedFeedback = (table, key) => (sameRow(table, key) ? feedback.get(staged) : undefined);
export const stagedDiscardVersion = (table, key) => (sameRow(table, key) ? (discards.get(staged) ?? 0) : 0);
/** @returns {Readonly<Record<string, string>>} */
export const stagedEditErrors = (tableId, key) => (sameRow(tableId, key) ? draftErrors(staged) : noEditErrors);

/* The preflight's word wins over a refusal's for the same field: it is about
   the value on screen now, the refusal about the one that was sent. */
function draftErrors(draft) {
  const client = editErrors.get(draft) ?? noEditErrors;
  const server = serverErrors.get(draft);
  if (!server) return client;
  const cached = mergedErrors.get(server);
  if (cached?.client === client) return cached.errors;
  const errors = Object.freeze({ ...server, ...client });
  mergedErrors.set(server, { client, errors });
  return errors;
}

/** Whether this field's editor should take the focus a refused Save left for it. Consumed. */
export function takeFieldFocus(tableId, key, column) {
  if (!fieldFocus || fieldFocus.draft !== staged || fieldFocus.field !== column || !sameRow(tableId, key)) return false;
  fieldFocus = null;
  return true;
}

/* A column's own mark, and its row-defined fields' (`specs.capacity`): the
   whole object is what was staged again. */
function clearServerError(draft, name) {
  const server = serverErrors.get(draft);
  const of = (field) => field === name || field.startsWith(`${name}.`);
  if (fieldFocus?.draft === draft && of(fieldFocus.field)) fieldFocus = null;
  if (!server || !Object.keys(server).some(of)) return;
  const rest = Object.fromEntries(Object.entries(server).filter(([field]) => !of(field)));
  if (Object.keys(rest).length) serverErrors.set(draft, Object.freeze(rest));
  else serverErrors.delete(draft);
}

function clearServerErrors(draft) {
  serverErrors.delete(draft);
  if (fieldFocus?.draft === draft) fieldFocus = null;
}

/* A field is on screen when its editor — open or not — is registered and
   drawn. Presence, not focusability: a pending save disables the launchers. */
function fieldOnScreen(draft, name) {
  const root = draft.inputs[name]?.element;
  return Boolean(root?.isConnected && !root.closest('[hidden], [inert], [aria-hidden="true"]'));
}

/**
 * Mark the fields a refused save named — the New form's contract, through the
 * same shape check — on the record they are drawn on, and say in the summary
 * only what cannot be marked: fields this record does not show, or none named
 * at all. An explicit Save leaves the focus on the first marked field in
 * catalog order; a blur save leaves it where the reader moved it.
 * @returns {string} The summary, empty when every named field is marked.
 */
function markRefusal(draft, table, result, focus) {
  const marks = Object.create(null);
  const unplaced = [];
  for (const { field, message } of result.fields ?? []) {
    // A row-defined field is `column.key` (definedFields.ts), marked where its own editor is registered under that name.
    const column = table.columns?.find((candidate) => candidate.name === field.split('.')[0]);
    if (column && fieldOnScreen(draft, field)) marks[field] = message;
    else unplaced.push(column ? `${columnLabel(table.id, field) ?? field}: ${message}` : '');
  }
  const marked = Object.keys(marks);
  if (marked.length) serverErrors.set(draft, Object.freeze(marks));
  else clearServerErrors(draft);
  const first =
    table.columns?.find((column) => Object.hasOwn(marks, column.name))?.name ??
    marked.find((field) => table.columns?.some((column) => field.startsWith(`${column.name}.`)));
  fieldFocus = focus && first ? { draft, field: first } : fieldFocus?.draft === draft ? null : fieldFocus;
  if (marked.length && !unplaced.length) return '';
  return [result.message, ...unplaced.filter(Boolean)].join(' ');
}
export function dismissSaveFeedback() {
  feedback.delete(staged);
  tell();
}

function readEditControls(draft) {
  /** @type {Record<string, import('./recordEditValidation.js').RecordEditControlState>} */
  const controls = Object.create(null);
  for (const [name, registered] of Object.entries(draft.inputs)) {
    if (!registered.element.isConnected || !registered.readState) continue;
    try {
      const value = registered.readState();
      if (!value || typeof value !== 'object' || Array.isArray(value) || 'then' in value) throw new Error();
      const { unresolvedReference, invalidInput } = value;
      if (
        (unresolvedReference !== undefined && typeof unresolvedReference !== 'boolean') ||
        (invalidInput !== undefined && typeof invalidInput !== 'boolean')
      )
        throw new Error();
      controls[name] = { unresolvedReference, invalidInput };
    } catch {
      // Control faults never expose callback diagnostics or permit a partial save.
      controls[name] = { invalidInput: true };
    }
  }
  return controls;
}

function errorControl(draft, name) {
  const root = draft.inputs[name]?.element;
  if (!root?.isConnected || root.closest('[hidden], [inert], [aria-hidden="true"]')) return;
  const selector =
    'input:not(:disabled):not([type="hidden"]), textarea:not(:disabled), select:not(:disabled), button:not(:disabled), [tabindex]:not([tabindex="-1"])';
  return root.matches(selector) ? root : root.querySelector(selector);
}

function publishEditValidation(draft, errors) {
  const previous = editErrors.get(draft) ?? noEditErrors;
  const names = Object.keys(errors);
  let changed = names.length !== Object.keys(previous).length || names.some((name) => errors[name] !== previous[name]);
  editErrors.set(draft, changed ? errors : previous);
  const inaccessible = names.filter((name) => !errorControl(draft, name));
  const priorFeedback = feedback.get(draft);
  if (inaccessible.length) {
    const message = inaccessible.map((name) => `${name}: ${errors[name]}`).join(' ');
    if (priorFeedback?.source !== 'validation' || priorFeedback.message !== message) {
      feedback.set(draft, { phase: 'error', source: 'validation', message });
      changed = true;
    }
  } else if (priorFeedback?.source === 'validation') {
    feedback.delete(draft);
    changed = true;
  }
  return changed;
}

/** Corrections may clear attempted validation, but mounting stays quiet. */
export function refreshEditValidation(table, key) {
  if (!prefersPages() || !sameRow(table.id, key) || !editErrors.has(staged)) return;
  const captured = staged,
    revision = stagedVersion();
  const currentTable = state.schema?.tables?.find((candidate) => candidate.id === table.id) ?? table;
  const errors = validateRecordEdits(currentTable, captured.values, readEditControls(captured));
  if (captured !== staged || revision !== stagedVersion() || !sameRow(table.id, key)) return;
  if (publishEditValidation(captured, errors)) tell();
}

/** What is staged for a column of the row on screen, or undefined. */
export const stagedValue = (column) => (staged.needsReview ? undefined : staged.values[column]);
export const pendingColumns = () => Object.keys(staged.values);

/**
 * Stage one change. Typing a value and then typing the original back is not
 * a change. Exported for the editor component.
 */
export function stage(table, key, column, value, original) {
  const known = table.columns?.find((c) => c.name === column.name);
  // A declared transition moves only through the record's actions.
  if (column.writable === false || column.changesBy === 'actions' || known?.writable === false || known?.changesBy === 'actions') return;
  // Freeze before an autosave publishes pending state. Other staged operations
  // (notably Undo reconciliation) still preserve edits begun while they settle.
  if (stagedAttempt(table.id, key) || (recordAutosavePending() && sameRow(table.id, key))) return;
  activateDraft(table, key);
  if (staged.needsReview) return;
  feedback.delete(staged);
  // An edited field is the reader's answer to its mark; the others keep theirs.
  clearServerError(staged, column.name);
  if (Object.hasOwn(staged.originals, column.name)) original = staged.originals[column.name];
  // Text inputs stringify numbers and booleans, but NULL is not the text "null".
  const unchanged = value === null || original === null ? value === original : String(value) === String(original);
  if (unchanged) {
    delete staged.values[column.name];
    delete staged.originals[column.name];
  } else {
    staged.values[column.name] = value;
    staged.originals[column.name] = original;
    /* A row-defined field (DefinedFields.tsx) is staged under `column.key`
       and saved as its column's whole object: the object it was read in and
       how its box's text becomes a value ride with the draft. */
    if (column.defined) (staged.folds ??= {})[column.name] = column.defined;
  }
  refreshEditValidation(table, key);
  tell();
}

/* What is sent: each row-defined field folded into its column's object, as
   JSON text (the server writes and judges the whole object). */
function folded(draft, values, originals) {
  const folds = draft.folds ?? {};
  const fields = Object.keys(values).filter((name) => Object.hasOwn(folds, name));
  if (!fields.length) return { values, originals };
  const objects = {};
  const sent = { ...values },
    guarded = { ...originals };
  for (const name of fields) {
    const { column, object, toValue } = folds[name];
    const next = (objects[column] ??= { ...object });
    const value = toValue(values[name]);
    if (value === undefined) delete next[name.slice(column.length + 1)];
    else next[name.slice(column.length + 1)] = value;
    delete sent[name];
    delete guarded[name];
  }
  for (const [column, object] of Object.entries(objects)) sent[column] = JSON.stringify(object);
  return { values: sent, originals: guarded };
}

/** The editor's element, kept so a successful write can confirm in place.
 * @param {() => import('./recordEditValidation.js').RecordEditControlState} [readState]
 */
export function registerInput(table, key, column, input, onCommitted, readState) {
  activateDraft(table, key);
  const captured = staged,
    registration = { element: input, onCommitted, readState };
  Object.defineProperty(captured.inputs, column, { value: registration, configurable: true, writable: true, enumerable: true });
  return () => {
    if (captured.inputs[column] === registration) delete captured.inputs[column];
  };
}

export { sameRow };

/* An update's guard names each changed column at the value it was read with —
   but a JSON column's, which no engine compares: it is written whole. */
function comparable(table, originals) {
  const json = new Set((table.columns ?? []).filter((column) => isJsonType(column.type)).map((column) => column.name));
  return json.size ? Object.fromEntries(Object.entries(originals).filter(([column]) => !json.has(column))) : originals;
}

let applying = false;
export const applyingStaged = () => applying;
let autosaveCancellation = 0;
/** @type {ReturnType<typeof captureSessionIdentity> | undefined} */
let autosaveIdentity;
/** @type {import('./updateAttempts.js').UpdateOwner | undefined} */
let autosaveOwner;
/** Deferred intent only: an already dispatched write still settles normally. */
export function cancelRecordAutosave() {
  autosaveCancellation++;
}
export function recordAutosavePending() {
  // Ordinary uncertainty keeps the record locked, not every route. Tenant
  // uncertainty still has its independent stronger navigation gate in core.
  return (
    autosaveIdentity !== undefined &&
    autosaveIdentity === sessionIdentity() &&
    autosaveOwner !== undefined &&
    updateAttempts.get(autosaveOwner)?.phase !== 'uncertain'
  );
}

/** Capture only for a fresh user edit leaving its complete interaction surface.
 * This predicate does not schedule or send anything. The interaction owner must
 * also prove its mount, picker state and current App save policy at dispatch. */
export function captureRecordAutosaveGuard(table, key, stillEditing) {
  const captured = staged,
    identity = captureSessionIdentity(),
    schema = state.schema;
  const capturedKey = { ...key },
    revision = stagedVersion();
  const cancellation = autosaveCancellation;
  const navigation = captureNavigation();
  const current = () => {
    try {
      return (
        typeof stillEditing === 'function' &&
        stillEditing() === true &&
        cancellation === autosaveCancellation &&
        prefersPages() &&
        navigation() &&
        captured === staged &&
        identity === sessionIdentity() &&
        schema === state.schema &&
        revision === stagedVersion() &&
        sameRow(table.id, capturedKey) &&
        pendingCount() > 0 &&
        !staged.needsReview &&
        !staged.manualSaveRequired &&
        !applying &&
        !stagedAttempt(table.id, capturedKey) &&
        !draftSchemaChanged(table) &&
        canEditRow(table, capturedKey)
      );
    } catch {
      return false;
    }
  };
  // An initially ineligible draft cannot be armed later by Resume, policy
  // changes, another acknowledgement or programmatic focus restoration.
  return current() ? current : () => false;
}

/**
 * @param {(opts?: { inPlace?: boolean }) => void} [onDone]
 * @param {{ trigger?: 'explicit'|'blur', guard?: () => boolean }} [options]
 */
export async function applyStaged(table, key, onDone = undefined, options = {}) {
  const trigger = options.trigger ?? 'explicit';
  if (trigger !== 'explicit' && trigger !== 'blur') return;
  const blur = trigger === 'blur';
  // Do not cancel the supplied blur capture before checking it.
  if (!blur) cancelRecordAutosave();
  const guard = () => {
    try {
      return typeof options.guard === 'function' && options.guard() === true;
    } catch {
      return false;
    }
  };
  if (blur && (!prefersPages() || staged.manualSaveRequired || !guard())) return;
  if (applying || staged.needsReview || stagedAttempt(table.id, key) || !sameRow(table.id, key)) return;
  if (!pendingCount()) {
    if (!blur && staged.manualSaveRequired) {
      staged.manualSaveRequired = false;
      editErrors.delete(staged);
      clearServerErrors(staged);
      feedback.delete(staged);
      tell();
    }
    return;
  }
  const currentTable = state.schema?.tables ? state.schema.tables.find((candidate) => candidate.id === table.id) : table;
  if (
    !currentTable ||
    draftSchemaChanged(currentTable) ||
    draftSchemaChanged(table) ||
    Object.keys(staged.values).some((name) => {
      const column = currentTable.columns?.find((c) => c.name === name);
      return column?.writable === false || column?.changesBy === 'actions';
    })
  )
    return;
  const app = prefersPages();
  if (app && !canEditRow(currentTable, key)) return;
  const captured = staged;
  const connection = captured.connection;
  const staging = { ...staged.values };
  const { values, originals } = folded(captured, staging, { ...staged.originals });
  key = { ...key };
  const schema = state.schema;
  const identity = captureSessionIdentity();
  const generation = connectionGeneration();
  const navigation = blur ? captureNavigation() : () => true;
  const cancellation = autosaveCancellation,
    revision = stagedVersion();
  if (app) {
    const errors = validateRecordEdits(currentTable, values, readEditControls(captured));
    if (
      captured !== staged ||
      revision !== stagedVersion() ||
      schema !== state.schema ||
      identity !== sessionIdentity() ||
      cancellation !== autosaveCancellation ||
      !sameRow(table.id, key) ||
      !canEditRow(currentTable, key) ||
      (blur && !guard())
    )
      return;
    const changed = publishEditValidation(captured, errors);
    if (Object.keys(errors).length) {
      if (changed) tell();
      if (!blur && captured === staged && identity === sessionIdentity() && sameRow(table.id, key)) {
        const first = Object.keys(errors)
          .map((name) => errorControl(captured, name))
          .find(Boolean);
        first?.focus();
      }
      return;
    }
  }
  feedback.delete(captured);
  const current = () => identity === sessionIdentity() && captured === staged && sameRow(table.id, key) && state.canWrite;
  const dispatchCurrent = () =>
    current() &&
    schema === state.schema &&
    generation === connectionGeneration() &&
    !draftSchemaChanged(table) &&
    (!app || (prefersPages() && canEditRow(currentTable, key))) &&
    (!blur || (navigation() && cancellation === autosaveCancellation && !captured.manualSaveRequired && !captured.needsReview));
  applying = true;
  if (blur) {
    autosaveIdentity = identity;
    autosaveOwner = { connection: connection ?? null, table: table.id, key: { ...key } };
  }
  try {
    tell();
    const ok = app || (await confirmUpdate(table, key, values, originals));
    if (!ok) return;
    if (!dispatchCurrent()) {
      if (!blur) toast(say('theRecordConnectionOrTable'), 'error');
      return;
    }
    /** @type {(() => void) | undefined} */
    let acknowledged;
    const result = await updateAttempts.run({ connection: connection ?? null, table: table.id, key }, values, () => {
      if (!dispatchCurrent()) throw Object.assign(new Error(say('theRecordChangedBefore')), { outcome: 'not_applied' });
      if (app) acknowledged = captureRecordWriteRefresh(table.id, key);
      return api('/api/update', { ...ownedBy(connection), table: table.id, key, values, expected: comparable(table, originals) });
    });
    if (result.kind !== 'applied') {
      if (result.kind === 'rejected') captured.manualSaveRequired = true;
      if (app && current() && result.kind === 'rejected') {
        /* The draft stays as it was; the fields the server named are marked
           on it, and nothing is retried — a blur save included. */
        const summary = markRefusal(captured, currentTable, result, !blur);
        if (summary) feedback.set(captured, { phase: 'error', message: summary });
        else feedback.delete(captured);
        tell();
      } else if (identity === sessionIdentity() && (result.kind !== 'uncertain' || !current())) toast(result.message, 'error');
      return;
    }
    const n = Object.keys(result.applied).length;
    const inputs = captured.inputs;
    // Settle the original draft even after navigation selected another record.
    for (const [column, value] of Object.entries(result.applied)) {
      if (Object.is(captured.values[column], values[column])) {
        delete captured.values[column];
        delete captured.originals[column];
      } else if (column in captured.values) captured.originals[column] = value;
    }
    // A row-defined field folded into a column that was written, unless it was edited again meanwhile.
    const foldedSaved = {};
    for (const name of Object.keys(staging)) {
      const fold = captured.folds?.[name];
      if (!fold || !Object.hasOwn(result.applied, fold.column)) continue;
      // Its editor is told what it now holds: the box's own text, which the object was written from.
      foldedSaved[name] = staging[name];
      if (!Object.is(captured.values[name], staging[name])) continue;
      delete captured.values[name];
      delete captured.originals[name];
      delete captured.folds[name];
    }
    if (!Object.keys(captured.values).length) {
      captured.needsReview = false;
      captured.manualSaveRequired = false;
      editErrors.delete(captured);
    }
    // What a refusal said was about the values it saw; these were written.
    clearServerErrors(captured);
    acknowledged?.();
    // History follows the original owner even if another record is now open.
    if (
      identity === sessionIdentity() &&
      connection === state.activeConnection &&
      schema === state.schema &&
      generation === connectionGeneration()
    )
      void shell().undo.refresh();
    tell();
    if (!current()) {
      if (identity === sessionIdentity())
        toast(say('updatedColumnsOnTheOriginal', { count: n, connection: connection ?? say('theOriginalConnection') }), 'ok');
      return;
    }

    // An App has no Undo: the dock says what was saved.
    if (app) feedback.set(captured, { phase: 'saved', message: say('changesSaved'), identity, columns: Object.keys(values) });
    else
      toast(
        say('updatedColumns', { count: n, name: table.name }),
        'ok',
        !identity.tenantRequired && result.undoId
          ? {
              /* Beside the confirmation, because this is the moment someone realises
         it was the wrong row — and sending them to a menu to find Undo wastes
         the seconds in which they still remember what they changed. */
              label: say('common.undo'),
              run: () => {
                if (identity === sessionIdentity() && connection === state.activeConnection) void shell().undo.last(result.undoId);
              },
            }
          : undefined,
      );

    /* Confirmed in place rather than by re-rendering. A re-render would throw
       away the row you are looking at and rebuild it, which reads as a flicker
       and loses the caret; worse, it left the fields showing their unsaved
       styling because the DOM they styled was gone before the class was.
       Showing the saved value, in green, on the field you just edited is both
       calmer and more specific — it says *which* fields landed. */
    tell();
    confirmSaved(inputs, { ...result.applied, ...foldedSaved });
    // Only the pending bar is refreshed, so the green fields survive.
    onDone?.({ inPlace: true });
  } catch (err) {
    // Attempt failures are classified above; presentation failures must not resend.
    toast(err.message, 'error');
  } finally {
    if (blur) {
      autosaveIdentity = undefined;
      autosaveOwner = undefined;
    }
    applying = false;
    tell();
  }
}

function confirmSaved(inputs, applied) {
  for (const [column, value] of Object.entries(applied)) {
    const registered = inputs[column];
    const input = registered?.element;
    if (!input || !input.isConnected) continue;
    // The value the database actually stored, which may differ from what was
    // typed — "17901" comes back as the number 17901.
    registered.onCommitted?.(value);
  }
}

/** Show the statement before it runs. This is the last stop before a write. */
function confirmUpdate(table, key, values, originals) {
  return new Promise((resolve) => {
    const q = (id) => `"${id}"`;
    const sets = Object.keys(values)
      .map((c) => `${q(c)} = ?`)
      .join(',\n       ');
    const where = [
      ...Object.keys(key).map((c) => `${q(c)} = ?`),
      ...Object.keys(originals).map((c) => `${q(c)} ${originals[c] === null ? 'IS NULL' : '= ?'}`),
    ].join(' AND ');
    const sql = `UPDATE ${q(table.id)}\n   SET ${sets}\n WHERE ${where};`;

    /* The parameters shown are the raw staged values. The server coerces them
       against the declared column types and returns what it applied, so a
       number typed as text is corrected there rather than guessed at here. */
    const params = JSON.stringify([
      ...Object.values(values),
      ...Object.values(key),
      ...Object.values(originals).filter((value) => value !== null),
    ]);

    const rows = Object.entries(values).map(([column, to]) => {
      const from = originals[column];
      const type = table.columns.find((c) => c.name === column)?.type ?? '';
      return el('tr', {}, [
        el('td', {}, [el('span', { class: 'diff-col', text: column }), el('span', { class: 'diff-type', text: type.toLowerCase() })]),
        el('td', { class: `diff-from${from === null ? ' null' : ''}`, text: from === null ? 'null' : String(from) }),
        el('td', { class: 'diff-arrow', text: '→' }),
        el('td', { class: `diff-to${to === null ? ' null' : ''}`, text: to === null ? 'null' : String(to) }),
      ]);
    });

    const dialog = el('dialog', { class: 'confirm confirm-wide' }, [
      el('h2', { text: rows.length === 1 ? say('applyThisChange') : say('applyChanges', { count: rows.length }) }),
      el('p', {}, [
        document.createTextNode('One row in '),
        el('strong', { text: table.id }),
        document.createTextNode(', identified by '),
        el('strong', {
          text: Object.entries(key)
            .map(([k, v]) => `${k} = ${v}`)
            .join(', '),
        }),
        document.createTextNode('. Applied as a single statement only if these fields still match their original values.'),
      ]),
      el('table', { class: 'confirm-diff' }, el('tbody', {}, rows)),
      el('pre', { class: 'ddl', text: sql }),
      el('p', { class: 'confirm-params', text: say('parameters', { params }) }),
      el('div', { class: 'confirm-actions' }, [
        el('button', {
          type: 'button',
          class: 'ghost',
          text: say('common.cancel'),
          onclick: () => {
            dialog.close();
            resolve(false);
          },
        }),
        el('button', {
          type: 'button',
          class: 'primary',
          text: say('common.apply'),
          onclick: () => {
            dialog.close();
            resolve(true);
          },
        }),
      ]),
    ]);
    dialog.addEventListener('close', () => dialog.remove());
    dialog.addEventListener('cancel', () => resolve(false));
    portalRoot().append(dialog);
    dialog.showModal();
  });
}

/** Why a row is not editable, for the record view to explain rather than hide. */
export function whyNotEditable(table) {
  if (!state.canWrite) return null; // not in write mode: say nothing
  if (!table) return say('unknownTable');
  if (table.isView) return say('thisIsAView');
  if (!table.columns.some((c) => c.primaryKey)) {
    return say('thisTableHasNoPrimary');
  }
  return null;
}
