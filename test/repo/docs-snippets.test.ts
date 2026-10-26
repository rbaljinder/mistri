// test-package: shared — a check of the repository that names both binaries (scripts/test-owners.mjs).
/*
 * The App examples in the documentation, parsed by the real parser, so an
 * example in a vocabulary the parser refuses fails here and not in a
 * reader's editor.
 *
 * The rule is the fence's title. A fenced block titled `app.ts`, `app.mjs`
 * or `app.json` — ```ts title="app.ts" — is a whole App file, and Starlight
 * draws that title as the file's name, so the reader is told what the test
 * is told. It is evaluated with the `@mistriwork/mistri/app` helpers it imports and
 * handed to parseAppConfig. A whole App imports nothing else; an example
 * that needs its sibling modules is a fragment.
 *
 * A fragment is not checked, so a fragment may not look whole: a block with
 * `export default defineApp(` must either carry the title or elide
 * something visibly (`…` or `...`). Without that guard an untitled,
 * complete-looking example would go stale unseen, which is what this test
 * exists to stop.
 *
 * Grammar strings and names are judged against no catalog here: queries,
 * columns and tables need a database, and `mistri check` judges those. What
 * this catches is the shape of the manifest.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transpile } from '../support/tsc.js';
import * as dsl from '@mistriwork/mistri/app';
import { parseAppConfig } from '../../packages/mistri/src/shared/app.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const markdownUnder = (dir: string): string[] =>
  readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.md'))
    .map((file) => join(dir, file).split('\\').join('/'));
const FILES = [
  ...markdownUnder('docs'),
  ...markdownUnder('site/src/content/docs'),
  'README.md',
  'packages/tablewalk/README.md',
  'packages/mistri/README.md',
  ...markdownUnder('examples/apps').filter((file) => file.endsWith('README.md')),
].sort();

interface Fence {
  file: string;
  line: number;
  lang: string;
  meta: string;
  body: string;
}

/** Every fenced block, with the line its opening fence is on. */
function fences(file: string): Fence[] {
  const lines = readFileSync(join(root, file), 'utf8').split('\n');
  const found: Fence[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^\s*(`{3,}|~{3,})\s*([^\s`]*)\s*(.*)$/.exec(lines[i]);
    if (!open) continue;
    const [, fence, lang, meta] = open;
    const close = new RegExp(`^\\s*${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`);
    let end = i + 1;
    while (end < lines.length && !close.test(lines[end])) end++;
    found.push({ file, line: i + 1, lang, meta, body: lines.slice(i + 1, end).join('\n') });
    i = end;
  }
  return found;
}

const WHOLE = /\btitle=["']app\.(ts|mjs|json)["']/;
const all = FILES.flatMap(fences);
const whole = all.filter((fence) => WHOLE.test(fence.meta));
const helpers = dsl as unknown as Record<string, unknown>;

/** The App a whole-file example exports, built with the helpers it imports. */
function evaluate(fence: Fence): unknown {
  if (fence.lang === 'json') return JSON.parse(fence.body);
  const js = transpile(fence.body, { module: 'esnext' });
  const names: string[] = [];
  const values: unknown[] = [];
  const body = js
    .replace(/^import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"];?[ \t]*$/gm, (_, clause: string, specifier: string) => {
      if (specifier !== '@mistriwork/mistri/app')
        throw new Error(`imports "${specifier}"; a whole App file imports only @mistriwork/mistri/app.`);
      const named = /^\{([\s\S]*)\}$/.exec(clause.trim());
      if (!named)
        throw new Error(
          `imports @mistriwork/mistri/app as "${clause}"; name the helpers: import { defineApp } from '@mistriwork/mistri/app'.`,
        );
      for (const piece of named[1]
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)) {
        const [exported, local = exported] = piece.split(/\s+as\s+/).map((part) => part.trim());
        if (!Object.hasOwn(helpers, exported)) throw new Error(`imports "${exported}", which @mistriwork/mistri/app does not export.`);
        names.push(local);
        values.push(helpers[exported]);
      }
      return '';
    })
    .replace(/^export default\s+/m, 'return ')
    .replace(/^export\s+(?=const|let|function)/gm, '');
  return new Function(...names, body)(...values);
}

test('the docs hold whole App examples, so this check is not vacuous', () => {
  assert.ok(whole.length >= 5, `found ${whole.length} fences titled app.ts, app.mjs or app.json`);
});

test('a fragment does not look like a whole App: it is titled, or it elides', () => {
  const looksWhole = all.filter(
    (fence) => !WHOLE.test(fence.meta) && /export default defineApp\(/.test(fence.body) && !/…|\.\.\./.test(fence.body),
  );
  assert.deepEqual(
    looksWhole.map((fence) => `${fence.file}:${fence.line}`),
    [],
    'Title a complete example ```ts title="app.ts" so it is parsed, or show what it leaves out with … .',
  );
});

for (const fence of whole) {
  test(`${fence.file}:${fence.line} parses as an App`, () => {
    parseAppConfig(evaluate(fence), `${fence.file}:${fence.line}`);
  });
}
