/**
 * An App's custom components, compiled to what the browser loads: one ES
 * module per component, its stylesheet beside it, both named for their
 * content and served at `/{app}/_components/<file>` (componentRoutes.ts).
 *
 * One compiler, Rolldown, the optional peer `mistri build` already uses:
 * from source on every load and reload (the App's watcher recompiles), and
 * once in `mistri build`, whose components/ graph is pinned to the
 * mistri that made it. A second path through Vite would have meant two
 * output shapes, and Vite serves nothing outside this repository and would
 * resolve `react` from the App's own tree. Rolldown is needed only by an App
 * that declares components; one that does, without it, is refused in one line.
 *
 * The host's singletons stay out of every bundle: `react`, its JSX runtime,
 * `react-dom`, `@mistriwork/mistri/ui` and `@mistriwork/mistri/page` are left as bare imports,
 * written as paths to the page's own copies when the file is served
 * (componentSdk.ts, http/componentRoutes.ts). A second
 * React breaks hooks; a second query cache outlives a sign-out. What a
 * component may never reach is refused here, as a compile error: the server
 * entries (`@mistriwork/mistri/commands` and its siblings), Node's builtins, any file
 * outside the App directory that is not an installed package. Its CSS is
 * wrapped in `@layer app` and scoped to the component's own element,
 * so `structure` still wins over it, and nothing it writes reaches the rest of
 * the page. The layer stands after the kit's control recipes and the looks, so a
 * `<button>` card an App draws keeps its own corner under a round-control look.
 */
import { createHash } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire, isBuiltin } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ComponentDecl, ComponentKind } from '@mistriwork/engine/shared/appComponents.js';
import { COMPONENTS_SEGMENT, HOST_MODULES } from '../../shared/uiSdk.js';
import { loadRolldown, rolldownErrors, type Bundler } from '../build/bundle.js';
import { hostVersion } from './componentSdk.js';

/** One compiled component: its kind, the files it is served as, and the App's own modules it was made from. */
interface CompiledComponent {
  kind: ComponentKind;
  js: string;
  css?: string;
  /** Relative to the App directory: what `mistri check` lints. */
  sources: string[];
}

/** An App's components as served: by id, and every file by its served name. */
export interface CompiledComponents {
  entries: Record<string, CompiledComponent>;
  files: Record<string, string>;
  /** The App's control kit (`uiKit`, Preview): served from the same place, named `ui-kit-<hash>`. */
  kit?: { js: string; css?: string; sources: string[] };
}

const APP_DSL = fileURLToPath(new URL('../../../schema/app.mjs', import.meta.url));
/* This runtime's own server code, wherever it runs from: src/ under tsx, dist/ once built — this package's, and the
   engine's beneath it. */
const ENGINE = dirname(createRequire(import.meta.url).resolve('@mistriwork/engine/package.json'));
const SERVER_CODE = [fileURLToPath(new URL('../', import.meta.url)), join(ENGINE, 'src', 'server'), join(ENGINE, 'dist', 'server')].map(
  real,
);

/** What an App with components is told when Rolldown is not installed beside mistri. */
const ROLLDOWN_NEEDED =
  'declares custom components, which are compiled with rolldown: install it beside mistri ' +
  '(`npm i -D rolldown`), or serve a `mistri build` of the App.';

/* The imports a component may not make, each with the reason it is told. */
const REFUSED: Array<[RegExp, string]> = [
  [
    /^@mistriwork\/mistri\/(commands|policy|jobs|maintenance)(\/|$)/,
    "is server code, and a component runs in the reader's browser. Read through @mistriwork/mistri/ui's hooks; change data through the App's actions and commands",
  ],
  [/^@mistriwork\/mistri\/ui\/testing$/, "is for a component's tests, not the component"],
  [
    /^@mistriwork\/mistri$|^@mistriwork\/mistri\/(?!app$|ui$|page$|behaviors$|primitives$|charts$|views$)/,
    'is not a module a component may import; it draws with @mistriwork/mistri/ui',
  ],
  [
    /^@tanstack\/react-query(\/|$)/,
    "would bring a query cache of its own, which a sign-out does not clear; read through @mistriwork/mistri/ui's useRows, useRecord and useBreakdown",
  ],
  [
    /^(react|react-dom)\//,
    "is not one the page provides; a component imports react, react/jsx-runtime and react-dom, which are the page's own",
  ],
];

/* The page's on-demand entries, lowest first: each brings its own stylesheet and those under it (the primitives'
   stand on the charts', the views' on both: packages/mistri/src/client/components/sdk/{charts,primitives,views}.ts). */
const SURFACE_ENTRIES = ['charts', 'primitives', 'views'] as const;
type SurfaceEntry = (typeof SURFACE_ENTRIES)[number];
/* The entry that brings a host stylesheet a component names. One that is every surface at once (`style.css`,
   `styles/surfaces.css`) needs the highest, which is all of them: a component that names it may write the views'
   classes in its own markup without importing a view. A name not listed per bundle falls to that one too. */
const HOST_SURFACES_CSS = new Map<string, SurfaceEntry>([
  ['@mistriwork/ui/style.css', 'views'],
  ['@mistriwork/ui/styles/surfaces.css', 'views'],
  ['@mistriwork/ui/styles/surfaces/views.css', 'views'],
  ['@mistriwork/ui/styles/surfaces/primitives.css', 'primitives'],
  ['@mistriwork/ui/styles/ui-sdk-surfaces.css', 'primitives'],
  ['@mistriwork/ui/styles/surfaces/charts.css', 'charts'],
  ['@mistriwork/ui/styles/surfaces/base.css', 'charts'],
]);
const surfaceEntryId = (entry: SurfaceEntry) => `@mistriwork/mistri/${entry}`;
const HOST_UI_CSS = new Set([
  ...HOST_SURFACES_CSS.keys(),
  '@mistriwork/ui/controls.css',
  '@mistriwork/ui/tokens.css',
  '@mistriwork/ui/behaviors.css',
  '@mistriwork/ui/preferences.css',
]);
const VIRTUAL_HOST_CSS = '\0mistri:host-ui-css';

const inside = (file: string, dir: string) => file === dir || file.startsWith(dir.endsWith(sep) ? dir : dir + sep);
const installed = (file: string) => file.split(sep).includes('node_modules');

/** The real path, so a symlink cannot walk a module out of the App directory. */
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

interface ParsedCssImport {
  start: number;
  end: number;
  spec: string;
  layer?: string;
  supports?: string;
  media?: string;
}

/**
 * Reads top-level `@import` statements from a stylesheet: quoted (`"..."`, `'...'`) or `url(...)` (quoted or unquoted),
 * followed by optional `layer` / `layer(name)`, `supports(...)` and media conditions up to the closing `;`.
 */
function scanCssImports(css: string): ParsedCssImport[] {
  const found: ParsedCssImport[] = [];
  const len = css.length;
  let i = 0;
  const skipSpaceAndComments = () => {
    while (i < len) {
      if (/\s/.test(css[i]!)) {
        i += 1;
      } else if (css[i] === '/' && css[i + 1] === '*') {
        const close = css.indexOf('*/', i + 2);
        i = close >= 0 ? close + 2 : len;
      } else {
        break;
      }
    }
  };
  const readQuoted = (): string | undefined => {
    const q = css[i];
    if (q !== '"' && q !== "'") return undefined;
    i += 1;
    let out = '';
    while (i < len && css[i] !== q) {
      if (css[i] === '\\' && i + 1 < len) {
        out += css[i + 1]!;
        i += 2;
      } else {
        out += css[i]!;
        i += 1;
      }
    }
    if (css[i] === q) i += 1;
    return out;
  };
  const readParens = (): string => {
    let depth = 1;
    i += 1;
    const start = i;
    while (i < len && depth > 0) {
      const ch = css[i]!;
      if (ch === '"' || ch === "'") {
        readQuoted();
        continue;
      }
      if (ch === '/' && css[i + 1] === '*') {
        const close = css.indexOf('*/', i + 2);
        i = close >= 0 ? close + 2 : len;
        continue;
      }
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      i += 1;
    }
    return css.slice(start, depth === 0 ? i - 1 : i).trim();
  };
  const skipStatement = () => {
    while (i < len) {
      const ch = css[i]!;
      if (ch === '"' || ch === "'") {
        readQuoted();
        continue;
      }
      if (ch === '/' && css[i + 1] === '*') {
        const close = css.indexOf('*/', i + 2);
        i = close >= 0 ? close + 2 : len;
        continue;
      }
      if (ch === '(') {
        readParens();
        continue;
      }
      if (ch === ';') {
        i += 1;
        return true;
      }
      if (ch === '{') return false;
      i += 1;
    }
    return false;
  };

  while (i < len) {
    skipSpaceAndComments();
    if (i >= len || css[i] !== '@') break;
    const start = i;
    const kw = /^@([A-Za-z-]+)/.exec(css.slice(i))?.[1]?.toLowerCase();
    if (kw === 'charset' || kw === 'layer') {
      i += 1 + kw.length;
      if (skipStatement()) continue;
      break;
    }
    if (kw !== 'import') break;
    i += 7;
    skipSpaceAndComments();
    let spec: string | undefined;
    if (css[i] === '"' || css[i] === "'") {
      spec = readQuoted()?.trim();
    } else if (/^url\(/i.test(css.slice(i, i + 4))) {
      i += 3; // positioned at '('
      const body = readParens();
      if ((body.startsWith('"') && body.endsWith('"')) || (body.startsWith("'") && body.endsWith("'"))) {
        spec = body.slice(1, -1).trim();
      } else {
        spec = body.trim();
      }
    }
    if (!spec) break;
    skipSpaceAndComments();
    let layer: string | undefined;
    if (/^layer(?:\s*\(|\b)/i.test(css.slice(i))) {
      i += 5;
      skipSpaceAndComments();
      layer = css[i] === '(' ? readParens() : '';
      skipSpaceAndComments();
    }
    let supports: string | undefined;
    if (/^supports\s*\(/i.test(css.slice(i))) {
      i += 8;
      skipSpaceAndComments();
      if (css[i] === '(') supports = readParens();
      skipSpaceAndComments();
    }
    const mediaStart = i;
    if (!skipStatement()) break;
    const media = css.slice(mediaStart, i - 1).trim() || undefined;
    found.push({ start, end: i, spec, layer, supports, media });
  }
  return found;
}

function wrapImportedCss(css: string, stmt: ParsedCssImport): string {
  let out = css.trim();
  if (!out) return '';
  if (stmt.supports) out = `@supports (${stmt.supports}) {\n${out}\n}`;
  if (stmt.media) out = `@media ${stmt.media} {\n${out}\n}`;
  if (stmt.layer !== undefined) out = stmt.layer ? `@layer ${stmt.layer} {\n${out}\n}` : `@layer {\n${out}\n}`;
  return `${out}\n`;
}

function wrapCss(id: string, css: string): string {
  /* After the kit and the looks, before theme and structure (style.css names the order): a field report had an App's
     own `<button>` card turned into a pill by the kit's round-control recipe, which a `components` rule could not
     outrank. Layout no look may move is still not the component's to move, and `@scope` keeps every rule inside the
     component's own element — a `:root` or a bare `li` never leaks out. */
  return `@layer app {\n@scope ([data-component="${id}"]) {\n${css.trim()}\n}\n}\n`;
}

/**
 * One page module compiled as a component is, for the server to read its
 * definition under stand-ins (appPages.ts); undefined without rolldown. It
 * names no bundler in its signature, so an App's typecheck, which reads this
 * module's declarations, never reads rolldown's.
 */
export async function compilePageModule(dir: string, decl: ComponentDecl): Promise<string | undefined> {
  const bundler = await loadRolldown();
  return bundler ? (await compileOne(bundler, dir, decl, false)).code : undefined;
}

async function compileOne(
  bundler: Bundler,
  dir: string,
  decl: ComponentDecl,
  minify: boolean,
  shared: readonly string[] = [],
  kit = false,
): Promise<{ code: string; map: string; css: string; sources: string[] }> {
  const entry = resolve(dir, decl.module);
  const at = kit ? `the UI kit (${decl.module})` : `the component "${decl.id}" (${decl.module})`;
  let file: string;
  try {
    if (!statSync(entry).isFile()) throw new Error('not a file');
    file = real(entry);
  } catch {
    throw new Error(`${at} names a module that does not exist in ${dir}.`);
  }
  const root = real(dir);
  if (!inside(file, root)) throw new Error(`${at} resolves outside the App directory. A component's module lives inside it.`);
  let order: string[] = [];
  let modules: string[] = [];
  const shown = (id: string | undefined) => (id && isAbsolute(id) ? relative(root, id) : (id ?? decl.module));
  const boundary: import('rolldown').Plugin = {
    name: 'mistri:component-boundary',
    async resolveId(source, importer, options) {
      if (Object.hasOwn(HOST_MODULES, source)) return { id: source, external: true };
      const surfaceEntry = HOST_SURFACES_CSS.get(source);
      if (surfaceEntry) return { id: surfaceEntryId(surfaceEntry), external: true };
      if (HOST_UI_CSS.has(source)) return { id: VIRTUAL_HOST_CSS };
      if (source === '@mistriwork/mistri/app') return APP_DSL;
      const refused = REFUSED.find(([pattern]) => pattern.test(source));
      if (refused) this.error(`${shown(importer)}: "${source}" ${refused[1]}.`);
      if (isBuiltin(source)) this.error(`${shown(importer)}: "${source}" is a Node module, and a component runs in the reader's browser.`);
      if (!importer) return null;
      const found = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!found || found.external || !isAbsolute(found.id)) return found;
      const target = real(found.id);
      if (SERVER_CODE.some((dir) => inside(target, dir)))
        this.error(`${shown(importer)}: "${source}" is mistri's own server code, which a component never imports.`);
      if (!inside(target, root) && !installed(target) && !shared.some((dir) => inside(target, real(dir)))) {
        this.error(
          `${shown(importer)}: "${source}" is outside the App directory. A component's modules live in it, or are installed packages.`,
        );
      }
      return found;
    },
    /* A stylesheet is collected in the order the graph imports it (buildEnd)
       and served beside the script; Rolldown no longer bundles CSS. */
    load(id) {
      if (id === VIRTUAL_HOST_CSS) return { code: '', moduleSideEffects: false, moduleType: 'js' };
      if (id.endsWith('.css')) return { code: '', moduleSideEffects: true, moduleType: 'js' };
      return null;
    },
    buildEnd() {
      /* Evaluation order: a module's imports in the order it writes them,
         before the module itself, each once — the cascade order a page would get. */
      const seen = new Set<string>();
      order = [];
      /* A module reached by `import()` is inlined into the one script (no code splitting), so its stylesheet
         ships with it too: walked after everything the entry imports, as a page would load it later. Left out,
         a component's lazily loaded part drew without its rules (a field report). */
      const later: string[] = [];
      const visit = (id: string) => {
        if (seen.has(id)) return;
        seen.add(id);
        const info = this.getModuleInfo(id);
        for (const dependency of info?.importedIds ?? []) visit(dependency);
        later.push(...(info?.dynamicallyImportedIds ?? []));
        order.push(id);
      };
      visit(this.getModuleInfo(file) ? file : entry);
      for (let next = later.shift(); next !== undefined; next = later.shift()) visit(next);
      modules = [...this.getModuleIds()];
    },
  };
  let output: import('rolldown').RolldownOutput['output'];
  try {
    ({ output } = (await bundler.build({
      input: file,
      cwd: root,
      platform: 'browser',
      /* The App's tsconfig is for its typecheck; paths it maps are not the browser's. */
      tsconfig: false,
      /* A package that says `process.env.NODE_ENV` is told production; nothing
         else of the server's environment reaches a component (componentLint.ts
         refuses the author's own reads of it). */
      transform: { jsx: 'react-jsx', define: { 'process.env.NODE_ENV': '"production"' } },
      resolve: { extensionAlias: { '.js': ['.ts', '.tsx', '.js', '.jsx'] } },
      plugins: [boundary],
      logLevel: 'silent',
      output: { dir: root, format: 'esm', sourcemap: 'hidden', minify, codeSplitting: false },
      write: false,
    })) as import('rolldown').RolldownOutput);
  } catch (error) {
    throw new Error(`${at} does not compile:\n    ${rolldownErrors(error).split('\n').join('\n    ')}`);
  }
  const chunk = output.find((item) => item.type === 'chunk' && item.isEntry);
  if (!chunk || chunk.type !== 'chunk') throw new Error(`${at} compiled to nothing.`);
  if (!chunk.exports.includes('default'))
    throw new Error(
      kit
        ? `${at} has no default export. Export the kit: export default defineUiKit({ Button, … }).`
        : decl.kind === 'page'
          ? `[page-file] ${at} has no default export. Export the page: export default definePage({ … }).`
          : `${at} has no default export. Export the component: export default function Thing(props) { … }.`,
    );
  const cssFiles = order.filter((id) => id.endsWith('.css') && isAbsolute(id));
  const extraCss = new Set<string>();
  const visitedCss = new Set<string>();
  /* The highest entry a stylesheet of the component's asks for by importing a host sheet, as its place in SURFACE_ENTRIES. */
  let cssNeedsEntry = -1;
  const readCss = async (cssId: string, stack = new Set<string>()): Promise<string> => {
    const resolvedId = real(cssId);
    if (stack.has(resolvedId) || visitedCss.has(resolvedId)) return '';
    visitedCss.add(resolvedId);
    const nextStack = new Set(stack);
    nextStack.add(resolvedId);
    const raw = await readFile(resolvedId, 'utf8');
    const chunks: string[] = [];
    let last = 0;
    for (const stmt of scanCssImports(raw)) {
      chunks.push(raw.slice(last, stmt.start));
      last = stmt.end;
      const surfaceEntry = HOST_SURFACES_CSS.get(stmt.spec);
      if (surfaceEntry) cssNeedsEntry = Math.max(cssNeedsEntry, SURFACE_ENTRIES.indexOf(surfaceEntry));
      if (HOST_UI_CSS.has(stmt.spec)) continue;
      if (/^(?:https?:|\/\/|data:)/i.test(stmt.spec)) {
        throw new Error(
          `${at}: CSS @import "${stmt.spec}" cannot load an external URL inside a scoped component stylesheet; import a local or installed stylesheet.`,
        );
      }
      const refused = REFUSED.find(([pattern]) => pattern.test(stmt.spec));
      if (refused) throw new Error(`${at}: CSS @import "${stmt.spec}" ${refused[1]}.`);
      let candidate: string | null = null;
      if (stmt.spec.startsWith('.')) {
        const local = resolve(dirname(resolvedId), stmt.spec);
        if (existsSync(local)) candidate = local;
      } else {
        const local = resolve(dirname(resolvedId), stmt.spec);
        if (existsSync(local)) {
          candidate = local;
        } else {
          try {
            candidate = createRequire(resolvedId).resolve(stmt.spec);
          } catch {
            candidate = null;
          }
        }
      }
      if (!candidate || !existsSync(candidate)) {
        throw new Error(`${at}: CSS @import "${stmt.spec}" could not be resolved from ${shown(resolvedId)}.`);
      }
      const realChild = real(candidate);
      if (SERVER_CODE.some((dir) => inside(realChild, dir)))
        throw new Error(`${at}: CSS @import "${stmt.spec}" is mistri's own server code.`);
      if (!inside(realChild, root) && !installed(realChild) && !shared.some((dir) => inside(realChild, real(dir))))
        throw new Error(`${at}: CSS @import "${stmt.spec}" resolves outside the App directory.`);
      extraCss.add(realChild);
      const childCss = await readCss(realChild, nextStack);
      chunks.push(wrapImportedCss(childCss, stmt));
    }
    chunks.push(raw.slice(last));
    return chunks.join('');
  };
  const cssParts: string[] = [];
  for (const id of cssFiles) cssParts.push(await readCss(id));
  const css = cssParts.filter(Boolean).join('\n');
  /* The compiled code already brings an entry's stylesheet where it imports that entry or a higher one; the import
     is added only for what the component's own CSS asked for beyond that. */
  const imported = Math.max(
    -1,
    ...[...chunk.code.matchAll(/@mistriwork\/mistri\/(primitives|charts|views)\b/g)].map(([, entry]) =>
      SURFACE_ENTRIES.indexOf(entry as SurfaceEntry),
    ),
  );
  const code = cssNeedsEntry > imported ? `import "${surfaceEntryId(SURFACE_ENTRIES[cssNeedsEntry]!)}";\n${chunk.code}` : chunk.code;
  const own = (id: string) => isAbsolute(id) && inside(real(id), root) && !installed(id);
  const sources = [...new Set([...modules.filter(own), ...cssFiles.filter(own), ...[...extraCss].filter(own)])]
    .map((id) => relative(root, real(id)).split(sep).join('/'))
    .sort();
  return { code, map: chunk.map?.toString() ?? '', css, sources };
}

/**
 * Compile every component an App declares. Undefined when it declares none —
 * the only case that needs no Rolldown. Throws with the component named and
 * the compiler's own line for each problem, so a load names the fix.
 */
export async function compileComponents(
  dir: string,
  decls: ReadonlyMap<string, ComponentDecl>,
  /** `shared`: folders outside `dir` its components may import as their own — the platform's rooms reach the kit's
      components, which a checkout holds in another package rather than under node_modules. */
  options: { minify?: boolean; shared?: readonly string[] } = {},
): Promise<CompiledComponents | undefined> {
  if (!decls.size) return undefined;
  const bundler = await loadRolldown();
  if (!bundler) throw new Error(`The App ${ROLLDOWN_NEEDED}`);
  const entries: Record<string, CompiledComponent> = {};
  const files: Record<string, string> = {};
  for (const decl of [...decls.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const built = await compileOne(bundler, dir, decl, options.minify ?? false, options.shared);
    /* The host version is in the name because the code is served with its host paths written, and those name it. */
    const hash = createHash('sha256')
      .update(built.code)
      .update('\0')
      .update(built.css)
      .update('\0')
      .update(hostVersion())
      .digest('hex')
      .slice(0, 12);
    const name = `${decl.id}-${hash}`;
    files[`${name}.js`] = `${built.code.trimEnd()}\n//# sourceMappingURL=${name}.js.map\n`;
    if (built.map) files[`${name}.js.map`] = JSON.stringify({ ...JSON.parse(built.map), file: `${name}.js` });
    if (built.css.trim()) files[`${name}.css`] = wrapCss(decl.id, built.css);
    entries[decl.id] = { kind: decl.kind, js: `${name}.js`, ...(built.css.trim() ? { css: `${name}.css` } : {}), sources: built.sources };
  }
  return { entries, files };
}

/** The name a compiled kit is served under: the component file pattern, which a leading `_` would not match. */
const UI_KIT = 'ui-kit';

/**
 * Compile an App's control kit (`uiKit`, Preview) into `compiled`, or into a set of its own when the App declares no
 * component. The same boundary as a component: the page's React and SDK are the kit's, and nothing of the server's.
 * Its stylesheet is not scoped to an element, as a component's is: a kit draws controls everywhere on the page,
 * popups in a portal included, so its rules are page-wide, in the `app` layer, after the kit's control recipes and the looks, so a control
 * the kit draws wears the App's dress; `theme` and `structure` win over it.
 */
export async function compileUiKit(
  dir: string,
  module: string,
  compiled: CompiledComponents | undefined,
  options: { minify?: boolean; shared?: readonly string[] } = {},
): Promise<CompiledComponents> {
  const bundler = await loadRolldown();
  if (!bundler)
    throw new Error(
      'The App declares a UI kit, which is compiled with rolldown: install it beside mistri (`npm i -D rolldown`), or serve a `mistri build` of the App.',
    );
  const decl: ComponentDecl = { id: UI_KIT, module, kind: 'section' };
  const built = await compileOne(bundler, dir, decl, options.minify ?? false, options.shared, true);
  const hash = createHash('sha256')
    .update(built.code)
    .update('\0')
    .update(built.css)
    .update('\0')
    .update(hostVersion())
    .digest('hex')
    .slice(0, 12);
  const name = `${UI_KIT}-${hash}`;
  const files: Record<string, string> = { ...compiled?.files };
  files[`${name}.js`] = `${built.code.trimEnd()}\n//# sourceMappingURL=${name}.js.map\n`;
  if (built.map) files[`${name}.js.map`] = JSON.stringify({ ...JSON.parse(built.map), file: `${name}.js` });
  const css = built.css.trim() ? `${name}.css` : undefined;
  if (css) files[css] = `@layer app {\n${built.css.trim()}\n}\n`;
  return { entries: compiled?.entries ?? {}, files, kit: { js: `${name}.js`, ...(css ? { css } : {}), sources: built.sources } };
}

/** The compiled kit's code, for the server to read its slots under stand-ins (appPages.ts `readUiKit`). */
export function uiKitCode(compiled: CompiledComponents): string | undefined {
  const js = compiled.kit?.js;
  return js ? compiled.files[js]?.replace(/\n\/\/# sourceMappingURL=.*\n$/, '\n') : undefined;
}

/**
 * Where an App's control kit is served, for the page's head (clientHttp.ts `uiKit`): the inside addresses, each as the
 * browser reaches it (`outward`), so the meta's address is the very one the head preloads.
 */
export function uiKitHref(
  appId: string,
  compiled: CompiledComponents | undefined,
  outward: (inside: string) => string,
): { js: string; css?: string } | undefined {
  const kit = compiled?.kit;
  if (!kit) return undefined;
  const at = (file: string) => outward(`/${encodeURIComponent(appId)}/${COMPONENTS_SEGMENT}/${file}`);
  return { js: at(kit.js), ...(kit.css ? { css: at(kit.css) } : {}) };
}

/** The compiled module source for one compiled component id (sourcemap comment stripped), for server-side rendering of public custom pages. */
export function componentCode(compiled: CompiledComponents | undefined, id: string): string | undefined {
  const entry = compiled && Object.hasOwn(compiled.entries, id) ? compiled.entries[id] : undefined;
  return entry ? compiled?.files[entry.js]?.replace(/\n\/\/# sourceMappingURL=.*\n$/, '\n') : undefined;
}

/** Where a compiled page component's JS and CSS are served, for `<head>` preloading (clientHttp.ts `pageAsset`). */
export function pageAssetHref(
  appId: string,
  compiled: CompiledComponents | undefined,
  id: string,
  outward: (inside: string) => string,
): { id: string; js: string; css?: string } | undefined {
  const entry = compiled && Object.hasOwn(compiled.entries, id) ? compiled.entries[id] : undefined;
  if (!entry) return undefined;
  const at = (file: string) => outward(`/${encodeURIComponent(appId)}/${COMPONENTS_SEGMENT}/${file}`);
  return { id, js: at(entry.js), ...(entry.css ? { css: at(entry.css) } : {}) };
}

/** Where each component is served, for the App payload: `/{app}/_components/<file>`, the inside address the page says where its App is mounted (client addressMount.js). */
export function componentHrefs(
  appId: string,
  compiled: CompiledComponents | undefined,
): Record<string, { kind: ComponentKind; href: string; css?: string }> | undefined {
  if (!compiled) return undefined;
  const at = (file: string) => `/${encodeURIComponent(appId)}/${COMPONENTS_SEGMENT}/${file}`;
  return Object.fromEntries(
    Object.entries(compiled.entries).map(([id, entry]) => [
      id,
      { kind: entry.kind, href: at(entry.js), ...(entry.css ? { css: at(entry.css) } : {}) },
    ]),
  );
}
