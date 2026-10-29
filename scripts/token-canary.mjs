/**
 * The canary themes `npm run test:tokens` wears (scripts/visual-matrix.mjs --tokens), and the probe that reads a
 * page under one.
 *
 * Every color a page draws should come from the theme: a role (`ink`, `nav.ground`, `status.critical`), that role
 * faded (`color-mix(… transparent)`), or two of them mixed. A part that draws in a literal instead — the sort
 * dropdown's edge at 1.22:1 whatever `lineControl` said (0.9.2 field report) — is one an App's theme cannot reach,
 * and no contrast check sees it. So each canary gives every role a color of its own, unlike any other and unlike
 * white, black or a grey, and the probe reads every element's computed colors twice: once as the page is drawn,
 * and again after every role is moved to a second color. A color that did not move is a literal; one that moved
 * but is not a role, a role faded, or on the line between two (what `color-mix(in srgb …)` makes) mixes a literal
 * in. Either fails the run, naming the element.
 *
 * Four canaries: one on each built-in look, and one wearing the treatments no built-in look wears (`brandLook.css`),
 * so every sheet the recipe menu can fetch is read.
 */
import { compileAppTheme } from '../packages/mistri/src/shared/themeSpec.ts';
import { PALETTE_TOKENS } from '../packages/engine/src/shared/themeTokens.ts';
import { RECIPE_MENU } from '../packages/engine/src/shared/themeRecipes.ts';

/** The roles that are colors: `rulesWeight` and `rulesControl` are widths. */
const ROLES = Object.keys(PALETTE_TOKENS).filter((role) => role !== 'rulesWeight' && role !== 'rulesControl');

const hex = (h, s, l) => {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
};

/* Saturated, spread round the wheel by the golden angle and over three lightnesses, so no two roles are near one
   another and none is near white, black or a grey: a literal lands on a role or between two only by accident. A
   mode's set is its own, so a literal kept for one mode is caught in the other. */
function palette(offset, step = 0) {
  return Object.fromEntries(
    ROLES.map((role, index) => [role, hex((offset + index * 137.508) % 360, 0.85, [0.32, 0.48, 0.64][(index + step) % 3])]),
  );
}

/** The probe's second reading: every role of the mode moved, hue and lightness, so nothing drawn from one stays put. */
export function canaryMoves(mode) {
  const [from, to] = mode === 'dark' ? [palette(61), palette(241, 1)] : [palette(0), palette(180, 1)];
  return ROLES.map((role) => [PALETTE_TOKENS[role], from[role], to[role]]);
}

/** The treatments only an App's own theme picks: the values whose sheet is `brand`. */
const OWN = Object.fromEntries(
  Object.entries(RECIPE_MENU)
    .map(([part, values]) => [part, Object.keys(values).find((value) => values[value] === 'brand')])
    .filter(([, value]) => value),
);

export const CANARY_LOOKS = ['workshop', 'lumen', 'mono', 'sage', 'ledger', 'own'];

/* The tokens that are the same under every theme on purpose: what is drawn over a photograph (the lightbox, a
   gallery's count and steps, a hero's words and actions) is judged against the photo, not the page, and a scrim
   darkens whatever lies under it; neither moves with the palette. A color drawn in exactly one of these is a token
   all the same. */
export const FIXED_TOKENS = ['--lightbox-ground', '--lightbox-ink', '--lightbox-line', '--scrim', '--scrim-light'];

/** A canary theme on `look`, compiled as an App's own theme is, every role then set to its canary color. */
export function canaryTheme(look) {
  const theme = compileAppTheme(
    {
      kind: 'theme',
      id: `canary-${look}`,
      label: `Canary ${look}`,
      extends: look === 'own' ? 'mono' : look,
      ...(look === 'own' ? { recipes: OWN } : {}),
    },
    `canary ${look}`,
  );
  return { ...theme, light: { ...theme.light, ...palette(0) }, dark: { ...theme.dark, ...palette(61) }, palettes: undefined };
}

/**
 * Runs in the page: every visible element's drawn colors that are not the theme's, read with the roles where the
 * theme put them and again with every role moved (`moves`: each custom property, its color, its second color).
 * Returns one line per literal and the elements that drew it, a few of each.
 */
export function tokenProbe({ moves, tolerance, fixed = [] }) {
  const pen = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  /* A computed color as the browser serializes it, unrounded: a role faded to 8% read back off a canvas is
     premultiplied to a few levels and lands anywhere within a dozen of its role. The canvas reads anything else. */
  const rgba = (css) => {
    const rgb = /^rgba?\(([\d.]+),? ([\d.]+),? ([\d.]+)(?:,? \/? ?([\d.]+))?\)$/.exec(css);
    if (rgb) return [+rgb[1], +rgb[2], +rgb[3], rgb[4] === undefined ? 1 : +rgb[4]];
    const srgb = /^color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.]+))?\)$/.exec(css);
    if (srgb) return [srgb[1] * 255, srgb[2] * 255, srgb[3] * 255, srgb[4] === undefined ? 1 : +srgb[4]];
    pen.clearRect(0, 0, 1, 1);
    pen.fillStyle = 'rgba(0,0,0,0)';
    pen.fillStyle = css;
    pen.fillRect(0, 0, 1, 1);
    const d = pen.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  };
  /* A theme color is a pair of readings, before and after the move: a role, or a color a sheet derives from them.
     What an element draws is the theme's when its pair is one of these, or the same mix of two or three of them in
     both readings — `color-mix(in srgb, A t%, B)` moves with A and B and keeps its t; the avatar's disc mixes its
     slot into a mix of the ink and the surface. A literal mixed in keeps a share of itself fixed, so no one set of
     weights explains both readings. The tolerance is a rounding's. Alpha is not compared: a role faded is the role. */
  const six = ([a1, a2]) => [a1[0], a1[1], a1[2], a2[0], a2[1], a2[2]];
  const fits = (c, w, vs) => c.every((value, k) => Math.abs(vs.reduce((sum, v, i) => sum + w[i] * v[k], 0) - value) <= tolerance);
  const unit = (w) => w.every((x) => x > -0.01 && x < 1.01);
  const explained = (c1, c2, list) => {
    const c = six([c1, c2]);
    const vs = list.map(six);
    if (vs.some((v) => fits(c, [1], [v]))) return true;
    const dot = (a, b) => a.reduce((sum, x, k) => sum + x * b[k], 0);
    const minus = (a, b) => a.map((x, k) => x - b[k]);
    for (let i = 0; i < vs.length; i++)
      for (let j = i + 1; j < vs.length; j++) {
        // c − b = t(a − b): the t that fits best, then whether it fits.
        const d = minus(vs[i], vs[j]);
        const length = dot(d, d);
        if (!length) continue;
        const t = dot(d, minus(c, vs[j])) / length;
        if (unit([t]) && fits(c, [t, 1 - t], [vs[i], vs[j]])) return true;
      }
    for (let i = 0; i < vs.length; i++)
      for (let j = i + 1; j < vs.length; j++)
        for (let k = j + 1; k < vs.length; k++) {
          // c − v3 = x(v1 − v3) + y(v2 − v3), solved in least squares.
          const p = minus(vs[i], vs[k]),
            q = minus(vs[j], vs[k]),
            r = minus(c, vs[k]);
          const pp = dot(p, p),
            pq = dot(p, q),
            qq = dot(q, q),
            det = pp * qq - pq * pq;
          if (Math.abs(det) < 1e-6) continue;
          const x = (dot(p, r) * qq - dot(q, r) * pq) / det,
            y = (dot(q, r) * pp - dot(p, r) * pq) / det;
          if (unit([x, y, 1 - x - y]) && fits(c, [x, y, 1 - x - y], [vs[i], vs[j], vs[k]])) return true;
        }
    return false;
  };
  /* The custom properties the sheets declare, each read where a rule declares it: a soft status ground on the
     root, the menu's remapped inks on the side menu. Read before and after the move, a pair each. */
  const declared = [];
  const walk = (list) => {
    for (const rule of list) {
      if (rule.style && rule.selectorText) {
        const names = [...rule.style].filter((name) => name.startsWith('--'));
        if (names.length) {
          let el = null;
          try {
            el = document.querySelector(rule.selectorText);
          } catch {
            /* a selector the engine reads only in a sheet (a pseudo-element) */
          }
          if (el) for (const name of names) declared.push([el, name]);
        }
      }
      if (rule.cssRules) walk(rule.cssRules);
    }
  };
  for (const sheet of document.styleSheets) {
    try {
      walk(sheet.cssRules);
    } catch {
      /* another origin's sheet: not the App's */
    }
  }
  const probe = document.createElement('i');
  document.body.append(probe);
  const resolve = () =>
    declared.map(([el, name]) => {
      const value = getComputedStyle(el).getPropertyValue(name).trim();
      probe.style.color = '';
      probe.style.color = value;
      return probe.style.color ? rgba(getComputedStyle(probe).color) : undefined;
    });
  /* What each element draws: its words' color where it has words of its own, its ground, each drawn edge and
     outline, and an SVG shape's fill and stroke. */
  const drawn = [];
  for (const el of document.querySelectorAll('body *')) {
    if (el === probe || !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    /* A control's hidden twin (a select's native input) is a pixel, none, clipped away or hidden from every reader:
       nothing anyone sees. */
    const box = el.getBoundingClientRect();
    if (box.width * box.height <= 1 || el.matches('input[aria-hidden="true"]')) continue;
    const style = getComputedStyle(el);
    if (/^rect\(0px,? 0px,? 0px,? 0px\)$/.test(style.clip) || style.clipPath === 'inset(50%)') continue;
    const parts = [];
    // A box's typed words; a checkbox's color is the browser's own mark, not a word.
    if (
      el.matches('input:not([type=checkbox], [type=radio], [type=range]), textarea, select') ||
      [...el.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim())
    )
      parts.push(['color', 'color']);
    parts.push(['background-color', 'backgroundColor']);
    for (const side of ['Top', 'Right', 'Bottom', 'Left'])
      if (style[`border${side}Style`] !== 'none' && parseFloat(style[`border${side}Width`]) > 0)
        parts.push([`border-${side.toLowerCase()}-color`, `border${side}Color`]);
    if (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) parts.push(['outline-color', 'outlineColor']);
    if (el instanceof SVGGeometryElement || el instanceof SVGTextContentElement) {
      // A line has no inside to fill.
      if (style.fill !== 'none' && !style.fill.startsWith('url(') && el.tagName !== 'line') parts.push(['fill', 'fill']);
      if (style.stroke !== 'none' && !style.stroke.startsWith('url(') && parseFloat(style.strokeWidth) > 0)
        parts.push(['stroke', 'stroke']);
    }
    drawn.push([el, parts.map(([property, key]) => [property, key, style[key]])]);
  }
  const before = resolve();
  const root = getComputedStyle(document.documentElement);
  const steady = fixed.flatMap((name) => {
    probe.style.color = '';
    probe.style.color = root.getPropertyValue(name).trim();
    return probe.style.color ? [rgba(getComputedStyle(probe).color)] : [];
  });
  const isFixed = (c) => steady.some((p) => p.every((value, k) => Math.abs(value - c[k]) <= (k === 3 ? 0.01 : tolerance)));
  // Moved without easing: a transition would read half-way between the two.
  const still = document.createElement('style');
  still.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; }';
  document.head.append(still);
  /* The roles stand on the root, and an App's accent, focus, link and their soft tint on the body as well
     (appTheme.js): each is moved where it is written. */
  const holders = [document.documentElement, document.body];
  const kept = holders.map((el) => moves.map(([name]) => el.style.getPropertyValue(name)));
  moves.forEach(([name, , to], index) => holders.forEach((el, h) => (h === 0 || kept[h][index]) && el.style.setProperty(name, to)));
  const after = resolve();
  const theme = [
    ...moves.map(([, from, to]) => [rgba(from), rgba(to)]),
    ...before.flatMap((c, index) => (c && after[index] && c[3] ? [[c, after[index]]] : [])),
  ];
  const seen = new Map();
  const verdicts = new Map();
  for (const [el, parts] of drawn) {
    const style = getComputedStyle(el);
    for (const [property, key, first] of parts) {
      const c1 = rgba(first);
      if (c1[3] === 0) continue;
      const second = style[key];
      // Most of a page draws in a handful of colors: each pair is explained once.
      const pair = `${first}|${second}`;
      if (!verdicts.has(pair)) verdicts.set(pair, second !== first ? explained(c1, rgba(second), theme) : isFixed(c1));
      if (verdicts.get(pair)) continue;
      const name = `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).join('.')}` : ''}`;
      const line = `${property} ${first}${second === first ? '' : ' (a role mixed with a literal)'}`;
      const list = seen.get(line) ?? [];
      if (list.length < 3 && !list.includes(name)) list.push(name);
      seen.set(line, list);
    }
  }
  holders.forEach((el, h) =>
    moves.forEach(([name], index) => (kept[h][index] ? el.style.setProperty(name, kept[h][index]) : el.style.removeProperty(name))),
  );
  still.remove();
  probe.remove();
  return [...seen].map(([line, elements]) => `${line} on ${elements.join(', ')}`);
}
