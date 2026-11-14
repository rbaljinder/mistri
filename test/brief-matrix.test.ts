/**
 * `mistri new --brief` over briefs of five kinds (test/fixtures/briefs): each draft, as written, passes
 * `mistri check --design` with its types, says what it left out in its README, and — for the two an agent wrote from a
 * customer's paragraph — runs the journeys `mistri test init` writes for it. A draft that failed its own first check
 * was the first thing an agent building from the skill met; a brief of one shape passing said nothing of the others.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';
import { runNewApp } from '../packages/mistri/src/server/cli/newApp.js';

const checkout = resolve('.');
const BRIEFS = ['shop', 'clinic', 'rental', 'helpdesk', 'school'] as const;
/* The two written by an agent from a customer's paragraph: their generated journeys are run too. */
const JOURNEYED = new Set<string>(['shop', 'clinic']);

describe('a draft from a brief passes its own first check', () => {
  const root = mkdtempSync(join(tmpdir(), 'brief-matrix-'));
  after(() => rmSync(root, { recursive: true, force: true }));
  /* Outside the checkout, with mistri and TypeScript "installed" above the Apps, as a project that ran npm install. */
  mkdirSync(join(root, 'node_modules', '@mistriwork'), { recursive: true });
  for (const name of ['mistri', 'engine', 'kit', 'ui'])
    symlinkSync(join(checkout, 'packages', name), join(root, 'node_modules', '@mistriwork', name), 'dir');
  symlinkSync(join(checkout, 'node_modules', 'typescript'), join(root, 'node_modules', 'typescript'), 'dir');
  symlinkSync(join(checkout, 'node_modules', 'tsx'), join(root, 'node_modules', 'tsx'), 'dir');
  mkdirSync(join(root, 'node_modules', '@types'));
  symlinkSync(join(checkout, 'node_modules', '@types', 'node'), join(root, 'node_modules', '@types', 'node'), 'dir');
  const mistri = (dir: string, ...args: string[]) => {
    const ran = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        join(checkout, 'packages/mistri/src/server/index.ts'),
        ...args,
        '--app',
        dir,
        '--config',
        join(dir, 'mistri.json'),
      ],
      { cwd: checkout, encoding: 'utf8', timeout: 180_000 },
    );
    return { status: ran.status, out: `${ran.stdout}${ran.stderr}` };
  };

  for (const brief of BRIEFS) {
    test(`${brief}: scaffolds with no scaffold problem, checks clean with its types, and says what it left out`, async () => {
      const dir = join(root, brief);
      const said: string[] = [];
      const [log, error] = [console.log, console.error];
      console.log = () => {};
      console.error = (line: unknown) => said.push(String(line));
      let code: number;
      try {
        code = await runNewApp(['--brief', join(checkout, 'test/fixtures/briefs', `${brief}.md`), dir]);
      } finally {
        console.log = log;
        console.error = error;
      }
      assert.equal(code, 0, said.join('\n'));
      assert.ok(!said.some((line) => /scaffold problem/.test(line)), said.join('\n'));
      assert.equal(mistri(dir, 'migrate', 'stores', 'up').status, 0);
      const seeded = mistri(dir, 'seed');
      assert.equal(seeded.status, 0, seeded.out);
      const checked = mistri(dir, 'check', '--design');
      assert.equal(checked.status, 0, checked.out);
      assert.match(checked.out, /typecheck\s+passed/, checked.out);
      assert.match(checked.out, /validation\s+passed/, checked.out);
      /* A brief with commands leaves their questions and rules to the author, and the README says so. */
      assert.match(readFileSync(join(dir, 'README.md'), 'utf8'), /## Not drafted\n\nThe brief asked for these/);
      /* The administrator the first account holds is granted something, whatever roles the brief named. */
      assert.match(readFileSync(join(dir, 'app.ts'), 'utf8'), /admin: \{/);

      if (!JOURNEYED.has(brief)) return;
      const init = mistri(dir, 'test', 'init');
      assert.equal(init.status, 0, init.out);
      const ran = spawnSync(process.execPath, ['--import', 'tsx', '--test', 'tests/*.test.ts'], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 420_000,
        env: { ...process.env, NODE_PATH: '' },
      });
      assert.equal(ran.status, 0, `the generated tests of ${brief}:\n${ran.stdout.slice(-4000)}${ran.stderr.slice(-2000)}`);
    });
  }

  test('a ref the brief calls unique keeps its key, and a step the brief starts from two states leaves both', () => {
    assert.match(
      readFileSync(join(root, 'school', 'db/schema.sql'), 'utf8'),
      /student_id INTEGER NOT NULL UNIQUE REFERENCES student\(id\)/,
    );
    const shop = readFileSync(join(root, 'shop', 'resources.ts'), 'utf8');
    assert.match(shop, /shipped: \{ on: \{ markDelivered: 'delivered', returnOrder: 'returned' \} \}/);
    assert.match(shop, /delivered: \{ on: \{ returnOrder: 'returned' \} \}/);
  });
});
