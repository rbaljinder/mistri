import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lintComponents } from '../packages/mistri/src/server/app/componentLint.js';
import { componentCode } from '../packages/mistri/src/server/build/checkProblems.js';

const made: string[] = [];
after(() => Promise.all(made.map((dir) => rm(dir, { recursive: true, force: true }))));

async function lint(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'tw-token-'));
  made.push(dir);
  await mkdir(join(dir, 'c'), { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, 'c', name), text);
  return lintComponents(dir, { entries: { tile: { sources: Object.keys(files).map((n) => `c/${n}`) } } } as never);
}

test('an unknown var(--…) warns with the token it was meant to be; a real or own token does not', async () => {
  const { warnings, problems } = await lint({
    'tile.css': '.c-tile { color: var(--negative); background: var(--surface); gap: var(--tile-gap); --tile-gap: 8px; }',
    'tile.tsx': "export default () => <b style={{ color: 'var(--ink-mutd)' }} />;",
  });
  assert.deepEqual(problems, []);
  const said = warnings.map((w) => w.text);
  assert.equal(said.length, 2);
  assert.match(said[0]!, /"--negative".*var\(--status-critical\)/);
  assert.match(said[1]!, /"--ink-mutd".*var\(--ink-muted\)/);
  assert.equal(componentCode(said[0]!), 'component-token');
});
