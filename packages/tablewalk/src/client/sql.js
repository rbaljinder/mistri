/**
 * The SQL editor.
 *
 * tablewalk's argument against a SQL box is in `packages/engine/src/shared/query.ts`: a tool
 * that lets people type SQL "would have to either trust them or write a SQL
 * parser to untrust them". That is a good argument for why the *query language*
 * exists and a bad reason to have no SQL at all — every language has a last
 * mile, and for this one it is window functions, recursive CTEs and `EXPLAIN`.
 * Without a SQL box that last mile means leaving for `psql`, and once you have
 * left you do not come back for the walk.
 *
 * The dilemma is dissolved rather than answered: the statement is not trusted
 * *or* parsed, it is handed to a connection that cannot write. See `runSql` in
 * adapters/adapter.ts for what that costs and what it buys.
 *
 * Two ways in, on purpose. A statement typed from scratch is what people expect
 * from a database browser. The other is the ramp: run something in the query
 * language, open the SQL pane, and edit what it compiled to. That turns the
 * pane from a thing you read into a thing you start from, and it is the only
 * place in the tool that teaches the SQL behind the language.
 */
import { createElement } from 'react';
import { $, explainedSql, state, whenConnectionChanges } from '@mistriwork/kit/client/core.js';
import { canUseDatabaseTools } from '@mistriwork/kit/client/connectionScope.js';
import { addMenuItem, menuMode } from '@mistriwork/kit/client/menu.js';
import { mount, unmount } from '@mistriwork/kit/client/components/mount.js';
import { onDemand } from '@mistriwork/kit/client/components/onDemand.js';
import { say } from './copy/workbench/sql.js';
import { addHostListener, portalRoot } from '@mistriwork/kit/client/shellHost.js';

/* The Workbench's, loaded the first time it opens: an App's reader may never
   open it, and an App's first page should not wait for it. */
const SqlPane = onDemand(() => import('./components/SqlPane.js'), 'SqlPane');

/** The statement being edited, per connection, so switching back keeps it. */
const drafts = new Map();

const connectionKey = () => state.activeConnection ?? 'default';

let panel = null;

export function openSql(initial) {
  if (!canUseDatabaseTools()) return;
  if (panel) {
    if (initial !== undefined) {
      drafts.set(connectionKey(), initial);
      paint();
    }
    panel.querySelector('.sql-input')?.focus();
    return;
  }
  if (initial !== undefined) drafts.set(connectionKey(), initial);
  paint();
}

function close() {
  if (!panel) return;
  unmount(panel);
  panel.remove();
  panel = null;
}

/**
 * The pane is `components/SqlPane.tsx`, mounted fresh: it is built entirely from
 * state — which connection it names, which dialect, whether "Run as
 * write…" is offered, and which draft is in the box — so following a switch
 * or a new starting statement is a rebuild, not a patch.
 */
function paint() {
  const existing = panel;
  panel = document.createElement('div');
  panel.className = 'sql-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'SQL');
  portalRoot().append(panel);
  if (existing) {
    unmount(existing);
    existing.remove();
  }
  mount(
    panel,
    createElement(SqlPane, {
      draft: drafts.get(connectionKey()) ?? '',
      onDraft: (text) => drafts.set(connectionKey(), text),
      onClose: close,
    }),
  );
}

export function initSql() {
  /* The ramp.
  
     The SQL pane has always shown what the query language compiled to, and it
     has always been a `<pre>` — something to read. Making it a starting point
     costs one button and changes what the pane is for: you can now build a
     query the easy way, see the statement, and take it over at the point the
     language runs out. That is the shortest path from knowing the language to
     knowing the database, and nothing else in the tool offers it. */
  $('explain-edit')?.addEventListener('click', () => openSql(explainedSql()));

  /* An open editor follows the database it is switched to.
  
     The panel is built entirely from state — which connection it names, which
     dialect, whether "Run as write…" is offered, and which draft is in the
     box — and it was built once. Left open across a switch it kept the head
     it started with: it went on naming the previous database while the
     statement it ran went to the new one, and it kept offering a write on a
     connection the server would refuse. `paint()` already replaces an
     existing panel, so following the switch is one call. */
  whenConnectionChanges(() => {
    if (panel) paint();
  });

  addMenuItem({
    label: say('sql'),
    scope: 'workbench',
    available: canUseDatabaseTools,
    detail: say('writeAStatement'),
    onSelect: () => openSql(),
  });

  addHostListener(
    document,
    'keydown',
    (e) => {
      if (menuMode() !== 'workbench' || e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || !e.shiftKey) return;
      e.preventDefault();
      openSql();
    },
    true,
  );
}
