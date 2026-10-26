/**
 * A built App, read back: the build manifest `mistri build` writes
 * (mistri-build.json), the compiled App beside it (app.json), and the
 * lossless JSON both are written in.
 *
 * A build is the LoadedApp a start would otherwise compute — the worker's
 * import of the TypeScript graph, the parse, the features composed, the
 * authority reported — done once, in CI, and frozen. Serving one is a hash
 * check and a decode: no worker, no TypeScript, no parse. That is only true
 * while the code that wrote app.json is the code reading it, so a build is
 * pinned to the mistri version that made it and refused by any other,
 * and every file it holds is hashed so that a build edited in place, or
 * half-copied into an image, is refused rather than served.
 *
 * The writer is src/server/build/; this module is the half a server needs,
 * which is why it lives with the loader.
 */
import { createHash } from 'node:crypto';
import { runtimeVersion } from '@mistriwork/engine/server/packageVersion.js';
import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertAuthorityLock, AUTHORITY_LOCK, type AppAuthority } from './authorityLock.js';
import type { DefinitionInput, LoadedApp } from './apps.js';
import { holdLocalizer, localizerOf, type AppCatalogs } from './appMessages.js';
import { checkPageLoaders } from './pageLoaderCheck.js';
import type { CompiledComponents } from './appComponents.js';
import { readBuiltFonts } from './appFonts.js';
import { readBuiltBrand } from './appBrand.js';
import { resolveMistriFromBuild } from './buildResolution.js';
import { assertAppApiContext, readApiApp } from '../api/appApiValidation.js';

/** The build manifest's file name: its presence is what makes a directory a build. */
export const BUILD_MANIFEST = 'mistri-build.json';
const FORMAT = 1;

/** The server entries a build may bundle, by the flag that names each. */
export const BUILD_ENTRY_KINDS = ['commands', 'jobs', 'policy'] as const;
export type BuildEntryKind = (typeof BUILD_ENTRY_KINDS)[number];

export interface BuildManifest {
  format: typeof FORMAT;
  /** The mistri that made the build; the only one that serves it. */
  mistri: string;
  /** The Node that made it: informational, since the JSON and ESM it wrote are Node's to read on any 24+. */
  node: string;
  app: { id: string; name: string; manifest: string };
  bundler: { name: 'rolldown'; version: string } | { name: 'strip-types'; node: string } | { name: 'none' };
  checks: {
    typecheck: { status: 'passed' | 'skipped' | 'none'; detail: string };
    /** Always passed: a build that fails validation is never written. */
    validation: 'passed';
    database: { status: 'passed' | 'skipped'; detail: string };
  };
  /** The bundled server entries, by kind, relative to the build. */
  entries: Partial<Record<BuildEntryKind, string>>;
  /**
   * What the build produced, by kind, relative to the build; a kind that is
   * absent was not produced. This is the extension point for the outputs a
   * later build adds — the custom components' graph (`components`), and the
   * served OpenAPI document once it can be computed without a database —
   * each a new optional key here and a new file under `sha256`, so a reader
   * never has to guess what a build holds.
   */
  outputs: { manifest: string; definition?: string; types?: string; components?: string; fonts?: string; brand?: string };
  /** Every file of the build except this manifest, by relative path. */
  sha256: Record<string, string>;
}

/** What `LoadedApp.build` says about the build an App was served from. */
export interface AppBuildInfo {
  dir: string;
  mistri: string;
  node: string;
  /** The absolute paths of the bundled server entries, by kind. */
  entries: Partial<Record<BuildEntryKind, string>>;
}

export const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

/* ---------- lossless JSON ----------

   The parser writes keys whose value is undefined — `{ text: s.text }` for
   a section with no text — and JSON cannot say undefined: it drops the key.
   A built App would then be a different object from its source, and
   `Object.keys`, `in` and a deep-strict comparison all see the difference.
   So the encoder records where each undefined key was, and the decoder puts
   it back in the same place in the key order. Anything else JSON cannot
   carry exactly is refused, loudly, as a bug in tablewalk: the definition is
   the parser's output, and the parser produces plain data. */

type Hole = [parent: string, key: string | number, position: number];

const escape = (segment: string | number) => String(segment).replaceAll('~', '~0').replaceAll('/', '~1');

function notJson(where: string, what: string): never {
  throw new Error(`The compiled App cannot hold ${what} at "${where || '/'}" exactly as JSON. This is a bug in mistri, not in your App.`);
}

/** The value as a JSON tree, and the undefined keys and elements it had. */
export function encodeLossless(value: unknown): { tree: unknown; undefinedAt: Hole[] } {
  const holes: Hole[] = [];
  const walk = (node: unknown, at: string): unknown => {
    if (node === null || typeof node === 'string' || typeof node === 'boolean') return node;
    if (typeof node === 'number') {
      if (!Number.isFinite(node) || Object.is(node, -0)) notJson(at, `the number ${Object.is(node, -0) ? '-0' : String(node)}`);
      return node;
    }
    if (typeof node !== 'object') notJson(at, `a ${typeof node}`);
    const prototype = Object.getPrototypeOf(node);
    if (Array.isArray(node)) {
      if (prototype !== Array.prototype || Object.keys(node).length !== node.length) notJson(at, 'an array with holes or extra properties');
      return node.map((element: unknown, index: number) => {
        if (element !== undefined) return walk(element, `${at}/${index}`);
        holes.push([at, index, index]);
        return null;
      });
    }
    if (prototype !== Object.prototype)
      notJson(at, prototype === null ? 'an object with no prototype' : `a ${(node as object).constructor?.name ?? 'class'} instance`);
    if (Object.getOwnPropertySymbols(node).length || Object.getOwnPropertyNames(node).length !== Object.keys(node).length) {
      notJson(at, 'symbol or hidden keys');
    }
    const out: Record<string, unknown> = {};
    Object.keys(node).forEach((key, position) => {
      const descriptor = Object.getOwnPropertyDescriptor(node, key)!;
      if (!('value' in descriptor)) notJson(`${at}/${escape(key)}`, 'an accessor');
      if (descriptor.value === undefined) holes.push([at, key, position]);
      else
        Object.defineProperty(out, key, {
          value: walk(descriptor.value, `${at}/${escape(key)}`),
          enumerable: true,
          writable: true,
          configurable: true,
        });
    });
    return out;
  };
  return { tree: walk(value, ''), undefinedAt: holes };
}

/** The inverse of encodeLossless: the tree, with its undefined keys back where they were. */
export function decodeLossless(tree: unknown, undefinedAt: readonly Hole[]): unknown {
  const byParent = new Map<string, Hole[]>();
  for (const hole of undefinedAt) {
    const list = byParent.get(hole[0]);
    if (list) list.push(hole);
    else byParent.set(hole[0], [hole]);
  }
  const walk = (node: unknown, at: string): unknown => {
    if (node === null || typeof node !== 'object') return node;
    const holes = byParent.get(at);
    if (Array.isArray(node)) {
      const out = node.map((element: unknown, index) => walk(element, `${at}/${index}`));
      for (const [, index] of holes ?? []) out[index as number] = undefined;
      return out;
    }
    const entries: Array<[string, unknown]> = Object.keys(node).map((key) => [
      key,
      walk((node as Record<string, unknown>)[key], `${at}/${escape(key)}`),
    ]);
    for (const [, key, position] of [...(holes ?? [])].sort((a, b) => a[2] - b[2])) entries.splice(position, 0, [String(key), undefined]);
    // fromEntries defines each key, so an own `__proto__` stays a key rather than a prototype.
    return Object.fromEntries(entries);
  };
  return walk(tree, '');
}

/* ---------- the compiled App ---------- */

interface CompiledApp {
  format: typeof FORMAT;
  /** What authority.lock holds for this App: its effective authority when it was built. */
  authority: string;
  /** Which file defined each page, relative to the App directory it was built from. */
  sources: Record<string, string>;
  app: unknown;
  pages: unknown;
  origins: unknown;
  /** What a reader's language is said from (appMessages.ts `Localizer`), where the App has catalogs. */
  messages?: unknown;
  undefined: Hole[];
}

/* A built App says itself in each reader's language as its source does: by parsing its definition again with the
   catalogs (apps.ts `localizedApp`), and with a tenant's own words over them. So app.json keeps that input beside the
   parse — the manifest's export, its JSON pages, the command catalog its names resolve to, and the checked catalogs. */
interface CompiledWords {
  definition: { raw: unknown; filePages: unknown; catalog?: Array<[string, unknown]> };
  catalogs: Pick<AppCatalogs, 'source' | 'locales' | 'files' | 'advisories'>;
}

function compiledWords(loaded: LoadedApp): CompiledWords | undefined {
  const localizer = localizerOf(loaded.app);
  if (!localizer) return undefined;
  const { raw, filePages, catalog } = localizer.definition as DefinitionInput;
  const { source, locales, files, advisories } = localizer.catalogs;
  return {
    definition: { raw, filePages, ...(catalog ? { catalog: [...catalog] } : {}) },
    /* A catalog's entries have no prototype (appMessages.ts), which JSON cannot say: they are written plain, and read back bare. */
    catalogs: {
      source,
      locales: Object.fromEntries(Object.entries(locales).map(([tag, entries]) => [tag, { ...entries }])),
      files: { ...files },
      advisories: [...advisories],
    },
  };
}

/** app.json's text for a loaded App: the definition, its provenance, and its authority report. */
export function compiledAppJson(loaded: LoadedApp, sourceDir: string): string {
  const words = compiledWords(loaded);
  const { tree, undefinedAt } = encodeLossless({
    app: loaded.app,
    pages: loaded.pages,
    origins: loaded.origins,
    ...(words ? { messages: words } : {}),
  });
  const sources = Object.fromEntries(
    Object.entries(loaded.sources).map(([page, file]) => [page, relative(sourceDir, file).split(sep).join('/')]),
  );
  const compiled: CompiledApp = {
    format: FORMAT,
    authority: loaded.authority!.report,
    sources,
    ...(tree as Pick<CompiledApp, 'app' | 'pages' | 'origins' | 'messages'>),
    undefined: undefinedAt,
  };
  return `${JSON.stringify(compiled, null, 2)}\n`;
}

function decodeCompiledApp(
  text: string,
  where: string,
): Pick<LoadedApp, 'app' | 'pages' | 'origins'> & { authority: string; messages?: CompiledWords } {
  const compiled = JSON.parse(text) as CompiledApp;
  if (compiled?.format !== FORMAT || typeof compiled.authority !== 'string' || !Array.isArray(compiled.undefined)) {
    throw new Error(`${where} is not a compiled App this mistri reads.`);
  }
  const { app, pages, origins, messages } = decodeLossless(
    {
      app: compiled.app,
      pages: compiled.pages,
      origins: compiled.origins,
      ...(compiled.messages === undefined ? {} : { messages: compiled.messages }),
    },
    compiled.undefined,
  ) as Pick<LoadedApp, 'app' | 'pages' | 'origins'> & { messages?: CompiledWords };
  return { app, pages, origins, authority: compiled.authority, ...(messages ? { messages } : {}) };
}

/* ---------- custom components ---------- */

/** Where a build lists its compiled components; the files sit beside it, each hashed like every file of the build. */
export const COMPONENTS_INDEX = 'components/components.json';

/** The index a build writes: each component's kind and served files, without the sources a watcher needs. */
export function componentsIndex(compiled: CompiledComponents): Record<string, { kind: string; js: string; css?: string }> {
  return Object.fromEntries(Object.entries(compiled.entries).map(([id, { kind, js, css }]) => [id, { kind, js, ...(css ? { css } : {}) }]));
}

async function readBuiltComponents(dir: string, index: string): Promise<CompiledComponents> {
  const listed = JSON.parse(await readFile(join(dir, index), 'utf8')) as Record<
    string,
    { kind: 'section' | 'value'; js: string; css?: string }
  >;
  const files: Record<string, string> = {};
  const entries: CompiledComponents['entries'] = {};
  const folder = join(dir, 'components');
  for (const [id, entry] of Object.entries(listed)) {
    for (const file of [entry.js, `${entry.js}.map`, ...(entry.css ? [entry.css] : [])]) {
      const text = await readFile(join(folder, file), 'utf8').catch(() => undefined);
      if (text === undefined && !file.endsWith('.map')) throw new Error(`${dir}: components/${file} is missing. ${rebuild}`);
      if (text !== undefined) files[file] = text;
    }
    entries[id] = { kind: entry.kind, js: entry.js, ...(entry.css ? { css: entry.css } : {}), sources: [] };
  }
  return { entries, files };
}

/** A build's theme fonts (appFonts.ts), from its fonts/ folder by the names its definition carries. */
async function builtFonts(app: LoadedApp['app'], dir: string): Promise<Pick<LoadedApp, 'fonts' | 'brand'>> {
  const fonts = await readBuiltFonts(app, dir, rebuild);
  /* The logo's pictures beside them, from brand/ (appBrand.ts). */
  const brand = await readBuiltBrand(app, dir, rebuild);
  return { ...(fonts ? { fonts } : {}), ...(brand ? { brand } : {}) };
}

/* ---------- reading a build ---------- */

const rebuild = 'Rebuild it with `mistri build`; a build is not edited in place.';

/** The manifest, once its format and version say this runtime may serve it. */
async function readBuildManifest(dir: string): Promise<BuildManifest> {
  const path = join(dir, BUILD_MANIFEST);
  let manifest: BuildManifest;
  try {
    manifest = JSON.parse(await readFile(path, 'utf8')) as BuildManifest;
  } catch (error) {
    throw new Error(`${path}: ${(error as Error).message}`);
  }
  if (manifest?.format !== FORMAT || typeof manifest.mistri !== 'string' || !manifest.sha256 || !manifest.outputs?.manifest) {
    throw new Error(`${path} is not a build this mistri reads (format ${String(manifest?.format)}). ${rebuild}`);
  }
  if (manifest.mistri !== runtimeVersion()) {
    throw new Error(
      `${dir} was built by mistri ${manifest.mistri}; this is mistri ${runtimeVersion()}. ` +
        "A build is pinned to the version that made it: rebuild it with this version's `mistri build`.",
    );
  }
  return manifest;
}

/** Every file the manifest names, re-hashed; the first one missing or changed refuses the build. */
async function verifyBuildFiles(dir: string, manifest: BuildManifest): Promise<void> {
  const root = resolve(dir);
  for (const [name, expected] of Object.entries(manifest.sha256)) {
    const file = resolve(root, name);
    if (isAbsolute(name) || normalize(name).startsWith('..') || !file.startsWith(root + sep)) {
      throw new Error(`${join(dir, BUILD_MANIFEST)} names "${name}", which is not inside the build. ${rebuild}`);
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(file);
    } catch {
      throw new Error(`${dir}: ${name} is missing. ${rebuild}`);
    }
    if (sha256(bytes) !== expected)
      throw new Error(`${dir}: ${name} has changed since it was built (its content hash differs). ${rebuild}`);
  }
}

/**
 * Load a build as `loadApp` loads a source directory. The lock gate is the
 * same one — an App whose authority is not its lock's does not start — with
 * `lock: 'report'` for mistri check, which names the difference instead.
 */
export async function loadBuiltApp(dir: string, options: { lock?: 'enforce' | 'report' } = {}): Promise<LoadedApp> {
  const manifest = await readBuildManifest(dir);
  await verifyBuildFiles(dir, manifest);
  const path = join(dir, manifest.outputs.manifest);
  const { app, pages, origins, authority: report, messages } = decodeCompiledApp(await readFile(path, 'utf8'), path);
  const lockPath = join(dir, AUTHORITY_LOCK);
  const lock = Object.hasOwn(manifest.sha256, AUTHORITY_LOCK) ? await readFile(lockPath, 'utf8') : undefined;
  const authority: AppAuthority = { report, lockPath, ...(lock === undefined ? {} : { lock }) };
  if (options.lock !== 'report') assertAuthorityLock(authority);
  assertAppApiContext(readApiApp(app));
  const entries = Object.fromEntries(Object.entries(manifest.entries).map(([kind, file]) => [kind, resolve(dir, file)]));
  /* Its entries' `mistri/…` imports are this mistri's, wherever the build was put (buildResolution.ts). */
  resolveMistriFromBuild(dir);
  /* Its free-form pages' loaders, from the commands bundle the build made, held to its pages as a source load holds them. */
  const loaders = entries.commands
    ? (await import('../commands/pageLoaders.js')).pageLoadersOf(
        await import(pathToFileURL(entries.commands).href),
        basename(entries.commands),
      )
    : undefined;
  checkPageLoaders(app, loaders, path);
  /* And its human checks, from the same bundle (commands/challenges.ts). */
  const challenges = entries.commands
    ? (await import('../commands/challenges.js')).challengesOf(
        await import(pathToFileURL(entries.commands).href),
        basename(entries.commands),
      )
    : undefined;
  (await import('../commands/challenges.js')).namedChallenge(app.auth?.challenge, challenges, path);
  if (messages) {
    /* The formatter is imported only for a build with catalogs, as a source load imports it (appMessages.ts). */
    const { default: Format } = await import('intl-messageformat');
    const { raw, filePages, catalog } = messages.definition;
    const definition: DefinitionInput = {
      raw: raw as DefinitionInput['raw'],
      path,
      filePages: filePages as DefinitionInput['filePages'],
      ...(catalog ? { catalog: new Map(catalog) as NonNullable<DefinitionInput['catalog']> } : {}),
    };
    const locales = Object.fromEntries(
      Object.entries(messages.catalogs.locales).map(([tag, entries]) => [tag, Object.freeze(Object.assign(Object.create(null), entries))]),
    );
    holdLocalizer(app, { definition, catalogs: Object.freeze({ ...messages.catalogs, locales: Object.freeze(locales), Format }) });
  }
  return {
    path,
    dir,
    app,
    pages,
    // A build defines every page in app.json; where each came from is kept there for readers.
    sources: Object.fromEntries(pages.map((page) => [page.id, path])),
    authority,
    origins,
    build: { dir: resolve(dir), mistri: manifest.mistri, node: manifest.node, entries },
    ...(manifest.outputs.components ? { components: await readBuiltComponents(dir, manifest.outputs.components) } : {}),
    ...(await builtFonts(app, dir)),
    ...(loaders ? { loaders } : {}),
    ...(challenges ? { challenges } : {}),
  };
}
