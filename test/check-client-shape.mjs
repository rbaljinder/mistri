/**
 * One static check over the client stylesheets: does every corner and every
 * lift come from the look?
 *
 * A popup's shape was once written into each popup: `.th-menu` said 8px and
 * a soft 20px shadow, so in Mono — square, hairline — the column menu and
 * the settings menu came out round and floating beside square fields and
 * cards. The looks set shape as tokens (docs/design.md, Shape); this check
 * makes using them the default rather than the remembered extra.
 *
 * A `border-radius` passes when every term is 0, a pill's 999px, a circle's
 * 50%, or an expression over a token (`var(--radius-pop)`,
 * `min(3px, var(--radius))`: at most 3px, never rounder than the look). A
 * `box-shadow` passes when it is `none`, one token, or only drawn lines — a
 * shadow with no blur in a token's colour, such as a drop marker's 2px rule
 * in the accent — which are strokes, not lift. Token definitions are custom
 * properties and never match.
 *
 * The database browser wears no look and keeps its own values
 * (docs/design.md, Two dresses): a rule under
 * `:where(:root:not([data-visual-theme]))` is the Workbench's own and may
 * name its literal, since no look can reach it. Anything else needs an entry
 * below, with its reason.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { treeFiles } from '../scripts/workspace.mjs';

const ROOT = new URL('../', import.meta.url).pathname;
const WORKBENCH_OWN = ':where(:root:not([data-visual-theme]))';

/** `file` and a fragment of the rule's selector, and why its literal stands. */
const ALLOWED = [];

const files = treeFiles('src/client')
  .filter(({ rel }) => rel.endsWith('.css'))
  .map(({ path }) => path);

/** Split on a separator that is not inside parentheses. */
function split(value, separator) {
  const parts = [];
  let depth = 0,
    start = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0 && separator.test(c)) {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(value.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

const KEYWORD = /^(?:inherit|initial|unset|revert|revert-layer)$/;
const tokened = (term) => /^[a-z-]+\(/.test(term) && term.includes('var(--');
const radiusOk = (value) =>
  KEYWORD.test(value) || split(value, /[\s/]/).every((term) => /^(?:0|0px|999px|50%)$/.test(term) || tokened(term));

/** A layer that only draws a line: no blur, in a token's colour. */
function strokeLayer(layer) {
  const terms = split(layer, /\s/).filter((t) => t !== 'inset');
  const colour = terms.filter((t) => !/^-?[\d.]+(?:px|vmax|vmin|em|rem)?$/.test(t));
  const lengths = terms.filter((t) => /^-?[\d.]+(?:px|vmax|vmin|em|rem)?$/.test(t));
  const blur = lengths[2];
  return (
    colour.length === 1 &&
    (colour[0].startsWith('var(--') || /^(?:currentColor|transparent)$/.test(colour[0])) &&
    (blur === undefined || /^0(?:px)?$/.test(blur))
  );
}
const shadowOk = (value) =>
  KEYWORD.test(value) ||
  value === 'none' ||
  /^var\(--[\w-]+(?:,\s*var\(--[\w-]+\))?\)$/.test(value) ||
  split(value, /,/).every(strokeLayer);

const failures = [];
const used = new Set();
for (const file of files) {
  const rel = relative(ROOT, file);
  const source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  const selectors = [];
  for (const m of source.matchAll(/([^{};]+)\{|\}|([a-z-]+)\s*:\s*([^;{}]+)(?:;|(?=\}))/g)) {
    if (m[1] !== undefined) {
      selectors.push(m[1].trim().replace(/\s+/g, ' '));
      continue;
    }
    if (m[0] === '}') {
      selectors.pop();
      continue;
    }
    const property = m[2];
    const value = m[3].trim().replace(/\s*!important$/, '');
    const radius = /^border(?:-[a-z]+)*-radius$/.test(property);
    if (!radius && property !== 'box-shadow') continue;
    if (radius ? radiusOk(value) : shadowOk(value)) continue;
    const selector = selectors.at(-1) ?? '';
    if (selector.startsWith(WORKBENCH_OWN)) continue;
    const allowed = ALLOWED.find((a) => a.file === rel && selector.includes(a.selector));
    if (allowed) {
      used.add(allowed);
      continue;
    }
    const line = source.slice(0, m.index).split('\n').length;
    failures.push(`${rel}:${line}: ${selector.slice(0, 80)} { ${property}: ${value} }`);
  }
}
for (const entry of ALLOWED) if (!used.has(entry)) failures.push(`allowlist entry no longer needed: ${entry.file} ${entry.selector}`);

if (failures.length) {
  console.error('✗ a literal corner or lift outside the shape tokens:\n');
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    "\nUse the look's shape tokens (docs/design.md, Shape): --radius, --radius-item, " +
      '--radius-pop, --radius-panel, --radius-dialog, --radius-lg; --shadow-pop, ' +
      '--shadow-panel, --shadow-modal, --shadow-control. A value only the database ' +
      `browser wears goes under ${WORKBENCH_OWN}.`,
  );
  process.exit(1);
}
console.log("✓ client shape: every corner and lift comes from the look's tokens");
