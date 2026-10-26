/**
 * What the App is, as the client knows it: the loaded manifest and the modes
 * read from it. A leaf. `appnav.js` fetches and registers the App's words and
 * openers (and so reaches the Page tree through the peek drawer); the App
 * framework's modules that only ask "is there an App, and which" import this
 * instead, so the answer does not drag navigation in behind it. The kit asks
 * the shell (shellMode.ts `app()`, `inApp()`), which the App shell answers
 * from here: a kit module never reads the App framework's state itself.
 */
import { state } from '@mistriwork/kit/client/core.js';
import { sessionIdentity } from '@mistriwork/kit/client/sessionIdentity.js';

/** @type {{ owner: string, identity: ReturnType<typeof sessionIdentity>, app: import('../shared/appPayload.js').AppPayloadApp | null, loadError?: string, loadProblem?: import('../shared/appPayload.js').AppLoadProblem, live?: boolean } | null} */
let cache = null;

/** The loader's answer for this connection, or null to forget it.
 * @param {typeof cache} next */
export function setAppCache(next) {
  cache = next;
}

/**
 * The app curating this connection's UI, or null for the ordinary browser.
 * @returns {import('../shared/appPayload.js').AppPayloadApp | null}
 */
export function activeApp() {
  if (!cache || !cache.app || cache.identity !== sessionIdentity()) return null;
  /* Stale answers are no answers: a switch that has not re-fetched yet must
     not dress the new connection in the old connection's app. */
  if (state.activeConnection && cache.owner && cache.owner !== state.activeConnection) {
    return null;
  }
  return cache.app;
}

/** In the app's curated mode: any App is active. An App serves only what it
 * declares and never the Workbench, so an account its grants give no view —
 * an administrator of an App that declares no `admin` role — sees the App
 * with nothing in it, not the Workbench's tables, Run and Schema. */
export function inAppMode() {
  return Boolean(activeApp());
}

/**
 * Why the app directory on disk no longer loads, while the app served is
 * the last good save — the hot-reload story, told where the author is
 * looking. Empty when disk and server agree.
 */
export function appLoadError() {
  return (activeApp() && cache?.loadError) || '';
}

/** The same, placed in the App's files for the overlay (appLive.ts); undefined when there is none, or no place yet. */
export function appLoadProblem() {
  return (activeApp() && cache?.loadError && cache.loadProblem) || undefined;
}

/** Whether the server follows this App's source, and so tells the page of each save (appLive.ts). */
export function appFollowsSaves() {
  return Boolean(activeApp() && cache?.live);
}

/** Active-App policy also covers cold record/page links with no selected list.
 * This preference grants no permission to edit or submit a record.
 * @returns {'explicit'|'blur'}
 */
export function appSaveMode() {
  return inAppMode() && activeApp()?.ui.editing?.save === 'blur' ? 'blur' : 'explicit';
}
