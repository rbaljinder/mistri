/**
 * A build serves from wherever it is put (OP5). Its server entries keep `@mistriwork/mistri/commands` as a bare import, and
 * Node resolved it from the bundle's own folder upward: a build written beside the App outside the project, or copied
 * into an image away from the node_modules that holds tablewalk, did not start ("Cannot find package 'tablewalk'").
 * A build is pinned to the tablewalk serving it, so its `tablewalk/…` imports are that tablewalk's own modules.
 *
 * The server here runs from the build's folder with a tsconfig that maps nothing, so nothing but the build's own
 * resolution can find `@mistriwork/mistri/commands`: no node_modules is above it.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { buildApp } from '../packages/mistri/src/server/build/build.js';
import { runMigrate } from '../packages/engine/src/server/migrate/cli.js';
import { MIGRATE_APPS } from '../packages/mistri/src/server/cli/appTargets.js';
import { mistriEntry } from '../packages/mistri/src/server/app/buildResolution.js';

const ROOT = resolve('.');
/* An App's starts are mistri's (test/support/bins.ts). */
const ENTRY = join(ROOT, 'packages', 'mistri', 'src', 'server', 'index.ts');
const MISTRI = join(ROOT, 'packages', 'mistri');
const TSX = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as { port: number };
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

test("a build's tablewalk imports are the running tablewalk's own entries", () => {
  assert.equal(mistriEntry('@mistriwork/mistri/commands'), join(MISTRI, 'src', 'server', 'commands.ts'));
  assert.equal(mistriEntry('@mistriwork/mistri/jobs'), join(MISTRI, 'src', 'server', 'jobs.ts'));
  assert.equal(mistriEntry('@mistriwork/mistri/app'), join(MISTRI, 'schema', 'app.mjs'));
  for (const not of ['@mistriwork/mistri/nothing', 'mistriish', 'tablewalk/app', 'react']) assert.equal(mistriEntry(not), undefined);
});

test('a build beside the App, with no node_modules above it, starts and serves', { timeout: 180_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-build-placement-'));
  const children: ChildProcess[] = [];
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const closed = once(child, 'close');
      child.kill('SIGTERM');
      await closed;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  for (let up = directory; up !== dirname(up); up = dirname(up))
    assert.equal(existsSync(join(up, 'node_modules', '@mistriwork', 'mistri')), false);
  const db = new DatabaseSync(join(directory, 'desk.db'));
  db.exec(
    "CREATE TABLE item (id INTEGER PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open'); INSERT INTO item (title) VALUES ('Fix the bell');",
  );
  db.close();
  const config = join(directory, 'mistri.json');
  writeFileSync(config, JSON.stringify({ connections: [{ name: 'desk', url: './desk.db', writable: true }] }));
  const app = join(directory, 'desk');
  mkdirSync(app);
  writeFileSync(join(app, 'package.json'), '{ "type": "module" }\n');
  writeFileSync(
    join(app, 'app.json'),
    JSON.stringify({
      id: 'desk',
      name: 'Desk',
      connection: 'desk',
      resources: { item: { access: 'write', actions: { close: { label: 'Close', command: 'close' } } } },
      auth: { roles: { agent: { read: true, write: false, commands: ['close'] } } },
      views: { items: { kind: 'list', from: 'item' } },
      home: 'items',
    }),
  );
  writeFileSync(
    join(app, 'commands.mjs'),
    `import { defineCommand, defineCommands } from '@mistriwork/mistri/commands';
export default defineCommands({
  close: defineCommand({ source: 'desk', target: 'item', read: ['item'], write: ['item'],
    async handle({ db, record }) { await db.item.update(record, { status: 'closed' }); } }),
});
`,
  );
  const { out } = await buildApp({ app, out: join(directory, 'desk-build'), commands: join(app, 'commands.mjs') }, { typecheck: false });
  const lines: string[] = [];
  assert.equal(
    await runMigrate(['stores', 'up', '--app', out, '--config', config], (line) => lines.push(line), undefined, MIGRATE_APPS),
    0,
    lines.join('\n'),
  );

  // The repository's compiler settings, without the `paths` that point @mistriwork/mistri/commands at src/ from anywhere.
  const tsconfig = join(directory, 'tsconfig.json');
  writeFileSync(tsconfig, JSON.stringify({ extends: join(ROOT, 'tsconfig.json'), compilerOptions: { paths: {} } }));
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [
      '--import',
      TSX,
      ENTRY,
      '--config',
      'mistri.json',
      '--app',
      'desk-build',
      '--commands',
      'desk-build/server/commands.mjs',
      '--port',
      String(port),
    ],
    {
      cwd: directory,
      env: {
        ...process.env,
        MISTRI_OPEN: '0',
        TSX_TSCONFIG_PATH: tsconfig,
        BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
        XDG_CONFIG_HOME: join(directory, 'config'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  children.push(child);
  let log = '';
  child.stdout!.on('data', (chunk) => (log += String(chunk)));
  child.stderr!.on('data', (chunk) => (log += String(chunk)));
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => reject(new Error(`did not start: ${log}`)), 60_000);
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
  assert.match(log, /a build by mistri [\d.]+(?:-[\w.]+)?, served as built/);
  assert.match(log, /signs people in/);
  const ready = await fetch(`http://127.0.0.1:${port}/readyz`);
  assert.equal(ready.status, 200, log);
});
