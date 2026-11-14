#!/usr/bin/env node
/* Loads the ui-next kit into a copy of one of the repository's Apps, the way an App installs any control kit:
   `uiKit: './ui/kit.tsx'` (site/src/content/docs/docs/control-kits.md).

     node scripts/try-in-app.mjs [app directory]      # default: examples/apps/lintel

   For Lintel it also adds two pages drawn whole by ui-next (in-app/lintel/pages): the rent roll and a lease.

   mistri compiles a kit from modules inside the App's own directory, or from installed packages, so the kit's
   sources are copied into the copy's `ui/next/`; @ui-sdk/* is found in this folder's node_modules, above it. The
   copy is written to `.app/<name>` here, which is not committed, and the App it was copied from is not touched.
   Run it from the repository root's install (Node 24): it prints how to serve the copy. */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const repo = resolve(here, '../..');
const source = resolve(repo, process.argv[2] ?? 'examples/apps/lintel');
const name = basename(source);
const app = join(here, '.app', name);

if (!existsSync(join(source, 'app.ts'))) {
  console.error(`${relative(repo, source)} has no app.ts: name an App's directory.`);
  process.exit(1);
}

rmSync(app, { recursive: true, force: true });
mkdirSync(dirname(app), { recursive: true });
cpSync(source, app, { recursive: true, filter: (path) => !path.includes(`${name}/tests`) && !path.includes('node_modules') });

/* The kit and the sheets it is dressed by, kept in the shape they have here so their imports of each other hold. */
const next = join(app, 'ui', 'next');
mkdirSync(join(next, 'src'), { recursive: true });
cpSync(join(here, 'kit'), join(next, 'kit'), {
  recursive: true,
  filter: (path) => !/\.test\.tsx$|vitest\.config\.ts$|[/\\]gallery$|[/\\]gallery[/\\]/.test(path),
});
cpSync(join(here, 'src', 'theme'), join(next, 'src', 'theme'), { recursive: true });

/* UI SDK's stylesheet dresses a few bare elements (a link, a rule, a code span). On a page of its own that is the
   page's look; in an App those elements are mistri's, and a kit's sheet is page-wide, so the App's copy of the
   sheet leaves them out. Every other rule in it names a part by its data-slot. */
const BARE = new Set(['a', ':is(a, summary):focus-visible', 'hr', 'code', 'kbd']);
function withoutBareElements(css) {
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
writeFileSync(join(next, 'web.css'), withoutBareElements(readFileSync(join(here, 'node_modules/@ui-sdk/core/dist/web.css'), 'utf8')));
const styles = join(next, 'kit', 'styles.ts');
writeFileSync(styles, readFileSync(styles, 'utf8').replace("'@ui-sdk/core/web.css'", "'../web.css'"));

const theme = process.argv.includes('--theme');
/* Whether this App has pages of its own here, drawn with one shared module (below): the kit then carries it. */
const shared = existsSync(join(here, 'in-app', name, 'pages')) && existsSync(join(here, 'in-app', name, 'ui.ts'));
writeFileSync(
  join(app, 'ui', 'kit.tsx'),
  `/* Written by experiments/ui-next/scripts/try-in-app.mjs: ui-next as this App's control kit. */
import './next/kit/styles';
${theme ? "import './next/kit/bridge.css';\n" : ''}${
    shared
      ? `import * as shared from './next/ui-real';

/* What the pages draw with, held here so the page has one copy of it (./next/ui.ts reads this). Only in a browser:
   the server reads the kit's slots with none. */
if (typeof document !== 'undefined') (globalThis as { __uiNext?: typeof shared }).__uiNext = shared;
`
      : ''
  }
export { default } from './next/kit/index';
`,
);

const manifest = join(app, 'app.ts');
const text = readFileSync(manifest, 'utf8');
if (/\buiKit\s*:/.test(text)) {
  console.error(`${name} already names a kit (uiKit). Choose an App without one.`);
  process.exit(1);
}
const at = text.lastIndexOf('} satisfies');
const close = at >= 0 ? at : text.lastIndexOf('});');
if (close < 0) {
  console.error(`Could not find where ${name}/app.ts closes its defineApp({ … }). Add uiKit: './ui/kit.tsx' by hand.`);
  process.exit(1);
}
writeFileSync(manifest, `${text.slice(0, close)}  uiKit: './ui/kit.tsx',\n${text.slice(close)}`);

/* The App's own pages drawn whole by ui-next, where this folder has some for it (`in-app/<name>/pages`): free-form
   pages (`pages/<path>.page.tsx`), each at its own address beside the App's views. Here they read the library two
   folders up; in the copy the library sits in `ui/next/src`, so their imports are pointed there. */
const pages = join(here, 'in-app', name, 'pages');
if (existsSync(pages)) {
  cpSync(join(here, 'src'), join(next, 'src'), { recursive: true });
  const moved = (text) =>
    text
      .replaceAll("'../../../src", "'../ui/next/src")
      .replaceAll("'../format'", "'../ui/next/format'")
      .replaceAll("'../lintel.css'", "'../ui/next/lintel.css'")
      .replaceAll("'../ui'", "'../ui/next/ui'");
  for (const file of readdirSync(pages)) writeFileSync(join(app, 'pages', file), moved(readFileSync(join(pages, file), 'utf8')));
  for (const file of readdirSync(join(here, 'in-app', name))) {
    if (file !== 'pages' && file !== 'ui.ts') cpSync(join(here, 'in-app', name, file), join(next, file));
  }

  /* One UI SDK on the page. mistri compiles the kit and each page to a file of its own, so `ui.ts`, the one module
     the pages draw with, is split in two here. The real one goes with the kit, which loads before anything is
     drawn and holds it; the pages get a stand-in of the same names that reads the kit's. A page then carries only
     its own code. The server also reads each page's definition with no browser behind it, so the stand-in must
     load there too: its names are simply empty until there is a kit. */
  const ui = join(here, 'in-app', name, 'ui.ts');
  if (shared) {
    const source = readFileSync(ui, 'utf8');
    writeFileSync(join(next, 'ui-real.ts'), source.replaceAll("'../../src'", "'./src'"));
    const values = [...source.matchAll(/^export \{([^}]*)\} from/gm)].flatMap((match) =>
      match[1]
        .split(',')
        .map((one) => one.trim())
        .filter(Boolean),
    );
    const types = [...source.matchAll(/^export type \{[^}]*\} from '[^']*';/gm)].map((match) => match[0].replace("'../../src'", "'./src'"));
    writeFileSync(
      join(next, 'ui.ts'),
      `/* Written by experiments/ui-next/scripts/try-in-app.mjs: the pages' stand-in for ./ui-real.ts, which the kit holds. */
type Real = typeof import('./ui-real');
const host = ((globalThis as { __uiNext?: Real }).__uiNext ?? {}) as Real;
${types.join('\n')}
${values.map((one) => `export const ${one} = host.${one};`).join('\n')}
`,
    );
  }
}

const shown = relative(repo, app);
console.log(`Wrote ${shown} with uiKit: './ui/kit.tsx'.`);
console.log(`Serve it from the repository root as the App's README serves the original, with --app ${shown}.`);
