/**
 * Saved SQL statements: the ones you keep, and the ones your team commits.
 *
 * Two stores, one list. A statement in `tablewalk.json` was checked in by
 * somebody and is the same to the person looking for it as one they saved this
 * morning — the only difference is whether they may delete it. Merging them
 * here rather than showing two lists is the whole point: nobody wants to
 * remember which half of their query library they are looking at.
 *
 * Stored as text, never as anything compiled. It stays readable in the editor,
 * it survives the schema changing underneath it — at worst as a visible error
 * you can fix rather than a silently wrong answer — and a statement in the
 * config file can be reviewed by someone who knows SQL and nothing about this
 * tool.
 */
import { api, loadJson, saveJson, state, toast } from '@mistriwork/kit/client/core.js';
import { connectionGeneration } from '@mistriwork/kit/client/connectionTransition.js';
import { canUseDatabaseTools } from '@mistriwork/kit/client/connectionScope.js';
import { sessionIdentity, subscribeSessionIdentity } from '@mistriwork/kit/client/sessionIdentity.js';
import { say } from './copy/workbench/sqlsaved.js';

const KEY = 'mistri.sql.v1';

const connectionKey = () => state.activeConnection ?? 'default';

/** Config-defined statements for the open connection, fetched once per switch. */
let fromConfig = [];
let fetchedFor = null;
let loadGeneration = 0;

subscribeSessionIdentity(() => {
  fromConfig = [];
  fetchedFor = null;
  loadGeneration++;
});

export async function loadSavedSql() {
  const owner = sessionIdentity();
  const connection = connectionKey();
  const request = ++loadGeneration;
  if (!canUseDatabaseTools()) {
    fromConfig = [];
    fetchedFor = null;
    return;
  }
  const generation = connectionGeneration();
  const isCurrent = () =>
    owner === sessionIdentity() && request === loadGeneration && generation === connectionGeneration() && connection === connectionKey();
  try {
    const data = await api('/api/queries');
    // Check both the server's connection and this read's generation, including A/B/A switches.
    if (data.connection && data.connection !== connectionKey()) return;
    if (!isCurrent()) return;
    fromConfig = data.queries ?? [];
    fetchedFor = connectionKey();
  } catch {
    /* A config file that does not answer costs the committed half of the list.
       The browser's own statements still work, which is the right way round. */
    if (!isCurrent()) return;
    fromConfig = [];
    fetchedFor = connectionKey();
  }
}

function localFor(connection) {
  return loadJson(KEY, {})[connection] ?? [];
}

/**
 * Everything saved for this connection, config first.
 *
 * Config first because a checked-in statement is usually the canonical one and
 * the personal ones are variations on it.
 */
export function savedStatements() {
  if (!canUseDatabaseTools()) return [];
  const connection = connectionKey();
  const config = fetchedFor === connection ? fromConfig : [];
  return [...config.map((q) => ({ ...q, source: 'config' })), ...localFor(connection).map((q) => ({ ...q, source: 'saved' }))];
}

/**
 * Keep a statement under a name.
 *
 * A repeated name replaces rather than duplicating: two entries called "Daily
 * totals" that do different things is worse than losing the older one, and the
 * person typing the name a second time is almost always correcting the first.
 * A name the config file already uses is refused instead — that one is not
 * ours to replace, and silently shadowing it would make a committed statement
 * mean something different on one machine.
 */
export function saveStatement(name, sql) {
  if (!canUseDatabaseTools()) return false;
  const connection = connectionKey();
  const trimmed = name.trim();
  if (!trimmed) return false;

  if (fetchedFor === connection && fromConfig.some((q) => q.name === trimmed)) {
    toast(say('isDefinedInTablewalk', { trimmed }), 'error');
    return false;
  }

  const all = loadJson(KEY, {});
  const kept = (all[connection] ?? []).filter((q) => q.name !== trimmed);
  kept.push({ name: trimmed, sql: sql.trim() });
  all[connection] = kept;

  if (!saveJson(KEY, all)) {
    toast(say('common.couldNotSaveThisBrowser'), 'error');
    return false;
  }
  return true;
}

export function removeStatement(name) {
  if (!canUseDatabaseTools()) return;
  const connection = connectionKey();
  const all = loadJson(KEY, {});
  all[connection] = (all[connection] ?? []).filter((q) => q.name !== name);
  saveJson(KEY, all);
}
