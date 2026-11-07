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

async function lintShared(files: Record<string, string>, entries: Record<string, string[]>) {
  const dir = await mkdtemp(join(tmpdir(), 'tw-shared-'));
  made.push(dir);
  await mkdir(join(dir, 'c'), { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, 'c', name), text);
  return lintComponents(dir, {
    entries: Object.fromEntries(Object.entries(entries).map(([id, sources]) => [id, { sources: sources.map((n) => `c/${n}`) }])),
  } as never);
}

test('a stylesheet two components share is linted once, and a class either owns is not flagged', async () => {
  const { warnings } = await lintShared(
    { 'receipt.css': '.c-bill { color: #123456; }\n.c-slip-row { gap: 4px; }\n.card { gap: 2px; }' },
    { bill: ['receipt.css'], slip: ['receipt.css'] },
  );
  const said = warnings.map((w) => `${w.component}:${w.line} ${w.text}`);
  assert.equal(said.filter((text) => /#123456/.test(text)).length, 1);
  assert.equal(said.filter((text) => /"\.card"/.test(text)).length, 1);
  assert.equal(said.filter((text) => /c-slip-row/.test(text)).length, 0);
  assert.equal(said.length, 2);
  assert.ok(
    said.every((text) => text.startsWith('bill:')),
    'said under the first component that sources it',
  );
});

test('a radius of all zeros is a square on purpose; any other literal radius still warns', async () => {
  const { warnings } = await lint({
    'tile.css': [
      '.c-tile { border-radius: 0; }',
      '.c-tile-a { border-radius: 0px; }',
      '.c-tile-b { border-radius: 0rem; }',
      '.c-tile-c { border-radius: 0 0 0 0; }',
      '.c-tile-d { border-radius: 0px 0; }',
      '.c-tile-e { border-radius: var(--radius); }',
      '.c-tile-f { border-radius: 0 4px 0 0; }',
      '.c-tile-g { border-top-left-radius: 6px; }',
    ].join('\n'),
  });
  assert.deepEqual(
    warnings.map((w) => w.line),
    [7, 8],
  );
});
