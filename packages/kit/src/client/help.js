/**
 * The query language, written down inside the tool that speaks it.
 *
 * Clicking here writes query text rather than hiding state, which is the best
 * thing about this interface and also its one cliff: the first screen is an
 * empty bar with a placeholder, and nothing on it says what the bar takes.
 * Every other way of learning it — the README, the error messages, the SQL
 * pane — is either somewhere else or only reachable after you have already
 * guessed something that parses.
 *
 * Two answers, and they share a generator:
 *
 *   - a reference panel (`?`, or the overflow menu), grammar on the left and
 *     working examples on the right;
 *   - three runnable examples on the empty state, so the landing page teaches
 *     the language instead of only drawing the schema.
 *
 * Both are built from the *connected* schema. A reference full of `customer`
 * and `invoice` is a reference about somebody else's database: on a schema
 * with sixty-six tables and none of those names it teaches the syntax and
 * nothing about the thing in front of you, and every example in it is a link
 * that errors when clicked. Examples that name real tables can be clicked, and
 * clicking one is the fastest way to learn a language.
 *
 * What is documented here is what `packages/engine/src/shared/query.ts` accepts, checked by
 * running every example against a real database rather than by reading the
 * README. One thing the grammar looks like it should take is deliberately
 * absent: `not contains`, which the compiler rejects in as many words.
 *
 * The panel and what it says are loaded the first time it opens
 * (helpContent.js); this is its host, the `?` key and the menu entries.
 */
import { createElement } from 'react';
import { addMenuItem, menuMode } from './menu.js';
import { mount, unmount } from './components/mount.js';
import { onDemand } from './components/onDemand.js';
import { say } from './copy/workbench/help.js';
import { addHostListener, portalRoot } from './shellHost.js';

/* Loaded the first time the panel opens. */
const HelpPanel = onDemand(() => import('./components/HelpPanel.js'), 'HelpPanel');

let host = null;
let restoreFocus = null;

function closeHelp() {
  if (!host) return;
  unmount(host);
  host.remove();
  host = null;
  restoreFocus?.focus?.();
  restoreFocus = null;
}

/**
 * The panel is `components/HelpPanel.tsx`; this is its one host on the body, and the focus it hands back.
 * @param {{ keys?: boolean }} [options] `keys`: the keys-only panel an App's reader gets, without the query language.
 */
export function openHelp(options = {}) {
  if (host) {
    closeHelp();
    return;
  }
  restoreFocus = document.activeElement;
  host = document.createElement('div');
  host.className = 'help-host';
  portalRoot().append(host);
  mount(host, createElement(HelpPanel, { onClose: closeHelp, keysOnly: options.keys === true }));
}

/**
 * Register the panel, and bind `?` to it.
 *
 * One registration covers the overflow menu and ⌘K both, which is the whole
 * point of the registry in menu.js.
 *
 * `?` is a printable character, so unlike ⌘K it has to stand aside for text:
 * typing a question mark into the query bar must produce a question mark and
 * not a dialog over the field you are typing in. The same test app.js uses for
 * `/` and `t`, plus contenteditable, which no field here uses today and one
 * might tomorrow.
 */
export function initHelp() {
  addMenuItem({
    label: say('queryLanguageMore'),
    scope: 'workbench',
    detail: say('theGrammarWithExamples'),
    onSelect: openHelp,
  });

  /* Keep the full shortcut catalog with the database tools. App readers
     can still open contextual keyboard help directly with `?`. */
  addMenuItem({
    label: say('keyboardShortcuts'),
    scope: 'workbench',
    detail: say('theKeysThisPageTakes'),
    onSelect: () => openHelp({ keys: true }),
  });

  addHostListener(document, 'keydown', (e) => {
    if (e.key !== '?' || e.metaKey || e.ctrlKey || e.altKey) return;
    const target = document.activeElement;
    if (/input|textarea|select/i.test(target?.tagName ?? '') || (target instanceof HTMLElement && target.isContentEditable)) return;
    e.preventDefault();
    openHelp(menuMode() === 'workbench' ? {} : { keys: true });
  });
}
