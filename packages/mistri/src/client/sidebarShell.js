/**
 * The bar in the sidebar (`ui.shell.header: 'sidebar'`, a side-placed App's default): no band across the window; the
 * sidebar runs the window's full height, its head the bar's mark, New and search, its foot the bell and the account
 * above the workspace and Collapse. Each room's own head row is then the content's first line.
 *
 * The bar's parts are moved, not drawn twice: every control in it is mounted once (the account, the New menu, the
 * issues badge, the assistant's door) and is found by its host wherever that host stands, so the same elements
 * dock in the sidebar and go back to the bar when the shell crosses to a phone's drawer or the top placement. The
 * header keeps its `.topbar` class in the sidebar, so a theme's bar recipe (`recipes.bar`: ruled, dark) dresses the
 * sidebar's head as it dressed the bar.
 */
import { shellById, shellQuery } from '@mistriwork/kit/client/shellHost.js';

/**
 * Whether a side-placed App's shell stands the bar in its sidebar: yes unless the author says `header: 'bar'`, or
 * says `rail: false` and leaves the header unsaid — folded whole, the sidebar would take the mark, the search and the
 * account with it, so that App keeps the bar (an explicit `'sidebar'` beside `rail: false` is refused, appUi.ts).
 * The placement, the phone and the signed-out visitor are the caller's (appChrome.js).
 * @param {{ header?: 'bar' | 'sidebar', rail?: boolean } | undefined} shell
 */
export function headerInSidebar(shell) {
  if (shell?.header !== undefined) return shell.header === 'sidebar';
  return shell?.rail !== false;
}

/** The foot row the account and the bar's other keys dock in, made once, above the workspace's identity. */
function footRow(sidebar) {
  let foot = shellById('sidebar-account');
  if (!foot) {
    foot = document.createElement('div');
    foot.id = 'sidebar-account';
    foot.className = 'sidebar-account';
  }
  const identity = sidebar.querySelector(':scope > #sidebar-app-footer');
  if (foot.parentElement !== sidebar || (identity && foot.nextElementSibling !== identity)) {
    if (identity) identity.before(foot);
    else sidebar.append(foot);
  }
  return foot;
}

/**
 * Dock the bar's parts in the sidebar (`on`) or put them back in the bar. Idempotent: the shell calls it on every
 * menu draw and after every brand pass, since the New menu's host is made beside the bar's other keys.
 * @param {boolean} on
 */
export function dockBar(on) {
  const header = shellQuery('header.topbar');
  const sidebar = shellQuery('.layout > .sidebar');
  const actions = shellQuery('.topbar-actions');
  const search = shellById('search-button');
  if (!(header instanceof HTMLElement) || !(sidebar instanceof HTMLElement) || !(actions instanceof HTMLElement)) return;
  const newHost = shellById('new-menu-host');
  if (on) {
    if (header.parentElement !== sidebar) sidebar.prepend(header);
    /* The head's two rows: the mark and New, then the search under them (structure.css lays them out). */
    if (search && search.parentElement !== header) header.append(search);
    /* New before the search, as the head reads: the mark's row, then the search's. */
    if (newHost && newHost.nextElementSibling !== search) (search ?? header.lastElementChild)?.before(newHost);
    const foot = footRow(sidebar);
    if (actions.parentElement !== foot) foot.append(actions);
    return;
  }
  if (header.parentElement === sidebar) {
    /* Where the page's markup puts it: after the skip link, before the SQL pane (index.html). */
    const after = shellById('explain-pane');
    if (after?.parentElement) after.before(header);
    else sidebar.closest('.layout')?.before(header);
  }
  if (actions.parentElement !== header) header.append(actions);
  if (search && search.parentElement !== actions) actions.prepend(search);
  /* Where appChrome.js makes it: before the assistant's door, else before the ··· menu's host. */
  if (newHost && newHost.parentElement !== actions) (shellById('assistant-host') ?? shellById('more-host'))?.before(newHost);
  shellById('sidebar-account')?.remove();
}
