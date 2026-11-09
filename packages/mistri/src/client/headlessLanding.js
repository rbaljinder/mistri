/**
 * Where a headless App's sign-in lands (`ui: { headless: true }`). The sign-in reloads the page it was on, and an App
 * with screens of its own goes on to its root; a headless App has none (its root answers 404), so the page goes back
 * to the front end that sent the person here, named by `?then=`, or says that the person is signed in and can go back.
 * A `then` is followed only on this origin: the sign-in page must not be a way to send a signed-in person elsewhere.
 */
import { $ } from '@mistriwork/kit/client/core.js';
import { el } from '@mistriwork/kit/client/dom.js';
import { say } from './copy/public/headlessLanding.js';
import { setTabTitle, shellBody } from '@mistriwork/kit/client/shellHost.js';

/**
 * A same-origin address, or nothing.
 * @param {string | null} address
 * @returns {URL | null}
 */
export function sameOrigin(address) {
  if (!address) return null;
  try {
    const url = new URL(address, window.location.origin);
    return url.origin === window.location.origin ? url : null;
  } catch {
    return null;
  }
}

export function landHeadless() {
  const then = sameOrigin(new URLSearchParams(window.location.search).get('then'));
  if (then) {
    window.location.replace(then.href);
    return;
  }
  /* The page that sent the person here, when it is this origin's and not this sign-in itself. */
  const back = sameOrigin(document.referrer);
  const from = back && back.pathname !== window.location.pathname ? back : null;
  shellBody().classList.add('app-mode', 'signin-door');
  setTabTitle(say('signedIn'));
  $('content').replaceChildren(
    el('div', { class: 'signin' }, [
      el('div', { class: 'signin-card' }, [
        el('h1', { class: 'signin-title', text: say('signedIn') }),
        el(
          'p',
          { class: 'signin-lede', role: 'status' },
          from ? [`${say('closeOrReturn')} `, el('a', { href: from.href, text: say('thePage') }), '.'] : [say('closeTab')],
        ),
      ]),
    ]),
  );
}
