/**
 * `mistri shot` steps and matrix: an App author verifying their App with an agent and no person got the loading
 * skeleton from a bare headless screenshot and had no way to open a record or type into a box before the picture.
 * `--click`, `--type`, `--press` and `--wait-for` are performed in the order given once the page has settled, and the
 * page is settled again after each; `--matrix` shoots every built-in look, light and dark, at a desk and on a phone.
 * Each test serves its own App on a free port over a temporary database, so none shares a server with another.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { runShot } from '../packages/mistri/src/server/build/shot.js';
import { THEME_PRESETS } from '../packages/engine/src/shared/themePresets.js';

function desk(t: TestContext, ui?: object) {
  const directory = mkdtempSync(join(tmpdir(), 'tw-shot-steps-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(join(directory, 'data.db'));
  try {
    db.exec(
      'CREATE TABLE ticket(id INTEGER PRIMARY KEY, title TEXT NOT NULL); ' +
        "INSERT INTO ticket VALUES (1, 'Printer'), (2, 'Laptop'), (3, 'Badge')",
    );
  } finally {
    db.close();
  }
  const appDir = join(directory, 'app');
  mkdirSync(appDir);
  writeFileSync(
    join(appDir, 'app.json'),
    JSON.stringify({
      id: 'desk',
      name: 'Desk',
      connection: 'data',
      resources: { ticket: {} },
      views: { tickets: { kind: 'list', from: 'ticket' } },
      home: 'tickets',
      ...(ui ? { ui } : {}),
    }),
  );
  const config = join(directory, 'mistri.json');
  writeFileSync(config, JSON.stringify({ connections: [{ id: 'data', name: 'data', url: join(directory, 'data.db') }] }));
  return { directory, appDir, config };
}

async function shoot(t: TestContext, ...flags: string[]) {
  return shootWith(t, undefined, ...flags);
}

async function shootWith(t: TestContext, ui: object | undefined, ...flags: string[]) {
  const fixture = desk(t, ui);
  const out = join(fixture.directory, 'out');
  const said: string[] = [];
  const warned: string[] = [];
  /* The browser's own scratch (Playwright's profile and artifacts, a system Chrome's fetcher) goes in the fixture's
     directory, which the test removes: CI's Node legs run before Playwright installs its browser, so shot falls back
     to the runner's Chrome, and what that leaves in the lane's TMPDIR failed the lane's leak check. */
  const temp = mkdtempSync(join(fixture.directory, 'tmp-'));
  const was = process.env.TMPDIR;
  process.env.TMPDIR = temp;
  try {
    const code = await runShot(
      ['--app', fixture.appDir, '--config', fixture.config, '--out', out, ...flags],
      (line) => said.push(line),
      (line) => warned.push(line),
    );
    return { code, said, warned, out };
  } finally {
    if (was === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = was;
  }
}

test('a click on a row is performed before the page is read', async (t) => {
  const bare = await shoot(t, '--text', '/tickets');
  const clicked = await shoot(t, '--text', '/tickets', '--click', 'Printer');
  assert.equal(bare.code, 0, bare.warned.join('\n'));
  assert.equal(clicked.code, 0, clicked.warned.join('\n'));
  assert.match(bare.said.join('\n'), /table: .* — 3 rows/);
  assert.match(clicked.said.join('\n'), /title: Printer/);
  assert.doesNotMatch(clicked.said.join('\n'), /table:/);
});

test('typed text and a key reach the page before the picture, which waits for what it was told to', async (t) => {
  const bare = await shoot(t, '/tickets');
  const typed = await shoot(
    t,
    '/tickets',
    '--click',
    'Search',
    '--type',
    'Search',
    'Laptop',
    '--wait-for',
    'Laptop',
    '--press',
    'ArrowDown',
  );
  assert.equal(typed.code, 0, typed.warned.join('\n'));
  const [before] = bare.said;
  const [after] = typed.said;
  assert.ok(!readFileSync(before!).equals(readFileSync(after!)), 'the picture after the steps is the picture without them');
});

test('a step that finds nothing is refused with the step and the address, and nothing is written', async (t) => {
  const { code, warned, said } = await shoot(t, '/tickets', '--click', 'Nonesuch');
  assert.equal(code, 1);
  assert.match(warned.join('\n'), /--click "Nonesuch": nothing on \/tickets matched/);
  assert.deepEqual(said, []);
});

/* A matrix is four pictures a look, every built-in look and then the App's own: about 113 s on a CI runner since
   Workshop made the built-in looks four, against the suite's 120 s for one test. */
const MATRIX = { timeout: 300_000 };

test('--matrix shoots every built-in look, light and dark, desk and phone, and indexes them', MATRIX, async (t) => {
  const { code, said, warned, out } = await shoot(t, '--matrix', '/tickets');
  assert.equal(code, 0, warned.join('\n'));
  const expected = THEME_PRESETS.flatMap((look) =>
    ['light', 'dark'].flatMap((mode) => ['desk', 'phone'].map((size) => `tickets-${look.id}-${mode}-${size}.png`)),
  );
  const folder = out; // --out is where the files go: no matrix/ under it.
  assert.deepEqual(readdirSync(folder).sort(), [...expected, 'index.html'].sort());
  assert.equal(said.at(-1), join(folder, 'index.html'));
  const index = readFileSync(join(folder, 'index.html'), 'utf8');
  for (const file of expected) assert.ok(index.includes(`src="${file}"`), `${file} is on the index`);
});

test("--matrix shoots the App's own theme as well as the built-in looks", MATRIX, async (t) => {
  const { code, warned, out } = await shootWith(
    t,
    { customThemes: [{ kind: 'theme', id: 'harbor', label: 'Harbor', extends: 'sage' }], theme: { preset: 'harbor' } },
    '--matrix',
    '/tickets',
  );
  assert.equal(code, 0, warned.join('\n'));
  const folder = out;
  const files = readdirSync(folder);
  for (const mode of ['light', 'dark'])
    for (const size of ['desk', 'phone']) assert.ok(files.includes(`tickets-harbor-${mode}-${size}.png`), `harbor ${mode} ${size}`);
  assert.equal(files.length, (THEME_PRESETS.length + 1) * 4 + 1);
  assert.match(readFileSync(join(folder, 'index.html'), 'utf8'), /<h3>Harbor<\/h3>/);
});

test('--matrix is not combined with what it decides itself', async (t) => {
  for (const flag of ['--dark', '--phone', '--text']) {
    const { code, warned } = await shoot(t, '--matrix', flag);
    assert.equal(code, 1);
    assert.match(warned.join('\n'), /--matrix/);
  }
});
