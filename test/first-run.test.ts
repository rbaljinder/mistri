/**
 * What a fresh coding agent hit first, building an App from the packed
 * package: each is said once, with the one command that fixes it.
 *
 *  - a package.json that reads the App as CommonJS (npm init writes one);
 *  - a TypeScript older than 7, which mistri check does not support;
 *  - a commands module without its default `defineCommands(...)` registry;
 *  - a command's journal and event store, made by `migrate stores up --app`;
 *  - DATABASE_URL beside a config that names the connections;
 *  - shot without Playwright's browser.
 *
 * SQLite only: each case makes its own database under a temporary directory.
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { browserInstallLine, installedChromiums, runShot } from '../packages/mistri/src/server/build/shot.js';
import { runAgent } from '../packages/mistri/src/server/cli/agentInit.js';
import { installTablewalk } from './support/installedTablewalk.js';
import { entryFor } from './support/bins.js';

const ROOT = resolve('.');

/* Outside the checkout, with tablewalk "installed" beside the Apps. */
const work = mkdtempSync(join(tmpdir(), 'tablewalk-first-run-'));
after(() => rmSync(work, { recursive: true, force: true }));
mkdirSync(join(work, 'node_modules'));
installTablewalk(join(work, 'node_modules'));

interface Ran {
  code: number;
  out: string;
  err: string;
}
function run(args: string[], env: NodeJS.ProcessEnv = {}): Promise<Ran> {
  return new Promise((done, reject) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', entryFor(args), ...args],
      { cwd: ROOT, timeout: 120_000, killSignal: 'SIGKILL', env: { ...process.env, DATABASE_URL: '', MISTRI_OPEN: '0', ...env } },
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

/** Tick's database in a directory of its own, and the config that names it. */
function database(name: string): { db: string; config: string } {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  const db = join(dir, 'tick.db');
  spawnSync(process.execPath, [join(ROOT, 'examples/databases/tick/seed.mjs'), db], { encoding: 'utf8' });
  return { db, config: `${db}.json` };
}

function app(name: string, files: Record<string, string>): string {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries({ 'package.json': '{ "type": "module" }\n', ...files })) {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  return dir;
}

const TICK = readFileSync(join(ROOT, 'examples/apps/tick/app.ts'), 'utf8');
const { config: tickConfig } = database('tick');

/* An App over Tick's table with one command that records an event. */
const COMMAND_APP = [
  "import { action, defineApp, listView } from '@mistriwork/mistri/app';",
  "export default defineApp({ id: 'tickc', name: 'TickC', connection: 'tick',",
  "  resources: { task: { access: 'write', actions: { finish: action('Finish', { command: 'finishTask' }) } } },",
  "  views: { tasks: listView('Tasks', 'task') }, home: 'tasks' });",
  '',
].join('\n');
const commands = (registry: string) =>
  [
    "import { defineCommand, defineCommands, defineEvent, defineSource, int, shape, text } from '@mistriwork/mistri/commands';",
    "const source = defineSource('tick');",
    "const finished = defineEvent('task.finished', shape({ task: int() }));",
    'export const finishTask = defineCommand({',
    "  source, target: 'task', when: 'completed = false',",
    '  output: shape({ task: int(), message: text({ max: 100 }) }), events: { finished },',
    '  async handle({ db, record }) {',
    '    await db.task.update(record, { completed: true });',
    "    return { task: Number(record.id), message: 'Done.' };",
    '  },',
    '});',
    registry,
    '',
  ].join('\n');

describe('a fresh project, as check meets it', () => {
  test('a package.json that reads the App as CommonJS is refused in one line, with the fix', async () => {
    for (const [name, manifest, says] of [
      ['commonjs', '{ "type": "commonjs" }', /says "type": "commonjs"/],
      ['typeless', '{ "name": "x" }', /has no "type"/],
    ] as const) {
      const dir = app(name, { 'package.json': manifest, 'app.ts': TICK });
      const ran = await run(['check', '--app', dir, '--config', tickConfig]);
      assert.equal(ran.code, 1, ran.out + ran.err);
      assert.match(ran.err, says);
      assert.match(ran.err, /Set "type": "module" \(npm pkg set type=module\)\.\n$/);
      assert.doesNotMatch(ran.out, /TS1295/, 'not one error per import');
    }
  });

  test('a TypeScript older than 7 fails the typecheck with the one fix rather than a crash', async () => {
    const dir = app('ts5', {
      'app.ts': TICK,
      'node_modules/typescript/package.json': '{ "name": "typescript", "version": "5.9.3", "main": "index.js" }\n',
      'node_modules/typescript/index.js': 'module.exports = {};\n',
      'node_modules/typescript/bin/tsc': 'process.exit(0);\n',
    });
    const ran = await run(['check', '--app', dir, '--config', tickConfig]);
    assert.equal(ran.code, 3, ran.out + ran.err);
    assert.match(ran.out, /typecheck {5}failed {2}TypeScript 5\.9\.3 is older than 7, which mistri check needs; npm i -D typescript\n/);
    assert.match(ran.out, /validation {4}passed/);
    const pkg = JSON.parse(readFileSync(join(ROOT, 'packages/mistri/package.json'), 'utf8'));
    assert.equal(pkg.peerDependencies.typescript, '>=7', 'TypeScript 7 is the minimum, not a matrix');
    assert.equal(pkg.peerDependenciesMeta.typescript.optional, true);
  });

  test('a commands module without its default defineCommands registry says so', async () => {
    const { config } = database('no-default');
    for (const [name, registry, why] of [
      ['named', 'export const all = defineCommands({ finishTask });', /it has no default export\./],
      ['one', 'export default finishTask;', /export default defineCommands\(\{ … \}\), every command by its id\. Command registry/],
    ] as const) {
      const dir = app(`commands-${name}`, { 'app.ts': COMMAND_APP, 'commands.ts': commands(registry) });
      const ran = await run(['check', '--app', dir, '--config', config]);
      assert.equal(ran.code, 4, ran.out + ran.err);
      assert.match(
        ran.out,
        /The commands module "commands\.ts" must default-export its registry: export default defineCommands\(\{ … \}\)/,
      );
      assert.match(ran.out, why);
    }
  });

  test("a command's journal and event store: check names the one command, and migrate stores up --app makes both, once", async () => {
    const { db, config } = database('stores');
    const dir = app('stores-app', { 'app.ts': COMMAND_APP, 'commands.ts': commands('export default defineCommands({ finishTask });') });
    const before = await run(['check', '--app', dir, '--config', config]);
    assert.equal(before.code, 4, before.out + before.err);
    assert.match(
      before.out,
      /has no event store for App "tickc"\. Provision it once, with the server stopped: `mistri migrate stores up --app <the App's directory>`/,
    );
    const up = await run(['migrate', 'stores', 'up', '--app', dir, '--config', config]);
    assert.equal(up.code, 0, up.out + up.err);
    assert.match(up.out, /tick: command journal v\d+ provisioned\n {2}tick: event store for App "tickc" v\d+ provisioned/);
    const again = await run(['migrate', 'stores', 'up', '--app', dir, '--config', config]);
    assert.equal(again.code, 0, again.out + again.err);
    assert.match(again.out, /command journal v\d+ present\n {2}tick: event store for App "tickc" v\d+ present/);
    const tables = spawnSync(
      process.execPath,
      [
        '-e',
        `const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync(${JSON.stringify(db)});
      console.log(d.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE '__mistri_command_%'").get().n)`,
      ],
      { encoding: 'utf8' },
    );
    assert.ok(Number(tables.stdout) > 0, tables.stderr);
    const after = await run(['check', '--app', dir, '--config', config]);
    assert.doesNotMatch(after.out, /event store|journal/, "what is left is the App's own (its sign-in), not a store");
  });

  test('DATABASE_URL beside a config: the config names the connections, and check says the variable is not used', async () => {
    const elsewhere = database('elsewhere');
    const ran = await run(['check', '--app', 'examples/apps/tick', '--config', tickConfig], { DATABASE_URL: elsewhere.db });
    assert.equal(ran.code, 0, ran.out + ran.err);
    assert.match(
      ran.out,
      /^Checking "Tick" in examples\/apps\/tick\n {2}note: DATABASE_URL is set, and .*tick\.db\.json names the connections, so it is not used; write "\$\{DATABASE_URL\}" as a connection's url to use it\.\n/,
    );
    /* A config that reads it says nothing more: the variable is its connection. */
    const reads = join(work, 'reads.json');
    writeFileSync(reads, JSON.stringify({ connections: [{ name: 'tick', url: '${DATABASE_URL}' }] }));
    const quiet = await run(['check', '--app', 'examples/apps/tick', '--config', reads], { DATABASE_URL: elsewhere.db });
    assert.equal(quiet.code, 0, quiet.out + quiet.err);
    assert.doesNotMatch(quiet.out, /note:/);
    /* With no config, it is the database, named as the App's one connection: the database said is the App's. */
    const alone = await run(['check', '--app', 'examples/apps/tick', '--no-config'], { DATABASE_URL: elsewhere.db });
    assert.doesNotMatch(alone.out, /which this server does not have/);
    assert.match(alone.out, /validation +passed/);
  });
});

describe('a fresh project, as it is set up', () => {
  test('agent init says what the project lacks, and its map names the registry and the stores command', () => {
    const project = mkdtempSync(join(tmpdir(), 'tablewalk-first-agent-'));
    try {
      writeFileSync(join(project, 'package.json'), '{ "name": "helpdesk", "type": "commonjs" }\n');
      let out = '';
      assert.equal(
        runAgent(
          ['init', '--dir', project, '--tool', 'claude'],
          (text) => {
            out += text;
          },
          () => {},
        ),
        0,
      );
      assert.match(out, /note: package\.json says "type": "commonjs", .*\(npm pkg set type=module\)\./);
      assert.match(out, /note: TypeScript is not installed here; .*\(npm i -D typescript\)\./);
      const agents = readFileSync(join(project, 'AGENTS.md'), 'utf8');
      assert.match(agents, /`commands\.ts` ends `export default defineCommands\(\{ … \}\)`/);
      assert.match(agents, /`npx @mistriwork\/mistri migrate stores up --app \.`/);
      assert.match(agents, /`"type": "module"`, and TypeScript 7 or later \(`npm i -D typescript`/);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test('a scaffold into a project whose package.json reads CommonJS keeps it and says the fix', async () => {
    const dir = app('scaffold-into', { 'package.json': '{ "name": "mine", "type": "commonjs" }\n' });
    const ran = await run([join(work, 'tick', 'tick.db'), '--scaffold-app', dir]);
    assert.equal(ran.code, 0, ran.out + ran.err);
    assert.match(ran.out, /says "type": "commonjs", .*Set "type": "module" \(npm pkg set type=module\)\./);
  });

  test('shot names the line that installs the browser its Playwright launches', () => {
    const project = '/work/helpdesk';
    assert.equal(browserInstallLine(join(project, 'node_modules', 'playwright'), project), 'npx playwright install --only-shell chromium');
    assert.equal(browserInstallLine(undefined, project), 'npx playwright install --only-shell chromium');
    const nested = join(project, 'node_modules', '@mistriwork', 'mistri', 'node_modules', 'playwright');
    assert.equal(browserInstallLine(nested, project), `node ${JSON.stringify(join(nested, 'cli.js'))} install --only-shell chromium`);
    assert.equal(
      browserInstallLine('/elsewhere/node_modules/playwright', project),
      `node "/elsewhere/node_modules/playwright/cli.js" install --only-shell chromium`,
    );
  });

  test('shot finds a Chromium another Playwright version installed, the headless shell and the newest build first', () => {
    const home = mkdtempSync(join(tmpdir(), 'tablewalk-browsers-'));
    const cache = join(home, '.cache', 'ms-playwright');
    const put = (file: string) => {
      mkdirSync(join(cache, file, '..'), { recursive: true });
      writeFileSync(join(cache, file), '');
    };
    put('chromium-1200/chrome-linux64/chrome');
    put('chromium_headless_shell-1187/chrome-headless-shell-linux64/chrome-headless-shell');
    put('chromium_headless_shell-1200/chrome-headless-shell-linux64/chrome-headless-shell');
    put('firefox-1490/firefox/firefox');
    mkdirSync(join(cache, 'chromium-1100'), { recursive: true }); // unpacked nothing: not offered
    assert.deepEqual(installedChromiums({}, home, 'linux'), [
      join(cache, 'chromium_headless_shell-1200/chrome-headless-shell-linux64/chrome-headless-shell'),
      join(cache, 'chromium_headless_shell-1187/chrome-headless-shell-linux64/chrome-headless-shell'),
      join(cache, 'chromium-1200/chrome-linux64/chrome'),
    ]);
    assert.deepEqual(installedChromiums({ PLAYWRIGHT_BROWSERS_PATH: join(home, 'none') }, join(home, 'nobody'), 'linux'), []);
    rmSync(home, { recursive: true, force: true });
  });

  test('shot --browser (or CHROME) naming no file is refused before anything is served', async () => {
    const said: string[] = [];
    const missing = join(work, 'no-such-chrome');
    const code = await runShot(
      ['--app', join(work, 'tick'), '--browser', missing],
      () => {},
      (line) => said.push(line),
    );
    assert.equal(code, 1);
    assert.ok(said.join('\n').includes(`${missing} (--browser, or CHROME) is not a file`), said.join('\n'));
  });
});
