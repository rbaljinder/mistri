/**
 * The language a visitor picked for an App, read from its cookie. Its own module, apart from publicForm.js: the App
 * shell's public home names the pick too, and importing it from there brought the sign-in screen into every App's
 * first paint.
 */
import { localeCookieName } from '@mistriwork/engine/shared/appLocale.js';

/**
 * The language this browser picked for an App (kit messages.ts `setMessageLanguage`), as its cookie holds it now;
 * undefined where it picked none. A form is fetched without cookies, so its read and its submission name the pick
 * themselves (`?locale=`), and a pick made since the page arrived is the one they name.
 * @param {string | undefined} appId
 * @returns {string | undefined}
 */
export function pickedLanguage(appId) {
  if (!appId) return undefined;
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
