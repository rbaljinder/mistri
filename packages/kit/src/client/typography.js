/**
 * What face the data wears: mono — tablewalk's own, values as things you
 * compare character by character — or sans, a reading cut where values
 * take the prose face and only true code stays code.
 *
 * A display preference like density and the theme: per person, per
 * browser, applied at boot before the first paint and again by the brand
 * pass on every connection switch. The whole
 * mechanism is one token — the stylesheet says `var(--mono)` everywhere
 * data is set, so swapping what that token resolves to re-dresses every
 * value at once, and a short carve-out list (DDL, SQL, the query
 * language) pins the surfaces that *are* code back to a real mono stack.
 */
import { shellBody } from './shellHost.js';
const KEY = 'mistri.typography';
/** @type {'default' | 'sans' | 'mono'} */
let remembered = 'default';
let sessionOnly = false;

export function typographyPreference() {
  if (sessionOnly) return remembered;
  try {
    const value = localStorage.getItem(KEY);
    remembered = value === 'sans' || value === 'mono' ? value : 'default';
  } catch {
    /* Keep the last readable or explicitly chosen value. */
  }
  return remembered;
}

export function applyTypography() {
  const preference = typographyPreference();
  shellBody().classList.toggle('type-sans', preference === 'sans');
  shellBody().classList.toggle('type-mono', preference === 'mono');
}

/** Default follows the app/preset; explicit faces override it. Unknown values mean mono. */
export function setTypography(choice) {
  remembered = choice === 'default' ? 'default' : choice === 'sans' ? 'sans' : 'mono';
  try {
    if (remembered === 'default') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, remembered);
    sessionOnly = false;
  } catch {
    // Nowhere to keep the choice is no reason to refuse it for this tab.
    sessionOnly = true;
  }
  applyTypography();
}
