#!/usr/bin/env node
/**
 * The tarball proof: the database browser builds and runs from the published engine, kit and ui, as it will once it
 * lives in a repository of its own.
 *
 * The browser's sources (packages/tablewalk/src) are copied into a fresh project that installs the packed
 * `@mistriwork/engine`, `@mistriwork/ui`, `@mistriwork/kit` and `tablewalk` tarballs, the kit's declared peers at the
 * versions this checkout has installed, and TypeScript. Nothing of this checkout is reachable from there: the
 * project's server is compiled by tsc against the packages' declarations, and its page is built by Vite with the kit's
 * preset (`@mistriwork/kit/vite`) from the kit's published client modules (scripts/browser-from-tarballs/vite.config.ts).
 * Then two servers are started on a demo SQLite file and each page is loaded in Chromium, to a table's rows, with no
 * page error and no failed request: the one just built, and the installed `tablewalk` package's own.
 *
 * What it catches is what the split would: a module the browser imports that a package does not publish (the host
 * list, scripts/boundary/entries.json `host`, is what the boundary check holds it to), a client module the kit does
 * not ship, a peer the kit's client needs and does not declare, a declaration missing for a server import, a preset
 * that only works over the kit's sources.
 *
 *   node scripts/prove-browser-from-tarballs.mjs              pack the four packages (run `npm run build` first)
 *   node scripts/prove-browser-from-tarballs.mjs <tarball>…   use these; the four are picked out of the rest by name
 *
 * The project is removed when the proof passes and kept, with its path printed, when it does not.
 */
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NAMES = ['@mistriwork/engine', '@mistriwork/ui', '@mistriwork/kit', 'tablewalk'];
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'tablewalk-from-tarballs-')));
const project = join(scratch, 'project');
const environment = { ...process.env, TABLEWALK_OPEN: '' };
for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'TSX_TSCONFIG_PATH']) delete environment[key];
const run = (command, args, cwd = project) =>
  execFileSync(command, args, { cwd, env: environment, stdio: ['ignore', 'inherit', 'inherit'], timeout: 600_000 });
const installed = (name) => JSON.parse(readFileSync(join(ROOT, 'node_modules', name, 'package.json'), 'utf8')).version;
const say = (line) => console.log(`prove-browser-from-tarballs: ${line}`);

let passed = false;
try {
  /* ---- the tarballs ---- */
  let tarballs = process.argv.slice(2).map((tarball) => resolve(tarball));
  if (!tarballs.length) {
    const packed = join(scratch, 'packed');
    mkdirSync(packed);
    execFileSync('npm', ['pack', ...NAMES.flatMap((name) => ['--workspace', name]), '--pack-destination', packed, '--silent'], {
      cwd: ROOT,
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    tarballs = readdirSync(packed).map((name) => join(packed, name));
  }
  const nameOf = (tarball) => JSON.parse(execFileSync('tar', ['-xOzf', tarball, 'package/package.json'], { encoding: 'utf8' })).name;
  const chosen = new Map(tarballs.map((tarball) => [nameOf(tarball), tarball]).filter(([name]) => NAMES.includes(name)));
  const missing = NAMES.filter((name) => !chosen.has(name));
  if (missing.length) throw new Error(`no tarball for ${missing.join(', ')}`);

  /* ---- the project: the browser's sources, the packages as published, and its tools ---- */
  mkdirSync(project);
  const browser = JSON.parse(readFileSync(join(ROOT, 'packages/tablewalk/package.json'), 'utf8'));
  writeFileSync(
    join(project, 'package.json'),
    JSON.stringify({ name: 'tablewalk-from-tarballs', version: browser.version, private: true, type: 'module' }, null, 2),
  );
  cpSync(join(ROOT, 'packages/tablewalk/src'), join(project, 'src'), {
    recursive: true,
    filter: (source) => !/\.(?:test|spec|stories)\.[jt]sx?$/.test(source),
  });
  cpSync(join(ROOT, 'scripts/browser-from-tarballs/vite.config.ts'), join(project, 'vite.config.ts'));
  writeFileSync(
    join(project, 'tsconfig.json'),
    JSON.stringify(
      {
        /* The server as the browser's own build compiles it: this checkout's settings (tsconfig.json), over the packages'
           declarations instead of their sources. */
        compilerOptions: {
          target: 'ES2023',
          lib: ['ES2023', 'DOM', 'DOM.Iterable'],
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          types: ['node'],
          strict: true,
          noUnusedLocals: true,
          noUnusedParameters: true,
          noFallthroughCasesInSwitch: true,
          esModuleInterop: true,
          skipLibCheck: true,
          noUncheckedSideEffectImports: false,
          allowJs: true,
          checkJs: false,
          verbatimModuleSyntax: true,
          rootDir: 'src',
          outDir: 'dist',
          removeComments: false,
        },
        include: ['src/server', 'src/shared'],
      },
      null,
      2,
    ),
  );
  const kit = JSON.parse(execFileSync('tar', ['-xOzf', chosen.get('@mistriwork/kit'), 'package/package.json'], { encoding: 'utf8' }));
  /* The kit's client needs exactly its declared peers: a library it imports and does not declare fails the build. */
  const tools = [...Object.keys(kit.peerDependencies ?? {}), 'typescript', '@types/node'].map((name) => `${name}@${installed(name)}`);
  say(`installing ${chosen.size} tarballs and ${tools.length} tools into ${project}`);
  run('npm', ['install', '--no-audit', '--no-fund', '--prefer-offline', '--loglevel=error', ...chosen.values(), ...tools]);

  /* ---- build ---- */
  run(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json']);
  run(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '-c', 'vite.config.ts', '--logLevel', 'warn']);
  const built = inventory(join(project, 'dist/client'));
  const shipped = inventory(join(project, 'node_modules/tablewalk/dist/client'));
  say(`built ${built.files} client files, ${kb(built.bytes)}; the packed tablewalk ships ${shipped.files}, ${kb(shipped.bytes)}`);
  const only = (a, b) => [...a.names].filter((name) => !b.names.has(name));
  if (only(built, shipped).length || only(shipped, built).length)
    say(
      `files only in the build: ${only(built, shipped).join(', ') || 'none'}; only in the package: ${only(shipped, built).join(', ') || 'none'}`,
    );

  /* ---- run, and load the page ---- */
  const database = join(project, 'demo.db');
  run(process.execPath, [
    '--input-type=module',
    '-e',
    `import { makeDemoDatabase } from '@mistriwork/engine/server/demo.js'; makeDemoDatabase(${JSON.stringify(database)});`,
  ]);
  const { chromium } = await import('playwright');
  const browserApp = await chromium.launch();
  try {
    for (const [label, main] of [
      ['built from the tarballs', 'dist/server/index.js'],
      ['the installed tablewalk package', 'node_modules/tablewalk/dist/server/index.js'],
    ])
      await serveAndLoad(browserApp, label, main, database);
  } finally {
    await browserApp.close();
  }
  passed = true;
  say('passed: the database browser builds and runs from the published engine, kit and ui.');
} catch (error) {
  console.error(`prove-browser-from-tarballs: ${error.message}`);
  console.error(`prove-browser-from-tarballs: the project is kept at ${project}`);
  process.exitCode = 1;
} finally {
  if (passed) rmSync(scratch, { recursive: true, force: true });
}

/** Start one server on the database, load its page to a table's rows, and stop it. */
async function serveAndLoad(browserApp, label, main, database) {
  const port = await freePort();
  const child = spawn(process.execPath, [main, database, '--port', String(port)], {
    cwd: project,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (chunk) => (logs += chunk));
  child.stderr.on('data', (chunk) => (logs += chunk));
  const exited = once(child, 'exit');
  try {
    const deadline = Date.now() + 30_000;
    while (!/Listening on http:\/\//.test(logs) && child.exitCode === null && Date.now() < deadline) await delay(50);
    if (!/Listening on http:\/\//.test(logs)) throw new Error(`${label}: the server did not start:\n${logs}`);
    const base = `http://127.0.0.1:${port}`;
    const page = await browserApp.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(`page error: ${error.message}`));
    page.on('response', (response) => {
      if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
    });
    page.on('requestfailed', (request) => errors.push(`failed: ${request.url()} ${request.failure()?.errorText ?? ''}`));
    await page.goto(`${base}/`);
    await page.locator('#content').filter({ hasText: /\S/ }).waitFor({ timeout: 30_000 });
    /* A table's rows: the walk, the grid and the Workbench's chunk, all drawn. The landing is the connection's
       address (named for the file, `/demo-db`), which the page writes once it has started; the table is under it. */
    await page.waitForURL((url) => url.pathname !== '/', { timeout: 30_000 });
    await page.goto(`${base}${new URL(page.url()).pathname.replace(/\/$/, '')}/invoice`);
    await page.locator('tbody tr').first().waitFor({ timeout: 30_000 });
    const rows = await page.locator('tbody tr').count();
    await page.close();
    if (errors.length) throw new Error(`${label}: the page loaded with errors:\n  ${errors.join('\n  ')}`);
    say(`${label}: served on a SQLite file, its page drew ${rows} invoice rows with no error.`);
  } finally {
    child.kill('SIGTERM');
    await exited;
  }
}

function freePort() {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

/** The client's files by name without their content hash, and their bytes (maps and compressed copies aside). */
function inventory(dir) {
  const files = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter(
    (file) => statSync(join(dir, file)).isFile() && !/\.(?:br|gz|map)$/.test(file),
  );
  return {
    files: files.length,
    bytes: files.reduce((sum, file) => sum + statSync(join(dir, file)).size, 0),
    names: new Set(files.map((file) => file.replace(/-[\w-]{8}\.(js|css)$/, '.$1'))),
  };
}

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}
