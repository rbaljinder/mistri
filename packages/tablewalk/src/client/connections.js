/**
 * The connection picker, and the switch, re-read and Manage it offers: the
 * Workbench's. Which connection a tab is on, and the list, are the kit's
 * (connectionList.js), since an App's tab asks the same runtime.
 *
 * The server holds the connection strings and this file never sees one — the
 * list it renders carries an id, a name, a dialect and a redacted detail. A
 * password cannot leak through a UI that was never given one.
 *
 * Connections added here are session-only. Writing them back to the config
 * file would mean a web page quietly editing a file on disk, which is a
 * surprise nobody asked for; the dialog says so rather than leaving you to
 * discover it after a restart.
 */
import { createElement } from 'react';
import { $, api, connectionChanged, render, state, toast } from '@mistriwork/kit/client/core.js';
import { mount, unmount } from '@mistriwork/kit/client/components/mount.js';
import { ConnectionPicker } from './components/ConnectionPicker.js';
import { syncWriteMode } from '@mistriwork/kit/client/write.js';
import { clearPeekCache } from '@mistriwork/kit/client/peek.js';
import { forgetPages } from '@mistriwork/kit/client/page.js';
import { loadSavedSql } from './sqlsaved.js';
import { beginConnectionTransition, connectionTransitionPending } from '@mistriwork/kit/client/connectionTransition.js';
import { canManageConnections } from '@mistriwork/kit/client/connectionScope.js';
import { refreshConnections, whenConnectionControls } from '@mistriwork/kit/client/connectionList.js';
import { say } from './copy/workbench/connections.js';
import { setTabTitle } from '@mistriwork/kit/client/shellHost.js';

/**
 * What the picker's "Manage" opens. A callback rather than an import:
 * connmanager.js refreshes and selects through this module, and an import back
 * made a cycle. The shell registers it (app.js).
 * @type {(() => unknown) | null}
 */
let manage = null;
/** @param {() => unknown} open */
export function whenManageConnections(open) {
  manage = open;
}

/**
 * Read the schema again, for the connection in hand.
 *
 * What changed is reported rather than swallowed: "nothing changed" is a real
 * answer to "did my migration land", and a button that always says "done"
 * cannot tell you it did nothing.
 */
export async function reintrospect(id = state.activeConnection) {
  if (!canManageConnections()) return;
  if (id !== state.activeConnection) {
    await api('/api/connections/refresh', { id });
    return;
  }
  const transition = beginConnectionTransition();
  const before = state.schema;
  try {
    const { schema } = await api('/api/connections/refresh', { id });
    if (!transition.isCurrent()) return;
    state.schema = schema;
    /* Rows cached against the old schema describe columns that may no longer
       exist. The connection is unchanged, so the peek cache's own key does
       not rule them out — this is the one case where it has to be emptied. */
    clearPeekCache();
    forgetPages();

    const was = new Set((before?.tables ?? []).map((t) => t.id));
    const now = new Set(schema.tables.map((t) => t.id));
    const added = [...now].filter((id) => !was.has(id));
    const gone = [...was].filter((id) => !now.has(id));
    const columnsBefore = (before?.tables ?? []).reduce((n, t) => n + t.columns.length, 0);
    const columnsNow = schema.tables.reduce((n, t) => n + t.columns.length, 0);

    const changes = [
      added.length ? say('tablesAdded', { tables: say('common.tables', { count: added.length }) }) : null,
      gone.length ? say('gonecountRemoved', { goneCount: gone.length }) : null,
      columnsNow !== columnsBefore
        ? say(columnsNow > columnsBefore ? 'columnsAdded' : 'columnsRemoved', { count: Math.abs(columnsNow - columnsBefore) })
        : null,
    ].filter(Boolean);

    await state.onSwitched?.(transition.isCurrent);
    if (!transition.isCurrent()) return;
    connectionChanged();
    render();
    toast(
      changes.length ? say('schemaReRead', { changes: changes.join(', ') }) : say('schemaReReadNothing', { count: schema.tables.length }),
      'ok',
    );
  } catch (err) {
    if (transition.isCurrent()) toast(err.message, 'error');
  } finally {
    transition.finish();
  }
}

/* The picker draws the connection controls from the moment the Workbench's
   shell loads this module (connectionList.js). */
whenConnectionControls({
  draw(picker) {
    const connections = state.connections ?? [];
    // A lone connection with no config file is not worth a picker.
    picker.hidden = connections.length < 2 && !connections.some((c) => c.source === 'config');
    /* The picker and the plain `name · dialect` label answer the same question,
       so exactly one of them is on screen. With a single unconfigured database
       there is nothing to pick between and the label is the honest form — and
       it still opens Connections, which is how a second one gets added. */
    $('db-label').hidden = !picker.hidden;
    if (picker.hidden) {
      unmount(picker);
      return;
    }

    mount(
      picker,
      createElement(ConnectionPicker, {
        connections,
        active: state.activeConnection,
        onSelect: (id) => void selectConnection(id),
        onReintrospect: reintrospect,
        onManage: () => void manage?.(),
      }),
    );
  },
  retire: unmount,
});

export async function selectConnection(id, { reload = false } = {}) {
  if (!canManageConnections()) return;
  if (!reload && id === state.activeConnection && !connectionTransitionPending()) return;
  const transition = beginConnectionTransition();
  try {
    const { schema } = await api('/api/connections/select', { id });
    if (!transition.isCurrent()) return;
    state.schema = schema;
    state.activeConnection = id;
    /* Switching database invalidates the trail entirely: a crumb naming a
       table in the old one would look like a step you could walk back to. */
    state.stack = [];
    state.page = 0;
    $('query').value = '';
    $('db-label').textContent = `${schema.label} · ${schema.dialect}`;
    setTabTitle(say('common.documentTitle', { title: schema.label }));
    await refreshConnections();
    if (!transition.isCurrent()) return;
    // The new connection has its own write setting, and must not inherit the
    // previous one in either direction.
    syncWriteMode();
    /* The new connection's committed statements, which the old ones are not.
       Without this the saved bar kept whatever the last connection had until
       the page was reloaded. */
    await loadSavedSql();
    if (!transition.isCurrent()) return;
    await state.onSwitched?.(transition.isCurrent);
    if (!transition.isCurrent()) return;
    /* Everything that lives outside the rendered view and is keyed to a
       database — the SQL editor is the one today — rebuilds here, after the
       schema and the per-connection loads have landed. */
    connectionChanged();
    render();
  } catch (err) {
    if (!transition.isCurrent()) return;
    toast(err.message, 'error');
    // Refresh choices without adopting a server default that another tab may have changed.
    await refreshConnections();
    if (!transition.isCurrent()) return;
    // A superseded switch may already have published its schema but not its app data.
    await state.onSwitched?.(transition.isCurrent);
    if (!transition.isCurrent()) return;
    connectionChanged();
    render();
  } finally {
    transition.finish();
  }
}
