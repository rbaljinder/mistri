/**
 * One static check over the client stylesheets: does every text size follow
 * the theme's base?
 *
 * A theme's `type.base` (13px to 16px) sets the size of the text an App is
 * drawn in, and every size grows with it: the base is worn as `--type-k`
 * (base / 13px) on the root, and each size is written over it,
 * `calc(12.5px * var(--type-k))`, which is 12.5px when nothing says
 * otherwise. A size in bare pixels would stay put while the rest grew — a
 * column head at 11px under 16px rows — so this check refuses one, as
 * check-client-shape.mjs refuses a corner the look does not say.
 *
 * A `font-size` or a `font` shorthand passes when its size is relative
 * (`em`, `%`, a keyword such as `inherit` or `smaller`), a token
 * (`var(--type-list-title)`), or an expression over `--type-k`. A size token
 * (a custom property named `--type-…`) holding pixels is held to the same.
 * Density is not type: it zooms the whole room and needs nothing here.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { treeFiles } from '../scripts/workspace.mjs';

const ROOT = new URL('../', import.meta.url).pathname;

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

/** A size in pixels that does not follow the base: a bare `12px`, or an expression with pixels and no `--type-k`. */
const fixed = (term) =>
  (/^-?[\d.]+px$/.test(term) || (/\d(?:\.\d+)?px/.test(term) && /^[a-z-]+\(/.test(term))) && !term.includes('--type-k');

/** The size term of a `font` shorthand: the term before the family, its line height after a slash dropped. */
function shorthandSizes(value) {
  return split(value, /\s/).flatMap((term) => split(term, /\//).slice(0, 1));
}

const failures = [];
for (const file of files) {
  const rel = relative(ROOT, file);
  const source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  for (const m of source.matchAll(/(?<![\w-])(--type-[\w-]+|font-size|font)\s*:\s*([^;{}]+)(?:;|(?=\}))/g)) {
    const property = m[1];
    const value = m[2].trim().replace(/\s*!important$/, '');
    const terms = property === 'font' ? shorthandSizes(value) : [value];
    const bad = terms.filter(fixed);
    if (!bad.length) continue;
    const line = source.slice(0, m.index).split('\n').length;
    failures.push(`${rel}:${line}: ${property}: ${value}`);
  }
}

if (failures.length) {
  console.error('✗ a text size in pixels that does not follow the theme’s base (write calc(<n>px * var(--type-k))):\n');
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(`✓ every text size in ${files.length} stylesheets follows the theme's base`);
