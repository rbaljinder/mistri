/**
 * `@mistriwork/kit/vite`: how a product bundles the kit's page, and how it serves it from source.
 *
 * The page is the kit's — its index.html, its entry (boot.js), the shell — and each product builds it into its own
 * dist/client with its own main: the App framework's (config/vite.mistri.config.ts) and the database browser's (in
 * its own repository, over the published kit). This is the part they share, so a product checked out on its own,
 * over the published kit, builds the same page the same way:
 *
 *   - the page's entry starts `virtual:mistri/shell-main`, which `shellMain` answers with the product's main: the kit
 *     names neither product, and a product's bundle holds only its own main;
 *   - the client in surfaces (`surfaces`): a chunk for each kind of first page, and a page per surface naming its
 *     chunks (`surfacePages`), so the entry and its surface download at once;
 *   - minified, with source maps that carry our own sources (`ownSourcesOnly`), every text file precompressed once
 *     (`precompress`), the catalog's keys short (`shortCatalogKeys`), the faces' licenses beside them
 *     (`fontLicenses`), and TanStack's devtools client silent (`noDevtoolsClient`).
 *
 * The kit's client folder is its sources in a checkout (src/client) and the built modules an install carries
 * (dist/client): `KIT_CLIENT.source`, beside this module either way. The rules below read a module by what it is (a
 * catalog, a table of words, the shared words), not by where a checkout keeps it, so they hold for both.
 *
 * Minified, with source maps. The build was unminified on purpose once, so that a stack trace in a bug report named a
 * line a person could go and look at. It was also 3.4 MB of JavaScript before an App's first page could paint. The
 * maps keep the readability, and the page stops paying for it.
 *
 * Every script and stylesheet is named for its content (`assets/`), so the server can let a browser keep it for a
 * year: a new build is new names, and index.html, which is never cached without asking, is what points at them.
 */
import type { Plugin, PluginOption, UserConfig } from 'vite';
import { parseAst } from 'rolldown/parseAst';
import { RolldownMagicString, type CodeSplittingGroup } from 'rolldown';
import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { KIT_CLIENT } from './clientFiles.js';

/** The name the page's entry starts the product's main by (shellStart.js; shellMain.d.ts types it). */
export const SHELL_MAIN = 'virtual:mistri/shell-main';

/** The kit's client folder, with its trailing separator. */
const KIT = KIT_CLIENT.source.endsWith(sep) ? KIT_CLIENT.source : KIT_CLIENT.source + sep;

/**
 * A module of the kit's client by the name an import gives it (`app.js`, `shellHost.js`): the file itself, or the
 * TypeScript a `.js` name stands for in a checkout.
 */
export function kitModule(name: string): string {
  const path = resolve(KIT, name);
  if (existsSync(path)) return path;
  for (const ext of ['.ts', '.tsx']) {
    const candidate = path.replace(/\.js$/, ext);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`@mistriwork/kit/vite: the kit's client has no module ${name}.`);
}

/**
 * `./thing.js` may name `./thing.ts` — or `./thing.tsx`.
 *
 * That is how NodeNext and tsx read a relative import, and it is how every import in this repository is written: the
 * server's `.ts` files import each other with `.js` extensions because that is what tsc emits. The client uses the
 * same spelling to reach src/shared, so the same line type-checks under tsc, runs under tsx in the unit suite, and
 * bundles here.
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
 * The product's main, for the page's entry: `virtual:mistri/shell-main` is `main`, the module itself, so the build
 * sees the same graph it would through a plain import() of it.
 */
export function shellMain(main: string): Plugin {
  return {
    name: 'mistri:shell-main',
    enforce: 'pre',
    resolveId: (source) => (source === SHELL_MAIN ? main : null),
  };
}

/**
 * TanStack's devtools event client, replaced by a silent `EventClient` in the build (the kit's
 * devtoolsEventClient.js says why). From source the real one stays, for whoever runs the devtools.
 */
export function noDevtoolsClient(): Plugin {
  const silent = kitModule('devtoolsEventClient.js');
  return {
    name: 'mistri:no-devtools-client',
    apply: 'build',
    enforce: 'pre',
    resolveId: (source) => (source === '@tanstack/devtools-event-client' ? silent : null),
  };
}

/**
 * The client in surfaces: a chunk for each kind of first page, and the first page is the entry and one surface,
 * fetched together.
 *
 * It was one chunk, everything the entry reached, and so a sign-in screen ran a fifth of what it downloaded and an App
 * page a third: the Workbench, a tenant's flows and the public pages rode along in every one. Boot is in parts now
 * (the kit's boot.js says which), and each product's build gives each module to one:
 *
 *   index     the entry's own graph, and whatever the product lists beside it (`index`): the App framework's main,
 *             which every App page runs before anything else;
 *   surfaces  in the order given, each takes what it reaches that no earlier part has (`surfaces`), except what two
 *             of them both reach where the product says that is the entry's (`sharedWithEntry`): an App's shell
 *             and its public pages, both first pages, so neither fetches a third chunk they share.
 *
 * Reachability is read once, from the finished module graph, over static imports only: a part loaded on demand
 * (components/onDemand.tsx) stays a chunk of its own, as it always was. The server names a path's surface in the page
 * it sends (the engine's server/clientSurface.ts, with `surfacePages` below), so the entry and its surface download
 * at once.
 */
interface Surfaces {
  /** Modules the entry's chunk holds beside the entry's own graph, by path. */
  index?: readonly string[];
  /** Each surface's roots, by path, in the order they claim modules. */
  surfaces: Readonly<Record<string, readonly string[]>>;
  /** Pairs of surfaces whose shared modules are the entry's. */
  sharedWithEntry?: readonly (readonly [string, string])[];
}

function surfaces({ index = [], surfaces: parts, sharedWithEntry = [] }: Surfaces): {
  plugin: Plugin;
  groups: CodeSplittingGroup[];
} {
  const names = Object.keys(parts);
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
          if (!ids.includes(file)) this.error(`The ${name} surface's module, ${file}, is not in the build.`);
          return file;
        });
      const entry = reach([...ids.filter((id) => this.getModuleInfo(id)?.isEntry), ...rooted('index', index)]);
      const from = new Map(Object.entries(parts).map(([name, files]) => [name, reach(rooted(name, files), entry)]));
      home.clear();
      for (const id of entry) home.set(id, 'index');
      for (const [a, b] of sharedWithEntry) for (const id of from.get(a)!) if (from.get(b)!.has(id)) home.set(id, 'index');
      for (const name of names) for (const id of from.get(name)!) if (!home.has(id)) home.set(id, name);
    },
  };
  /* Highest first: a group takes its modules' dependencies with it unless a group before it has them, so the entry's
     are claimed before any surface's. */
  const order = ['index', ...names];
  const groups = order.map((name, i) => ({ name, priority: order.length - i, test: (id: string) => home.get(id) === name }));
  return { plugin, groups };
}

/**
 * The chrome's words in another language (the kit's client/copy/es.ts), one chunk per language, named
 * `copy.<language>`: fetched only for a reader said that language (messages.ts), and named by the server beside the
 * entry for one it knows is (server/clientSurface.ts `localePreloads`). Every surface's words are the shared table's
 * today, so a language is one chunk, not one per surface.
 */
const LOCALE_WORDS = /\/client\/copy\/([a-z]{2,3})\.[jt]s$/;
const LOCALE_GROUP: CodeSplittingGroup = {
  name: (id: string) => {
    const language = LOCALE_WORDS.exec(id)?.[1];
    return language ? `copy.${language}` : null;
  },
  priority: 10,
  test: LOCALE_WORDS,
};

/**
 * One page per first-page surface, each naming its chunks for the browser to fetch beside the entry (the engine's
 * server/clientSurface.ts sends the one an address needs). Without it the surface is asked for only once the entry
 * has run — a round trip in front of every first paint. `pages` is each page's file name (clientSurface.ts
 * `SURFACE_PAGES`) and the chunks it names; index.html is written in place.
 */
function surfacePages(pages: Readonly<Record<string, readonly string[]>>): Plugin {
  return {
    name: 'mistri:surface-pages',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const page = bundle['index.html'];
      if (page?.type !== 'asset') this.error('The build wrote no index.html to name the surfaces in.');
      const html = String(page.source);
      for (const [name, chunks] of Object.entries(pages)) {
        const tags = chunks
          .flatMap((wanted) => {
            const chunk = Object.values(bundle).find((file) => file.type === 'chunk' && file.name === wanted);
            if (!chunk || chunk.type !== 'chunk') this.error(`The build has no ${wanted} chunk for ${name}.`);
            /* Its stylesheet too, as a link rather than the import's own late injection: nothing it styles is drawn
               before it has arrived. */
            const css = [...(chunk.viteMetadata?.importedCss ?? [])].map((file) => `<link rel="stylesheet" crossorigin href="/${file}">`);
            return [`<link rel="modulepreload" crossorigin href="/${chunk.fileName}">`, ...css];
          })
          .join('\n    ');
        const source = html.replace(
          /(<link rel="stylesheet" crossorigin href="\/assets\/[^"]+\.css">)(?![\s\S]*<link rel="stylesheet" crossorigin href="\/assets\/)/,
          `$1\n    ${tags}`,
        );
        if (source === html) this.error(`index.html has no built stylesheet to name ${name}'s chunks beside.`);
        if (name === 'index.html') page.source = source;
        else this.emitFile({ type: 'asset', fileName: name, source });
      }
    },
  };
}

/**
 * The license of every face the build ships (the kit's client/fonts/), written beside the client as `fonts/<name>`:
 * Lumen's Inter, Workshop's Barlow and Ledger's IBM Plex Mono are under the SIL Open Font License, which asks that its
 * text travel with the font, and dist is what the package's `files` allowlist ships.
 */
function fontLicenses(): Plugin {
  const dir = join(KIT, 'fonts');
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
 * What the server may send compressed. Images and fonts are compressed already, and source maps are left out: only
 * devtools fetches one, a person waits for nothing, and their `.br` and `.gz` copies were most of what the package
 * grew by. The server sends a file with no variant as it is.
 */
const TEXT = /\.(html|js|css|json|svg|txt)$/;

/**
 * A `.br` and a `.gz` beside every text file the build wrote, at the highest settings, because this runs once per
 * release and the result is read by every page load after it. A variant that comes out no smaller than its file is
 * not written; the server sends the file as it is.
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
 * The maps keep our own sources and drop the libraries'.
 *
 * The maps ship with their sources inside so a person debugging an installed copy can read the code a trace lands in
 * — and that is ours: React's, TanStack's and Base UI's sources are published in their own packages, and were a
 * quarter of the package's bytes (1.9 MB of the maps' 7.9). A frame in a library still maps to its file and line;
 * devtools shows the file's name and asks for its text. Ours is ours wherever it was installed from: a product built
 * over the published kit keeps the kit's modules too. Rewritten on disk after the write, because a map is neither
 * hashed into a file name nor precompressed.
 */
export function ownSourcesOnly(outDir: string): Plugin {
  const LIBRARY = /(^|\/)node_modules\/(?!@mistriwork\/)/;
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
        map.sourcesContent = map.sourcesContent.map((content, at) => (LIBRARY.test(map.sources[at]) ? null : content));
        writeFileSync(path, JSON.stringify(map));
      }
    },
  };
}

/**
 * The catalog's keys, short in the build.
 *
 * A key is named for what it says (`noRowsMatch`), which is what a person reading the source wants and what a first
 * page does not: each one is written twice, in its module's table (client/copy/) and where it is said, and at the
 * catalog's move that was most of the 50 KB the App's first page grew by. Here each table's keys become `a`, `b`, …
 * in the order it lists them, and every call in the one module that says it is renamed to match. A shared word
 * (`common.*` in the kit's messages.ts) becomes `.a`, `.b`, … there and wherever it is said; the other shared keys
 * keep their names, since some are said through a variable (conditionText.ts's connectives), which a build cannot
 * follow. A table's letters never shadow a dotted name. The edits go through rolldown's MagicString, so the maps
 * still land on the source's line and column; under Vite's middleware (tsx, the test suites) nothing is renamed.
 *
 * A key the build cannot see is refused rather than guessed: a table's call must name its key as a string, or a
 * condition between strings, and the speaker may not travel as a value, since a call made elsewhere could not be
 * renamed.
 *
 * The client's modules are the kit's and the product's own: `clients` names the product's client folders (every
 * `packages/<name>/src/client/` of a checkout), and the kit's is always one of them. A module there under `copy/` is
 * a table.
 */
export function shortCatalogKeys(clients: readonly string[] = []): Plugin {
  const roots = [KIT, ...clients.map((dir) => (dir.endsWith(sep) ? dir : dir + sep))];
  const clientModule = (id: string) => roots.some((root) => id.startsWith(root));
  const isTableFile = (id: string) => roots.some((root) => id.startsWith(`${root}copy${sep}`));
  const LETTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const letters = (n: number): string =>
    n < LETTERS.length ? LETTERS[n] : letters(Math.floor(n / LETTERS.length) - 1) + LETTERS[n % LETTERS.length];
  type Node = { type: string; start: number; end: number; [field: string]: unknown };
  const children = (node: Node): Node[] =>
    Object.values(node).flatMap((value) =>
      (Array.isArray(value) ? value : [value]).filter(
        (item): item is Node => !!item && typeof item === 'object' && typeof (item as Node).type === 'string',
      ),
    );
  const nameOf = (key: Node): string | undefined =>
    key.type === 'Identifier' ? (key.name as string) : key.type === 'Literal' && typeof key.value === 'string' ? key.value : undefined;
  const parsed = (file: string) => parseAst(readFileSync(file, 'utf8'), { lang: file.endsWith('.js') ? 'js' : 'ts' }) as unknown as Node;
  const tables = new Map<string, Map<string, string>>();
  const tableOf = (file: string): Map<string, string> => {
    let table = tables.get(file);
    if (!table) {
      /* Its English is defineMessages' first object; any translations follow it, under the same keys. */
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
      visit(parsed(file));
      table = new Map(keys.map((key, at) => [key, letters(at)]));
      tables.set(file, table);
    }
    return table;
  };
  /* The kit's shared words: messages.ts in a checkout, messages.js built. */
  const MESSAGES = kitModule('messages.js');
  /* The `catalog` object of messages.ts: each language's words. */
  const catalogOf = (program: Node): Node | undefined => {
    let found: Node | undefined;
    const visit = (node: Node) => {
      if (found) return;
      if (node.type === 'VariableDeclarator' && (node.id as Node).type === 'Identifier' && (node.id as Node).name === 'catalog') {
        /* The source says `{ … } satisfies …`; what a transform sees has had its types taken off. */
        let init = node.init as Node;
        while (/^TS(?:Satisfies|As)Expression$/.test(init.type)) init = init.expression as Node;
        found = init;
        return;
      }
      children(node).forEach(visit);
    };
    visit(program);
    return found;
  };
  let shared: Map<string, string> | undefined;
  const sharedOf = (): Map<string, string> => {
    if (!shared) {
      /* The `common.*` keys of the English words, in the order they are written. */
      const english = ((catalogOf(parsed(MESSAGES))?.properties as Node[] | undefined) ?? []).find(
        (language) => nameOf(language.key as Node) === 'en',
      );
      const keys = (((english?.value as Node | undefined)?.properties as Node[] | undefined) ?? [])
        .map((property) => nameOf(property.key as Node))
        .filter((key): key is string => !!key && /^common\.\w+$/.test(key));
      shared = new Map(keys.map((key, at) => [key, `.${letters(at)}`]));
    }
    return shared;
  };
  return {
    name: 'mistri:short-catalog-keys',
    apply: 'build',
    enforce: 'post',
    async transform(code, rawId) {
      const id = rawId.split('?')[0];
      if (!clientModule(id)) return null;
      const isTable = isTableFile(id);
      if (id !== MESSAGES && !isTable && !/\/(?:copy\/[\w/]+|messages)\.js['"]/.test(code)) return null;
      const program = this.parse(code) as unknown as Node;
      const out = new RolldownMagicString(code);
      if (id === MESSAGES) {
        for (const language of (catalogOf(program)?.properties as Node[] | undefined) ?? []) {
          for (const property of (language.value as Node).properties as Node[]) {
            const to = sharedOf().get(nameOf(property.key as Node) ?? '');
            if (to !== undefined) out.overwrite((property.key as Node).start, (property.key as Node).end, JSON.stringify(to));
          }
        }
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
      /* The module that says: which of its names speak — a table's `say`, or messages.ts's `message`. Each import is
         resolved as the build resolves it, a workspace package's name through its exports (`@mistriwork/kit/client/
         messages.js`, how the products name the kit's words) and a relative one beside its module. */
      const speakers = new Map<string, Map<string, string> | null>();
      for (const node of program.body as Node[]) {
        if (node.type !== 'ImportDeclaration') continue;
        const specifier = (node.source as Node).value as string;
        if (!/(?:^|\/)(?:copy\/[\w/]+|messages)\.js$/.test(specifier)) continue;
        const from = (await this.resolve(specifier, id))?.id.split('?')[0];
        if (!from) continue;
        const want = isTableFile(from) ? 'say' : from === MESSAGES ? 'message' : undefined;
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

/** Where `@mistriwork/ui` is read from, if it resolves (a product's install, or this workspace's link). */
function uiFolder(): string[] {
  try {
    return [dirname(fileURLToPath(import.meta.resolve('@mistriwork/ui')))];
  } catch {
    return [];
  }
}

/** What a product says about its page. */
export interface KitClientOptions {
  /**
   * The product's workspace: the folder whose vite.config.ts serves the page from source, whose node_modules holds
   * Vite's dependency cache, and whose files Vite may read (`clientFiles` names the same folder to the server).
   */
  workspace: string;
  /** The product's main (shellStart.js starts it): its path, or a plugin that answers `virtual:mistri/shell-main`. */
  main: string | Plugin;
  /** The product's own client folders, whose catalogs and words `shortCatalogKeys` reads beside the kit's. */
  clients?: readonly string[];
  /** With it, a build into `outDir`; without, the config a source server and the test suites use, which builds nothing. */
  build?: Surfaces & {
    outDir: string;
    /** Each page the build writes (the engine's clientSurface.ts `SURFACE_PAGES`) and the chunks it preloads. */
    pages: Readonly<Record<string, readonly string[]>>;
  };
  /** The product's own plugins, before the kit's. */
  plugins?: PluginOption[];
}

/** The page's Vite config, for a product's build or its source server. */
export function kitClientConfig({ workspace, main, clients = [], build, plugins = [] }: KitClientOptions): UserConfig {
  const outDir = build?.outDir ?? resolve(workspace, 'node_modules/.cache/client-unbuilt');
  const split = build ? surfaces(build) : undefined;
  return {
    root: KIT_CLIENT.source,
    /* Builds and direct Vite use keep this checkout's dependencies apart from a linked worktree. Source middleware
       servers override this with one fresh directory per Vite generation (the engine's devclient.ts): Vite mutates
       optimizer metadata as it discovers imports, so independent processes cannot safely share even a
       checkout-scoped directory. */
    cacheDir: resolve(workspace, 'node_modules/.vite', `client-${createHash('sha256').update(workspace).digest('hex').slice(0, 12)}`),
    plugins: [
      ...plugins,
      jsMayBeTs(),
      typeof main === 'string' ? shellMain(main) : main,
      noDevtoolsClient(),
      ...(build && split ? [split.plugin, surfacePages(build.pages)] : []),
      /* Only the React half. Left to its default the plugin also rewrites the hand-written .js modules on their way
         to the browser — quoting, spacing — and the browser suite patches those modules by their source text; a
         module that arrives reformatted matches none of its patches. */
      react({ include: /\.[jt]sx$/ }),
      shortCatalogKeys(clients),
      fontLicenses(),
      precompress(outDir),
      ownSourcesOnly(outDir),
    ],
    /* The kit's modules are the page's own, served as they are, never pre-bundled: a pre-bundled copy of one would be
       a second instance beside the one the page's entry imports. Their own imports (React, TanStack) are still
       optimized as Vite finds them. */
    optimizeDeps: {
      exclude: ['@mistriwork/kit', '@mistriwork/engine', '@mistriwork/ui'],
      /* The source server has no HTML page for Vite to scan from (appType is custom), so it found the page's libraries
         one request at a time: a part loaded on demand brought a new one, the optimizer ran again under a new hash, and
         the page held React twice (`useId` of null in a form), lost the dialog it had open to the reload, or never went
         quiet for a browser test. Handed the folders the page's modules are in, it finds them all before the first
         request. The kit's modules reach `@mistriwork/ui`, which is excluded from the optimizer, so its folder is
         scanned for what it imports. Tests, their helpers and stories are not the page, and the server render runs in Node. */
      entries: [...clients, KIT_CLIENT.source, ...uiFolder()].flatMap((folder) => [
        `${folder}/**/*.{js,ts,tsx}`,
        `!${folder}/**/*.{test,spec,stories}.*`,
        `!${folder}/**/*[Tt]esting.*`,
        `!${folder}/**/*.d.ts`,
        `!${folder}/**/ssr/**`,
      ]),
    },
    /* A script names the files it loads (a lazy chunk's stylesheet, its preloads) relative to itself, not from the
       root: a server behind a reverse proxy under a path (`--base-path /tools`, shared/mount.ts) is at /tools/assets/,
       and the page the server sends says so in its own tags. A stylesheet names its face (lumenLook.css) beside
       itself the same way. The pages keep `/assets/`, which the server rewrites. */
    experimental: { renderBuiltUrl: (_file, { hostType }) => (hostType === 'js' || hostType === 'css' ? { relative: true } : undefined) },
    build: {
      outDir,
      emptyOutDir: true,
      target: 'es2023',
      minify: true,
      /* Beside each file, our sources included: the package is the only place a person debugging an installed copy
         can find them. The libraries' are in their own packages (`ownSourcesOnly`). */
      sourcemap: true,
      rolldownOptions: {
        output: {
          /* Hashed, the entry too, and all under assets/: that directory is the server's whole rule for what may be
             cached for good. The release workflow finds the entry through index.html. */
          entryFileNames: 'assets/[name]-[hash].js',
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
          /* One chunk for each surface's first page (`surfaces`, above). Left alone, the bundler cuts the graph into
             some thirty pieces along the seams it shares with the parts loaded on demand (components/onDemand.tsx),
             and a first visit fetches every piece. Those parts stay chunks of their own. */
          codeSplitting: { groups: [LOCALE_GROUP, ...(split?.groups ?? [])] },
        },
      },
    },
    server: {
      /* The product's sources, and anything else of its workspace a module reaches, sit outside the client root. */
      fs: { allow: [workspace] },
    },
  };
}
