/**
 * Light, dark, or whatever the machine is set to.
 *
 * The palette for all three has been in style.css from early on: a full token
 * override under `@media (prefers-color-scheme: dark)`, guarded as
 * `:root:not([data-theme="light"])`, and a second copy under
 * `:root[data-theme="dark"]`. That guard only means anything if something can
 * stamp `data-theme`, and nothing ever did — so the dark palette was reachable
 * by changing your operating system and by no other route, and the light one
 * was unreachable from a dark machine at all.
 *
 * This is that missing piece and nothing more. It writes one attribute.
 *
 * Three states rather than two, because "system" is a real answer and not the
 * absence of one: a reader who has told their machine to go dark at sunset
 * means it here too, and a toggle that only remembers light-or-dark quietly
 * opts them out of that. Absent attribute *is* the system state, which is why
 * the CSS was written to key off its absence.
 */
import { say } from './copy/shell/theme.js';
import { shellRoot } from './shellHost.js';

const KEY = 'mistri.theme';
const ORDER = ['system', 'light', 'dark'];

/* Said when asked, not when the module loads: a visitor's language arrives later. */
const LABEL = {
  system: () => say('matchTheSystem'),
  light: () => say('alwaysLight'),
  dark: () => say('alwaysDark'),
};

let current = 'system';
/** The worn theme's `scheme` (appTheme.js): `dark` is the mode a reader gets until they pick one, `dark-only` the only one. */
let scheme;

function stored() {
  try {
    const raw = window.localStorage?.getItem(KEY);
    /* Validated, not trusted: this comes back from storage a stale build or a
       hand edit may have written, and an unknown value would stamp
       `data-theme="banana"` — which matches no rule, so the page would render
       in the light palette while claiming to be in another one. */
    return ORDER.includes(raw) ? raw : 'system';
  } catch {
    return 'system';
  }
}

/** Whether the reader has picked a mode, "match the system" included: an absent key is no answer. */
function remembered() {
  try {
    return ORDER.includes(window.localStorage?.getItem(KEY));
  } catch {
    return false;
  }
}

/** The mode in force for a pick: a dark theme is dark until the reader has said otherwise, a dark-only one always. */
function shown(name) {
  if (scheme === 'dark-only') return 'dark';
  return scheme === 'dark' && name === 'system' && !remembered() ? 'dark' : name;
}

function apply(name) {
  current = ORDER.includes(name) ? name : 'system';
  const showing = shown(current);
  const root = shellRoot();
  if (showing === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', showing);
  /* Tells the browser which way to paint the things the page does not: form
     controls, scrollbars, the canvas behind an overscroll. Without it a dark
     page keeps light scrollbars. */
  root.style.colorScheme = showing === 'system' ? '' : showing;
}

/** The worn theme says it is dark (or dark only), or nothing; the page is stamped again when that changes. */
export function setThemeScheme(value) {
  if (value === scheme) return;
  scheme = value;
  apply(current);
}

/** Read the stored choice and put it on the page. Called once, at boot. */
export function initTheme() {
  apply(stored());
}

/** A mode held for this page only, never remembered: a theme bench frame (themeBench.ts) shows one mode whatever the reader picked. */
export function holdTheme(name) {
  apply(name);
}

/** What is in force, for a menu item that has to say so. */
export const themeChoice = () => current;
export const themeLabel = () => LABEL[current]();

/** An explicit preference; System continues to follow the operating system. */
export function setTheme(name) {
  const pick = ORDER.includes(name) ? name : 'system';
  /* Remembered before it is applied: a dark theme answers "match the system" with the system only once it is asked for. */
  try {
    window.localStorage?.setItem(KEY, pick);
  } catch {
    /* A theme that cannot be remembered is still a theme for this tab. */
  }
  apply(pick);
  return current;
}

export function effectiveTheme() {
  const showing = shown(current);
  return showing === 'system' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : showing;
}

/** A quick toggle always changes the visible palette, even when following System. */
export function toggleTheme() {
  return setTheme(effectiveTheme() === 'dark' ? 'light' : 'dark');
}
