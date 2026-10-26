/**
 * The screen for someone who has nothing connected yet.
 *
 * Until now `tablewalk` with no database printed its usage and exited(1). The
 * flags were all correct and it answered the wrong question: somebody who has
 * just installed a thing called tablewalk to find out what it is gets a wall
 * of options and no program. Worse, the tool already owned the answer — a
 * dialog that takes a connection string or its parts, tests it before keeping
 * it, and resolves the password from the environment or the keychain — and it
 * was one successful startup out of reach.
 *
 * So the server starts with nothing and this asks. Three things it is careful
 * about:
 *
 *   - It does not pretend to be the app. The query bar, the table list and
 *     the write toggle are all controls over a database, and leaving them on
 *     screen greyed or live-but-broken is an interface saying "try me" about
 *     things that cannot work yet. They are hidden until there is something
 *     for them to act on.
 *
 *   - It says what the tool is before asking for credentials. "Paste your
 *     production connection string" is a large request from a program that
 *     has not yet said what it does with it, so the read-only default and the
 *     fact that nothing is written to disk are on the screen making the ask,
 *     not in a README.
 *
 *   - It reloads rather than booting a second way. Once a connection exists,
 *     the ordinary start path is the one that has every other feature wired
 *     into it; assembling half of it again here is how the two would drift.
 *     A reload of a local page is imperceptible and cannot disagree with
 *     itself.
 */
import { createElement } from 'react';
import { $, api, el } from '@mistriwork/kit/client/core.js';
import { element } from '@mistriwork/kit/client/components/mount.js';
import { Welcome } from './components/Welcome.js';
import { setAppConfigured } from '@mistriwork/kit/client/connectionScope.js';
import { say } from './copy/workbench/welcome.js';
import { setTabTitle, shellBody } from '@mistriwork/kit/client/shellHost.js';

/**
 * What the server has, for the screen that runs when none of it opened.
 *
 * Returns the list, not a yes/no. "Is there anything?" was the wrong
 * question: a first connection that fails to open is listed and does not
 * open, so the answer was yes and the welcome screen was skipped — leaving
 * "Could not read the schema: No connection is open." on screen with nothing
 * to click. The right question is what is there, so the screen can say.
 */
export async function listConnections() {
  try {
    const runtime = await api('/api/runtime');
    if (typeof runtime?.appConfigured !== 'boolean') throw new Error(say('common.runtimeMetadataIsUnavailable'));
    setAppConfigured(runtime.appConfigured);
    if (runtime.appConfigured) return [];
    const data = await api('/api/connections');
    return data.connections ?? [];
  } catch {
    setAppConfigured(null);
    return [];
  }
}

/**
 * Draw it — `components/Welcome.tsx`.
 *
 * Nothing is initialised beyond this point on purpose — no palette, no
 * shortcuts, no undo. Every one of them reads `state.schema`, and there
 * isn't one. An App server never draws it: what it says when the App cannot
 * be shown is the App framework's (appUnavailable.js).
 *
 * @param {Array<{ name: string, error?: string }>} [listed]
 */
export function showWelcome(listed = []) {
  shellBody().classList.add('first-run');
  setTabTitle('tablewalk');
  $('db-label').textContent = say('noDatabase');
  $('content').replaceChildren(element('div', createElement(Welcome, { listed }), 'host-contents'));
}
