/**
 * Which connection or App this tab is on, from the server's runtime: the
 * first question boot asks, and the list the shell keeps current.
 *
 * Both shells start here. An App server answers with its Apps and the tab
 * takes the one its address names; the database browser answers with its
 * connections, which the Workbench's picker draws (connections.js registers
 * it with `whenConnectionControls`). An App is not a connection manager, so
 * where nothing draws the picker it and the database label stay hidden.
 */
import { $, api, state } from './core.js';
import { syncWriteMode } from './write.js';
import { connectionGeneration } from './connectionTransition.js';
import { canManageConnections, setAppConfigured } from './connectionScope.js';
import { RuntimeMetadataError, UnknownAppError } from './requestIdentity.js';
import { say } from './copy/shell/connectionList.js';

/** @type {import('@mistriwork/engine/shared/connection.js').RuntimeMetadata | null} */
let initialRuntime = null;

/** Choose the logical App before the first schema or manifest request. */
export async function bootstrapRequestIdentity(requested) {
  try {
    /** @type {import('@mistriwork/engine/shared/connection.js').RuntimeMetadata} */
    const runtime = await api('/api/runtime');
    if (typeof runtime?.appConfigured !== 'boolean') throw new RuntimeMetadataError(say('runtimeMetadataIsInvalid'));
    setAppConfigured(runtime.appConfigured);
    if (runtime.appConfigured) {
      if (
        !Array.isArray(runtime.apps) ||
        runtime.apps.some(
          (app) => !app || typeof app.id !== 'string' || !app.id || typeof app.name !== 'string' || typeof app.writable !== 'boolean',
        )
      ) {
        throw new RuntimeMetadataError(say('invalidRuntimeApplicationList'));
      }
      const selected = requested || runtime.active;
      if (!selected) throw new Error(say('chooseAnApplicationUrl'));
      if (!runtime.apps.some((app) => app.id === selected)) throw new UnknownAppError(selected, runtime.apps);
      state.activeConnection = selected;
      state.connections = runtime.apps;
    }
    initialRuntime = runtime;
  } catch (error) {
    initialRuntime = null;
    setAppConfigured(null);
    throw error;
  }
}

export async function initConnections(onSwitched) {
  state.onSwitched = onSwitched;
  await refreshConnections();
  if (!state.activeConnection) throw new Error(say('common.applicationRuntimeIsUnavailable'));
}

/**
 * Redraw the picker from the server's list.
 *
 * Exported because a deep link switches connection without going through
 * `selectConnection` — it opens the connection the link names and rebuilds
 * the trail — and the picker was left showing whatever the server called
 * active. Landing on a link into one database with the sidebar naming another
 * is the interface disagreeing with itself about where you are.
 */
let listGeneration = 0;
export async function refreshConnections() {
  const request = ++listGeneration;
  const generation = connectionGeneration();
  const connection = state.activeConnection;
  const isCurrent = () => request === listGeneration && generation === connectionGeneration() && connection === state.activeConnection;
  let data;
  try {
    /** @type {import('@mistriwork/engine/shared/connection.js').RuntimeMetadata} */
    const runtime = initialRuntime ?? (await api('/api/runtime'));
    initialRuntime = null;
    if (!isCurrent()) return;
    if (runtime?.appConfigured === true) {
      data = { connections: runtime.apps, active: runtime.active, appConfigured: true };
    } else if (runtime?.appConfigured === false) {
      data = { ...(await api('/api/connections')), appConfigured: false };
    } else {
      throw new Error(say('common.runtimeMetadataIsUnavailable'));
    }
  } catch {
    if (!isCurrent()) return;
    setAppConfigured(null);
    /* One connection, no config file: the picker has nothing to offer, so it
       gets out of the way rather than showing a control with one option.
    
       `conn-select` was the `<select>` this used to be, and there has been no
       such element since it became a custom dropdown — so this line, on the
       one path that runs when the connection list cannot be read, threw a
       TypeError out of the handler meant to recover from the failure. It
       escaped `initConnections`, which boot awaits, and the page never
       finished starting: a server hiccup on one request took the whole app
       down rather than hiding a picker. */
    $('conn-picker').hidden = true;
    $('db-label').hidden = !canManageConnections();
    controls?.retire($('conn-picker'));
    return;
  }
  if (!isCurrent()) return;
  if (!Array.isArray(data.connections)) throw new Error(say('invalidRuntimeApplicationOrConnection'));
  // Internal ownership/cache keys keep their historical connection names.
  // App runtime metadata contains authored App IDs, not database connections.
  state.connections = data.connections;
  setAppConfigured(typeof data.appConfigured === 'boolean' ? data.appConfigured : null);
  // The server default is only for boot. An established tab owns its connection.
  if (!state.activeConnection) state.activeConnection = data.active;

  /* Write mode is remembered per connection, and until now it was only
     re-read when someone *switched* connection — never on the way in. So a
     page reload landed on the active connection with write mode off, and the
     setting quietly came back the moment you switched away and back. `initWriteMode`
     runs before this, when `state.activeConnection` is still undefined, so
     there is nothing it could have read. */
  syncWriteMode();

  syncConnectionControls();
}

/**
 * The Workbench's picker, which draws the connection controls once its shell
 * is loaded (connections.js). A registration rather than an import: an App
 * never loads the picker, and the list is the kit's.
 * @type {{ draw(picker: HTMLElement): void, retire(picker: HTMLElement): void } | null}
 */
let controls = null;
/** @param {{ draw(picker: HTMLElement): void, retire(picker: HTMLElement): void }} next */
export function whenConnectionControls(next) {
  controls = next;
}

/** App ownership: an App is not a connection manager. */
export function syncConnectionControls() {
  const picker = $('conn-picker');
  if (!canManageConnections() || !controls) {
    picker.hidden = true;
    $('db-label').hidden = true;
    controls?.retire(picker);
    return;
  }
  controls.draw(picker);
}
