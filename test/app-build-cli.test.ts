/**
 * `mistri build` as a command: the exit code of each step that can fail,
 * the database checks when a config reaches the database, and a server
 * started from the build — the same App on the wire as its source, never
 * watched, and started only with the build's own entries.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { VALIDATE, validating } from './support/validation.js';

const ROOT = resolve('.');
/* An App's starts are mistri's (test/support/bins.ts). */
const ENTRY = join(ROOT, 'packages', 'mistri', 'src', 'server', 'index.ts');
const work = mkdtempSync(join(tmpdir(), 'tablewalk-build-cli-'));
// The projects here install TypeScript, as the quickstart's does: the typecheck reads only the project's.
mkdirSync(join(work, 'node_modules'));
symlinkSync(join(ROOT, 'node_modules', 'typescript'), join(work, 'node_modules', 'typescript'), 'dir');
after(() => rmSync(work, { recursive: true, force: true }));

interface Ran {
  code: number;
  out: string;
  err: string;
}
function run(args: string[], timeout = 120_000): Promise<Ran> {
  return new Promise((done, reject) => {
    const child = validating(args);
    execFile(
      process.execPath,
      ['--import', 'tsx', ENTRY, ...child.args],
      { cwd: ROOT, timeout, killSignal: 'SIGKILL', env: child.env },
      (error, out, err) => {
        if (error && (error as { killed?: boolean }).killed) {
          reject(new Error(`tablewalk ${args.join(' ')} did not exit`));
          return;
        }
        done({ code: (error as { code?: number } | null)?.code ?? 0, out, err });
      },
    );
  });
}

function app(name: string, files: Record<string, string>): string {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
  return dir;
}
const TINY = { id: 'tiny', name: 'Tiny', resources: { ticket: {} }, views: { ticket: { kind: 'list', from: 'ticket' } }, home: 'ticket' };

describe('mistri build, the command', () => {
  test('refuses a call it cannot act on, with exit code 1', async () => {
    const none = await run(['build']);
    assert.equal(none.code, 1);
    assert.match(none.err, /--app <dir> names the App to build/);
    const unknown = await run(['build', '--app', 'examples/apps/tick', '--minify']);
    assert.equal(unknown.code, 1);
    assert.match(unknown.err, /unknown option "--minify"/);
    const help = await run(['build', '--help']);
    assert.equal(help.code, 0);
    assert.match(help.out, /mistri build --app <dir> \[--app-entry <file>\] \[--out <dir>\]/);
  });

  test('builds Tick: typechecked without a tsconfig, validated, bundled', async () => {
    const out = join(work, 'tick');
    const ran = await run(['build', '--app', 'examples/apps/tick', '--out', out]);
    assert.equal(ran.code, 0, ran.err);
    const lines = ran.out.trim().split('\n');
    assert.match(lines[0], /^typecheck: passed — tsc \d+\.\d+\.\d+, 1 file, no tsconfig\.json$/);
    assert.match(lines[1], /^validate: passed — "Tick": 1 views?, 1 pages?/);
    assert.match(lines[2], /^bundle: rolldown \d+\.\d+\.\d+ — definition\/app\.mjs$/);
    assert.match(lines[3], /^database: skipped — no --config; the catalog checks run when the build starts$/);
    assert.match(lines[4], new RegExp(`^built ${out} in [\\d.]+s\\. Serve it: mistri --app ${out}$`));
    assert.equal(JSON.parse(readFileSync(join(out, 'mistri-build.json'), 'utf8')).checks.typecheck.status, 'passed');
  });

  test('a type error fails the typecheck, with exit code 2 and what tsc said', async () => {
    const dir = app('mistyped', {
      'package.json': '{ "type": "module" }\n',
      'app.ts': `const count: number = 'three';\nexport default { ...${JSON.stringify(TINY)}, count };\n`,
    });
    const ran = await run(['build', '--app', dir, '--out', join(work, 'mistyped-out')]);
    assert.equal(ran.code, 2, ran.out);
    assert.match(ran.err, /mistri build: typecheck failed \(tsc [\d.]+, 1 file, no tsconfig\.json\)\./);
    assert.match(ran.err, /app\.ts\(1,7\): error TS2322/);
  });

  test("UX-1: the typecheck runs the project's TypeScript only, never the one beside tablewalk", async () => {
    const bare = mkdtempSync(join(tmpdir(), 'tablewalk-build-bare-'));
    try {
      const dir = join(bare, 'untyped');
      mkdirSync(dir);
      writeFileSync(join(dir, 'package.json'), '{ "type": "module" }\n');
      writeFileSync(join(dir, 'app.ts'), `const count: number = 'three';\nexport default { ...${JSON.stringify(TINY)}, count };\n`);
      const ran = await run(['build', '--app', dir, '--out', join(bare, 'out')]);
      assert.match(ran.out, /^typecheck: skipped — TypeScript is not installed in the App's project; npm i -D typescript to check types$/m);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  test('an App that does not load fails validation, with exit code 3', async () => {
    const dir = app('unlinked', { 'app.json': JSON.stringify({ ...TINY, home: 'nowhere' }) });
    const ran = await run(['build', '--app', dir, '--out', join(work, 'unlinked-out')]);
    assert.equal(ran.code, 3);
    assert.match(ran.out, /^typecheck: none — no TypeScript to check$/m);
    assert.match(ran.err, /mistri build: validation failed: .*nowhere/);
  });

  test('a commands module that cannot load fails registry validation, with exit code 3', async () => {
    const dir = app('broken-import', { 'app.json': JSON.stringify(TINY), 'commands.mjs': "import './gone.mjs';\nexport default {};\n" });
    const ran = await run(['build', '--app', dir, '--commands', join(dir, 'commands.mjs'), '--out', join(work, 'broken-import-out')]);
    assert.equal(ran.code, 3);
    assert.match(ran.err, /mistri build: validation failed: .*commands module could not be loaded/);
  });
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as { port: number };
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

async function serve(args: string[]): Promise<{ origin: string; log: () => string; child: ChildProcess }> {
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', 'tsx', ENTRY, ...args, '--port', String(port)], {
    cwd: ROOT,
    env: { ...process.env, MISTRI_OPEN: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout!.on('data', (chunk) => {
    log += String(chunk);
  });
  child.stderr!.on('data', (chunk) => {
    log += String(chunk);
  });
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => reject(new Error(`did not start: ${log}`)), 30_000);
    child.stdout!.on('data', () => {
      if (log.includes('Listening on')) {
        clearTimeout(timer);
        done();
      }
    });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error(`exited: ${log}`));
    });
  });
  return { origin: `http://127.0.0.1:${port}`, log: () => log, child };
}

describe('Thread, built against its database and served from the build', () => {
  const db = join(work, 'thread.db');
  const out = join(work, 'thread');
  const servers: ChildProcess[] = [];
  before(() => execFileSync(process.execPath, [resolve('test/fixtures/databases/thread/seed.mjs'), db]));
  after(async () => {
    for (const child of servers) {
      if (child.exitCode !== null) continue;
      const closed = once(child, 'close');
      child.kill('SIGTERM');
      await closed;
    }
  });

  test('--config reaching the database writes the types and runs mistri check on the build', async () => {
    const ran = await run(['build', '--app', 'test/fixtures/apps/thread', '--config', `${db}.json`, '--out', out]);
    assert.equal(ran.code, 0, ran.err);
    assert.match(ran.out, /^database: passed — validation passed on the build$/m);
    // The same file --export types writes for the App; Thread commits the connection-level one, which the note says.
    const exported = await run(['--config', `${db}.json`, '--app', 'test/fixtures/apps/thread', '--export', 'types']);
    assert.equal(readFileSync(join(out, 'mistri-schema.d.ts'), 'utf8'), exported.out);
    assert.match(
      ran.out,
      /^types: note — test\/fixtures\/apps\/thread\/mistri-schema\.d\.ts differs from the database types in this build; compare before replacing it \(the App may intentionally keep connection-level types\): /m,
    );
    assert.ok(
      ran.out.includes(`npx @mistriwork/mistri --config '${db}.json' --app '${resolve('test/fixtures/apps/thread')}' --export types`),
    );
    const manifest = JSON.parse(readFileSync(join(out, 'mistri-build.json'), 'utf8'));
    assert.equal(manifest.outputs.types, 'mistri-schema.d.ts');
    assert.equal(manifest.checks.database.status, 'passed');
    const checked = await run(['--config', `${db}.json`, '--app', out, VALIDATE]);
    assert.equal(checked.code, 0, checked.err);
    // Advice (an unindexed reference a page walks) may follow the verdict; it never changes it.
    assert.match(checked.out, /^Thread: ok\n(  warning: .+\n)*$/);
  });

  test('types check just wrote are the ones the build agrees with: no note follows a check', async () => {
    // Field report N3: the build added a newline of its own to types that end in one, so every file check wrote "differed".
    const copy = join(work, 'thread-app');
    cpSync(resolve('test/fixtures/apps/thread'), copy, { recursive: true });
    mkdirSync(join(copy, 'node_modules'));
    mkdirSync(join(copy, 'node_modules', '@mistriwork'), { recursive: true });
    symlinkSync(join(ROOT, 'packages', 'mistri'), join(copy, 'node_modules', '@mistriwork', 'mistri'), 'dir');
    // The project installs TypeScript, as the quickstart does: the typecheck reads only the project's.
    symlinkSync(join(ROOT, 'node_modules', 'typescript'), join(copy, 'node_modules', 'typescript'), 'dir');
    writeFileSync(join(copy, 'package.json'), '{ "type": "module" }\n');
    const exported = await run(['--config', `${db}.json`, '--app', copy, '--export', 'types']);
    assert.equal(exported.code, 0, exported.err);
    writeFileSync(join(copy, 'mistri-schema.d.ts'), exported.out);
    await run(['check', '--app', copy, '--config', `${db}.json`]);
    assert.equal(readFileSync(join(copy, 'mistri-schema.d.ts'), 'utf8'), exported.out, 'check keeps what --export types wrote');
    assert.ok(exported.out.endsWith('}\n') && !exported.out.endsWith('\n\n'), 'one newline at the end');
    const built = join(work, 'thread-after-check');
    const ran = await run(['build', '--app', copy, '--config', `${db}.json`, '--out', built]);
    assert.equal(ran.code, 0, ran.err);
    assert.doesNotMatch(ran.out, /types: note/);
    assert.equal(readFileSync(join(built, 'mistri-schema.d.ts'), 'utf8'), exported.out);
  });

  test('a database the config names but cannot reach skips those checks, and says they run at start', async () => {
    const config = join(work, 'unreachable.json');
    writeFileSync(config, JSON.stringify({ connections: [{ name: 'thread', url: 'postgres://tablewalk@127.0.0.1:9/none' }] }));
    const ran = await run(['build', '--app', 'test/fixtures/apps/thread', '--config', config, '--out', join(work, 'thread-unreached')]);
    assert.equal(ran.code, 0, ran.err);
    assert.match(ran.out, /^database: skipped — connection "thread" could not be opened; the catalog checks run when the build starts$/m);
    assert.doesNotMatch(ran.out + ran.err, /127\.0\.0\.1:9/, 'never the URL');
  });

  test('a server started from the build answers as its source does, and watches nothing', async () => {
    const built = await serve(['--config', `${db}.json`, '--app', out]);
    servers.push(built.child);
    const source = await serve(['--config', `${db}.json`, '--app', 'test/fixtures/apps/thread']);
    servers.push(source.child);
    assert.match(built.log(), /mistri: app "Thread" from .*app\.json — a build by mistri [\d.]+(?:-[\w.]+)?, served as built: no reload/);
    const [fromBuild, fromSource] = await Promise.all(
      [built, source].map((server) => fetch(`${server.origin}/api/app`).then((response) => response.json())),
    );
    // Only the source is watched, so only it offers the reload stream (`live`): a build answers the same without it.
    assert.equal(fromSource.live, true);
    assert.equal('live' in fromBuild, false);
    delete fromSource.live;
    assert.deepEqual(fromBuild, fromSource);
    const page = await fetch(`${built.origin}/thread`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>/);
  });
});

describe('a build is started with what it was built with', () => {
  const out = join(work, 'forecourt');
  before(async () => {
    const ran = await run([
      'build',
      '--app',
      'test/fixtures/apps/forecourt',
      '--commands',
      'test/fixtures/apps/forecourt/commands.ts',
      '--out',
      out,
    ]);
    assert.equal(ran.code, 0, ran.err);
  });

  test("--commands must name the build's own entry, never the TypeScript it came from", async () => {
    const ran = await run(['--no-config', '--app', out, '--commands', 'test/fixtures/apps/forecourt/commands.ts', VALIDATE]);
    assert.equal(ran.code, 1);
    assert.match(
      ran.err,
      /is a build: --commands must be its own .*server\/commands\.mjs, not test\/fixtures\/apps\/forecourt\/commands\.ts\./,
    );
    const jobs = await run([
      '--no-config',
      '--app',
      out,
      '--commands',
      join(out, 'server/commands.mjs'),
      '--jobs',
      join(out, 'server/commands.mjs'),
      VALIDATE,
    ]);
    assert.equal(jobs.code, 1);
    assert.match(jobs.err, /was built without --jobs, so it has no jobs entry\. Rebuild it with mistri build --jobs <file>\./);
  });

  test("--write-authority is the source's to do", async () => {
    const ran = await run(['--no-config', '--app', out, VALIDATE, '--write-authority']);
    assert.equal(ran.code, 1);
    assert.match(ran.err, /a build's authority\.lock is its source's\. Write the lock in the App's directory, then rebuild\./);
  });

  test("another version's build is refused at start, with the fix", async () => {
    const manifest = JSON.parse(readFileSync(join(out, 'mistri-build.json'), 'utf8'));
    writeFileSync(join(out, 'mistri-build.json'), JSON.stringify({ ...manifest, mistri: '0.0.1' }));
    const ran = await run(['--no-config', '--app', out, VALIDATE]);
    assert.equal(ran.code, 1);
    assert.match(
      ran.err,
      /App error: .* was built by mistri 0\.0\.1; this is mistri [\d.]+(?:-[\w.]+)?\. A build is pinned to the version that made it: rebuild it/,
    );
  });
});

/* An App that reads its environment is built from the config entry that
   passes it (`apps[].env`), and the database check runs on the build in the
   source's place: one App, never the source loaded beside its build. */
describe('mistri build, an App with an environment', () => {
  const dir = join(work, 'regional');
  const db = join(work, 'regional.db');
  const config = join(work, 'regional.json');
  before(() => {
    app('regional', { 'app.mjs': `export default ${JSON.stringify(TINY).replace('"Tiny"', '`Tiny ${process.env.REGION}`')};\n` });
    execFileSync(process.execPath, [
      '-e',
      `const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync(${JSON.stringify(db)});
      d.exec('CREATE TABLE ticket (id INTEGER PRIMARY KEY, title TEXT)'); d.close();`,
    ]);
    writeFileSync(config, JSON.stringify({ connections: [{ name: 'tickets', url: db }], apps: [{ dir, env: ['REGION'] }] }));
  });

  test("the config's entry passes the environment, and mistri check checks the build alone", async () => {
    const out = join(work, 'regional-build');
    const ran = await new Promise<Ran>((done, reject) => {
      execFile(
        process.execPath,
        ['--import', 'tsx', ENTRY, 'build', '--app', dir, '--config', config, '--out', out],
        { cwd: ROOT, timeout: 120_000, env: { ...process.env, REGION: 'north' } },
        (error, stdout, stderr) =>
          error && (error as { killed?: boolean }).killed
            ? reject(error)
            : done({ code: (error as { code?: number } | null)?.code ?? 0, out: stdout, err: stderr }),
      );
    });
    assert.equal(ran.code, 0, ran.err);
    assert.match(ran.out, /^validate: passed — "Tiny north"/m);
    assert.match(ran.out, /^database: passed — validation passed on the build$/m);
    assert.equal(JSON.parse(readFileSync(join(out, 'app.json'), 'utf8')).app.name, 'Tiny north');
  });

  test('a config that does not pass the name leaves it unread, and the refusal names it', async () => {
    const bare = join(work, 'regional-bare.json');
    writeFileSync(bare, JSON.stringify({ connections: [{ name: 'tickets', url: db }], apps: [dir] }));
    const ran = await run(['build', '--app', dir, '--config', bare, '--out', join(work, 'regional-unset')]);
    assert.equal(ran.code, 3);
    assert.match(ran.err, /read process\.env\.REGION/);
  });

  test('a config that lists another App is refused before anything is staged', async () => {
    const other = join(work, 'two-apps.json');
    writeFileSync(
      other,
      JSON.stringify({ connections: [{ name: 'tickets', url: db }], apps: [{ dir, env: ['REGION'] }, 'examples/apps/tick'] }),
    );
    const ran = await run(['build', '--app', dir, '--config', other, '--out', join(work, 'regional-two')]);
    assert.equal(ran.code, 1);
    assert.match(ran.err, /lists "apps" other than .*regional, which the database checks would load beside this one/);
  });
});
