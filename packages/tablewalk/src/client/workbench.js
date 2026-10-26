/**
 * The database browser's shell over the kit's (shells.ts `ShellTools`):
 * the query bar and its completer, the SQL pane, the connections and their
 * manager, Undo, the page builder's surface, the database's own commands and
 * the first-run screen for a server with nothing open.
 *
 * Handed to the kit's boot (app.js) by the database browser's main
 * (workbenchShell.js), and in the chunk the Workbench's page preloads beside
 * it. An App's page never names it: an App's reader never downloads it.
 */
import { initComplete } from './complete.js';
import { closeConnectionManagement, openConnections } from './connmanager.js';
import { selectConnection, whenManageConnections } from './connections.js';
import { initSql, openSql } from './sql.js';
import { initUndo, refreshUndo, undoDescription, undoLast, undoToast } from './undo.js';
import { loadSavedPages } from '@mistriwork/kit/client/savedPages.js';
import { openBuilder } from './pagebuilder.js';
import { loadSavedSql, savedStatements } from './sqlsaved.js';
import { registerSurface } from '@mistriwork/kit/client/surfaces.js';
import { onDemand } from '@mistriwork/kit/client/components/onDemand.js';
import { addMenuItem, menuMode, setMenuGroup } from '@mistriwork/kit/client/menu.js';
import { addPaletteSource } from '@mistriwork/kit/client/palette.js';
import { installShell, shell } from '@mistriwork/kit/client/shellMode.js';
import { toggleWriteMode } from '@mistriwork/kit/client/write.js';
import {
  $,
  breakdownView,
  currentEntry,
  explainVisible,
  findTable,
  go,
  setExplaining,
  state,
  tableView,
} from '@mistriwork/kit/client/core.js';
import { looksLikeBreakdown } from '@mistriwork/engine/shared/breakdowntext.js';
import { canManageConnections, canUseDatabaseTools } from '@mistriwork/kit/client/connectionScope.js';
import { sessionIdentity } from '@mistriwork/kit/client/sessionIdentity.js';
import { addHostListener, shellBody, shellQuery } from '@mistriwork/kit/client/shellHost.js';
import { say } from './copy/workbench/workbench.js';
import { openAgentConsole } from './agent.js';
import { openAsk } from './ask.js';
import { openFindValue } from './findvalue.js';
import { openShapeCheck } from './shapecheck.js';
import { listConnections, showWelcome } from './welcome.js';

/** @type {import('@mistriwork/kit/client/shells.js').KitShell | null} */
let kit = null;

/**
 * Run a line of the query language, from wherever it was written.
 *
 * The header's form and the ⌘/ modal both land here. Which endpoint answers
 * a line is a decision with one home: a second copy in the modal would be
 * the one that forgets about `by` the next time the language grows.
 */
const runQueryText = (raw) => {
  const text = String(raw ?? '').trim();
  if (!text) return;
  const tableName = text.split(/\s+/)[0];
  const table = findTable(tableName) ?? state.schema.tables.find((t) => t.name === tableName);
  /* `by` is the one keyword that changes which endpoint answers, so the
     decision is made here rather than by letting the query parser fail on a
     line it was never going to understand. That failure was the whole bug:
     `invoice count, sum total as billed by status` came back as
     `"billed" is not a column on invoice` — an error about a column nobody
     claimed was one, with nothing to say that the thing being asked for
     exists and has its own answer. */
  const entry = looksLikeBreakdown(text)
    ? breakdownView(table ? table.id : tableName, text)
    : tableView(table ? table.id : tableName, text);
  const top = currentEntry();
  /* Refining the query you are already looking at replaces that crumb;
     querying a different table is a fresh start, not a step in the walk. */
  const sameTable = top && top.kind === entry.kind && top.table === entry.table;
  go(entry, sameTable ? 'replace' : 'reset');
};

/** Once, before the Workbench's first paint: its answers, its surfaces, its palette places and its keys. */
function start(boot) {
  if (kit) return;
  kit = boot;
  /* The Workbench's journal, which each of its writes reports to (undo.js). */
  installShell({
    undo: { refresh: refreshUndo, last: undoLast, toast: undoToast },
    /* The page builder, which a saved page's Layout opens (PageRoom.tsx). */
    editPage: (page, options) => void openBuilder(/** @type {any} */ (page), options),
  });
  /* What a store opens (surfaces.js; connections.js's Manage): a store never
     imports the component or manager that imports it, so the loop between them
     is cut here, where both are known. */
  whenManageConnections(openConnections);
  registerSurface(
    'pageBuilder',
    onDemand(() => import('./components/PageBuilder.js'), 'PageBuilder'),
  );

  /* Saved SQL, alongside everything else. A statement someone committed to
     tablewalk.json is a place you go, in the same sense a table is. */
  addPaletteSource('places', () =>
    workbenchShown()
      ? savedStatements().map((statement) => ({
          kind: 'sql',
          label: statement.name,
          search: `${statement.name} ${statement.description ?? ''} ${statement.sql}`,
          detail: statement.source === 'config' ? say('fromTablewalkJson') : say('savedSql'),
          run: () => openSql(statement.sql),
        }))
      : [],
  );
  addPaletteSource('databases', () =>
    workbenchShown() && canManageConnections()
      ? (state.connections ?? [])
          .filter((connection) => connection.id !== state.activeConnection)
          .map((connection) => ({
            kind: 'database',
            label: connection.name,
            search: `${connection.name} ${connection.dialect}`,
            detail: connection.detail ?? connection.dialect,
            run: () => selectConnection(connection.id),
          }))
      : [],
  );

  /* The connection name is a link to the connections dialog. It is the only
     way in when there is a single unconfigured database — the picker that
     otherwise carries the gear is hidden in exactly that case. */
  $('db-label').addEventListener('click', () => void openConnections());

  $('querybar').addEventListener('submit', (e) => {
    e.preventDefault();
    runQueryText($('query').value);
  });

  /**
   * ⌘/ — the query bar with room to write in.
   *
   * Bound at the document with capture, the same way ⌘K is and for the same
   * reason: it has to work from wherever the hands are, including from inside
   * the header's bar. `/` still focuses that bar — it is documented and people
   * use it — so this adds a surface rather than moving one.
   */
  addHostListener(
    document,
    'keydown',
    (e) => {
      if (shell().inApp() || e.key !== '/' || !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      openAsk({ initial: $('query').value, onRun: runQueryText });
    },
    true,
  );

  /* SQL stays in the header rather than going into the menu with the rest.

     It is a state you leave on while you work — learning what the language
     compiles to, or checking a query you are unsure of — not an action you
     take once. A toggle you flip several times an hour does not belong two
     clicks deep, and unlike the others it has to *show* whether it is on. */
  const sqlToggle = $('sql-toggle');
  sqlToggle.addEventListener('click', () => {
    setExplaining(!explainVisible());
    sqlToggle.setAttribute('aria-pressed', String(explainVisible()));
  });

  addHostListener(document, 'keydown', (e) => {
    /* Only when the bar itself holds focus: unconditional, this one line
       undid the grid's own Escape (which had just focused the bar) and
       dumped keyboard users at the top of the document. */
    if (e.key === 'Escape' && document.activeElement === $('query')) $('query').blur();
    const active = document.activeElement;
    const typing = /input|textarea/i.test(active?.tagName ?? '') || active?.getAttribute?.('contenteditable') === 'true';
    /* Not while something is open over the page (app.js says why). */
    const covered = Boolean(active?.closest?.('[role="dialog"], dialog[open], .pb, .help-panel, .palette, .conn-manager'));
    if (covered) return;
    if (e.key === '/' && !typing && !shell().inApp()) {
      // In app mode the query bar is hidden; focusing it would type into
      // a control that is not on screen.
      e.preventDefault();
      $('query').focus();
    }
    // `t` for tables, next to `/` for the query bar.
    if (e.key === 't' && !typing && !e.metaKey && !e.ctrlKey && !shell().inApp()) {
      e.preventDefault();
      if (shellBody().classList.contains('sidebar-hidden')) {
        const reveal = shellQuery('.sidebar-reveal');
        if (reveal instanceof HTMLButtonElement) reveal.click();
      }
      $('table-filter').focus();
      $('table-filter').select();
    }
  });
}

/* The palette's Workbench places are offered where the Workbench's menu is. */
const workbenchShown = () => menuMode() === 'workbench';

let completing = false;
/** Each brand pass: the query bar's completer where the Workbench shows, and the Connections group. */
function brand() {
  /* The query bar's completer is the Workbench's; once. */
  if (!shell().inApp() && !completing) {
    completing = true;
    initComplete();
  }
  if (!canManageConnections()) closeConnectionManagement();
  setMenuGroup(
    say('common.connections'),
    canManageConnections()
      ? [
          {
            label: say('connectionsMore'),
            scope: 'workbench',
            detail: say('addEditSaveToAFile'),
            onSelect: () => void openConnections(),
          },
        ]
      : [],
  );
}

/** Its commands, each where the boot registers it, since the menu lists them in the order they arrive (menu.js). */
function menu(at) {
  if (at === 'editing')
    addMenuItem({
      label: say('editingEnabled'),
      category: say('common.records'),
      scope: 'workbench',
      checked: () => state.canWrite,
      detail: () => (state.canWrite ? say('changesRequireReviewAndApply') : 'existing records are read-only'),
      onSelect: () => void toggleWriteMode(),
    });
  if (at === 'sql') {
    initSql();
    initUndo();
    // The Workbench's menu names the last edit, so it asks at once.
    void refreshUndo();
  }
  if (at === 'schema')
    addMenuItem({
      label: say('common.schema'),
      scope: 'workbench',
      detail: say('everyTableInThisDatabase'),
      onSelect: () => kit?.goHome(),
    });
  if (at === 'undo')
    addMenuItem({
      /* Named rather than generic. "Undo" alone makes you remember what you did;
         the label says it, so the decision does not need a memory. */
      label: say('undoTheLastEdit'),
      scope: 'workbench',
      category: say('common.records'),
      available: () => !sessionIdentity().tenantRequired,
      // A function, so it describes the last edit rather than the state at boot.
      detail: () => undoDescription() ?? say('nothingToUndoHint'),
      onSelect: () => void undoLast(),
    });
  if (at === 'tools') {
    addMenuItem({
      /* The same surface the key opens. A shortcut nobody is told about is a
         feature for whoever wrote it. */
      label: say('writeAQuery'),
      scope: 'workbench',
      detail: say('theQueryBarWithRoom'),
      onSelect: () => openAsk({ initial: $('query').value, onRun: runQueryText }),
    });
    addMenuItem({
      /* The question you have when a string arrives from somewhere else and
         you cannot yet name the table it belongs to — which is the one search
         every other search here cannot start. */
      label: say('findAValue'),
      scope: 'workbench',
      detail: say('whichTableMentions'),
      /* Starting from the cell under the grid cursor when there is one: the
         question nearly always arrives *while* looking at a value, and
         retyping what is on screen is the tax this whole tool exists to
         remove. `title` before `textContent`, because a shortened cell keeps
         the whole value in its tooltip. */
      onSelect: () => {
        const cursor = shellQuery('.cell-cursor');
        const value = cursor?.getAttribute('title') ?? cursor?.textContent?.trim() ?? '';
        openFindValue(value);
      },
    });
    addMenuItem({
      /* The same question `lint` answers for an agent and `--lint` answers for
         CI, asked by the person who can actually fix the unindexed key. */
      label: say('checkTheShape'),
      scope: 'workbench',
      detail: say('whatThisSchemaWill'),
      onSelect: () => openShapeCheck(),
    });
    addMenuItem({
      label: say('common.agentConsole'),
      scope: 'workbench',
      available: canUseDatabaseTools,
      detail: say('driveTheMcpTools'),
      onSelect: () => openAgentConsole(),
    });
  }
}

/** @type {import('@mistriwork/kit/client/shells.js').ShellTools} */
export const workbenchShell = {
  start,
  brand,
  /* Layouts, saved pages and SQL are stored per connection. */
  loadStores: () => Promise.all([loadSavedPages(), loadSavedSql()]),
  menu,
  showWelcome,
  listConnections,
};
