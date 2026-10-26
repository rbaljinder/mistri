/**
 * The client's first module: the page's look, who is here, and which part
 * of the client this page needs.
 *
 * It was the whole boot once, and so every page — a public form, a sign-in
 * screen — downloaded the Workbench, the App shell and a tenant's flows
 * before it could draw a field. Now boot is in parts, each a chunk of its own
 * (vite.config.ts, `surfaces`):
 *
 *   this module     the look before the first paint, and the App
 *                   framework's main (appShell.js, who-am-I and what an App
 *                   does before its shell), which shellStart.js names;
 *   publicSurface   a public form, the landing, the sign-in screen;
 *   shell           the kit's shell (app.js), with the App framework's chrome
 *                   (appnav.js);
 *   workbench       the database browser's main and its tools
 *                   (workbenchShell.js, workbench.js), which its page preloads
 *                   beside the shell;
 *   tenantShell     a tenant's flows, loaded by the App's chrome where used.
 *
 * A first page is this chunk and one surface, never a chain: the server
 * names the surface a path will need in the page it sends
 * (server/clientSurface.ts), so both download together. Where it guesses
 * wrong, the import below fetches the right one — a moment slower, never
 * wrong.
 */
import { startShell } from './shellStart.js';
import { failStartup, finishStartup } from './startup.js';
import { startupSettled } from './startupHold.js';
import { lookSheetReady } from './visualTheme.js';

/* The worn look's own sheet, where it has one, is on the page before the
   page is, and so is the room, complete (startupHold.ts). */
void startShell()
  .then(lookSheetReady)
  .then(() => startupSettled())
  .then(finishStartup)
  .catch(failStartup);
