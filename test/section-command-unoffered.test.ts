import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lintComponents } from '../packages/mistri/src/server/app/componentLint.js';
import { componentCode } from '../packages/mistri/src/server/build/checkProblems.js';
import { unofferedRefusal } from '../packages/mistri/src/server/commands/businessCommandLoader.js';
import { refusalCause } from '@mistriwork/engine/shared/refusal.js';

// A field report: a section ran useCommand('archive') for a command no action offered, and the browser was
// answered 403 "not available to this account" whatever the role granted, with nothing in the log to say why.

const made: string[] = [];
after(() => Promise.all(made.map((dir) => rm(dir, { recursive: true, force: true }))));

async function lint(source: string, unprepared: ReadonlySet<string>) {
  const dir = await mkdtemp(join(tmpdir(), 'tw-unoffered-'));
  made.push(dir);
  await mkdir(join(dir, 'c'), { recursive: true });
  await writeFile(join(dir, 'c', 'tile.tsx'), source);
  return lintComponents(dir, { entries: { tile: { sources: ['c/tile.tsx'] } } } as never, undefined, undefined, undefined, unprepared);
}

const SECTION = [
  "import { useCommand as run, CommandButton } from '@mistriwork/mistri/ui';",
  'export default function Tile() {',
  "  const archive = run('archive');",
  '  return <CommandButton command="close" />;',
  '}',
].join('\n');

test("a section's command that nothing offers is a check problem naming the command and the fix", async () => {
  const { problems } = await lint(SECTION, new Set(['archive', 'close']));
  const said = problems.map((p) => p.text);
  assert.equal(said.length, 2);
  assert.match(said[0]!, /useCommand\('archive'\).*403.*command: 'archive', header: false/);
  assert.match(said[1]!, /<CommandButton command="close">.*command: 'close'/);
  assert.equal(componentCode(said[0]!), 'section-command-unoffered');
});

test('an offered command, or one a section does not name, is not a problem', async () => {
  assert.deepEqual((await lint(SECTION, new Set())).problems, []);
  assert.deepEqual((await lint(SECTION, new Set(['refund']))).problems, []);
});

test('a call that is not the SDK hook is not read as one', async () => {
  const own = "const useCommand = (n: string) => n;\nexport default () => { useCommand('archive'); return null; };";
  assert.deepEqual((await lint(own, new Set(['archive']))).problems, []);
});

test("the 403 for an unoffered command carries the reason for the operator, not the caller's sentence", () => {
  const error = unofferedRefusal(new Error('not available to this account'), 'archive');
  assert.equal(error.message, 'not available to this account');
  assert.match(String(refusalCause(error)), /"archive".*no action, form, import.*offers it.*header: false/);
});
