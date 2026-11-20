/**
 * The language a visitor picked for an App, read from its cookie. Its own module, apart from publicForm.js: the App
 * shell's public home names the pick too, and importing it from there brought the sign-in screen into every App's
 * first paint.
 */
import { localeCookieName } from '@mistriwork/engine/shared/appLocale.js';

/**
 * The language this browser picked for an App: the page address's `?locale=`, else its cookie as it holds it now
 * (kit messages.ts `setMessageLanguage`); undefined where it picked none. A form is fetched without cookies, so its read and its submission name the pick
 * themselves (`?locale=`), and a pick made since the page arrived is the one they name.
 * @param {string | undefined} appId
 * @returns {string | undefined}
 */
export function pickedLanguage(appId) {
  if (!appId) return undefined;
  /* A page opened with `?locale=` (a link that says its language, or the switch at a public page's foot) is read in
     it; the server keeps it only where it is one of the App's catalogs. */
  const asked = new URLSearchParams(window.location.search).get('locale');
  if (asked) return asked;
  const name = localeCookieName(appId);
  for (const part of document.cookie.split(';')) {
    const at = part.indexOf('=');
    if (at < 0 || part.slice(0, at).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(at + 1).trim()) || undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}
