/**
 * The sign-in screen, as the vanilla client reaches it.
 *
 * The screen itself is a component (components/SignIn.tsx); this is the seam
 * app.js already called, kept so that the crossing into React is one
 * import here and not a change in every caller.
 */
import { createElement } from 'react';
import { $ } from '@mistriwork/kit/client/core.js';
import { isMounted, mount } from '@mistriwork/kit/client/components/mount.js';
import { SignIn } from './components/SignIn.js';
import { applyBrandLogo, headBrandingMark } from './appBrand.js';
import { say } from './copy/public/signin.js';
import { setTabTitle, shellBody, shellQuery } from '@mistriwork/kit/client/shellHost.js';

/** @typedef {import('./components/SignIn.js').SignInInfo} SignInInfo */
/** @typedef {import('./components/SignIn.js').SignInHome} SignInHome */

/**
 * @param {SignInInfo} info
 * @param {SignInHome} [site] The App's public pages, when this door has them beside it.
 * @param {{ start?: 'up'; lead?: string }} [opening] Where the door opens, and why it is here.
 */
export function showSignIn(info, site, opening = {}) {
  // WHOAMI/401 publishes only this name, not the authenticated App definition.
  // Keep both entry paths in the same shell without loading private metadata.
  shellBody().classList.add('app-mode', 'signed-out');
  const brand = shellQuery('.brand-name');
  if (brand) brand.textContent = info.app;
  applyBrandLogo(shellQuery('.brand-mark'), headBrandingMark() ?? info.look?.logo, info.app, info.look?.icons);
  // The App's own, with no vendor suffix: its reader signs in to it, not to tablewalk.
  setTabTitle(say('signInApp', { app: info.app }));
  const home = $('home-button');
  if (home instanceof HTMLButtonElement) {
    home.disabled = true;
    home.removeAttribute('title');
  }
  const host = $('content');
  /* Drawn into the pane's own root when the shell has one — a session that
     expired mid-walk — replacing the walk's tree; cleared first only when
     the pane still holds the page's static markup. */
  if (!isMounted(host)) host.replaceChildren();
  mount(host, createElement(SignIn, { info, home: site, ...opening }));
}
