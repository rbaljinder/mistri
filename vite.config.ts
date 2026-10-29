/**
 * How the client is bundled, and how it is served from source.
 *
 * The client is hand-written ES modules, in each package's src/client: the kit's page and shell, and each product's
 * rooms beside them, reached by package name (`@mistriwork/mistri/client/appShell.js`). For a long time they
 * went to the browser exactly as written — no bundler — which had one cost:
 * they could not import the TypeScript under src/shared, so the rules both
 * sides need (what a row is called, how a record's columns group, where one
 * condition ends) existed twice, and test/mirrors.test.ts held the copies
 * together. Now they import the shared modules directly, and this file is
 * what makes that runnable:
 *
 *   - at `npm run build`, `vite build` writes the kit's dist/client (packages/kit/src/clientFiles.ts), which is
 *     what the published package serves. A person running `npx tablewalk` still has
 *     no build step; the build moved into `npm run build`, which already
 *     compiled the server.
 *   - under tsx (`npm run dev`, `npm start`, the test suites), the server
 *     serves the kit's src/client through Vite's middleware — see packages/engine/src/server/devclient.ts
 *     — so an edit is a reload away and nothing has to be built first.
 *
 * Minified, with source maps. The build was unminified on purpose once, so
 * that a stack trace in a bug report named a line a person could go and look
 * at. It was also 3.4 MB of JavaScript before an App's first page could
 * paint. The maps keep the readability — they ship in the package with our
 * own sources inside (`ownSourcesOnly`), so devtools and a mapped stack trace land on the original
 * line — and the page stops paying for it.
 *
 * Every script and stylesheet is named for its content (`assets/`), so the
 * server can let a browser keep it for a year: a new build is new names,
 * and index.html, which is never cached without asking, is what points at
 * them. Each text file is compressed here, once, into `.br` and `.gz` beside
 * it, and the server picks one per request (packages/engine/src/server/clientHttp.ts) without
 * spending any CPU on it.
 */
import { defineConfig, type Plugin, type UserConfig } from 'vite';
import { RolldownMagicString, type CodeSplittingGroup } from 'rolldown';
import { parseAst } from 'rolldown/parseAst';
import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SURFACE_PAGES } from './packages/engine/src/server/clientSurface.ts';
import { KIT_CLIENT } from './packages/kit/src/clientFiles.ts';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * `./thing.js` may name `./thing.ts` — or `./thing.tsx`.
 *
 * That is how NodeNext and tsx read a relative import, and it is how every
 * import in this repo is written: the server's `.ts` files import each other
 * with `.js` extensions because that is what tsc emits. The client uses the
 * same spelling to reach src/shared, so the same line type-checks under
 * tsc, runs under tsx in the unit suite, and bundles here.
 */
export function jsMayBeTs(): Plugin {
  return {
    name: 'mistri:js-may-be-ts',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !source.startsWith('.') || !source.endsWith('.js')) return null;
      const asJs = resolve(dirname(importer), source);
      if (existsSync(asJs)) return null;
      for (const ext of ['.ts', '.tsx']) {
        const candidate = asJs.slice(0, -3) + ext;
        if (existsSync(candidate)) return candidate;
      }
      return null;
    },
  };
}

/**
 * The page's addressMount.js reads its mount from the page; the server
 * renderer (packages/mistri/src/client/ssr/render.tsx) has no page, so for a server render
 * only, that module is its server twin, which reads the mount of the
 * request being rendered. The client's own graph never sees the swap.
 */
export function ssrAddressMount(): Plugin {
  const page = resolve(HERE, 'packages/kit/src/client/addressMount.js');
  return {
    name: 'mistri:ssr-address-mount',
    enforce: 'pre',
    resolveId(source, importer, options) {
      if (!options?.ssr || !importer || !source.endsWith('addressMount.js')) return null;
      return resolve(dirname(importer), source) === page ? resolve(HERE, 'packages/mistri/src/client/ssr/addressMount.server.ts') : null;
    },
  };
}

/**
 * TanStack's devtools event client, replaced by a silent `EventClient` in the build
 * (packages/mistri/src/client/devtoolsEventClient.js says why). From source the real one
 * stays, for whoever runs the devtools.
 */
export function noDevtoolsClient(): Plugin {
  return {
    name: 'mistri:no-devtools-client',
    apply: 'build',
    enforce: 'pre',
    resolveId(source) {
      return source === '@tanstack/devtools-event-client' ? resolve(HERE, 'packages/mistri/src/client/devtoolsEventClient.js') : null;
    },
  };
}

/**
 * The client in surfaces: a chunk for each kind of first page, and the first
 * page is the entry and one surface, fetched together.
 *
 * It was one chunk, everything the entry reached, and so a sign-in screen
 * ran a fifth of what it downloaded and an App page a third: the Workbench,
 * a tenant's flows and the public pages rode along in every one. Boot is in
 * parts now (packages/kit/src/client/boot.js says which), and each product's
 * build gives each module to one. The two products build apart — the page's
 * entry names both mains (shellStart.js), and each build stands the other's
 * in with a stub (`withoutOtherMain`) — so neither ships a byte of the other:
 *
 *   the App framework's (vite.mistri.config.ts)
 *     index     the entry's own graph, the App framework's main (appShell.js,
 *               which every page runs before anything else), and whatever
 *               the public pages and the shell both need — so a first page
 *               is the entry and its own chunk, never a third one they share;
 *     public    the rest of what a public form, the landing and the sign-in
 *               screen need;
 *     shell     the rest of what an App needs to paint: the kit's shell
 *               (app.js) and the App's chrome (appnav.js);
 *     tenant    a tenant's flows, which load after the shell, so what they
 *               share with it is its.
 *
 *   the database browser's (vite.tablewalk.config.ts)
 *     index     the entry's own graph;
 *     workbench the kit's shell, the database browser's main and its tools
 *               (workbenchShell.js, workbench.js): its only page fetches all
 *               of it at once.
 *
 * Every first page is two chunks, both named in its page (`PAGES`), so both
 * download at once.
 *
 * Reachability is read once, from the finished module graph, over static
 * imports only: a part loaded on demand (components/onDemand.tsx) stays a
 * chunk of its own, as it always was. The server names a path's surface
 * in the page it sends (server/clientSurface.ts, with `surfacePages` below),
 * so the entry and its surface download at once.
 */
export type Product = 'tablewalk' | 'mistri';
const BUILDS = {
  mistri: {
    /* The entry's own: its graph, and the main it starts on every page. */
    index: ['packages/mistri/src/client/appShell.js'],
    surfaces: {
      public: ['packages/mistri/src/client/publicSurface.js'],
      shell: ['packages/kit/src/client/app.js', 'packages/mistri/src/client/appnav.js'],
      tenant: ['packages/mistri/src/client/tenantShell.js'],
    },
    /* The main the page's entry names that this build stands in for (shellStart.js). */
    other: { specifier: 'tablewalk/client/workbenchShell.js', bin: 'tablewalk' },
  },
  tablewalk: {
    index: [],
    surfaces: {
      workbench: [
        'packages/kit/src/client/app.js',
        'packages/tablewalk/src/client/workbenchShell.js',
        'packages/tablewalk/src/client/workbench.js',
      ],
    },
    other: { specifier: '@mistriwork/mistri/client/appShell.js', bin: 'mistri' },
  },
} as const satisfies Record<Product, { index: readonly string[]; surfaces: Record<string, readonly string[]>; other: object }>;

function surfaces(product: Product): { plugin: Plugin; groups: CodeSplittingGroup[] } {
  const build = BUILDS[product];
  const names = Object.keys(build.surfaces);
  const home = new Map<string, string>();
  const plugin: Plugin = {
    name: 'mistri:surfaces',
    apply: 'build',
    buildEnd() {
      const ids = [...this.getModuleIds()];
      const reach = (roots: string[], stop: Set<string> = new Set()) => {
        const seen = new Set<string>();
        const pending = [...roots];
        while (pending.length) {
          const id = pending.pop()!;
          if (seen.has(id) || stop.has(id)) continue;
          seen.add(id);
          pending.push(...(this.getModuleInfo(id)?.importedIds ?? []));
        }
        return seen;
      };
      const rooted = (name: string, files: readonly string[]) =>
        files.map((file) => {
          const root = resolve(HERE, file);
          if (!ids.includes(root)) this.error(`The ${name} surface's module, ${file}, is not in the build.`);
          return root;
        });
      const entry = reach([...ids.filter((id) => this.getModuleInfo(id)?.isEntry), ...rooted('index', build.index)]);
      const from = new Map(
        Object.entries(build.surfaces as Record<string, readonly string[]>).map(([name, files]) => [
          name,
          reach(rooted(name, files), entry),
        ]),
      );
      home.clear();
      for (const id of entry) home.set(id, 'index');
      if (product === 'mistri') {
        const [publicReach, shell, tenant] = ['public', 'shell', 'tenant'].map((name) => from.get(name)!);
        /* What the shell shares with the public pages is the entry's: both first pages fetch it. */
        for (const id of shell) home.set(id, publicReach.has(id) ? 'index' : 'shell');
        for (const id of publicReach) if (!home.has(id)) home.set(id, 'public');
        for (const id of tenant) if (!home.has(id)) home.set(id, 'tenant');
      } else {
        for (const id of from.get('workbench')!) if (!home.has(id)) home.set(id, 'workbench');
      }
    },
  };
  /* Highest first: a group takes its modules' dependencies with it unless a
     group before it has them, so the entry's are claimed before any surface's. */
  const order = ['index', ...names];
  const groups = order.map((name, i) => ({ name, priority: order.length - i, test: (id: string) => home.get(id) === name }));
  return { plugin, groups };
}

/**
 * The other product's main, as this build sees it: a module that says whose page this is not. The page's entry
 * names both mains (shellStart.js, the client's bin), and the server of each product only ever sends a page that
 * starts its own, so the stand-in runs only on a page a server of this product did not send.
 */
export function withoutOtherMain(product: Product): Plugin {
  const { specifier, bin } = BUILDS[product].other;
  const id = '\0mistri:other-main';
  return {
    name: 'mistri:without-other-main',
    apply: 'build',
    enforce: 'pre',
    resolveId(source) {
      return source === specifier ? id : null;
    },
    load(loaded) {
      if (loaded !== id) return null;
      const said = JSON.stringify(`This page is ${bin}'s, and this build is ${product}'s: run npx ${bin} to serve it.`);
      return `export async function start() { throw new Error(${said}); }\n`;
    },
  };
}

/**
 * The chrome's words in another language (packages/kit/src/client/copy/es.ts), one chunk
 * per language, named `copy.<language>`: fetched only for a reader said that
 * language (messages.ts), and named by the server beside the entry for one
 * it knows is (server/clientSurface.ts `localePreloads`), whose budget is
 * scripts/bundle-budget.mjs's `LOCALE_BUDGET`. Every surface's words are the
 * shared table's today, so a language is one chunk, not one per surface.
 */
const LOCALE_WORDS = /\/src\/client\/copy\/([a-z]{2,3})\.ts$/;
const LOCALE_GROUP: CodeSplittingGroup = {
  name: (id: string) => {
    const language = LOCALE_WORDS.exec(id)?.[1];
    return language ? `copy.${language}` : null;
  },
  priority: 10,
  test: LOCALE_WORDS,
};

/**
 * One page per first-page surface, each naming its chunks for the browser to
 * fetch beside the entry (server/clientSurface.ts sends the one an address
 * needs). Without it the surface is asked for only once the entry has run —
 * a round trip in front of every first paint. Each product writes its own
 * pages: an App's (the shell surface, index.html) and a public one's, or the
 * Workbench's. The database browser's index.html is the entry alone.
 */
const PAGES: Record<Product, Partial<Record<keyof typeof SURFACE_PAGES, string[]>>> = {
  mistri: { shell: ['shell'], public: ['public'] },
  tablewalk: { workbench: ['workbench'] },
};
function surfacePages(product: Product): Plugin {
  return {
    name: 'mistri:surface-pages',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const page = bundle['index.html'];
      if (page?.type !== 'asset') this.error('The build wrote no index.html to name the surfaces in.');
      const html = String(page.source);
      for (const [surface, chunks] of Object.entries(PAGES[product]) as [keyof typeof SURFACE_PAGES, string[]][]) {
        const name = SURFACE_PAGES[surface];
        const tags = chunks
          .flatMap((wanted) => {
            const chunk = Object.values(bundle).find((file) => file.type === 'chunk' && file.name === wanted);
            if (!chunk) this.error(`The build has no ${wanted} chunk for ${name}.`);
            /* Its stylesheet too, as a link rather than the import's own late
               injection: nothing it styles is drawn before it has arrived. */
            const css = [...(chunk.viteMetadata?.importedCss ?? [])].map((file) => `<link rel="stylesheet" crossorigin href="/${file}">`);
            return [`<link rel="modulepreload" crossorigin href="/${chunk.fileName}">`, ...css];
          })
          .join('\n    ');
        const source = html.replace(
          /(<link rel="stylesheet" crossorigin href="\/assets\/[^"]+\.css">)(?![\s\S]*<link rel="stylesheet" crossorigin href="\/assets\/)/,
          `$1\n    ${tags}`,
        );
        if (source === html) this.error(`index.html has no built stylesheet to name ${surface}'s chunk beside.`);
        if (name === 'index.html') page.source = source;
        else this.emitFile({ type: 'asset', fileName: name, source });
      }
    },
  };
}

/**
 * The license of every face the build ships (src/client/fonts/), written
 * beside the client as `fonts/<name>`: Lumen's Inter, Workshop's Barlow and Ledger's IBM Plex Mono are
 * under the SIL Open Font License, which asks that its text travel with the font, and dist is
 * what the package's `files` allowlist ships.
 */
function fontLicenses(): Plugin {
  const dir = resolve(HERE, 'packages/kit/src/client/fonts');
  return {
    name: 'mistri:font-licenses',
    apply: 'build',
    generateBundle() {
      for (const name of readdirSync(dir).filter((file) => file.endsWith('.txt')))
        this.emitFile({ type: 'asset', fileName: `fonts/${name}`, source: readFileSync(join(dir, name)) });
    },
  };
}

/**
 * What the server may send compressed. Images and fonts are compressed
 * already, and source maps are left out: only devtools fetches one, a person
 * waits for nothing, and their `.br` and `.gz` copies were most of what the
 * package grew by. The server sends a file with no variant as it is.
 */
const TEXT = /\.(html|js|css|json|svg|txt)$/;

/**
 * A `.br` and a `.gz` beside every text file the build wrote, at the
 * highest settings, because this runs once per release and the result is
 * read by every page load after it. A variant that comes out no smaller
 * than its file is not written; the server sends the file as it is.
 */
function precompress(outDir: string): Plugin {
  return {
    name: 'mistri:precompress',
    apply: 'build',
    writeBundle(options, bundle) {
      const dir = options.dir ?? outDir;
      for (const name of Object.keys(bundle)) {
        if (!TEXT.test(name)) continue;
        const path = join(dir, name);
        const data = readFileSync(path);
        const br = brotliCompressSync(data, {
          params: {
            [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
            [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
            [constants.BROTLI_PARAM_SIZE_HINT]: data.length,
          },
        });
        const gz = gzipSync(data, { level: constants.Z_BEST_COMPRESSION });
        if (br.length < data.length) writeFileSync(`${path}.br`, br);
        if (gz.length < data.length) writeFileSync(`${path}.gz`, gz);
      }
    },
  };
}

/**
 * The maps keep tablewalk's own sources and drop the libraries'.
 *
 * The maps ship with their sources inside so a person debugging an installed
 * copy can read the code a trace lands in — and that is ours: React's,
 * TanStack's and Base UI's sources are published in their own packages, and
 * were a quarter of the package's bytes (1.9 MB of the maps' 7.9). A frame in
 * a library still maps to its file and line; devtools shows the file's name
 * and asks for its text. Rewritten on disk after the write, because a map is
 * neither hashed into a file name nor precompressed.
 */
export function ownSourcesOnly(outDir: string): Plugin {
  return {
    name: 'mistri:own-sources-only',
    apply: 'build',
    writeBundle(options, bundle) {
      const dir = options.dir ?? outDir;
      // A chunk's map is written beside it and may not be an entry of its own.
      const maps = new Set(Object.keys(bundle).map((name) => (name.endsWith('.map') ? name : `${name}.map`)));
      for (const name of maps) {
        const path = join(dir, name);
        if (!existsSync(path)) continue;
        const map = JSON.parse(readFileSync(path, 'utf8')) as { sources: string[]; sourcesContent?: (string | null)[] };
        if (!map.sourcesContent) continue;
        map.sourcesContent = map.sourcesContent.map((content, at) => (/(^|\/)node_modules\//.test(map.sources[at]) ? null : content));
        writeFileSync(path, JSON.stringify(map));
      }
    },
  };
}

/**
 * The catalog's keys, short in the build.
 *
 * A key is named for what it says (`noRowsMatch`), which is what a person
 * reading the source wants and what a first page does not: each one is
 * written twice, in its module's table (src/client/copy/) and where it is
 * said, and at the catalog's move that was most of the 50 KB the App's first
 * page grew by. Here each table's keys become `a`, `b`, … in the order it
 * lists them, and every call in the one module that says it is renamed to
 * match. A shared word (`common.*` in messages.ts) becomes `.a`, `.b`, …
 * there and wherever it is said; the other shared keys keep their names,
 * since some are said through a variable (conditionText.ts's connectives),
 * which a build cannot follow. A table's letters never shadow a dotted
 * name. The edits go
 * through rolldown's MagicString, so the maps still land on the source's
 * line and column; under Vite's middleware (tsx, the test suites) nothing
 * is renamed.
 *
 * A key the build cannot see is refused rather than guessed: a table's call
 * must name its key as a string, or a condition between strings, and the
 * speaker may not travel as a value, since a call made elsewhere could not
 * be renamed.
 */
export function shortCatalogKeys(): Plugin {
  /* Every package's catalogs: each layer keeps the words its own client says. */
  const COPY = /\/packages\/[^/]+\/src\/client\/copy\//;
  const LETTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const letters = (n: number): string =>
    n < LETTERS.length ? LETTERS[n] : letters(Math.floor(n / LETTERS.length) - 1) + LETTERS[n % LETTERS.length];
  const tables = new Map<string, Map<string, string>>();
  const tableOf = (file: string): Map<string, string> => {
    let table = tables.get(file);
    if (!table) {
      /* Its English is defineMessages' first object; any translations follow it, under the same keys. */
      const program = parseAst(readFileSync(file, 'utf8'), { lang: 'ts' }) as unknown as Node;
      let keys: string[] = [];
      const visit = (node: Node) => {
        const callee = node.callee as Node | undefined;
        if (node.type === 'CallExpression' && callee?.type === 'Identifier' && callee.name === 'defineMessages') {
          const english = (node.arguments as Node[])[0];
          keys = ((english?.properties as Node[] | undefined) ?? []).map((property) => nameOf(property.key as Node) ?? '');
          return;
        }
        children(node).forEach(visit);
      };
      visit(program);
      table = new Map(keys.map((key, at) => [key, letters(at)]));
      tables.set(file, table);
    }
    return table;
  };
  const MESSAGES = resolve(HERE, 'packages/kit/src/client/messages.ts');
  let shared: Map<string, string> | undefined;
  const sharedOf = (): Map<string, string> => {
    if (!shared) {
      const source = readFileSync(MESSAGES, 'utf8');
      const start = source.indexOf('  en: {');
      const english = source.slice(start, source.indexOf('\n  },\n', start));
      const keys = [...english.matchAll(/^ {4}'(common\.\w+)':\s/gm)].map((match) => match[1]);
      shared = new Map(keys.map((key, at) => [key, `.${letters(at)}`]));
    }
    return shared;
  };
  /* Where an import of a catalog lands: a relative one beside its module, a workspace package's (`@mistriwork/kit/client/
     messages.js`, how the App framework and the database browser name the kit's words) through that package's exports
     map, as Vite resolves it here — its source. */
  const PACKAGE = /^(@mistriwork\/[^/]+|tablewalk)\/(.+)$/;
  const manifests = new Map<string, { dir: string; exports: Record<string, unknown> }>();
  const sourceOf = (importer: string, specifier: string): string | undefined => {
    if (specifier.startsWith('.')) return resolve(dirname(importer), specifier).replace(/\.js$/, '.ts');
    const [, name, path] = PACKAGE.exec(specifier) ?? [];
    if (!name) return undefined;
    let manifest = manifests.get(name);
    if (!manifest) {
      const dir = resolve(HERE, 'packages', name.replace(/^@mistriwork\//, ''));
      if (!existsSync(join(dir, 'package.json'))) return undefined;
      manifest = { dir, exports: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).exports ?? {} };
      manifests.set(name, manifest);
    }
    const target = manifest.exports[`./${path}`];
    const file = typeof target === 'string' ? target : (target as { default?: unknown } | undefined)?.default;
    return typeof file === 'string' ? resolve(manifest.dir, file) : undefined;
  };
  type Node = { type: string; start: number; end: number; [field: string]: unknown };
  const children = (node: Node): Node[] =>
    Object.values(node).flatMap((value) =>
      (Array.isArray(value) ? value : [value]).filter(
        (item): item is Node => !!item && typeof item === 'object' && typeof (item as Node).type === 'string',
      ),
    );
  const nameOf = (key: Node): string | undefined =>
    key.type === 'Identifier' ? (key.name as string) : key.type === 'Literal' && typeof key.value === 'string' ? key.value : undefined;
  return {
    name: 'mistri:short-catalog-keys',
    apply: 'build',
    enforce: 'post',
    transform(code, rawId) {
      const id = rawId.split('?')[0];
      if (!/\/packages\/[^/]+\/src\/client\//.test(id)) return null;
      const isTable = COPY.test(id);
      if (id !== MESSAGES && !isTable && !/\/(?:copy\/[\w/]+|messages)\.js['"]/.test(code)) return null;
      const program = this.parse(code) as unknown as Node;
      const out = new RolldownMagicString(code);
      if (id === MESSAGES) {
        const visit = (node: Node) => {
          if (node.type === 'VariableDeclarator' && (node.id as Node).type === 'Identifier' && (node.id as Node).name === 'catalog') {
            for (const language of (node.init as Node).properties as Node[]) {
              for (const property of (language.value as Node).properties as Node[]) {
                const to = sharedOf().get(nameOf(property.key as Node) ?? '');
                if (to !== undefined) out.overwrite((property.key as Node).start, (property.key as Node).end, JSON.stringify(to));
              }
            }
            return;
          }
          children(node).forEach(visit);
        };
        visit(program);
        return { code: out };
      }
      /* Another language's shared words (copy/es.ts): its keys are messages.ts's, shortened as they are there. */
      if (LOCALE_WORDS.test(id)) {
        const visit = (node: Node) => {
          if (node.type === 'VariableDeclarator' && (node.init as Node | undefined)?.type === 'ObjectExpression') {
            for (const property of (node.init as Node).properties as Node[]) {
              const to = sharedOf().get(nameOf(property.key as Node) ?? '');
              if (to !== undefined) out.overwrite((property.key as Node).start, (property.key as Node).end, JSON.stringify(to));
            }
            return;
          }
          children(node).forEach(visit);
        };
        visit(program);
        return { code: out };
      }
      if (isTable) {
        const table = tableOf(id);
        const renameKeys = (object: Node | undefined) => {
          if (object?.type !== 'ObjectExpression') this.error(`${id}: a table must be an object written out.`);
          for (const property of object.properties as Node[]) {
            const name = property.type === 'Property' && !property.computed ? nameOf(property.key as Node) : undefined;
            const to = name === undefined ? undefined : table.get(name);
            if (to === undefined) this.error(`${id}: every key of a table must be written as a name, one to a line.`);
            out.overwrite((property.key as Node).start, (property.key as Node).end, to);
          }
        };
        const visit = (node: Node) => {
          if (
            node.type === 'CallExpression' &&
            (node.callee as Node).type === 'Identifier' &&
            (node.callee as Node).name === 'defineMessages'
          ) {
            const [english, translated] = node.arguments as Node[];
            renameKeys(english);
            for (const language of (translated?.properties as Node[] | undefined) ?? []) renameKeys(language.value as Node);
            return;
          }
          children(node).forEach(visit);
        };
        visit(program);
        return { code: out };
      }
      /* The module that says: which of its names speak — a table's `say`, or messages.ts's `message`. */
      const speakers = new Map<string, Map<string, string> | null>();
      for (const node of program.body as Node[]) {
        if (node.type !== 'ImportDeclaration') continue;
        const from = sourceOf(id, (node.source as Node).value as string);
        if (!from) continue;
        const want = COPY.test(from) ? 'say' : from === MESSAGES ? 'message' : undefined;
        if (!want) continue;
        for (const specifier of node.specifiers as Node[]) {
          if (specifier.type === 'ImportSpecifier' && nameOf(specifier.imported as Node) === want)
            speakers.set((specifier.local as Node).name as string, want === 'say' ? tableOf(from) : null);
        }
      }
      if (!speakers.size) return null;
      const key = (node: Node, table: Map<string, string> | null) => {
        if (node.type === 'ConditionalExpression') {
          key(node.consequent as Node, table);
          key(node.alternate as Node, table);
          return;
        }
        /* messages.ts's own speaker may be handed a key in a variable: those are left as they are. */
        if (node.type !== 'Literal' || typeof node.value !== 'string') {
          if (table) this.error(`${id}: a key must be written as a string, or a condition between strings.`);
          return;
        }
        const to = table?.get(node.value) ?? sharedOf().get(node.value);
        if (to !== undefined) out.overwrite(node.start, node.end, JSON.stringify(to));
        else if (table && !node.value.includes('.')) this.error(`${id}: ${node.value} is not in its table.`);
      };
      const visit = (node: Node, parent: Node | undefined) => {
        if (node.type === 'ImportDeclaration') return;
        if (
          node.type === 'CallExpression' &&
          (node.callee as Node).type === 'Identifier' &&
          speakers.has((node.callee as Node).name as string)
        ) {
          const [first] = node.arguments as Node[];
          if (!first) this.error(`${id}: a call to its table names no key.`);
          key(first, speakers.get((node.callee as Node).name as string)!);
          for (const argument of node.arguments as Node[]) visit(argument, node);
          return;
        }
        if (
          node.type === 'Identifier' &&
          speakers.get(node.name as string) &&
          !(parent?.type === 'Property' && parent.key === node && !parent.shorthand) &&
          !(parent?.type === 'MemberExpression' && parent.property === node && !parent.computed)
        ) {
          this.error(`${id}: ${node.name as string} travels as a value; say its key where it is called.`);
        }
        for (const child of children(node)) visit(child, node);
      };
      visit(program, undefined);
      return out.hasChanged() ? { code: out } : null;
    },
  };
}

/**
 * The client's config: with a product, that product's build (vite.tablewalk.config.ts, vite.mistri.config.ts) into
 * its own dist/client; without one, the source serving devclient.ts and the test suites use, which serves both mains
 * from the kit's sources and builds nothing.
 */
export function clientConfig(product?: Product): UserConfig {
  const outDir = product ? resolve(HERE, `packages/${product}/dist/client`) : resolve(HERE, 'node_modules/.cache/client-unbuilt');
  const split = product ? surfaces(product) : undefined;
  return {
    root: KIT_CLIENT.source,
    /* Builds and direct Vite use keep this checkout's dependencies apart from a
     linked worktree. Source middleware servers override this with one fresh
     directory per Vite generation in devclient.ts: Vite mutates optimizer
     metadata as it discovers imports, so independent processes cannot safely
     share even a checkout-scoped directory. */
    cacheDir: resolve(HERE, 'node_modules/.vite', `client-${createHash('sha256').update(HERE).digest('hex').slice(0, 12)}`),
    plugins: [
      ssrAddressMount(),
      jsMayBeTs(),
      noDevtoolsClient(),
      ...(product ? [withoutOtherMain(product), split!.plugin, surfacePages(product)] : [productless()]),
      /* Only the React half. Left to its default the plugin also rewrites
       the hand-written .js modules on their way to the browser — quoting,
       spacing — and e2e/mutations.spec.ts patches those modules by their
       source text; a module that arrives reformatted matches none of its
       patches. */
      react({ include: /\.[jt]sx$/ }),
      shortCatalogKeys(),
      fontLicenses(),
      precompress(outDir),
      ownSourcesOnly(outDir),
    ],
    /* A script names the files it loads (a lazy chunk's stylesheet, its
     preloads) relative to itself, not from the root: a server behind a
     reverse proxy under a path (`--base-path /tools`, shared/mount.ts) is
     at /tools/assets/, and the page the server sends says so in its own
     tags. A stylesheet names its face (lumenLook.css) beside itself the
     same way. The pages keep `/assets/`, which the server rewrites. */
    experimental: { renderBuiltUrl: (_file, { hostType }) => (hostType === 'js' || hostType === 'css' ? { relative: true } : undefined) },
    build: {
      outDir,
      emptyOutDir: true,
      target: 'es2023',
      minify: true,
      /* Beside each file, our sources included: the package is the only place
       a person debugging an installed copy can find them. The libraries'
       are in their own packages (`ownSourcesOnly`). */
      sourcemap: true,
      rolldownOptions: {
        output: {
          /* Hashed, the entry too, and all under assets/: that directory is
           the server's whole rule for what may be cached for good. The
           release workflow finds the entry through index.html. */
          entryFileNames: 'assets/[name]-[hash].js',
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
          /* One chunk for each surface's first page (`surfaces`, above).
           Left alone, the bundler cuts the graph into some thirty pieces
           along the seams it shares with the parts loaded on demand
           (components/onDemand.tsx), and a first visit fetches every piece.
           Those parts stay chunks of their own. */
          codeSplitting: { groups: [LOCALE_GROUP, ...(split?.groups ?? [])] },
        },
      },
    },
    server: {
      /* src/shared and src/adapters sit outside the client root. */
      fs: { allow: [HERE] },
    },
  };
}

/** The config with no product builds nothing: a client is one product's (vite.tablewalk.config.ts, vite.mistri.config.ts). */
function productless(): Plugin {
  return {
    name: 'mistri:productless',
    apply: 'build',
    buildStart() {
      this.error('Build the client as one product: vite build -c vite.tablewalk.config.ts, or -c vite.mistri.config.ts.');
    },
  };
}

export default defineConfig(clientConfig());
