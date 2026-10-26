/**
 * What an App server's page says when it cannot show the App: an address
 * that names no App here, an App that is not being served, and a tenant's
 * public address that names no workspace. Each is drawn in place of the
 * room, by the App framework's chrome (appnav.js), and never by the
 * Workbench's welcome (welcome.js), which an App server has no use for.
 *
 * Nothing is initialised beyond this point on purpose, as on the welcome
 * screen: no palette, no shortcuts, no undo, since there is no schema.
 */
import { $, el } from '@mistriwork/kit/client/core.js';
import { activeApp } from './appState.js';
import { shown } from '@mistriwork/kit/client/addressMount.js';
import { applyBrandLogo } from './appBrand.js';
import { setTabTitle, shellBody, shellQuery } from '@mistriwork/kit/client/shellHost.js';
import { say } from './copy/shell/appUnavailable.js';

/**
 * Why the App could not be shown.
 * @param {import('@mistriwork/kit/client/requestIdentity.js').UnknownAppError} [unknown] the address named no App this server serves
 * @param {string} [unavailable] what the server said about why it is not serving the App
 */
export function showAppUnavailable(unknown = undefined, unavailable = undefined) {
  shellBody().classList.add('first-run');
  if (unknown) {
    /* The address names no App here — a typo, or a link to an id that
       changed. Saying "could not connect to its database" sent people
       debugging a database that was fine; name what is served instead. */
    shellBody().classList.add('app-bound');
    setTabTitle(say('noAppHere'));
    $('content').replaceChildren(
      el('div', { class: 'welcome' }, [
        el('h1', {}, [say('noAppNamedHere', { requested: unknown.requested })]),
        el('p', {}, [
          unknown.apps.length
            ? say('thisServerServes', {
                value: unknown.apps.length === 1 ? say('oneApp') : say('apps', { appsCount: unknown.apps.length }),
              })
            : say('thisServerServesNoApp'),
        ]),
        ...(unknown.apps.length
          ? [
              el(
                'ul',
                {},
                unknown.apps.map((served) =>
                  el('li', {}, [
                    el('a', { href: shown(`/${encodeURIComponent(served.id)}`) }, [served.name]),
                    say('at', { id: served.id }),
                  ]),
                ),
              ),
            ]
          : []),
      ]),
    );
    return;
  }
  /* An App's screen wears the App: its name and mark in the bar, its look's tokens in the page. The vendor's mark
     is the Workbench's alone. The three lines are the ones startup.ts draws when the page cannot start at all. */
  const app = activeApp();
  shellBody().classList.add('app-bound');
  const name = app?.name ?? say('application');
  const brand = shellQuery('.brand-name');
  if (brand) brand.textContent = name;
  applyBrandLogo(
    shellQuery('.brand-mark'),
    /** @type {import('./appTheme.js').RecordTheme | undefined} */ (app?.ui.theme)?.branding?.mark ?? app?.ui.logo,
    name,
  );
  setTabTitle(app?.name ?? say('applicationUnavailable'));
  $('content').replaceChildren(
    el('div', { class: 'unavail', role: 'alert' }, [
      /* The room's heading, as every room has one: a screen reader that walks by heading finds the screen by it. */
      el('h1', { class: 'unavail-title' }, [say('isUnavailable', { name })]),
      el('p', { class: 'unavail-line' }, [unavailable ?? say('theApplicationCouldNotConnect')]),
      el('button', { type: 'button', class: 'unavail-action', onclick: () => window.location.reload() }, [say('retry')]),
    ]),
  );
}

/**
 * A tenant App's public address (`?via=`) that names no workspace: a stale or
 * mistyped link. The server answers it as it answers every
 * address it will not place — one 404 that tells nothing of any tenant — so
 * the page says the address holds nothing, not that a database is out of
 * reach, and offers the App's sign-in.
 * @param {string} name the App's name, from who-am-I
 * @param {string} signIn the App's sign-in address
 */
export function showNoWorkspace(name, signIn) {
  shellBody().classList.add('first-run', 'app-bound');
  setTabTitle(name);
  $('content').replaceChildren(
    el('div', { class: 'welcome' }, [
      el('h1', {}, [say('noWorkspaceHere')]),
      el('p', {}, [say('noWorkspaceLivesAt')]),
      el('a', { class: 'btn', href: signIn }, [say('signIn')]),
    ]),
  );
}
