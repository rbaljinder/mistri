/** `mistri new [<name>] [<dir>]`: the starter it writes is a task list with its own database, rows in it, and a
 * config `mistri dev` reads, and it passes `mistri check` as written. Run through the real CLI in a temporary
 * directory outside the checkout, with the packages linked in as a project would install them. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runCli } from './appApiCli.js';
import { installTablewalk } from './support/installedTablewalk.js';

test('new writes a starter App that has rows, checks, and names its database for dev', { timeout: 300000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tw-new-app-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dir = join(directory, 'chores');
  const made = await runCli(['new', 'House Chores', dir]);
  assert.equal(made.code, 0, made.err);
  assert.match(made.out, /Next: cd .* && npm install && npm run dev/);
  for (const file of [
    'app.ts',
    'README.md',
    'package.json',
    'tsconfig.json',
    'mistri.json',
    'house-chores.db',
    'db/migrations/V1__task.sql',
  ])
    assert.ok(existsSync(join(dir, file)), file);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.dev, 'mistri dev .');
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['@mistriwork/mistri']);
  /* A path in a file is from that file's folder: the project moves as one. */
  assert.equal(JSON.parse(readFileSync(join(dir, 'mistri.json'), 'utf8')).connections[0].url, 'house-chores.db');
  const db = new DatabaseSync(join(dir, 'house-chores.db'), { readOnly: true });
  try {
    assert.equal((db.prepare('SELECT count(*) AS n FROM task').get() as { n: number }).n, 5);
  } finally {
    db.close();
  }

  installTablewalk(join(dir, 'node_modules'));
  const checked = await runCli(['check', '--app', dir, '--config', join(dir, 'mistri.json'), '--json']);
  assert.equal(JSON.parse(checked.out).ok, true, checked.out);

  const again = await runCli(['new', 'House Chores', dir]);
  assert.equal(again.code, 1);
  assert.match(again.err, /is not empty — new refuses to write over anything/);
});

test('new with a flag it does not take says the forms it has', async () => {
  const refused = await runCli(['new', '--nope']);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /Usage: mistri new \[<name>\] \[<dir>\]\. An App that is only an API is mistri new --api <name>/);
});

test(
  'new --template intake writes a public multi-step intake from the stock blocks, and it checks as written',
  { timeout: 300000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'tw-new-intake-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const dir = join(directory, 'help');
    const made = await runCli(['new', '--template', 'intake', 'Help Desk', dir]);
    assert.equal(made.code, 0, made.err);
    assert.match(made.out, /Next: cd .* && npm install && npm run dev, then open \/form\/apply/);
    for (const file of [
      'app.ts',
      'commands.ts',
      'README.md',
      'package.json',
      'tsconfig.json',
      'mistri.json',
      'help-desk.db',
      'db/migrations/V1__inquiry.sql',
    ])
      assert.ok(existsSync(join(dir, file)), file);
    /* The stock block only: no page, no component, no stylesheet of its own. */
    assert.deepEqual(
      readdirSync(dir).filter((entry) => /\.(css|tsx)$/.test(entry) || entry === 'pages' || entry === 'components'),
      [],
    );
    const app = readFileSync(join(dir, 'app.ts'), 'utf8');
    assert.match(app, /style: 'intake'/);
    assert.match(app, /public: true/);
    const db = new DatabaseSync(join(dir, 'help-desk.db'), { readOnly: true });
    try {
      assert.equal((db.prepare('SELECT count(*) AS n FROM inquiry').get() as { n: number }).n, 1);
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'inquiry'").get());
    } finally {
      db.close();
    }

    installTablewalk(join(dir, 'node_modules'));
    const checked = await runCli(['check', '--app', dir, '--config', join(dir, 'mistri.json'), '--json']);
    assert.equal(JSON.parse(checked.out).ok, true, checked.out);
    // Clean as written: a scaffold that warns teaches its reader to ignore the warnings.
    const warned = (JSON.parse(checked.out).problems as { severity: string; code: string }[]).filter((p) => p.severity === 'warning');
    assert.deepEqual(
      warned.map((p) => p.code),
      [],
      checked.out,
    );

    const again = await runCli(['new', '--template', 'intake', 'Help Desk', dir]);
    assert.equal(again.code, 1);
    assert.match(again.err, /is not empty — new refuses to write over anything/);
  },
);

test('new --template names the one template it has', async () => {
  const refused = await runCli(['new', '--template', 'dashboard']);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /Usage: mistri new --template intake \[<name>\] \[<dir>\]/);
});
