/** Proves the acceptance suite can fail: it breaks one rule at a time in a copy of Loaner Desk and expects
 * the test that owns that rule to go red, naming it, while the untouched App stays green.
 * Run from a checkout: node --import tsx test/loaner-desk-acceptance/prove-red.mjs
 * The real App directory is never edited, so a dirty tree is fine. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { seed } from '../fixtures/databases/loaner-desk/seed.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, '../fixtures/apps/loaner-desk');
const suite = join(here, 'acceptance.test.ts');
const packageRoot = dirname(createRequire(import.meta.url).resolve('@mistriwork/mistri/package.json'));
/* In a checkout, the CLI's source under tsx, as the seeds run it (examples/databases/lintel/seed.mjs): a checkout's
   built CLI resolves the other packages only under --conditions=mistri-built — without it, the engine's .ts under
   Node's own type stripping, whose `.js` imports name no file — and may be older than the source. Installed, the
   package's own bin, as `npx @mistriwork/mistri` runs it. */
const source = join(packageRoot, 'src/server/index.ts');
const built = !existsSync(source);
const cli = built
  ? [join(packageRoot, JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).bin.mistri)]
  : ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href, source];
const cliEnv = built ? process.env : { ...process.env, TSX_TSCONFIG_PATH: join(packageRoot, '../../tsconfig.json') };

const VARIANTS = [
  {
    name: 'policy: the viewer role is granted the commands',
    file: 'app.ts',
    from: "viewer: { label: 'Viewer', read: true, write: false },",
    to: "viewer: { ...staff, label: 'Viewer' },",
    // The reviewer accepted the change: the lock is rewritten, so only the tests stand in the way.
    lock: true,
    red: ['Authorization case "viewer cannot check out" failed', 'Authorization case "viewer cannot return" failed'],
    green: ['✔ staff check an item out'],
  },
  {
    name: 'integration: the callback is keyed on the attempt, not the kiosk’s scan',
    file: 'jobs.ts',
    from: 'key: (body) => kioskScan(body).scan,',
    to: 'key: (body) => `${kioskScan(body).scan}:${Date.now()}`,',
    lock: false,
    red: ['✖ a scan returns the loan once, a retried delivery replays it'],
    green: ['✔ the authorization matrix holds'],
  },
];

function run(env = {}) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', suite], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 300_000,
  });
  return { code: result.status, output: `${result.stdout}\n${result.stderr}` };
}

const clean = run();
assert.equal(clean.code, 0, `The untouched App must pass first:\n${clean.output}`);
console.log('ok  the untouched App passes');

for (const variant of VARIANTS) {
  const root = mkdtempSync(join(tmpdir(), 'tablewalk-prove-red-'));
  try {
    mkdirSync(join(root, 'node_modules/@mistriwork'), { recursive: true });
    symlinkSync(packageRoot, join(root, 'node_modules/@mistriwork/mistri'), 'dir');
    // `check --write-authority` typechecks the copy too, and its tsconfig names the node types.
    mkdirSync(join(root, 'node_modules/@types'));
    symlinkSync(join(packageRoot, '../../node_modules/@types/node'), join(root, 'node_modules/@types/node'), 'dir');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    const copy = join(root, 'loaner-desk');
    cpSync(app, copy, { recursive: true });
    // Its `paths` walk up to the checkout's packages from where the App lives; from here they name the workspace's.
    const tsconfig = join(copy, 'tsconfig.json');
    writeFileSync(tsconfig, readFileSync(tsconfig, 'utf8').replaceAll('../../../../packages/', `${dirname(packageRoot)}/`));
    const source = readFileSync(join(copy, variant.file), 'utf8');
    assert.ok(source.includes(variant.from), `${variant.name}: ${variant.file} no longer holds the line this variant changes`);
    writeFileSync(join(copy, variant.file), source.replace(variant.from, variant.to));
    if (variant.lock) {
      const database = seed(join(root, 'lock.db'));
      const written = spawnSync(process.execPath, [...cli, 'check', '--app', copy, '--config', `${database}.json`, '--write-authority'], {
        cwd: root,
        env: cliEnv,
        encoding: 'utf8',
      });
      assert.equal(written.status, 0, `${variant.name}: rewriting authority.lock failed:\n${written.stdout}${written.stderr}`);
    }
    const broken = run({ LOANER_DESK_APP: copy });
    assert.notEqual(broken.code, 0, `${variant.name}: the suite stayed green:\n${broken.output}`);
    for (const line of variant.red) assert.ok(broken.output.includes(line), `${variant.name}: expected "${line}" in:\n${broken.output}`);
    for (const line of variant.green)
      assert.ok(broken.output.includes(line), `${variant.name}: expected "${line}" still green:\n${broken.output}`);
    console.log(`ok  ${variant.name} → red`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
