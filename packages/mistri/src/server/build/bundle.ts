/**
 * The bundle step of `mistri build`: the App's definition graph, and the
 * server entries it is started with, as ESM a server imports without loading
 * TypeScript.
 *
 * Two graphs, never one. The definition (app.ts and its imports) is plain
 * data evaluated in a worker: it is bundled whole, `@mistriwork/mistri/app` inlined
 * as this runtime's own helpers, so the file is self-contained. The server
 * entries (--commands, --jobs, --policy) are one build with several inputs:
 * modules they share — Ignition's events, imported by its commands and its
 * jobs — become one chunk, so they stay one instance as Node's module cache
 * makes them from source. Every other bare specifier there stays external:
 * `@mistriwork/mistri/commands` and its siblings must be the running server's own
 * modules (a registry is branded in a module-private WeakSet, a handler's
 * error class is tested with instanceof), and an installed package belongs
 * to the deployment's node_modules. What the App wrote is bundled; what it
 * installed is not. The one exception is `@mistriwork/mistri/app`, inlined in both
 * graphs: its helpers are stateless data constructors (a server module
 * builds its input fields with them), so a copy is the same as the original,
 * and a build that carries its own needs nothing resolved for them.
 *
 * Rolldown is an optional peer, imported only here. Without it each module
 * is type-stripped on its own with node:module's stripTypeScriptTypes, in
 * strip mode — the erasable-syntax rule Node applies when it runs the
 * source — and mirrored under src/, one file per module, relative imports
 * rewritten to the emitted names. Outputs are .mjs with no package.json of
 * their own: an installed package resolves from the project the build sits
 * in, as it does for the source, and `@mistriwork/mistri/commands` and its siblings
 * from the mistri that serves the build, wherever it sits
 * (app/buildResolution.ts).
 */
import { existsSync, realpathSync, statSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isBuiltin, stripTypeScriptTypes } from 'node:module';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A bundle that could not be made: the build's exit code 4. */
export class BundleError extends Error {}

export interface Bundler {
  name: 'rolldown';
  version: string;
  build: typeof import('rolldown').build;
}

/** Rolldown when it is installed; undefined when it is not, which is not an error. */
export async function loadRolldown(): Promise<Bundler | undefined> {
  try {
    const rolldown = await import('rolldown');
    return { name: 'rolldown', version: rolldown.VERSION, build: rolldown.build };
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND' && /['"]rolldown['"]/.test((error as Error).message);
    if (missing) return undefined;
    throw new BundleError(`rolldown is installed but could not be loaded: ${(error as Error).message}`);
  }
}

/* The DSL helpers this runtime ships. A build is pinned to its version, so
   its definition carries this version's helpers, not whichever copy the
   App's project happens to resolve. */
const APP_DSL = fileURLToPath(new URL('../../../schema/app.mjs', import.meta.url));

const bare = (id: string) => !id.startsWith('.') && !isAbsolute(id) && !id.startsWith('\0') && !/^[a-z][a-z0-9+.-]*:/i.test(id);
const posix = (path: string) => path.split(sep).join('/');
const specifier = (from: string, to: string) => {
  const path = posix(relative(dirname(from), to));
  return path.startsWith('.') ? path : `./${path}`;
};

async function rolldownBuild(
  bundler: Bundler,
  options: {
    input: Record<string, string>;
    dir: string;
    inline: boolean;
    external: (id: string) => boolean;
    plugins?: import('rolldown').Plugin[];
  },
): Promise<string[]> {
  const warnings: string[] = [];
  try {
    await bundler.build({
      input: options.input,
      platform: 'node',
      /* Node's type stripping reads no tsconfig either — honouring `paths`
         would build something the source never ran. */
      tsconfig: false,
      external: (id, _importer, isResolved) => !isResolved && (isBuiltin(id) || options.external(id)),
      plugins: options.plugins,
      // The spelling the samples use: `./events.js` names events.ts, as under tsx.
      resolve: { extensionAlias: { '.js': ['.ts', '.js'], '.mjs': ['.mts', '.mjs'] } },
      onLog: (level, log) => {
        if (level === 'warn') warnings.push(log.message);
      },
      output: {
        dir: options.dir,
        format: 'esm',
        sourcemap: true,
        // Readable, as everything this repository ships: a stack trace names a line a person can open.
        minify: false,
        entryFileNames: '[name].mjs',
        chunkFileNames: 'chunks/[name]-[hash].mjs',
        ...(options.inline ? { codeSplitting: false } : {}),
      },
      write: true,
    });
  } catch (error) {
    throw new BundleError(rolldownErrors(error));
  }
  return warnings;
}

/* Rolldown's diagnostics are drawn for a terminal: colours, a code frame, a
   path relative to wherever it ran. A CI log wants one plain line per
   problem, naming the file and the place. */
const COLOUR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
export function rolldownErrors(error: unknown): string {
  const found = (
    error as { errors?: Array<{ code?: string; message?: string; id?: string; loc?: { file?: string; line: number; column: number } }> }
  ).errors;
  if (!Array.isArray(found) || !found.length) return String((error as Error).message ?? error).replace(COLOUR, '');
  return found
    .map(({ code, message = '', id, loc }) => {
      const said = message
        .replace(COLOUR, '')
        .split('\n')[0]
        .replace(/^\[[A-Z_]+\]\s*/, '')
        .replace(/ in \S+$/, '');
      const where = loc ? `${loc.file ?? id}:${loc.line}:${loc.column + 1}` : id;
      return `${where ? `${where}: ` : ''}${code ? `${code} ` : ''}${said}`;
    })
    .join('\n');
}

/* ---------- the fallback: one file per module ---------- */

/* Import and export specifiers in stripped code. A fallback's scanner, not a
   parser: it reads the statement forms an App's modules use, and a form it
   misses is a module it does not copy, which the first import of the build
   names. Type-only imports are already blank by the time it looks. */
const STATIC_IMPORT = /\b(?:import|export)\b[^'"`;]*?\bfrom\s*(['"])([^'"\n]+)\1|\bimport\s*(['"])([^'"\n]+)\3/dg;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/dg;

interface Module {
  code: string;
  imports: Array<{ start: number; end: number; target: string }>;
}

function resolveRelative(from: string, spec: string): string {
  const base = resolve(dirname(from), spec);
  const candidates = [base];
  if (spec.endsWith('.js')) candidates.push(`${base.slice(0, -3)}.ts`);
  if (spec.endsWith('.mjs')) candidates.push(`${base.slice(0, -4)}.mts`);
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  throw new BundleError(`${from}: cannot resolve "${spec}". Name the file with its extension, as Node requires.`);
}

const emittedName = (file: string) => {
  const ext = extname(file);
  if (['.cts', '.cjs', '.tsx'].includes(ext)) {
    throw new BundleError(`${file}: the fallback bundles ES modules only. Install rolldown to build it.`);
  }
  return ['.ts', '.mts', '.js', '.mjs'].includes(ext) ? `${file.slice(0, -ext.length)}.mjs` : file;
};

async function stripGraph(entries: Record<string, string>, dir: string): Promise<void> {
  const modules = new Map<string, Module>();
  const vendored = join(dir, 'mistri-app.mjs');
  let vendorDsl = false;
  const visit = async (file: string): Promise<void> => {
    if (modules.has(file)) return;
    const source = await readFile(file, 'utf8');
    let code = source;
    if (/\.m?ts$/.test(file)) {
      try {
        code = stripTypeScriptTypes(source, { mode: 'strip' });
      } catch (error) {
        throw new BundleError(`${file}: ${(error as Error).message}`);
      }
    }
    const module: Module = { code, imports: [] };
    modules.set(file, module);
    if (!/\.m?[jt]s$/.test(file)) return;
    for (const pattern of [STATIC_IMPORT, DYNAMIC_IMPORT]) {
      for (const match of code.matchAll(pattern)) {
        const group = match[2] !== undefined ? 2 : 4;
        const spec = match[group];
        const [start, end] = match.indices![group]!;
        if (spec === '@mistriwork/mistri/app') {
          vendorDsl = true;
          module.imports.push({ start, end, target: vendored });
        } else if (spec.startsWith('.')) {
          const target = resolveRelative(file, spec);
          module.imports.push({ start, end, target });
          await visit(target);
        }
      }
    }
  };
  for (const file of Object.values(entries)) await visit(file);
  const files = [...modules.keys()];
  // The common ancestor of every module: usually the App directory.
  let root = dirname(files[0]);
  while (!files.every((file) => file.startsWith(root + sep))) root = dirname(root);
  const out = (file: string) => (file === vendored ? vendored : join(dir, 'src', emittedName(relative(root, file))));
  for (const [file, module] of modules) {
    let code = module.code;
    // From the end, so each rewrite leaves the earlier offsets where they were.
    for (const { start, end, target } of [...module.imports].sort((a, b) => b.start - a.start)) {
      code = code.slice(0, start) + specifier(out(file), out(target)) + code.slice(end);
    }
    await mkdir(dirname(out(file)), { recursive: true });
    await writeFile(out(file), code);
  }
  if (vendorDsl) await copyFile(APP_DSL, vendored);
  for (const [name, file] of Object.entries(entries)) {
    const target = specifier(join(dir, `${name}.mjs`), out(file));
    await writeFile(join(dir, `${name}.mjs`), `export * from '${target}';\nexport { default } from '${target}';\n`);
  }
}

/* ---------- the two graphs ---------- */

const appDsl: import('rolldown').Plugin = { name: 'mistri:app-dsl', resolveId: (id) => (id === '@mistriwork/mistri/app' ? APP_DSL : null) };

/* A module's `import.meta.url`, inlined into the one definition file, would name that file, and a theme package says
   `from: import.meta.url` so its stylesheet and faces are read beside it (themeSpec.ts). Each module keeps its own:
   the source file, relative to the bundle, so the build carries no path on this machine and resolves it as long as it
   sits where it was made. `${out}.staging-<pid>` is `out`'s sibling, so the two resolve the same. The bundle is
   evaluated only to prove it is the source's App; a built App is served from app.json and its own fonts/ and brand/. */
const ownUrl = (dir: string): import('rolldown').Plugin => ({
  name: 'mistri:own-url',
  transform(code, id) {
    if (!isAbsolute(id) || !/\bimport\.meta\.url\b/.test(code)) return null;
    const path = posix(relative(dir, id)).split('/').map(encodeURIComponent).join('/');
    return { code: code.replace(/\bimport\.meta\.url\b/g, `new URL(${JSON.stringify(path)}, import.meta.url).href`), map: null };
  },
});

/** The App definition graph as `<dir>/app.mjs`. Returns bundler warnings. */
export async function bundleDefinition(bundler: Bundler | undefined, manifest: string, dir: string): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  if (!bundler) {
    await stripGraph({ app: manifest }, dir);
    return [];
  }
  return rolldownBuild(bundler, {
    input: { app: manifest },
    dir,
    inline: true,
    // Only builtins stay out: the definition is data, and a self-contained file is one a build can move.
    external: () => false,
    // Node's loader names a module by its real path, so the relative one is measured from the real folder.
    plugins: [appDsl, ownUrl(realpathSync(dir))],
  });
}

/** The server entries, by kind, as `<dir>/<kind>.mjs`. Returns bundler warnings. */
export async function bundleServer(bundler: Bundler | undefined, entries: Record<string, string>, dir: string): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  if (!bundler) {
    await stripGraph(entries, dir);
    return [];
  }
  return rolldownBuild(bundler, {
    input: entries,
    dir,
    inline: false,
    external: (id) => id !== '@mistriwork/mistri/app' && bare(id),
    plugins: [appDsl],
  });
}
