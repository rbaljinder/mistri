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
 * length in `rem` is held exactly as one in `px` is: `0.4375rem` is 7px by
 * another name, and the lazy surface sheets once wrote some 1,100 spaces that
 * way, 7, 5, 11 and 9px among them, where a rule that read only `px` never
 * looked. An `em` passes: it is a share of the element's own text, which no
 * step of a fixed scale can say. A
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
import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { treeFiles } from '../scripts/workspace.mjs';

const ROOT = new URL('../', import.meta.url).pathname;
const ALLOW = join(ROOT, 'test/client-space.allow.json');
const SPACE_PROPERTY = /^(?:padding|margin|gap|row-gap|column-gap)(?:-(?:top|bottom|left|right|inline|block)(?:-(?:start|end))?)?$/;

/** Every package's client sheets, and @mistriwork/ui's handwritten sheets (ui-sdk*.css are generated from @ui-sdk/core). */
const sheets = () =>
  [...treeFiles('src/client'), ...treeFiles('src').filter(({ pkg }) => pkg.dir === 'packages/ui')]
    .filter(({ rel }) => rel.endsWith('.css') && rel !== 'styles/ui-sdk.css' && rel !== 'styles/ui-sdk-surfaces.css')
    .map(({ path }) => path);

/** Split on whitespace that is not inside parentheses. */
export function split(value) {
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

/** A space term that is not the scale's: a length in px or rem (or a function of such lengths with no token in it).
    A zero is a zero in either unit; the hairline is `1px`, and `0.0625rem` is not a second spelling of it. */
export function spaceLiteral(term) {
  if (/^-?(?:0|1)(?:px)?$/.test(term) || term === '0') return undefined;
  if (/^-?(?:0+\.?0*|\.0+)rem$/.test(term)) return undefined;
  if (/^-?[\d.]+(?:px|rem)$/.test(term)) return term;
  if (/^[a-z-]+\(/.test(term) && /\d(?:\.\d+)?(?:px|rem)/.test(term) && !/var\(--|env\(/.test(term)) return term;
  return undefined;
}

/** A text size written as a number over --type-k rather than a token: a step's is its token, and one off the scale
    is a new size. */
export function textLiteral(term) {
  return /^calc\([\d.]+px \* var\(--type-k\)\)$/.test(term) ? term : undefined;
}

/** What one sheet holds off the scales: `{ key, line }` per term, a key being `space 7px` or `font-size calc(…)`. A
    declaration with `off-scale:` in a comment on its line, or on the line above, is off the scale on purpose. */
export function literalsIn(original) {
  const out = [];
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
    for (const term of bad) out.push({ key: `${property.startsWith('font') ? 'font-size' : 'space'} ${term}`, line });
  }
  return out;
}

/** What is wrong between what the sheets hold (`{ file: { key: [line] } }`) and what the list counts: more than it
    allows, or fewer, which is a count to lower. */
export function problems(found, allowed) {
  const failures = [];
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
  return failures;
}

/** Every sheet's literals, by its path from the repository's root. */
export function findAll(files = sheets()) {
  const found = {};
  for (const file of files) {
    const rel = relative(ROOT, file);
    for (const { key, line } of literalsIn(readFileSync(file, 'utf8'))) ((found[rel] ??= {})[key] ??= []).push(line);
  }
  return found;
}

function main(argv) {
  const files = sheets();
  const found = findAll(files);

  if (argv.includes('--write')) {
    const out = {};
    for (const rel of Object.keys(found).sort())
      out[rel] = Object.fromEntries(
        Object.entries(found[rel])
          .sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))
          .map(([key, at]) => [key, at.length]),
      );
    writeFileSync(ALLOW, `${JSON.stringify(out, null, 2)}\n`);
    console.log(`✓ wrote ${relative(ROOT, ALLOW)}`);
    return 0;
  }

  const allowed = JSON.parse(readFileSync(ALLOW, 'utf8'));
  const failures = problems(found, allowed);

  if (failures.length) {
    console.error('✗ a space or a text size off the scales:\n');
    for (const failure of failures) console.error(`  ${failure}`);
    console.error(
      '\nWrite a step of the scale (docs/design.md, Space and text): --space-1…--space-8 (2, 4, 8, 12, 16, 24, 32, 48px) and the halves --space-1h, --space-2h, --space-3h, --space-4h (3, 6, 10, 14px: a length in rem is a literal as one in px is), ' +
        '--text-xs…--text-xl (11, 12, 13, 14, 16, 20px), or a semantic token. A value off the scale on purpose says why ' +
        'beside it: /* off-scale: … */.',
    );
    return 1;
  }
  const held = Object.values(allowed).reduce((sum, keys) => sum + Object.values(keys).reduce((a, b) => a + b, 0), 0);
  console.log(`✓ every space and text size in ${files.length} stylesheets is on the scales (${held} older literals counted, none new)`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main(process.argv.slice(2));
