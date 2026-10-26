/**
 * One rule for a path a config file writes: it is the file's folder's, in every tool that reads the file. A SQLite
 * file a config names by a relative path is located once, where the file is read (loadConfig), so a check run from an
 * App's folder (`mistri check --app . --config ../mistri.json`, the scaffold's own "Next" step), a migrate, a
 * suite, a test host started in its own workspace and the command journal a start puts beside the database all open
 * the one file — and a save writes the path back as it was written.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { Registry, loadConfig, saveConfig, sqliteTargetFrom } from '../packages/engine/src/server/connections.js';
import { readStartupConfig } from '../packages/engine/src/server/cli/config.js';
import { parseArgs } from '../packages/engine/src/server/cli/args.js';
import { createTestWorkspace } from '../packages/mistri/src/server/testing/workspace.js';
import { CONFIG_SECTIONS } from '../packages/mistri/src/server/serviceConnections.js';
import { entryFor } from './support/bins.js';

const ROOT = resolve('.');
const TSX = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

const dir = mkdtempSync(join(tmpdir(), 'tablewalk-relative-sqlite-'));
after(() => rmSync(dir, { recursive: true, force: true }));

/** A project: a database and a config beside it, an App in a folder below, and somewhere else to run from. */
function project(name: string, url = './shop.db') {
  const root = join(dir, name);
  mkdirSync(join(root, 'app'), { recursive: true });
  mkdirSync(join(root, 'elsewhere'), { recursive: true });
  const db = new DatabaseSync(join(root, 'shop.db'));
  db.exec("create table bike (id integer primary key, name text not null); insert into bike values (1, 'Brompton')");
  db.close();
  writeFileSync(join(root, 'mistri.json'), JSON.stringify({ connections: [{ name: 'shop', url, writable: true }] }));
  writeFileSync(
    join(root, 'app', 'app.json'),
    JSON.stringify({
      id: 'shop',
      name: 'Shop',
      connection: 'shop',
      resources: { bike: { access: 'write' } },
      views: { bike: { kind: 'list', from: 'bike' } },
      home: 'bike',
    }),
  );
  return root;
}

test('a relative path, sqlite: and file: target are said from the folder given; the rest as written', () => {
  const base = '/srv/shop';
  assert.equal(sqliteTargetFrom('./shop.db', base), '/srv/shop/shop.db');
  assert.equal(sqliteTargetFrom('data/shop.db', base), '/srv/shop/data/shop.db');
  assert.equal(sqliteTargetFrom('sqlite:shop.db', base), 'sqlite:/srv/shop/shop.db');
  assert.equal(sqliteTargetFrom('file:./shop.db', base), '/srv/shop/shop.db');
  assert.equal(sqliteTargetFrom('file:///var/shop.db', base), '/var/shop.db');
  for (const kept of ['/var/shop.db', 'sqlite:/var/shop.db', ':memory:', 'postgres://u@h/db', '${DATABASE_URL}'])
    assert.equal(sqliteTargetFrom(kept, base), kept);
  assert.equal(sqliteTargetFrom('./shop.db', undefined), './shop.db');
});

test('the config is read with its SQLite paths located: every reader of it gets the one file, the save the written path', async () => {
  const root = project('read');
  writeFileSync(
    join(root, 'mistri.json'),
    JSON.stringify({
      connections: [
        { name: 'shop', url: './shop.db', writable: true },
        { name: 'gone', url: 'file:./missing/gone.db' },
        { name: 'kept', url: 'sqlite:/var/kept.db' },
        { name: 'env', url: '${SHOP_DB}' },
      ],
    }),
  );
  /* What a suite, a token command, an experiment source and a test account read: loadConfig's connections. */
  const loaded = (await loadConfig(join(root, 'mistri.json'), CONFIG_SECTIONS))!;
  assert.deepEqual(
    loaded.connections.map((c) => [c.url, c.writtenUrl]),
    [
      [join(root, 'shop.db'), './shop.db'],
      [join(root, 'missing', 'gone.db'), 'file:./missing/gone.db'],
      ['sqlite:/var/kept.db', undefined],
      ['${SHOP_DB}', undefined],
    ],
  );

  /* What a start reads — the command journal, the jobs and the stores a start puts beside the database locate the
     connection by its configured url, so it must be the file the adapter opens. */
  const registry = new Registry();
  await readStartupConfig(parseArgs(['--config', join(root, 'mistri.json')]), registry, CONFIG_SECTIONS);
  try {
    const shop = registry.list().find((c) => c.name === 'shop')!;
    assert.equal(registry.configOf(shop.id)!.url, join(root, 'shop.db'));
    const { schema } = await registry.open(shop.id);
    assert.deepEqual(
      schema.tables.map((t) => t.name),
      ['bike'],
    );
    // What a refusal names: the absolute path tried.
    const gone = registry.list().find((c) => c.name === 'gone')!;
    assert.equal(registry.sqliteFile(gone.id), join(root, 'missing', 'gone.db'));
    // Saved back as written, relative; a connection added in the session by a relative path is saved where it is.
    registry.add({ name: 'session', url: 'session.db', source: 'session' });
    await saveConfig(join(root, 'mistri.json'), registry.configs());
    const saved = JSON.parse(readFileSync(join(root, 'mistri.json'), 'utf8')) as { connections: Array<{ name: string; url: string }> };
    assert.deepEqual(
      saved.connections.map((c) => [c.name, c.url]),
      [
        ['shop', './shop.db'],
        ['gone', 'file:./missing/gone.db'],
        ['kept', 'sqlite:/var/kept.db'],
        ['env', '${SHOP_DB}'],
        ['session', resolve('session.db')],
      ],
    );
  } finally {
    await registry.closeAll();
  }
});

test("a test workspace's copy of a config copies each SQLite file it names, however the path is written", async () => {
  const root = project('workspace');
  writeFileSync(
    join(root, 'mistri.json'),
    JSON.stringify({
      connections: [
        { name: 'plain', url: './shop.db' },
        { name: 'scheme', url: 'sqlite:shop.db' },
        { name: 'file', url: 'file:./shop.db' },
      ],
    }),
  );
  const workspace = await createTestWorkspace();
  try {
    const copied = JSON.parse(readFileSync(await workspace.copyConfig(join(root, 'mistri.json')), 'utf8')) as {
      connections: Array<{ url: string }>;
    };
    for (const { url } of copied.connections) {
      assert.ok(url.startsWith(workspace.directory), `${url} is a copy in the workspace`);
      const db = new DatabaseSync(url.replace(/^sqlite:/, ''), { readOnly: true });
      assert.equal((db.prepare('select name from bike').get() as { name: string }).name, 'Brompton');
      db.close();
    }
  } finally {
    await workspace.close();
  }
});

function run(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise((done) =>
    execFile(
      process.execPath,
      ['--import', TSX, entryFor(args), ...args],
      {
        cwd,
        timeout: 120_000,
        env: { ...process.env, TSX_TSCONFIG_PATH: join(ROOT, 'tsconfig.json'), ...env },
      },
      (error, out, err) => done({ code: (error as { code?: number } | null)?.code ?? 0, out, err }),
    ),
  );
}

test('every command reads a config from another folder the same way: the file beside it, never a new one here', async () => {
  const root = project('commands');
  const here = join(root, 'elsewhere');
  const config = ['--config', '../mistri.json'];
  const ran = {
    check: await run(['check', '--app', '../app', ...config], here),
    migrate: await run(['migrate', 'status', '--app', '../app', ...config], here),
    stores: await run(['migrate', 'stores', 'status', ...config], here),
    storesApp: await run(['migrate', 'stores', 'up', '--app', '../app', ...config], here),
    seed: await run(['seed', '--app', '../app', ...config, '--append', '--rows', '1'], here),
    build: await run(['build', '--app', '../app', ...config, '--out', '../build'], here),
  };
  /* `migrate status` fails until something is applied, and nothing is here: the exit 2 and its sentence show it
     found the shop beside the config (a new empty file here would have failed some other way). */
  for (const [command, result] of Object.entries(ran))
    assert.equal(result.code, command === 'migrate' ? 2 : 0, `${command}: ${result.out}\n${result.err}`);
  assert.match(ran.migrate.out, /Nothing applied yet/);
  assert.match(ran.stores.out, /^Stores in shop \(sqlite, (\.\.|.*\/commands)\/shop\.db\)$/m);
  // The build's database step read the file beside the config, not an empty one here.
  assert.match(ran.build.out, /^database: passed/m);
  assert.deepEqual(readdirSync(here), [], 'nothing was opened where the commands ran');
  const db = new DatabaseSync(join(root, 'shop.db'), { readOnly: true });
  assert.ok((db.prepare('select count(*) as n from bike').get() as { n: number }).n > 1, 'seed wrote to the file beside the config');
  db.close();
  assert.ok(existsSync(join(root, 'shop.db')));
});

test('shot and grade read a config from another folder the same way', { timeout: 180_000 }, async (t) => {
  const root = project('browser');
  const here = join(root, 'elsewhere');
  /* Chromium leaves its profile and fetcher folders in TMPDIR after it closes; given the project's own, they go
     with the project instead of reading to the gate as a case that never cleaned up. */
  const browserTmp = join(root, 'tmp');
  mkdirSync(browserTmp);
  const shot = await run(['shot', '--app', '../app', '--config', '../mistri.json', '--text'], here, { TMPDIR: browserTmp });
  if (/install --only-shell chromium/i.test(shot.err)) {
    t.skip('no Chromium here');
    return;
  }
  assert.equal(shot.code, 0, `${shot.out}\n${shot.err}`);
  // The one row of the file beside the config: an empty file opened here would have no table at all.
  assert.match(shot.out, /table: .*Name — 1 row/);
  const grade = await run(['grade', '../app', '--config', '../mistri.json'], here, { TMPDIR: browserTmp });
  assert.equal(grade.code, 0, `${grade.out}\n${grade.err}`);
  assert.match(grade.out, /^grade: \d+\/100/m);
  assert.deepEqual(readdirSync(here), [], 'nothing was opened where the commands ran');
});
