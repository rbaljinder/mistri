/**
 * How much room tablewalk takes: comfortable — the default of a look that does not say — spacious, or compact
 * (Lumen, Mono and Sage start an App compact, themeLooks.ts).
 *
 * A display preference like the theme, so it lives where the theme lives:
 * this browser's storage, per person. It applies across both modes,
 * because density is about the reader's eyes, not about which room they
 * are in.
 *
 * One uniform scale rather than a second set of font rules: the px values
 * in the stylesheet were chosen together, and scaling them together is
 * the only change that keeps those choices. The scale lands on the *root*
 * element, not on body: every fixed-position card measures the page with
 * getBoundingClientRect and then places itself, and only with the whole
 * document in one zoomed coordinate space do the measurement and the
 * placement agree — zoom on body put the peek card a room away from the
 * chip it described.
 */
import { refreshViewportScale } from './core.js';
import { shellQuery, shellRoot } from './shellHost.js';

const KEY = 'mistri.density';
/* Steps far enough apart to be steps: a 6% middle read as no change at
   all. The default look sits in the middle as "comfortable"; spacious is
   a real jump above it, compact the stylesheet's own tightest cut. */
const SCALE = { comfortable: '1.12', spacious: '1.24' };
/** @typedef {'compact' | 'comfortable' | 'spacious'} Density */
/** @param {unknown} value @returns {value is Density} */
const known = (value) => value === 'compact' || value === 'comfortable' || value === 'spacious';
/** @type {Density} */
let remembered = 'comfortable';
let sessionOnly = false;
/** The worn theme's density (`defineTheme({ density })`), until the reader picks their own. @type {Density | undefined} */
let themed;
/* Until the App's theme arrives, the density the server says its page wears (clientHttp.ts, `mistri-density`).
   Boot zooms before the first paint and the theme lands a round trip later: guessed as comfortable, a compact
   look (Lumen, every App's default) drew its startup outline at 1.12 and then pulled it back to 1, a layout
   shift of 0.12 on a phone before the App had drawn a thing. */
function themedNow() {
  if (themed) return themed;
  const told = shellQuery('meta[name="mistri-density"]')?.getAttribute('content');
  return (themed = known(told) ? told : 'comfortable');
}

/** The theme's density, for a reader with no choice of their own; applied at once when it changes.
    @param {unknown} choice */
export function setDensityDefault(choice) {
  const next = known(choice) ? choice : 'comfortable';
  if (next === themedNow()) return;
  themed = next;
  applyDensity();
}

export function densityChoice() {
  // A failed write must not let an older stored choice undo this tab's input.
  if (sessionOnly) return remembered;
  try {
    const stored = localStorage.getItem(KEY);
    remembered = known(stored) ? stored : themedNow();
  } catch {
    /* Keep the last readable or explicitly chosen value. */
  }
  return remembered;
}

export function applyDensity() {
  const choice = densityChoice();
  const scale = SCALE[choice];
  /* A list's row is a height per density (--row-h, style.css), drawn through the zoom: set here, with the zoom,
     before the first paint, so a row never changes height once drawn. */
  shellRoot().dataset.density = choice;
  const root = shellRoot().style;
  if (scale) {
    root.setProperty('zoom', scale);
    /* vh units do not shrink with the zoom, so the shell's height token
       must: a 100vh body under zoom overflowed the window by the zoom and
       gave the whole app an outer scrollbar that carried the topbar away. */
    root.setProperty('--shell-vh', `calc(100vh / ${scale})`);
    /* The startup outline painted from the page before this ran, at 1: it divides by this to stay where it was
       drawn (index.html), so the zoom landing is not a layout shift of the whole outline. */
    root.setProperty('--density-zoom', String(scale));
  } else {
    root.removeProperty('zoom');
    root.removeProperty('--shell-vh');
    root.removeProperty('--density-zoom');
  }
  refreshViewportScale();
}

/** Keep a choice and apply it. Anything unrecognised means comfortable. */
export function setDensity(choice) {
  remembered = known(choice) ? choice : 'comfortable';
  try {
    localStorage.setItem(KEY, remembered);
    sessionOnly = false;
  } catch {
    // Nowhere to keep the choice is no reason to refuse it for this tab.
    sessionOnly = true;
  }
  applyDensity();
}
