/**
 * The App framework's main in the browser: everything an App's page does
 * after the look (shellStart.js), from a public form, the landing and the
 * sign-in screen to the kit's shell with the App's chrome (appnav.js).
 *
 * Loaded by the entry with import() for any page the database browser did
 * not send, and placed in the entry's own chunk (vite.config.ts, `surfaces`),
 * so a public page is still the entry and its surface, fetched together. The
 * shell and the App's chrome are two chunks the App's page preloads beside
 * it, the chrome apart so the Workbench's page never fetches it; the public
 * pages are the other surface.
 */
import { api } from '@mistriwork/kit/client/core.js';
import { installShell } from '@mistriwork/kit/client/shellMode.js';
import { connectionFromHash } from '@mistriwork/kit/client/deeplink.js';
import { establishSessionIdentity, sessionIdentity } from '@mistriwork/kit/client/sessionIdentity.js';
import { setAppKeepsRoles, setRoleLabels } from '@mistriwork/kit/client/roleLabels.js';
import { invalidateSession } from '@mistriwork/kit/client/sessionLifecycle.js';
import { setPublicVisitor } from './publicVisitor.js';
import { landingRoute, publicFormRoute } from './publicRoutes.js';
import { arrivedPlacement, herePath, keepPlacement } from '@mistriwork/kit/client/addressMount.js';
import { setPublicPlacement } from '@mistriwork/kit/client/requestIdentity.js';
import { shellQuery } from '@mistriwork/kit/client/shellHost.js';

const publicSurface = () => import('./publicSurface.js');

/** The rest of an App's page, past the look (shells.ts `ShellMain`). */
export async function start() {
  /* A --dev server says so in the page (server/observe/): its observer's
     badge, and this page's errors and layout shifts reported to it. A
     production page has no such tag and never fetches the module. */
  if (shellQuery('meta[name="mistri-observe"]')) void import('./observe/beacon.js').then((beacon) => beacon.startBeacon()).catch(() => {});
  /* A frame of the theme bench the same dev server serves (server/themeBench/): it holds its mode and wears the
     theme the bench posts. A production page never fetches the module, and a window named so elsewhere is not one. */
  if (shellQuery('meta[name="mistri-observe"]') && window.name.startsWith('mistri-theme-bench:') && window.parent !== window)
    void import('./themeBench.js').then((bench) => bench.joinThemeBench(window.name)).catch(() => {});

  /* The path: the app routes by path, and a fragment is not an address.
     Read before anything renders, as the shell reads it again, in its inside
     form — the App's id first, the base path off (addressMount.js). */
  const path = herePath();
  /* A public form, and the landing for anyone, are asked for before who-am-I
     (publicSurface.js says why); an address that turns out to be neither
     carries on as any other. */
  const formAt = publicFormRoute(path);
  const landingAt = landingRoute(path);
  if ((formAt || landingAt?.kind === 'welcome') && (await (await publicSurface()).showPublicAddress(formAt, landingAt))) return;

  /* A server that signs people in: the first 401 with a sign-in body draws
     the screen, in the app's own dress, and boot stops there. The screen's
     part is fetched for it, so boot waits for it to be drawn before the
     page is revealed; revealed first, the empty shell showed for a beat. */
  /** @type {Promise<void> | undefined} */
  let signingIn;
  installShell({
    unauthorized: (info) => {
      if (sessionIdentity().mode === 'authenticated' || sessionIdentity().mode === 'locked') {
        invalidateSession('expired');
        return;
      }
      signingIn = publicSurface().then((surface) =>
        surface.showSignIn(/** @type {Parameters<Awaited<ReturnType<typeof publicSurface>>['showSignIn']>[0]} */ (info)),
      );
    },
  });

  const requestedApp = connectionFromHash(path);
  /* A tenant's public address the page arrived on asks who-am-I as that tenant's visitor; kept only when it answers so. */
  const via = arrivedPlacement();
  const asked = new URLSearchParams();
  if (requestedApp) asked.set('app', requestedApp);
  if (via) asked.set('via', via);
  const me = await api(asked.size ? `/api/whoami?${asked}` : '/api/whoami');
  establishSessionIdentity(me);
  setPublicPlacement(keepPlacement(!me.signedIn && me.tenantPublic === true));
  // What the App calls its roles, for every screen that names one.
  setRoleLabels(me?.roleLabels);
  setAppKeepsRoles(me?.hasRoles);
  setPublicVisitor(!me.signedIn && me.public === true);
  if (!me.signedIn && me.signIn) {
    /* Signed out at the App's root: the public view the App's home rules
       start a signed-out visitor on — its front page or a public form — when
       who-am-I names one; the sign-in screen when they start on a view only
       a signed-in visitor opens, so such an App boots on that one request.
       `/{app}/sign-in` always asks. */
    /* Not in an App the public browses: its front page reads the App's own
       rows (a landing's cards and search), so it is drawn inside the App,
       which boots for the visitor in the shell. */
    const home = landingAt?.kind === 'root' && typeof me.home === 'string' && me.public !== true;
    /* An App that opens resources to the public (`auth.public`) is browsed
       signed out, within that grant; the sign-in screen waits behind its
       Sign in link, and at `/{app}/sign-in`. */
    const door = me.public !== true || landingAt?.kind === 'sign-in';
    if (home || door) {
      const surface = await publicSurface();
      if (home && (await surface.showPublicHome(me.home, landingAt.app))) return;
      if (door) {
        surface.showSignInFor(me, landingAt);
        return;
      }
    }
  }
  /* An application asked this person for a token (`?authorize=`, auth/oauthServer.ts): signed in, the
     consent page, and nothing of the App behind it. Signed out, the sign-in screen above asked first and
     reloads to here. Its own part, fetched only for this. */
  const authorize = landingAt?.kind === 'sign-in' && me.signedIn ? new URLSearchParams(window.location.search).get('authorize') : null;
  if (authorize) {
    await (await import('./oauthConsent.js')).showConsent(authorize);
    return;
  }
  /* The kit's shell and the App's chrome, two chunks the page preloads together (vite.config.ts, `surfaces`). */
  const [{ boot }, { appChrome }] = await Promise.all([import('@mistriwork/kit/client/app.js'), import('./appnav.js')]);
  await boot(me, landingAt, { chrome: appChrome });
  await signingIn;
}
