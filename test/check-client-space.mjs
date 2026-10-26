/**
 * One static check over the client stylesheets: does every space and every
 * text size come from the scales?
 *
 * The sheets once held some four hundred distinct paddings, ninety gaps and
 * twenty body sizes in half-pixel steps, so an indent drifted by exactly the
 * amount a scale would have prevented and no look could move the rhythm. The
 * scales are tokens on `:root` (docs/design.md, Space and text):
 * `--space-1`…`--space-8` (and the control halves `--space-1h`, `--space-2h`, `--space-3h`
 * and `--space-4h`, 3, 6, 10 and 14px) and `--text-xs`…`--text-xl`, with the
 * semantic steps (`--room-inset`, `--section-seam`, `--row-h`) on top.
 *
 * A `padding`, `margin` or `gap` (and their sides and axes) passes when every
 * term is a token, `0`, `1px` or `-1px` (a hairline), `auto`, a percentage or
 * a keyword, or a function over a token (`calc(var(--space-4) + 2px)`). A
 * `font-size`, or the size in a `font` shorthand, passes when it is a token
 * (`--text-…`, `--type-…`) or relative (`em`, `%`, `rem`, a keyword); a size
 * written as a number over `--type-k` is a literal like any other.
 *
 * What is off the scale on purpose says why beside it, `/* off-scale: … *\/`
 * on its line or the line above. What was off the scale when the scales
 * arrived is counted, per file and value, in `client-space.allow.json`: a
 * file may hold fewer, never more, and a count that fell is lowered with
 * `node test/check-client-space.mjs --write`, so the list only shrinks.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { treeFiles } from '../scripts/workspace.mjs';

const ROOT = new URL('../', import.meta.url).pathname;
const ALLOW = join(ROOT, 'test/client-space.allow.json');
const SPACE_PROPERTY = /^(?:padding|margin|gap|row-gap|column-gap)(?:-(?:top|bottom|left|right|inline|block)(?:-(?:start|end))?)?$/;

/* Every package's client sheets, and @mistriwork/ui's, which sit at its src/ top. */
const files = [...treeFiles('src/client'), ...treeFiles('src', { recursive: false }).filter(({ pkg }) => pkg.dir === 'packages/ui')]
  .filter(({ rel }) => rel.endsWith('.css'))
  .map(({ path }) => path);

/** Split on whitespace that is not inside parentheses. */
function split(value) {
  const parts = [];
  let depth = 0,
    start = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0 && /\s/.test(c)) {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(value.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** A space term that is not the scale's: a length in px (or a function of lengths with no token in it). */
function spaceLiteral(term) {
  if (/^-?(?:0|1)(?:px)?$/.test(term) || term === '0') return undefined;
  if (/^-?[\d.]+px$/.test(term)) return term;
  if (/^[a-z-]+\(/.test(term) && /\d(?:\.\d+)?px/.test(term) && !/var\(--|env\(/.test(term)) return term;
  return undefined;
}

/** A text size written as a number over --type-k rather than a token: a step's is its token, and one off the scale
    is a new size. */
function textLiteral(term) {
  return /^calc\([\d.]+px \* var\(--type-k\)\)$/.test(term) ? term : undefined;
}

const found = {};
const failures = [];
for (const file of files) {
  const rel = relative(ROOT, file);
  const original = readFileSync(file, 'utf8');
  const lines = original.split('\n');
  const source = original.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  for (const m of source.matchAll(/(?<![\w-])([a-z-]+)\s*:\s*([^;{}]+)(?:;|(?=\}))/g)) {
    const property = m[1];
    const value = m[2].trim().replace(/\s*!important$/, '');
    let bad = [];
    if (SPACE_PROPERTY.test(property)) bad = split(value).map(spaceLiteral).filter(Boolean);
    else if (property === 'font-size') bad = [textLiteral(value)].filter(Boolean);
    else if (property === 'font')
      bad = split(value)
        .map((term) => textLiteral(term.split('/')[0]))
        .filter(Boolean);
    if (!bad.length) continue;
    const line = source.slice(0, m.index).split('\n').length;
    if (/off-scale:/.test(lines[line - 1] ?? '') || /off-scale:/.test(lines[line - 2] ?? '')) continue;
    for (const term of bad) {
      const key = `${property.startsWith('font') ? 'font-size' : 'space'} ${term}`;
      ((found[rel] ??= {})[key] ??= []).push(line);
    }
  }
}

if (process.argv.includes('--write')) {
  const out = {};
  for (const rel of Object.keys(found).sort())
    out[rel] = Object.fromEntries(
      Object.entries(found[rel])
        .sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))
        .map(([key, at]) => [key, at.length]),
    );
  writeFileSync(ALLOW, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`✓ wrote ${relative(ROOT, ALLOW)}`);
  process.exit(0);
}

const allowed = JSON.parse(readFileSync(ALLOW, 'utf8'));
for (const [rel, keys] of Object.entries(found))
  for (const [key, at] of Object.entries(keys)) {
    const may = allowed[rel]?.[key] ?? 0;
    if (at.length > may) failures.push(`${rel}:${at.join(',')}: ${key} (${at.length}, ${may} allowed)`);
  }
for (const [rel, keys] of Object.entries(allowed))
  for (const [key, may] of Object.entries(keys)) {
    const at = found[rel]?.[key]?.length ?? 0;
    if (at < may) failures.push(`${rel}: ${key} is held ${at} times, ${may} allowed: lower it (--write)`);
  }

if (failures.length) {
  console.error('✗ a space or a text size off the scales:\n');
  for (const failure of failures) console.error(`  ${failure}`);
  console.error(
    '\nWrite a step of the scale (docs/design.md, Space and text): --space-1…--space-8 (2, 4, 8, 12, 16, 24, 32, 48px) and the halves --space-1h, --space-2h, --space-3h, --space-4h (3, 6, 10, 14px), ' +
      '--text-xs…--text-xl (11, 12, 13, 14, 16, 20px), or a semantic token. A value off the scale on purpose says why ' +
      'beside it: /* off-scale: … */.',
  );
  process.exit(1);
}
const held = Object.values(allowed).reduce((sum, keys) => sum + Object.values(keys).reduce((a, b) => a + b, 0), 0);
console.log(`✓ every space and text size in ${files.length} stylesheets is on the scales (${held} older literals counted, none new)`);
