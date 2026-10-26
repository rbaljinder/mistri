/**
 * The pages a visitor sees before any App is theirs: a public form, the
 * landing, the sign-in screen.
 *
 * Loaded by boot.js on its own, without the shell: these pages draw one
 * surface in the App's dress and nothing of the App behind it, and a
 * visitor who never signs in never downloads the rest (vite.config.ts,
 * `surfaces`). Each answers whether it drew, so boot knows to stop.
 */
import { el } from '@mistriwork/kit/client/dom.js';
import { $ } from '@mistriwork/kit/client/core.js';
import { applyAppTheme } from './appTheme.js';
import { showSignIn } from './signin.js';
import { loadPublicForm, showPublicForm } from './publicForm.js';
import { loadLanding, showLanding } from './landing.js';
import { say } from './copy/public/publicSurface.js';
import { shown } from '@mistriwork/kit/client/addressMount.js';
import { shellBody } from '@mistriwork/kit/client/shellHost.js';
import { fetchServer } from '@mistriwork/kit/client/transport.js';
import { installShell } from '@mistriwork/kit/client/shellMode.js';
import { surfaceShell } from './surfaceShell.js';

export { showSignIn };

/** @param {{ id: string; theme?: import('../shared/app.js').AppTheme; customThemes?: import('@mistriwork/engine/shared/theme.js').ThemeDefinition[] }} look */
const wear = (look) => applyAppTheme(true, { id: look.id, ui: { theme: look.theme, customThemes: look.customThemes } });

/**
 * A public form's address, or the landing's for anyone, asked before who-am-I.
 *
 * A public form: `/{app}/form/{id}` is open to everyone, so it is drawn
 * before anyone is asked who they are. One read, the form, the App's name
 * and dress, and boot stops there — an applicant is never sent to sign in,
 * nothing of the App beyond the form is fetched, and someone signed in
 * submits it as the public too. On a server with no public form the address
 * is not one, and boot carries on as for any other.
 *
 * The public landing at `/{app}/welcome`: the App's front page drawn for
 * anyone, so staff can see what an applicant sees. An App without a landing
 * answers 404 and boot carries on as if this were any other address.
 * @param {ReturnType<typeof import('./publicRoutes.js').publicFormRoute>} formAt
 * @param {ReturnType<typeof import('./publicRoutes.js').landingRoute>} landingAt
 * @returns {Promise<boolean>} whether a page was drawn
 */
export async function showPublicAddress(formAt, landingAt) {
  /* A public page is drawn without the App shell, so it names the answers it shares with it. */
  installShell({ ...surfaceShell, signInHere });
  if (formAt) {
    let found;
    try {
      found = await loadPublicForm(formAt.id, { appId: formAt.app });
    } catch (error) {
      // A wrong address is a sentence on the page, not a failed start.
      shellBody().classList.add('app-mode', 'public-form-mode');
      $('content').replaceChildren(
        el('section', { class: 'form-page form-page-missing' }, [
          el('h1', { text: say('thisFormIsNotHere') }),
          el('p', { class: 'form-page-description', text: error instanceof Error ? error.message : say('theFormCouldNotBe') }),
        ]),
      );
      return true;
    }
    if (found && found.app.id === formAt.app) {
      wear(found.app);
      if (showPublicForm(found, formAt.page)) return true;
      // A status or account page of a form that has none: said as a wrong address is.
      $('content').replaceChildren(
        el('section', { class: 'form-page form-page-missing' }, [
          el('h1', { text: say('thisPageIsNotHere') }),
          el('p', { class: 'form-page-description', text: say('thisFormHasNoSuch') }),
        ]),
      );
      return true;
    }
  }
  if (landingAt?.kind === 'welcome') {
    const found = await loadLanding();
    if (found && found.app.id === landingAt.app) {
      wear(found.app);
      showLanding(found.app, found.landing);
      return true;
    }
  }
  return false;
}

/**
 * Draw the public view a signed-out visitor starts on, as who-am-I named it:
 * the landing, whose answer carries its own view key, else the public form
 * with that key. False when neither answers for this App; the caller signs in.
 * @param {string} view
 * @param {string | undefined} appId
 * @returns {Promise<boolean>}
 */
export async function showPublicHome(view, appId) {
  installShell({ ...surfaceShell, signInHere });
  const found = await loadLanding();
  if (found?.view === view && (!appId || found.app.id === appId)) {
    wear(found.app);
    showLanding(found.app, found.landing);
    return true;
  }
  try {
    const form = await loadPublicForm(view, { appId });
    if (!form || (appId && form.app.id !== appId)) return false;
    wear(form.app);
    // Asked only of someone signed out of an App that signs people in (boot.js): the door is theirs to find.
    showPublicForm(form, undefined, { signIn: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * The sign-in screen, in the App's own look. Without the look it was drawn in
 * the database browser's own tokens — a green button on an App whose accent
 * is blue — which reads as the wrong site at the one moment a visitor has
 * nothing else to go on. The staff door of an App with public pages leads
 * back to them: its landing or its public lists are at the App's root.
 * @param {Record<string, any>} me who-am-I's answer, signed out
 * @param {ReturnType<typeof import('./publicRoutes.js').landingRoute>} landingAt
 */
export function showSignInFor(me, landingAt) {
  const look = me.signIn.look;
  if (look) wear(look);
  const publicSite = landingAt?.kind === 'sign-in' && (typeof me.home === 'string' || me.public === true);
  showSignIn(me.signIn, publicSite ? { href: shown(`/${encodeURIComponent(landingAt.app ?? '')}`) } : undefined);
}

/**
 * The sign-in screen drawn where a signed-out visitor stands — an address of
 * an App the public browses that a member's role opens (TableRoom's refusal).
 * Signing in reloads the page it is on (SignIn.tsx), so the visitor comes
 * back to that address, not to the App's root as the top bar's door does.
 * @param {string} appId
 * @returns {Promise<boolean>} whether the screen was drawn
 */
export async function signInHere(appId) {
  const res = await fetchServer(`/api/whoami?app=${encodeURIComponent(appId)}`, {
    credentials: 'same-origin',
    signal: AbortSignal.timeout(15_000),
  });
  const me = await res.json();
  if (!me?.signIn) return false;
  // The door leads back to the App's public pages, as the staff door's does.
  showSignIn(me.signIn, { href: shown(`/${encodeURIComponent(appId)}`) });
  return true;
}
