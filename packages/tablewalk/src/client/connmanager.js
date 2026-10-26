/**
 * Connections, as a place rather than a dropdown.
 *
 * The picker in the sidebar answers "switch to another database" and nothing
 * else. Everything a person actually wants to do with a connection — see why
 * one will not open, correct a typed host, notice that a password is sitting
 * in a URL, remove one they added by mistake, make a session connection
 * permanent — had no home at all.
 *
 * Three ideas hold this together:
 *
 *   - **A connection is a card, not a row.** Its state is not one value: it
 *     has a target, a dialect, whether it is open, how many tables it found,
 *     where its password came from, and whether anything is worth warning
 *     about. A table of columns would either drop most of that or be unreadable.
 *
 *   - **Editing is session-scoped until you say otherwise.** Changes take
 *     effect immediately in the running process and touch no file. Writing
 *     them to disk is a separate button that names the file it is about to
 *     write. A page that silently edits a config file is a surprise, and this
 *     tool's whole argument is against surprises.
 *
 *   - **Failure is shown, not hidden.** A connection that cannot open stays in
 *     the list with its error, because a database missing from the list looks
 *     like one you never configured.
 */
import { createElement } from 'react';
import { api, el, state, toast } from '@mistriwork/kit/client/core.js';
import { promptFor } from '@mistriwork/kit/client/prompt.js';
import { reintrospect, selectConnection } from './connections.js';
import { refreshConnections } from '@mistriwork/kit/client/connectionList.js';
import { connectionGeneration } from '@mistriwork/kit/client/connectionTransition.js';
import { mount, unmount } from '@mistriwork/kit/client/components/mount.js';
import { onDemand } from '@mistriwork/kit/client/components/onDemand.js';
import { canManageConnections } from '@mistriwork/kit/client/connectionScope.js';
import { plural } from '@mistriwork/kit/client/locale.js';
import { say } from './copy/workbench/connmanager.js';
import { portalRoot } from '@mistriwork/kit/client/shellHost.js';

/* Managing connections is the Workbench's; each screen loads when first opened. */
const ConnectionManager = onDemand(() => import('./components/ConnectionManager.js'), 'ConnectionManager');
const ConnectionDialog = onDemand(() => import('./components/ConnectionDialog.js'), 'ConnectionDialog', { quiet: true });

let panel = null;
/** Where the connections were last written, so the next save offers the same file. */
let configFile = null;
let formHost = null;
const pending = new Set();
const SAVE_FILE = Symbol('save-file');

function workspaceOwner() {
  const connection = state.activeConnection;
  const generation = connectionGeneration();
  return () => canManageConnections() && connection === state.activeConnection && generation === connectionGeneration();
}

export function connectionsOpen() {
  return Boolean(panel);
}

/** The screen is `components/ConnectionManager.tsx`; this is its one host on the body. */
export async function openConnections() {
  /* The screen arrives with its frame: an `aria-modal` panel with nothing in
     it yet has no focus trap, and the first Tab would walk out of it. */
  await ConnectionManager.ready();
  if (!canManageConnections() || panel) return;
  panel = el('div', { class: 'conn-manager', role: 'dialog', 'aria-modal': 'true', 'aria-label': say('common.connections') });
  portalRoot().append(panel);
  mount(
    panel,
    createElement(ConnectionManager, {
      onClose: close,
      onOpen: (conn) => void selectConnection(conn.id),
      onAdd: (refresh) => addDialog(undefined, refresh),
      onEdit: (conn, refresh) => editDialog(conn, refresh),
      onRemove: (conn, refresh) => void removeConnection(conn, refresh),
      onSaveFile: (count) => void saveDialog(count),
      onIntrospect: (conn) => reintrospect(conn.id),
    }),
  );
}

function close() {
  if (!panel) return;
  unmount(panel);
  panel.remove();
  panel = null;
}

/** Discard standalone management surfaces when navigation enters an app. */
export function closeConnectionManagement() {
  close();
  if (formHost) {
    unmount(formHost);
    formHost.remove();
    formHost = null;
  }
}

/** The Add/Edit form, `components/ConnectionDialog.tsx`, on a host of its own. */
function connectionDialog(props) {
  if (!canManageConnections() || formHost?.isConnected) return;
  const host = document.createElement('div');
  formHost = host;
  host.className = 'host-contents';
  portalRoot().append(host);
  mount(
    host,
    createElement(ConnectionDialog, {
      ...props,
      onClose: () => {
        unmount(host);
        host.remove();
        if (formHost === host) formHost = null;
      },
    }),
  );
}

async function removeConnection(conn, refresh) {
  if (!canManageConnections() || pending.has(conn.id)) return;
  pending.add(conn.id);
  const current = workspaceOwner();
  try {
    const typed = await promptFor({
      title: say('removeName', { name: conn.name }),
      label: say('typeTheNameToConfirm'),
      hint: conn.source === 'config' ? say('thisConnectionCameFromTheConfig') : say('removingItHereAffects'),
      placeholder: conn.name,
    });
    if (typed?.trim() !== conn.name) {
      if (typed !== null && typed !== undefined) toast(say('namesDidNotMatch'), 'error');
      return;
    }
    if (!current()) return;
    const data = await api('/api/connections/remove', { id: conn.id });
    if (!Array.isArray(data.connections)) throw new Error(say('removalWasNotConfirmed'));
    toast(say('removed', { name: conn.name }), 'ok');
    /* Removing the last one leaves a page whose sidebar, query bar and grid
       all describe a database that is gone; the first-run screen is the
       honest state, and a reload is how it is reached. */
    if (current()) {
      if (!data.connections.length) {
        window.location.reload();
        return;
      }
      if (conn.id === state.activeConnection) {
        const replacement = data.connections.find((c) => c.id === data.active) ?? data.connections[0];
        await selectConnection(replacement.id);
      } else await refreshConnections();
    }
    await refresh();
  } catch (err) {
    toast(err.message, 'error');
    await refresh();
  } finally {
    pending.delete(conn.id);
  }
}

export function addConnection(onAdded) {
  if (!canManageConnections()) return;
  addDialog(onAdded);
}

function addDialog(onAdded, refresh) {
  const current = workspaceOwner();
  connectionDialog({
    title: say('addAConnection'),
    verb: say('addAndOpen'),
    run: async ({ url, name, schemas }) => {
      if (!current()) return { error: say('theWorkspaceChangedClose') };
      if (!url) return { error: say('aConnectionStringOrFile') };
      try {
        const data = await api('/api/connections', { url, name, schemas });
        if (typeof data.added !== 'string') return { error: say('additionWasNotConfirmed') };
        toast(say('added', { name: name || 'connection' }), 'ok');
        if (!current()) return null;
        if (onAdded) {
          /* The first-run screen has its own idea of what happens next — a
             reload, because a browser with no schema cannot switch to one. */
          onAdded(data);
          return null;
        }
        /* "Add and open" said open: `add` on the server makes a connection
           active only when there is not one already. */
        if (data.added) {
          close();
          await selectConnection(data.added);
          return null;
        }
        await refresh?.();
        return null;
      } catch (err) {
        // Refreshed even on failure: the server may have kept the entry with
        // its error attached, and a list that does not show it would be lying.
        await refresh?.();
        return { error: err.message };
      }
    },
  });
}

function editDialog(conn, refresh) {
  const current = workspaceOwner();
  connectionDialog({
    title: say('editQuotedNameQuoted', { name: conn.name }),
    name: conn.name,
    /* The stored URL is not sent to the browser — only its redacted form — so
       the box starts empty and a blank URL means "keep it". */
    url: '',
    schemas: conn.schemas,
    verb: say('common.saveChanges'),
    run: async ({ url, name, schemas }) => {
      if (!current()) return { error: say('theWorkspaceChangedClose') };
      if (pending.has(conn.id)) return { error: say('aChangeToThisConnection') };
      const body = { id: conn.id };
      if (url) body.url = url;
      if (name && name !== conn.name) body.name = name;
      if (JSON.stringify(schemas) !== JSON.stringify(conn.schemas ?? [])) body.schemas = schemas;
      if (Object.keys(body).length === 1) return { error: say('nothingToChange') };
      pending.add(conn.id);
      try {
        const data = await api('/api/connections/update', body);
        if (!Array.isArray(data.connections)) return { error: say('updateWasNotConfirmed') };
        toast(say('updated', { name: name || conn.name }), 'ok');
        if (current()) {
          if (conn.id === state.activeConnection) await selectConnection(conn.id, { reload: true });
          else await refreshConnections();
        }
        await refresh();
        return null;
      } catch (err) {
        toast(err.message, 'error');
        await refresh();
        return { error: say('couldNotUpdateTheConnection') };
      } finally {
        pending.delete(conn.id);
      }
    },
  });
}

async function saveDialog(count) {
  if (!canManageConnections() || pending.has(SAVE_FILE)) return;
  const current = workspaceOwner();
  pending.add(SAVE_FILE);
  try {
    const path = await promptFor({
      title: say('writeConnectionsToAFile'),
      label: say('path'),
      value: configFile ?? 'tablewalk.json',
      hint: say('connectionsWillBeWritten', { count }),
      placeholder: 'tablewalk.json',
    });
    if (!path || !current()) return;
    const data = await api('/api/connections/save', { path });
    if (typeof data.path !== 'string' || typeof data.count !== 'number') throw new Error(say('fileSaveWasNotConfirmed'));
    configFile = data.path;
    /* Say where the passwords went. */
    const moved = data.secrets ?? [];
    const where = moved.every((m) => m.stored === 'keychain') ? say('theKeychain') : say('aCredentialsFileMode');
    const secrets = moved.length ? say('passwordsMovedToTheFile', { count: moved.length, where }) : '';
    toast(say('wroteConnections', { count: data.count, path: data.path, secrets }), 'ok');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    pending.delete(SAVE_FILE);
  }
}
