/**
 * Features on disk: the loader composes them and reports what the composed
 * App grants, and authority.lock holds that line — the server refuses to
 * start an App whose effective authority is not its lock's, a reload never
 * changes what a running server grants, and mistri check, the one writer,
 * fails on any stale line with the difference printed.
 */
import { test, describe, after } from 'node:test';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appProblems, loadApp, mergeAppPages, reloadApp, watchApp, type AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { AUTHORITY_CHANGED, AUTHORITY_LOCK, authorityLockProblem } from '../packages/mistri/src/server/app/authorityLock.js';
import { createApp } from './support/createApp.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { VALIDATE, validating } from './support/validation.js';

const tmp = mkdtempSync(join(tmpdir(), 'tw-features-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** Leads are the App's; inventory is a feature that shows vehicles and grants the clerk their reads. */
const manifest = (
  inventory: Record<string, unknown> = {},
  clerk: Record<string, unknown> = { label: 'Clerk', read: ['lead'], write: ['lead'] },
) => ({
  name: 'Lending',
  resources: { lead: { access: 'write' }, vehicle: { access: 'write' } },
  auth: { roles: { clerk } },
  views: { leads: { kind: 'list', from: 'lead' } },
  home: [{ view: 'leads' }],
  nav: ['leads', { feature: 'inventory' }],
  features: [
    {
      id: 'inventory',
      views: { vehicles: { kind: 'list', from: 'vehicle' } },
      nav: ['vehicles'],
      auth: { roles: { clerk: { read: ['vehicle'] } } },
      ...inventory,
    },
  ],
});
/** The same inventory, now also letting the clerk write vehicles. */
const widened = () => manifest({ auth: { roles: { clerk: { read: ['vehicle'], write: ['vehicle'] } } } });
const WIDER = '+ role clerk write vehicle — features "inventory"';

const write = (name: string, raw: unknown): string => {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'app.json'), JSON.stringify(raw, null, 2));
  return dir;
};
const lock = async (dir: string) => {
  const loaded = await loadApp(dir, { lock: 'report' });
  writeFileSync(join(dir, AUTHORITY_LOCK), loaded.authority!.report);
  return loaded.authority!.report;
};

describe('the loader and authority.lock', () => {
  test('features compose on disk, the report names their grants, and a matching lock loads', async () => {
    const dir = write('match', manifest());
    const first = await loadApp(dir);
    assert.deepEqual(first.app.nav, [{ view: 'leads' }, { view: 'vehicles' }]);
    assert.match(first.authority!.report, /^role clerk read vehicle — features "inventory"$/m);
    assert.equal(first.authority!.lock, undefined, 'no lock yet: nothing to check against');
    await lock(dir);
    const again = await loadApp(dir);
    assert.equal(again.authority!.lock, again.authority!.report);
  });

  test('a lock that differs refuses the load, naming the difference; mistri check loads it to report', async () => {
    const dir = write('widen', manifest());
    await lock(dir);
    write('widen', widened());
    await assert.rejects(loadApp(dir), (err: Error) => {
      assert.match(
        err.message,
        /authority\.lock: the effective authority differs from the lock\. Review the change, then accept it with mistri check --write-authority\.\n {4}\+ role clerk write vehicle — features "inventory"$/,
      );
      return true;
    });
    const reported = await loadApp(dir, { lock: 'report' });
    assert.match(authorityLockProblem(reported.authority!, 'lines') ?? '', /\n {4}\+ role clerk write vehicle/);
  });

  /* An api block is parsed once, by composition (appFeatures.ts). While the
     loader's parse front parsed it a second time, an App that declared both
     `features` and `api.commands` could not be loaded at all: a command
     reference's `input` is a list once parsed, and the second parse refused
     it as "an object of fields keyed by name". */
  test('an App with features loads its api.commands, and the lock credits the feature that exposed one', async () => {
    const dir = write('api-commands', {
      ...manifest(),
      nav: ['leads', { feature: 'inventory' }],
      api: { version: 1, roles: ['clerk'], resources: { lead: { fields: ['id', 'name'] } }, commands: ['change'] },
      features: [
        {
          id: 'inventory',
          views: { vehicles: { kind: 'list', from: 'vehicle' } },
          nav: ['vehicles'],
          auth: { roles: { clerk: { read: ['vehicle'] } } },
          api: { commands: [{ command: 'retire', label: 'Retire' }] },
        },
      ],
    });
    // The commands module beside the manifest, which loading the App loads.
    const entry = JSON.stringify(new URL('../packages/mistri/src/server/commands.ts', import.meta.url).href);
    writeFileSync(
      join(dir, 'commands.mjs'),
      `import { defineCommand, defineCommands } from ${entry};
const change = { source: 'lending', target: 'lead', input: { note: { type: 'text' } }, async handle() {} };
export default defineCommands({ change: defineCommand(change), retire: defineCommand(change) });
`,
    );
    const loaded = await loadApp(dir);
    assert.deepEqual(
      loaded.app.api!.commands.map((entry) => entry.command.id),
      ['change', 'retire'],
    );
    assert.deepEqual(loaded.app.api!.commands[0].command.input, [{ name: 'note', label: 'Note', required: true, type: 'text' }]);
    // A command's version is its contract line's, not an exposure fact.
    assert.doesNotMatch(loaded.authority!.report, /^api command \w+ version/m);
    assert.match(loaded.authority!.report, /^api command change target \{.*"target":"lending\.lead".*\} — the App$/m);
    assert.match(loaded.authority!.report, /^api command retire target \{.*"target":"lending\.lead".*\} — features "inventory"$/m);
    // The lock the loader wrote is the one it then loads against, unchanged.
    await lock(dir);
    const again = await loadApp(dir);
    assert.equal(again.authority!.lock, again.authority!.report);
  });

  test('a grant moved between contributors starts the server, and fails the check until the lock says who', async () => {
    const dir = write('moved', manifest());
    await lock(dir);
    write('moved', manifest({ auth: undefined }, { read: ['lead', 'vehicle'], write: ['lead'] }));
    const loaded = await loadApp(dir);
    assert.equal(authorityLockProblem(loaded.authority!), undefined, "the effective authority is the lock's");
    const problem = authorityLockProblem(loaded.authority!, 'lines') ?? '';
    assert.match(problem, /the lock names different contributors; the effective authority is the same\./);
    assert.match(problem, /- role clerk read vehicle — features "inventory"\n {4}\+ role clerk read vehicle — the App/);
  });
});

describe('a reload never changes what a running server grants', () => {
  const startup = async (dir: string): Promise<AppHost> => {
    const app = await loadApp(dir);
    return { app, pages: mergeAppPages([], app) };
  };

  test('a presentation edit swaps; a feature that widens a grant closes the App until a restart', async () => {
    const dir = write('reload', manifest());
    const host = await startup(dir);
    const before = host.app;
    write('reload', manifest({ resources: { vehicle: { display: { name: { format: 'number' } } } } }));
    assert.equal(await reloadApp(host, dir, []), true);
    assert.notEqual(host.app, before);
    assert.equal(host.unavailable, undefined);
    write('reload', widened());
    assert.equal(await reloadApp(host, dir, []), false);
    assert.equal(host.unavailable, AUTHORITY_CHANGED);
    assert.equal(
      host.loadError,
      `${AUTHORITY_CHANGED}\n    ${WIDER}\n    What reloads and what needs a restart: \`mistri docs reload-and-restart\`.`,
    );
    write('reload', manifest());
    assert.equal(await reloadApp(host, dir, []), false, 'a revert does not reopen it: only a restart does');
    assert.equal(host.unavailable, AUTHORITY_CHANGED);
  });

  test('a lock rewritten to match the change still closes the App: the running process keeps its authority', async () => {
    const dir = write('relock', manifest());
    const host = await startup(dir);
    write('relock', widened());
    await lock(dir);
    assert.equal(await reloadApp(host, dir, []), false);
    assert.equal(host.unavailable, AUTHORITY_CHANGED);
    assert.ok((host.loadError ?? '').includes(WIDER), host.loadError);
  });

  test('an invalid edit that changes nothing it grants keeps the last good App serving', async () => {
    const dir = write('invalid', manifest());
    const host = await startup(dir);
    const before = host.app;
    write('invalid', manifest({ views: { vehicles: { kind: 'list', from: 'vehicle', lable: 'Stock' } } }));
    assert.equal(await reloadApp(host, dir, []), false);
    assert.equal(host.app, before);
    assert.equal(host.unavailable, undefined);
    assert.match(host.loadError ?? '', /features "inventory", views "vehicles" has no "lable"/);
  });

  test('while closed, every App request answers 503 with the restart message, and names no grant', async () => {
    const dir = write('closed', manifest());
    const host = await startup(dir);
    write('closed', widened());
    assert.equal(await reloadApp(host, dir, []), false);
    const bound = { host: '127.0.0.1', port: 0 };
    const server = createApp({ registry: new Registry(), bound, apps: [host] });
    try {
      server.listen(0, bound.host);
      await once(server, 'listening');
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      for (const path of ['/api/app', '/api/schema', '/api/runtime', '/api/forms']) {
        const response: Response = await fetch(`http://127.0.0.1:${address.port}${path}`, { signal: AbortSignal.timeout(3_000) });
        assert.equal(response.status, 503, path);
        assert.equal(response.headers.get('cache-control'), 'no-store', path);
        assert.deepEqual(await response.json(), { error: AUTHORITY_CHANGED }, path);
      }
    } finally {
      server.close();
    }
  });

  test('a save under features/ is a change the watcher sees', async () => {
    const dir = write('watched', manifest());
    mkdirSync(join(dir, 'features'));
    let calls = 0;
    const stop = watchApp(
      dir,
      () => {
        calls += 1;
      },
      20,
    );
    try {
      /* fs.watch arms asynchronously; a save nobody saw is made again, as the watchApp tests do. */
      for (let attempt = 0; attempt < 5 && !calls; attempt++) {
        writeFileSync(join(dir, 'features', 'inventory.mjs'), `export default ${attempt};\n`);
        const until = Date.now() + 2000;
        while (!calls && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      stop();
    }
    assert.ok(calls > 0);
  });
});

describe('mistri check checks the lock, and --write-authority writes it', () => {
  const db = join(tmp, 'lending.db');
  const sqlite = new DatabaseSync(db);
  sqlite.exec('CREATE TABLE lead (id INTEGER PRIMARY KEY, name TEXT); CREATE TABLE vehicle (id INTEGER PRIMARY KEY, name TEXT);');
  sqlite.close();
  const run = (args: string[], timeout = 120_000) => {
    const child = validating(args);
    return spawnSync(
      process.execPath,
      ['--import', 'tsx', 'packages/mistri/src/server/index.ts', '--no-config', '--db', db, ...child.args],
      {
        encoding: 'utf8',
        timeout,
        env: child.env,
      },
    );
  };

  test('written on purpose, then checked; a widened grant fails with the difference until it is accepted', () => {
    const dir = write('check', manifest());
    const lockFile = join(dir, AUTHORITY_LOCK);
    const written = run(['--app', dir, VALIDATE, '--write-authority']);
    assert.equal(written.status, 0, written.stdout + written.stderr);
    /* The verdict; the fixture's roles have no admin, which check advises about beneath it. */
    assert.match(written.stdout, /^Lending: ok\n/);
    assert.ok(written.stderr.includes(`mistri: wrote ${lockFile}`), written.stderr);
    assert.match(readFileSync(lockFile, 'utf8'), /^role clerk read vehicle — features "inventory"$/m);

    const clean = run(['--app', dir, VALIDATE]);
    assert.equal(clean.status, 0, clean.stdout + clean.stderr);
    assert.match(clean.stdout, /^Lending: ok\n/);

    write('check', widened());
    const stale = run(['--app', dir, VALIDATE]);
    assert.equal(stale.status, 1, stale.stdout + stale.stderr);
    assert.ok(
      stale.stdout.startsWith(
        `Lending: 1 problem\n  ${lockFile}: the effective authority differs from the lock. ` +
          `Review the change, then accept it with mistri check --write-authority.\n    ${WIDER}\n`,
      ),
      stale.stdout,
    );

    const started = run(['--app', dir, '--port', '0'], 60_000);
    assert.equal(started.status, 1, started.stdout + started.stderr);
    assert.ok(started.stderr.includes(`App error: ${lockFile}: the effective authority differs from the lock.`), started.stderr);

    assert.equal(run(['--app', dir, VALIDATE, '--write-authority']).status, 0);
    const accepted = run(['--app', dir, VALIDATE]);
    assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
  });

  test('mistri check prints a problem in what a feature wrote with the feature', () => {
    const dir = write('check-problem', manifest({ views: { vehicles: { kind: 'list', from: 'vehicle', show: ['nope'] } } }));
    const out = run(['--app', dir, VALIDATE]);
    assert.equal(out.status, 1, out.stdout + out.stderr);
    assert.match(out.stdout, /^Lending: 1 problem\n {2}app\.json: features "inventory", view "vehicles": /);
  });

  test('--write-authority is a mistri check flag', () => {
    const alone = run(['--write-authority'], 60_000);
    assert.equal(alone.status, 1);
    assert.match(alone.stderr, /--write-authority works with mistri check/);
  });
});

describe('problems and refusals name the feature that wrote them', () => {
  const table = (name: string) => ({
    name,
    schema: '',
    id: name,
    isView: false,
    columns: [
      { name: 'id', type: 'integer', nullable: false, primaryKey: true },
      { name: 'name', type: 'text', nullable: true, primaryKey: false },
    ],
  });
  const SCHEMA: DatabaseSchema = {
    label: 'lending',
    dialect: 'sqlite',
    readAt: '',
    foreignKeys: [],
    tables: [table('lead'), table('vehicle')],
  };

  test('appProblems names a feature view and a feature page by their feature', async () => {
    const dir = write(
      'problems',
      manifest({
        views: { vehicles: { kind: 'list', from: 'vehicle', show: ['nope'] } },
        pages: { vehicle: { base: 'vehicle', sections: [{ kind: 'fields', show: ['nope'] }] } },
      }),
    );
    const problems = appProblems(await loadApp(dir), SCHEMA);
    assert.ok(
      problems.some((line) => line.startsWith('app.json: features "inventory", view "vehicles": ')),
      problems.join('\n'),
    );
    assert.ok(
      problems.some((line) => line.startsWith('app.json: features "inventory", page "Vehicle": ')),
      problems.join('\n'),
    );
  });

  test('a pages/ file that repeats a feature page names the feature', async () => {
    const dir = write('collide', manifest({ pages: { vehicle: { base: 'vehicle' } } }));
    mkdirSync(join(dir, 'pages'));
    writeFileSync(join(dir, 'pages', 'vehicle.json'), JSON.stringify({ base: 'vehicle' }));
    await assert.rejects(
      loadApp(dir),
      /pages\/vehicle\.json: the page "vehicle" is already declared by features "inventory" \(.*app\.json\)\. A page is keyed once: in the App, in a feature, or as a pages\/ file\./,
    );
  });

  test('a pages/ module whose default export is a page is that page, found by its file; one without is a module pages import', async () => {
    const dir = write('found', manifest());
    mkdirSync(join(dir, 'pages'));
    writeFileSync(join(dir, 'pages', 'shared.ts'), `export const sections = [{ kind: 'fields', title: 'Contact' }];\n`);
    writeFileSync(join(dir, 'pages', 'lead.ts'), `import { sections } from './shared.ts';\nexport default { base: 'lead', sections };\n`);
    const loaded = await loadApp(dir);
    assert.equal(loaded.pages.find((page) => page.id === 'lead')?.sections[0].title, 'Contact');
    assert.equal(loaded.sources.lead, join(dir, 'pages', 'lead.ts'));
    assert.deepEqual(loaded.pageFiles, ['pages/lead.ts']);
    // The same key as a JSON file too is a page keyed twice.
    writeFileSync(join(dir, 'pages', 'lead.json'), JSON.stringify({ base: 'lead' }));
    await assert.rejects(loadApp(dir), /pages\/lead\.ts: the page "lead" is already declared in .*pages\/lead\.json\./);
  });

  test('a load refused over a feature view names the feature', async () => {
    const dir = write('refused', manifest({ views: { vehicles: { kind: 'list', from: 'vehicle', lable: 'Stock' } } }));
    await assert.rejects(loadApp(dir), /app\.json: features "inventory", views "vehicles" has no "lable"\./);
  });
});
