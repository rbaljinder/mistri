/**
 * The client's core as a story sees it: the real module, with `api` answered
 * by the fixtures a story registers instead of by a server. Every import of
 * packages/kit/src/client/core.js reaches this file (.storybook/main.ts says how), and
 * only this file reaches the real one.
 */
import { renderCrumbs, state, toast } from '../../packages/kit/src/client/core.js';
import { installShell } from '../../packages/kit/src/client/shellMode.js';

export * from '../../packages/kit/src/client/core.js';

/* The shell's answers every page has (app.js names them at boot): the record
   pages a table reads through, the Workbench's Undo and the record's verbs.
   Fetched after this module, since those modules import the core this file
   stands in for. */
void Promise.all([
  import('../../packages/kit/src/client/page.js'),
  import('../../packages/tablewalk/src/client/undo.js'),
  import('../../packages/mistri/src/client/components/Actions.js'),
]).then(([page, undo, actions]) =>
  installShell({
    resolvePage: page.recordPageId,
    undo: { refresh: undo.refreshUndo, last: undo.undoLast, toast: undo.undoToast },
    slots: { ActionBar: actions.ActionBar, useReachable: actions.useReachable },
  }),
);

const answers = new Map();

/**
 * A story's database: its tables and links on one writable demo connection,
 * and what each API path answers — `fn(body, path)` returns what the server
 * would. Called from a story's `beforeEach`, so every story starts clean.
 * @param {{ tables: import('../../packages/engine/src/shared/schema.js').TableMeta[], foreignKeys?: import('../../packages/engine/src/shared/schema.js').ForeignKey[], answer?: Record<string, Function>, writable?: boolean }} options
 */
export function fixture({ tables, foreignKeys = [], answer = {}, writable = true }) {
  answers.clear();
  for (const [path, fn] of Object.entries(answer)) answers.set(path, fn);
  Object.assign(state, {
    stack: [],
    activeConnection: 'demo',
    connections: [{ id: 'demo', name: 'Demo', writable }],
    schema: { dialect: 'sqlite', label: 'Demo', tables, foreignKeys },
  });
}

/** Navigation stays in the story while the real menu observes the new room. */
export function go(entry, mode = 'push') {
  if (mode === 'reset') state.stack = [entry];
  else if (mode === 'replace' && state.stack.length) state.stack[state.stack.length - 1] = entry;
  else state.stack.push(entry);
  renderCrumbs();
}

/** Load a served App through the same caption/display sources as the browser. */
export async function applicationFixture({ app, ...options }) {
  fixture({ ...options, answer: { ...options.answer, '/api/app': () => ({ app }) } });
  const { appShell, loadAppNav } = await import('../../packages/mistri/src/client/appNavigation.js');
  /* The App's answers, as the shell installs them at boot (app.js). */
  installShell(appShell);
  await loadAppNav();
  /* The shell's own switch (app.js): with an App, the palette and the menus
     offer its rooms and settings, not the database's raw tables. */
  const { setMenuMode } = await import('../../packages/kit/src/client/menu.js');
  setMenuMode(app ? 'app' : 'workbench');
}

export async function api(path, body) {
  const fn = answers.get(String(path).split('?')[0]);
  // A server's pause, so a story shows the component's loading state too.
  await new Promise((resolve) => setTimeout(resolve, 150));
  return fn ? fn(body ?? {}, path) : {};
}

/* A story has no walk to open a record into; it says what would open. */
export async function openRecord(table, _key, label) {
  toast(`Opens ${label || table}`);
}
