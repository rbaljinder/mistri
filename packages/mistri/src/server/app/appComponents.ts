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
 * wrapped in `@layer components` and scoped to the component's own element,
 * so a look still dresses it and `structure` still wins over it, and nothing
 * it writes reaches the rest of the page.
 */
import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire, isBuiltin } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ComponentDecl, ComponentKind } from '@mistriwork/engine/shared/appComponents.js';
import { COMPONENTS_SEGMENT, HOST_MODULES } from '../../shared/uiSdk.js';
import { loadRolldown, rolldownErrors, type Bundler } from '../build/bundle.js';

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
    /^@mistriwork\/mistri$|^@mistriwork\/mistri\/(?!app$|ui$|page$)/,
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

function wrapCss(id: string, css: string): string {
  /* After the base and before kit, look and structure (style.css names
     the order): a look may dress a component, layout no look may move is not
     the component's to move either, and `@scope` keeps every rule inside the
     component's own element — a `:root` or a bare `li` never leaks out. */
  return `@layer components {\n@scope ([data-component="${id}"]) {\n${css.trim()}\n}\n}\n`;
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
): Promise<{ code: string; map: string; css: string; sources: string[] }> {
  const entry = resolve(dir, decl.module);
  const at = `the component "${decl.id}" (${decl.module})`;
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
      if (id.endsWith('.css')) return { code: '', moduleSideEffects: true, moduleType: 'js' };
      return null;
    },
    buildEnd() {
      /* Evaluation order: a module's imports in the order it writes them,
         before the module itself, each once — the cascade order a page would get. */
      const seen = new Set<string>();
      order = [];
      const visit = (id: string) => {
        if (seen.has(id)) return;
        seen.add(id);
        for (const dependency of this.getModuleInfo(id)?.importedIds ?? []) visit(dependency);
        order.push(id);
      };
      visit(this.getModuleInfo(file) ? file : entry);
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
      decl.kind === 'page'
        ? `[page-file] ${at} has no default export. Export the page: export default definePage({ … }).`
        : `${at} has no default export. Export the component: export default function Thing(props) { … }.`,
    );
  const cssFiles = order.filter((id) => id.endsWith('.css') && isAbsolute(id));
  const css = (await Promise.all(cssFiles.map((id) => readFile(id, 'utf8')))).join('\n');
  const own = (id: string) => isAbsolute(id) && inside(real(id), root) && !installed(id);
  const sources = [...new Set([...modules.filter(own), ...cssFiles.filter(own)])]
    .map((id) => relative(root, real(id)).split(sep).join('/'))
    .sort();
  return { code: chunk.code, map: chunk.map?.toString() ?? '', css, sources };
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
    const hash = createHash('sha256').update(built.code).update('\0').update(built.css).digest('hex').slice(0, 12);
    const name = `${decl.id}-${hash}`;
    files[`${name}.js`] = `${built.code.trimEnd()}\n//# sourceMappingURL=${name}.js.map\n`;
    if (built.map) files[`${name}.js.map`] = JSON.stringify({ ...JSON.parse(built.map), file: `${name}.js` });
    if (built.css.trim()) files[`${name}.css`] = wrapCss(decl.id, built.css);
    entries[decl.id] = { kind: decl.kind, js: `${name}.js`, ...(built.css.trim() ? { css: `${name}.css` } : {}), sources: built.sources };
  }
  return { entries, files };
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
