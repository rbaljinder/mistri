/**
 * UI SDK's own stylesheet as @mistriwork/ui carries it: packages/ui/src/styles/ui-sdk.css, written from
 * node_modules/@ui-sdk/core/dist/web.css.
 *
 * It is carried as a file, and not imported from the package where it is used, because it is not taken whole:
 *
 * - UI SDK's sheet dresses a few bare elements (a link, a rule, a code span). On a page of its own that is the
 *   page's look; here those elements are the kit's and an App's, and a rule for every `a` would dress theirs.
 * - It dresses every part UI SDK has, about two hundred and thirty. The packages draw with some twenty of its
 *   families, and the sheet is in every first paint, so a rule for a part nothing here draws is taken out. Which
 *   families are drawn is read from what the packages import (`@ui-sdk/react/<family>`), so importing another
 *   brings its rules back the next time this runs, and the test fails until it has.
 * - Its own default colours are never read: packages/ui/src/styles/m-tokens.css says each of those names from the
 *   package's tokens. A default left here would be a colour no theme can move, so each name that sheet says is
 *   taken out of UI SDK's.
 *
 *   node scripts/ui-sdk-css.mjs           writes the file
 *   node scripts/ui-sdk-css.mjs --check   fails if the file is not what the installed UI SDK and the imports give
 *
 * `--check` runs in the Node suite (test/ui-sdk-css.test.ts), so a UI SDK upgrade that changes its sheet is seen.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';

const root = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const SOURCE = 'node_modules/@ui-sdk/core/dist/web.css';
const TARGET = 'packages/ui/src/styles/ui-sdk.css';

/** The selectors of the rules that dress an element by its tag alone. */
const BARE = new Set(['a', ':is(a, summary):focus-visible', 'hr', 'code', 'kbd']);

/** The sheet's one layer block with the bare-element rules taken out; everything else as it was written. */
export function withoutBareElements(css) {
  const open = css.indexOf('{');
  const close = css.lastIndexOf('}');
  const body = css.slice(open + 1, close);
  let kept = '';
  let depth = 0;
  let start = 0;
  let prelude = '';
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '{') {
      if (depth === 0)
        prelude = body
          .slice(start, i)
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .trim()
          .replace(/\s+/g, ' ');
      depth++;
    } else if (body[i] === '}') {
      depth--;
      if (depth === 0) {
        if (!BARE.has(prelude)) kept += body.slice(start, i + 1);
        start = i + 1;
      }
    }
  }
  return `${css.slice(0, open + 1)}${kept}${body.slice(start)}${css.slice(close)}`;
}

/** The UI SDK families the packages draw with: every `@ui-sdk/react/<family>` a source file imports. */
export function familiesDrawn() {
  const families = new Set();
  const walk = (dir) => {
    for (const one of readdirSync(dir, { withFileTypes: true })) {
      if (one.name === 'node_modules' || one.name === 'dist') continue;
      const at = `${dir}/${one.name}`;
      if (one.isDirectory()) walk(at);
      else if (/\.tsx?$/.test(one.name) && !/\.(test|stories)\./.test(one.name))
        for (const found of readFileSync(at, 'utf8').matchAll(/from '@ui-sdk\/react\/([a-z-]+)'/g)) families.add(found[1]);
    }
  };
  for (const pkg of readdirSync(root('packages'))) if (existsSync(root(`packages/${pkg}/src`))) walk(root(`packages/${pkg}/src`));
  return families;
}

/* Parts a family draws under another's name, and the ones any of them may use. */
const SHARED = ['label', 'visually-hidden', 'separator', 'popup', 'arrow', 'backdrop', 'form-input'];

/** The top-level statements of the sheet's one layer block: `[text, prelude]` pairs, in order. */
function statements(body) {
  const out = [];
  let depth = 0;
  let start = 0;
  let prelude = '';
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '{') {
      if (depth === 0) prelude = body.slice(start, i);
      depth++;
    } else if (body[i] === '}') {
      depth--;
      if (depth === 0) {
        out.push([
          body.slice(start, i + 1),
          prelude
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .trim()
            .replace(/\s+/g, ' '),
        ]);
        start = i + 1;
      }
    }
  }
  return [out, body.slice(start)];
}

/** The sheet without the rules for parts no package draws, and without the defaults `said` already says. */
export function onlyDrawn(css, families, said) {
  const open = css.indexOf('{');
  const close = css.lastIndexOf('}');
  const [all, rest] = statements(css.slice(open + 1, close));
  const drawn = (slot) => SHARED.includes(slot) || [...families].some((family) => slot === family || slot.startsWith(`${family}-`));
  const kept = all.map(([text, prelude]) => {
    if (/^:where\(:root, :host\)$/.test(prelude)) {
      // A declaration ends at a semicolon outside any parentheses; a comment before it goes with it.
      return text.replace(/(?:\s*\/\*(?:(?!\*\/)[\s\S])*\*\/)*\s*(--ui-[a-z-]+):(?:[^;(]|\([^)]*\))*;/g, (declaration, name) =>
        said.has(name) ? '' : declaration,
      );
    }
    if (prelude.startsWith('@')) return text;
    const slots = [...prelude.matchAll(/data-slot="([a-z-]+)"/g)].map((found) => found[1]);
    return slots.length && !slots.some(drawn) ? '' : text;
  });
  return `${css.slice(0, open + 1)}${kept.join('')}${rest}${css.slice(close)}`;
}

/** What the file should hold, from the UI SDK that is installed and the families the packages import. */
export function carried() {
  const version = JSON.parse(readFileSync(root('node_modules/@ui-sdk/core/package.json'), 'utf8')).version;
  const families = familiesDrawn();
  const said = new Set(
    [...readFileSync(root('packages/ui/src/styles/m-tokens.css'), 'utf8').matchAll(/^\s*(--ui-[a-z-]+):/gm)].map((found) => found[1]),
  );
  const head = `/* UI SDK's stylesheet (@ui-sdk/core ${version}, dist/web.css; Apache-2.0, https://github.com/vercel-labs/ui), for the
   parts the packages draw (${[...families].sort().join(', ')}), without its rules for bare
   elements and without the defaults styles/m-tokens.css says. Written by scripts/ui-sdk-css.mjs, which says why:
   edit that, not this. */\n`;
  return head + onlyDrawn(withoutBareElements(readFileSync(root(SOURCE), 'utf8')), families, said);
}

if (argv[1] === fileURLToPath(import.meta.url)) {
  const text = carried();
  if (argv.includes('--check')) {
    if (readFileSync(root(TARGET), 'utf8') !== text) {
      console.error(`${TARGET} is not what ${SOURCE} gives now. Run \`node scripts/ui-sdk-css.mjs\` and read the difference.`);
      exit(1);
    }
  } else writeFileSync(root(TARGET), text);
}
