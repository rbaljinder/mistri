/**
 * The database browser's main in the browser: everything the Workbench's page
 * does after the look (shellStart.js) — who is here, then the kit's shell
 * with the Workbench's chrome below and its tools (workbench.js).
 *
 * Loaded by the entry with import() where the database browser sent the page
 * (the `mistri-shell` meta, server/clientSurface.ts), and placed in the
 * Workbench's chunk with its tools (vite.config.ts, `surfaces`): that page
 * preloads the chunk beside the entry and the shell's, so the main is never a
 * round trip of its own, and an App's page never fetches it.
 *
 * The Workbench draws no App: no sign-in, no public pages, no tenant, no
 * App's look. Its chrome is what the kit's shell asks of a product
 * (shells.ts `ShellChrome`), answered the way the Workbench always was.
 */
import { $, api } from '@mistriwork/kit/client/core.js';
import { connectionFromHash } from '@mistriwork/kit/client/deeplink.js';
import { establishSessionIdentity } from '@mistriwork/kit/client/sessionIdentity.js';
import { herePath, keepPlacement } from '@mistriwork/kit/client/addressMount.js';
import { setPublicPlacement } from '@mistriwork/kit/client/requestIdentity.js';
import { setMessageScope } from '@mistriwork/kit/client/messages.js';
import { initHelp } from '@mistriwork/kit/client/help.js';
import { openPeek } from '@mistriwork/kit/client/peekpanel.js';
import { wearWorkbenchLook } from './workbenchLook.js';
import { workbenchShell } from './workbench.js';
import { say } from '@mistriwork/kit/client/copy/shell/startup.js';

/** @type {import('@mistriwork/kit/client/shells.js').ShellChrome} */
const workbenchChrome = {
  answers: {
    /* Space on a row glances at its record (peekpanel.js), drawn over the list. */
    peekRecord: (tableId, key, label, records, list) =>
      openPeek(tableId, key, label, 'drawer', /** @type {any} */ (records), /** @type {any} */ (list)),
  },
  /* No App to load: the chrome's words are the Workbench's own, in the reader's pick (messages.ts). */
  loadNav: () => setMessageScope(),
  /* Asked again in the reader's words: the page is drawn again in them, as it always was. */
  reloadNav: async () => {
    await setMessageScope();
    return true;
  },
  brand() {},
  dress: wearWorkbenchLook,
  /* The side list, always: the top bar and the phone drawer are an App's. */
  menu() {
    $('topnav').hidden = true;
    return true;
  },
  initHelp,
  /* The server could not say what it serves (the kit's shell asks the welcome where it could): the page could not
     start, and says so as any page does that cannot (startup.ts). */
  unavailable: (_unknown, reason) => {
    throw new Error(reason ?? say('unexpectedStartupError'));
  },
};

/** The rest of the Workbench's page, past the look (shells.ts `ShellMain`). */
export async function start() {
  const path = herePath();
  const requested = connectionFromHash(path);
  /* Asked as the server asked it for the page (firstPaint.ts), so the answer the page carries is the one taken. */
  const me = await api(requested ? `/api/whoami?${new URLSearchParams({ app: requested })}` : '/api/whoami');
  establishSessionIdentity(me);
  setPublicPlacement(keepPlacement(false));
  /* The kit's shell, a chunk the page preloads beside this one. */
  const { boot } = await import('@mistriwork/kit/client/app.js');
  await boot(me, null, { chrome: workbenchChrome, tools: workbenchShell });
}
