/**
 * The OAuth consent page, as boot reaches it: the App's sign-in address with
 * `?authorize=`, for someone signed in (signed out, the sign-in screen asks
 * first and comes back here). Loaded only then, so no other page carries it.
 *
 * The page is drawn in the App's own dress, as its sign-in is, and nothing of
 * the App behind it: the person is answering one question.
 */
import { createElement } from 'react';
import { $ } from '@mistriwork/kit/client/core.js';
import { mount } from '@mistriwork/kit/client/components/mount.js';
import { OAuthConsent, loadConsent } from './components/OAuthConsent.js';
import { applyAppTheme } from './appTheme.js';
import { applyBrandLogo } from './appBrand.js';
import { el } from '@mistriwork/kit/client/dom.js';
import { say } from './copy/public/oauthConsent.js';
import { setTabTitle, shellBody, shellQuery } from '@mistriwork/kit/client/shellHost.js';

/**
 * @param {string} request the pending request's id, from the address
 * @returns {Promise<void>}
 */
export async function showConsent(request) {
  shellBody().classList.add('app-mode', 'signed-out');
  const host = $('content');
  host.replaceChildren(el('div', { class: 'signin' }, [el('p', { class: 'signin-lede', role: 'status', text: say('loading') })]));
  const view = await loadConsent(request);
  if (typeof view === 'string') {
    host.replaceChildren(
      el('div', { class: 'signin' }, [
        el('div', { class: 'signin-card' }, [el('p', { class: 'signin-notice', role: 'alert', text: view })]),
      ]),
    );
    return;
  }
  const look = /** @type {Record<string, any> | undefined} */ (view.look);
  if (look) applyAppTheme(true, { id: look.id, ui: { theme: look.theme, customThemes: look.customThemes } });
  const brand = shellQuery('.brand-name');
  if (brand) brand.textContent = view.app.name;
  applyBrandLogo(shellQuery('.brand-mark'), look?.logo, view.app.name, look?.icons);
  setTabTitle(say('tabTitle', { app: view.app.name }));
  host.replaceChildren();
  mount(host, createElement(OAuthConsent, { view }));
}
