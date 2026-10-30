/**
 * `mistri build`: an App made ready for production.
 *
 * An App runs from its source directory, and that stays true — this is an
 * optional step, never a requirement, and the database browser has none. What
 * it adds is the work a start does at every boot, done once in CI, plus the
 * one check a start never runs: typecheck, validate the App the way loading
 * does, bundle its server modules, write the compiled App a server starts
 * from without loading TypeScript (appBuild.ts reads it back), and, when a
 * config reaches the database, run the real mistri check on exactly what
 * ships. Each step that can fail has its own exit code, so CI can say which.
 *
 * The work happens in a staging sibling of --out that is renamed into place
 * only when every step passed: a failed build leaves the previous one.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { Registry } from '@mistriwork/engine/server/connections.js';
import { loadApp, type LoadedApp } from '../app/apps.js';
import { AUTHORITY_LOCK, checkAuthorityLock } from '../app/authorityLock.js';
import { serverEntry } from '../serverEntry.js';
import { buildInputId } from './fingerprint.js';
import {
  BUILD_ENTRY_KINDS,
  BUILD_MANIFEST,
  COMPONENTS_INDEX,
  compiledAppJson,
  componentsIndex,
  decodeLossless,
  encodeLossless,
  sha256,
  type BuildEntryKind,
  type BuildManifest,
} from '../app/appBuild.js';
import { parseArgs } from '@mistriwork/engine/server/cli/args.js';
import { runtimeVersion } from '@mistriwork/engine/server/packageVersion.js';
import { CHECK_BUILD_OF } from '../cli/apps.js';
import { CHECK_VALIDATION } from '@mistriwork/engine/server/cli/args.js';
import { readStartupConfig } from '@mistriwork/engine/server/cli/config.js';
import { appTypes } from '../cli/oneShot.js';
import { sameTypes, typesFileText } from '../typegen.js';
import { BundleError, bundleDefinition, bundleServer, loadRolldown, type Bundler } from './bundle.js';
import { appDockerfile } from './dockerfile.js';
import { typecheckApp } from './typecheck.js';
import type { AppEnvName } from '../../shared/appAuthority.js';
import { CONFIG_SECTIONS } from '../serviceConnections.js';

/** The exit codes, one per step that can fail. */
export const BUILD_EXIT = { built: 0, couldNotBuild: 1, typecheck: 2, validation: 3, bundle: 4 } as const;

export class BuildFailure extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
  }
}

interface BuildRequest {
  app: string;
  /** The manifest, when it is not the directory's own app.ts (--app-entry); the directory stays the App's root. */
  appEntry?: string;
  out?: string;
  config?: string;
  commands?: string;
  jobs?: string;
  policy?: string;
}

/** What a caller may swap: the bundler (the fallback's test), and whether to typecheck (the parity suite checks types elsewhere). */
interface BuildSeams {
  bundler?: () => Promise<Bundler | undefined>;
  typecheck?: boolean;
}

const fail = (code: number, message: string, detail?: string) => new BuildFailure(code, message, detail);
/* Relative to where the command ran when that is shorter to read; absolute when it would climb out. */
const shown = (path: string) => {
  const near = relative(process.cwd(), path);
  return !near ? '.' : near.startsWith('..') ? path : near;
};
const shellArg = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
const inside = (child: string, parent: string) => child.startsWith(parent + sep);

/** The files under a directory, relative to it, sorted: what the manifest hashes. */
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort();
}

/** The first place two values differ, as a JSON Pointer; undefined when they are deep-strictly equal. */
function difference(a: unknown, b: unknown, at = ''): string | undefined {
  if (isDeepStrictEqual(a, b)) return undefined;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const found = difference((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${at}/${key}`);
      if (found) return found;
    }
  }
  return at || '/';
}

/* The CLI entry this module belongs to, and the loader flags it was started
   with (tsx's, under the test suites), so a child runs the same tablewalk. */
export function selfInvocation(): string[] {
  const entry = serverEntry();
  const kept: string[] = [];
  const argv = process.execArgv;
  for (let i = 0; i < argv.length; i++) {
    if (['--import', '--require', '-r', '--loader', '--experimental-loader', '--conditions', '-C'].includes(argv[i]))
      kept.push(argv[i], argv[++i]);
    else if (/^--(?:import|require|loader|experimental-loader|conditions)=/.test(argv[i])) kept.push(argv[i]);
  }
  return [...kept, entry];
}

/** Run this mistri's own validation over `args`, as a child (CHECK_VALIDATION): what `mistri check` and a build's database step both report. */
export function checkApp(args: string[], builtFrom?: string): Promise<{ code: number; output: string; stdout: string; stderr: string }> {
  return new Promise((done, reject) => {
    const env = { ...process.env, [CHECK_VALIDATION]: '1', ...(builtFrom ? { [CHECK_BUILD_OF]: builtFrom } : {}) };
    const child = spawn(process.execPath, [...selfInvocation(), ...args], { stdio: ['ignore', 'pipe', 'pipe'], env });
    let output = '';
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      output += String(chunk);
      stderr += String(chunk);
    });
    child.once('error', reject);
    child.once('close', (code) => done({ code: code ?? 1, output: output.trim(), stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

/** The connections the App binds, opened: the names that did not open, or the missing name. */
async function probe(registry: Registry, loaded: LoadedApp): Promise<{ unreachable: string[] }> {
  const bound = loaded.app.sources
    ? Object.values(loaded.app.sources).map((source) => source.connection)
    : [loaded.app.connection ?? registry.active ?? ''];
  const unreachable: string[] = [];
  for (const name of bound) {
    const found = registry.list().find((connection) => connection.id === name || connection.name === name);
    // A name the config does not have is mistri check's to report, as a problem.
    if (!found) continue;
    try {
      await registry.open(found.id);
    } catch {
      // Never the error text: a driver's message can carry the host and the user.
      unreachable.push(found.name);
    }
  }
  return { unreachable };
}

/** Build one App. `say` receives a line per step; a failure throws BuildFailure. */
export async function buildApp(
  request: BuildRequest,
  seams: BuildSeams = {},
  say: (line: string) => void = () => {},
): Promise<{ out: string; manifest: BuildManifest }> {
  const started = performance.now();
  const appDir = resolve(request.app);
  const info = await stat(appDir).catch(() => undefined);
  if (!info) throw fail(BUILD_EXIT.couldNotBuild, `${request.app} does not exist.`);
  if (!info.isDirectory()) {
    throw fail(
      BUILD_EXIT.couldNotBuild,
      `${request.app} is not a directory. A build is of an App directory: its manifest, pages/ and authority.lock travel together.`,
    );
  }
  if (existsSync(join(appDir, BUILD_MANIFEST)))
    throw fail(BUILD_EXIT.couldNotBuild, `${request.app} is already a build; build the App's source directory.`);
  /* An App at the package root — the command runs in it — has no build/ beside it: build/<name> would land inside
     it, so its build goes beside the App instead. Inside, its mistri-schema.d.ts would join the App's own
     typecheck under a tsconfig that includes everything. */
  const beside = resolve('build', basename(appDir));
  const out = resolve(
    request.out ?? (beside === appDir || inside(beside, appDir) ? join(dirname(appDir), `${basename(appDir)}-build`) : beside),
  );
  if (out === appDir || inside(out, appDir) || inside(appDir, out)) {
    throw fail(
      BUILD_EXIT.couldNotBuild,
      `--out ${shown(out)} overlaps the App directory. A build inside the App would be read as part of it — its typecheck, its reloads — so choose a directory beside it.`,
    );
  }
  if (existsSync(out)) {
    const held = (await stat(out)).isDirectory() ? await readdir(out) : undefined;
    if (!held || (held.length && !held.includes(BUILD_MANIFEST))) {
      throw fail(
        BUILD_EXIT.couldNotBuild,
        `${shown(out)} exists and is not an earlier build, so it is not replaced. Choose a new or empty --out.`,
      );
    }
  }
  const entries: Partial<Record<BuildEntryKind, string>> = {};
  for (const kind of BUILD_ENTRY_KINDS) {
    const given = request[kind];
    if (given === undefined) continue;
    const file = resolve(given);
    if (!existsSync(file) || !(await stat(file)).isFile() || !['.ts', '.mts', '.mjs', '.js'].includes(extname(file))) {
      throw fail(BUILD_EXIT.couldNotBuild, `--${kind} ${given} is not a .ts, .mts, .mjs or .js file.`);
    }
    entries[kind] = file;
  }
  if (entries.jobs && !entries.commands)
    throw fail(BUILD_EXIT.couldNotBuild, "--jobs requires --commands: a job runs one of the App's commands.");

  /* The config is read before anything is staged: a config that is wrong
     stops the start, and so it stops the build, with nothing left behind. */
  let registry: Registry | undefined;
  /* A config may list this App — that is where its environment is written
     (`apps[].env`), which its definition is evaluated with here as at a
     start — but not another App, which the database checks would load
     beside it. */
  let env: readonly AppEnvName[] | undefined;
  let listed = false;
  if (request.config !== undefined) {
    if (!existsSync(request.config)) throw fail(BUILD_EXIT.couldNotBuild, `--config ${request.config} does not exist.`);
    registry = new Registry();
    const config = await readStartupConfig(parseArgs(['--config', request.config]), registry, CONFIG_SECTIONS);
    if (config.apps.some((dir) => resolve(dir) !== appDir)) {
      await registry.closeAll();
      throw fail(
        BUILD_EXIT.couldNotBuild,
        `${request.config} lists "apps" other than ${shown(appDir)}, which the database checks would load beside this one. ` +
          'Give the build a config that lists only this App, or connections only.',
      );
    }
    listed = config.apps.length > 0;
    env = config.appEnv[appDir];
  }
  try {
    return await stagedBuild({ request, appDir, out, entries, registry, seams, say, started, env, listed });
  } finally {
    await registry?.closeAll();
  }
}

async function stagedBuild({
  request,
  appDir,
  out,
  entries,
  registry,
  seams,
  say,
  started,
  env,
  listed,
}: {
  request: BuildRequest;
  appDir: string;
  out: string;
  entries: Partial<Record<BuildEntryKind, string>>;
  registry?: Registry;
  seams: BuildSeams;
  say: (line: string) => void;
  started: number;
  /** The names the config passes the App's definition (`apps[].env`), and whether it lists the App at all. */
  env?: readonly AppEnvName[];
  listed: boolean;
}): Promise<{ out: string; manifest: BuildManifest }> {
  // 1. Typecheck.
  const manifestFile =
    request.appEntry !== undefined
      ? resolve(request.appEntry)
      : ['app.ts', 'app.mjs', 'app.json'].map((name) => join(appDir, name)).find((file) => existsSync(file));
  const entry = { ...(request.appEntry !== undefined ? { entry: request.appEntry } : {}), ...(env?.length ? { env } : {}) };
  const typecheck =
    seams.typecheck === false
      ? { status: 'skipped' as const, detail: 'not requested by the caller' }
      : await typecheckApp(appDir, [...(manifestFile ? [manifestFile] : []), ...Object.values(entries)]);
  if (typecheck.status === 'failed') throw fail(BUILD_EXIT.typecheck, `typecheck failed (${typecheck.detail}).`, typecheck.output);
  say(`typecheck: ${typecheck.status} — ${typecheck.detail}`);

  // 2. Validate, as a start would, with the lock checked line by line as mistri check checks it.
  let loaded: LoadedApp;
  try {
    loaded = await loadApp(appDir, { lock: 'report', ...entry });
  } catch (error) {
    throw fail(BUILD_EXIT.validation, `validation failed: ${(error as Error).message}`);
  }
  const lock = await checkAuthorityLock(loaded.authority, false);
  if (lock.problem) throw fail(BUILD_EXIT.validation, `validation failed: ${lock.problem}`);
  const store = loaded.app.auth?.store;
  if (store && !/^\$\{|^postgres(ql)?:\/\//i.test(store) && !isAbsolute(store)) {
    throw fail(
      BUILD_EXIT.validation,
      `validation failed: ${loaded.path}: "auth.store" is the relative path "${store}", which a build resolves inside ` +
        'its own output — and the next build deletes. Name an absolute path, a ${VARIABLE} or a postgres:// URL.',
    );
  }
  say(
    `validate: passed — "${loaded.app.name}": ${Object.keys(loaded.app.views).length} views, ${loaded.pages.length} pages` +
      `${loaded.authority?.lock === undefined ? '' : ', authority.lock matches'}`,
  );

  const staging = `${out}.staging-${process.pid}`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    // 3. Bundle.
    const bundler = await (seams.bundler ?? loadRolldown)().catch((error: Error) => {
      throw fail(BUILD_EXIT.bundle, `bundle failed: ${error.message}`);
    });
    if (!bundler) {
      say(
        "bundle: fallback succeeded — rolldown is not installed: each module was type-stripped on its own with node:module's stripTypeScriptTypes, not bundled. " +
          'The build still runs, but ships separate modules rather than a bundle; install rolldown beside mistri to bundle.',
      );
    }
    const outputs: BuildManifest['outputs'] = { manifest: 'app.json' };
    const warnings: string[] = [];
    try {
      if (loaded.path.endsWith('.ts') || loaded.path.endsWith('.mjs')) {
        warnings.push(...(await bundleDefinition(bundler, loaded.path, join(staging, 'definition'))));
        outputs.definition = 'definition/app.mjs';
        /* The bundle is proved, not trusted: loaded again from it, the App
           must be the very object its source is. */
        const fromBundle = await loadApp(appDir, {
          lock: 'report',
          ...entry,
          module: pathToFileURL(join(staging, outputs.definition)).href,
        }).catch((error: Error) => {
          throw new BundleError(`the bundled App definition does not load: ${error.message}`);
        });
        /* `modules` is the load's own bookkeeping (the files it read, for the watcher), not the App: the bundle
           is one file where the source was several, so the two lists differ by design. */
        const { modules: _bundled, ...bundled } = fromBundle;
        const { modules: _source, ...source } = loaded;
        const where = difference(bundled, source);
        if (where)
          throw new BundleError(`the bundled App definition differs from its source at ${where}. This is a bundler bug, not your App.`);
      }
      const server = Object.fromEntries(Object.entries(entries));
      if (Object.keys(server).length) warnings.push(...(await bundleServer(bundler, server, join(staging, 'server'))));
    } catch (error) {
      if (error instanceof BuildFailure) throw error;
      throw fail(BUILD_EXIT.bundle, `bundle failed: ${(error as Error).message}`);
    }
    /* The components/ graph: each custom component as the source load
       compiled it, content-named, against exactly this mistri's SDK, so a
       build serves them with no compiler at all. */
    if (loaded.components) {
      await mkdir(join(staging, 'components'), { recursive: true });
      for (const [file, text] of Object.entries(loaded.components.files)) await writeFile(join(staging, 'components', file), text);
      await writeFile(join(staging, COMPONENTS_INDEX), `${JSON.stringify(componentsIndex(loaded.components), null, 2)}\n`);
      outputs.components = COMPONENTS_INDEX;
      say(
        `components: ${Object.entries(loaded.components.entries)
          .map(([id, entry]) => `${id} (${entry.js}${entry.css ? `, ${entry.css}` : ''})`)
          .join(', ')}`,
      );
    }
    /* Its themes' font files, as the source load read them and under the names its definition carries
       (appFonts.ts): a build serves them from its own fonts/ folder, never from the source directory. */
    if (loaded.fonts) {
      await mkdir(join(staging, 'fonts'), { recursive: true });
      for (const [file, bytes] of Object.entries(loaded.fonts.files)) await writeFile(join(staging, 'fonts', file), bytes);
      outputs.fonts = 'fonts';
      say(
        `fonts: ${Object.entries(loaded.fonts.sources)
          .map(([file, source]) => `${source} (${file})`)
          .join(', ')}`,
      );
    }
    /* Its logo's pictures, the same way: a build serves them from its own brand/ folder (appBrand.ts). */
    if (loaded.brand) {
      await mkdir(join(staging, 'brand'), { recursive: true });
      for (const [file, bytes] of Object.entries(loaded.brand.files)) await writeFile(join(staging, 'brand', file), bytes);
      outputs.brand = 'brand';
      say(
        `brand: ${Object.entries(loaded.brand.sources)
          .map(([file, source]) => `${source} (${file})`)
          .join(', ')}`,
      );
    }
    const built = Object.fromEntries(Object.keys(entries).map((kind) => [kind, `server/${kind}.mjs`])) as BuildManifest['entries'];
    for (const warning of warnings) process.stderr.write(`mistri build: bundle warning: ${warning}\n`);
    say(
      `bundle: ${bundler ? `rolldown ${bundler.version}` : 'type-stripped'} — ${[outputs.definition, ...Object.values(built)].filter(Boolean).join(', ') || 'nothing to bundle (app.json)'}`,
    );

    // 4. The compiled App, proved lossless before it is written.
    const encoded = encodeLossless({ app: loaded.app, pages: loaded.pages, origins: loaded.origins });
    const place = difference(decodeLossless(encoded.tree, encoded.undefinedAt), {
      app: loaded.app,
      pages: loaded.pages,
      origins: loaded.origins,
    });
    if (place)
      throw fail(
        BUILD_EXIT.couldNotBuild,
        `the compiled App does not read back as written at ${place}. This is a bug in mistri, not in your App.`,
      );
    await writeFile(join(staging, 'app.json'), compiledAppJson(loaded, appDir));
    if (loaded.authority?.lock !== undefined) await writeFile(join(staging, AUTHORITY_LOCK), loaded.authority.lock);

    // 5. The database, when a config reaches it.
    let database: BuildManifest['checks']['database'] = {
      status: 'skipped',
      detail: 'no --config; the catalog checks run when the build starts',
    };
    if (registry) {
      const { unreachable } = await probe(registry, loaded);
      if (unreachable.length) {
        database = {
          status: 'skipped',
          detail: `connection ${unreachable.map((name) => `"${name}"`).join(', ')} could not be opened; the catalog checks run when the build starts`,
        };
      } else {
        try {
          const types = await appTypes(registry, loaded);
          await writeFile(join(staging, 'mistri-schema.d.ts'), typesFileText(types));
          outputs.types = 'mistri-schema.d.ts';
          const committed = await readFile(join(appDir, 'mistri-schema.d.ts'), 'utf8').catch(() => undefined);
          if (committed !== undefined && !sameTypes(committed, types)) {
            // A note, not a failure: the App's copy may be a connection-level export on purpose, or stale.
            say(
              `types: note — ${shown(join(appDir, 'mistri-schema.d.ts'))} differs from the database types in this build; ` +
                `compare before replacing it (the App may intentionally keep connection-level types): ` +
                `npx @mistriwork/mistri --config ${shellArg(request.config!)} --app ${shellArg(appDir)} --export types`,
            );
          }
        } catch (error) {
          throw fail(BUILD_EXIT.validation, `validation failed against the database: ${(error as Error).message}`);
        }
        database = { status: 'passed', detail: 'validation passed on the build' };
      }
    }
    const manifest: BuildManifest = {
      format: 1,
      mistri: runtimeVersion(),
      node: process.version,
      app: { id: loaded.app.id, name: loaded.app.name, manifest: basename(loaded.path) },
      bundler: bundler
        ? { name: 'rolldown', version: bundler.version }
        : outputs.definition || Object.keys(built).length
          ? { name: 'strip-types', node: process.version }
          : { name: 'none' },
      checks: { typecheck: { status: typecheck.status, detail: typecheck.detail }, validation: 'passed', database },
      entries: built,
      outputs,
      id: await buildInputId(request),
      sha256: {},
    };
    for (const file of await filesUnder(staging)) manifest.sha256[file] = sha256(await readFile(join(staging, file)));
    await writeFile(join(staging, BUILD_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
    if (database.status === 'passed') {
      /* The real flag, on exactly what ships: the staged build and its
         bundled entries, against the database, the command journal and the
         job stores, the way a start would attest them. */
      const args = [
        '--config',
        request.config!,
        '--app',
        staging,
        ...Object.entries(built).flatMap(([kind, file]) => [`--${kind}`, join(staging, file!)]),
      ];
      /* The config's entry for the source is the build's here: the child
         checks the staged build in its place, never both. */
      const checked = await checkApp(args, listed ? appDir : undefined);
      if (checked.code !== 0)
        throw fail(BUILD_EXIT.validation, 'validation failed: the validation of the build reported problems.', checked.output);
    }
    say(`database: ${database.status} — ${database.detail}`);

    // 6. Into place.
    await rm(out, { recursive: true, force: true });
    await mkdir(dirname(out), { recursive: true });
    await rename(staging, out);
    const flags = Object.entries(built)
      .map(([kind, file]) => ` --${kind} ${shown(join(out, file!))}`)
      .join('');
    say(`built ${shown(out)} in ${((performance.now() - started) / 1000).toFixed(1)}s. Serve it: mistri --app ${shown(out)}${flags}`);
    return { out, manifest };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

/** `mistri build …`, as the command line runs it. Returns the exit code. */
export async function runBuild(argv: string[], usage: string): Promise<number> {
  const request: Partial<BuildRequest & { dockerfile: string }> = {};
  const flags: Record<string, keyof BuildRequest | 'dockerfile'> = {
    '--app': 'app',
    '--app-entry': 'appEntry',
    '--out': 'out',
    '--config': 'config',
    '--commands': 'commands',
    '--jobs': 'jobs',
    '--policy': 'policy',
    '--dockerfile': 'dockerfile',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log(usage);
      return BUILD_EXIT.built;
    }
    const key = flags[arg];
    const value = argv[i + 1];
    const refusal = !key
      ? `unknown option "${arg}"`
      : value === undefined || value.startsWith('-')
        ? `${arg} needs a value`
        : request[key] !== undefined
          ? `${arg} may be supplied only once`
          : undefined;
    if (refusal) {
      console.error(
        `mistri build: ${refusal}. mistri build --app <dir> [--app-entry <file>] [--out <dir>] [--config <path>] [--commands <file>] [--jobs <file>] [--policy <file>] [--dockerfile <file>]`,
      );
      return BUILD_EXIT.couldNotBuild;
    }
    request[key!] = value;
    i++;
  }
  if (!request.app) {
    console.error('mistri build: --app <dir> names the App to build.');
    return BUILD_EXIT.couldNotBuild;
  }
  /* The Dockerfile that runs this same build in its own stage: nothing is built here, so none of the build's
     exit codes apply, and a path outside the context is the only refusal. */
  if (request.dockerfile !== undefined) {
    try {
      const { dockerfile, ...rest } = request;
      await mkdir(dirname(resolve(dockerfile)), { recursive: true });
      await writeFile(resolve(dockerfile), appDockerfile(rest as BuildRequest));
      console.log(`wrote ${shown(resolve(dockerfile))}; docker build -f ${shellArg(shown(resolve(dockerfile)))} . from here`);
      return BUILD_EXIT.built;
    } catch (error) {
      console.error(`mistri build: ${(error as Error).message}`);
      return BUILD_EXIT.couldNotBuild;
    }
  }
  /* stdout carries the build's own lines; whatever the loader and the config
     reader say on the way goes to stderr, as it does under mistri check. */
  const log = console.log;
  console.log = (...args: unknown[]) => console.error(...args);
  try {
    await buildApp(request as BuildRequest, {}, (line) => process.stdout.write(`${line}\n`));
    return BUILD_EXIT.built;
  } catch (error) {
    const failure = error instanceof BuildFailure ? error : new BuildFailure(BUILD_EXIT.couldNotBuild, (error as Error).message);
    process.stderr.write(`mistri build: ${failure.message}\n${failure.detail ? `${failure.detail}\n` : ''}`);
    return failure.code;
  } finally {
    console.log = log;
  }
}
