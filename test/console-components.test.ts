import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { isImportDeclaration, type StringLiteral } from 'typescript/unstable/ast';
import { parseText, transpile } from './support/tsc.js';
import { consoleComponents } from '../packages/mistri/src/server/console/components.js';

/** The engine as an install holds it beside the package: its exports answer from dist/, and dist/ has the one module asked for. */
async function installEngine(dir: string) {
  const engine = join(dir, 'node_modules/@mistriwork/engine');
  await mkdir(join(engine, 'dist/server'), { recursive: true });
  await writeFile(
    join(engine, 'package.json'),
    JSON.stringify({ name: '@mistriwork/engine', type: 'module', exports: { './*': './dist/*' } }),
  );
  const source = await readFile(new URL('../packages/engine/src/server/devclient.ts', import.meta.url), 'utf8');
  await writeFile(join(engine, 'dist/server/devclient.js'), transpile(source, { module: 'esnext' }));
  const product = await readFile(new URL('../packages/engine/src/server/product.ts', import.meta.url), 'utf8');
  await writeFile(join(engine, 'dist/server/product.js'), transpile(product, { module: 'esnext' }));
}

test('Console component artifact loads from an installed tree without source or compiler, independently of cwd', async (t) => {
  const compiled = await consoleComponents();
  assert.equal(await consoleComponents(), compiled, 'source compilation is lazy and shared');
  const entry = compiled.entries['console-controls'];
  assert.equal(entry.kind, 'page');
  const script = compiled.files[entry.js];
  assert.match(script, /export\s*\{/);
  const imports = parseText(script, 'entry.js')
    .statements.filter(isImportDeclaration)
    .map((statement) => (statement.moduleSpecifier as StringLiteral).text);
  /* Only what the host provides stays a bare import: React and the two SDK modules. `page` joined `ui` when the rooms
     began keeping their App, view and filters in the address (useAddressState). The rooms are the App framework's,
     so they name its SDK (`mistri/*`). */
  assert.deepEqual([...new Set(imports)].sort(), ['@mistriwork/mistri/page', '@mistriwork/mistri/ui', 'react', 'react/jsx-runtime']);
  assert.doesNotMatch(script, /\b(?:__require|require)\s*\(/, 'the browser never needs CommonJS React');
  const map = JSON.parse(compiled.files[`${entry.js}.map`]) as { sources: string[] };
  assert.ok(
    !map.sources.some((source) => /node_modules|client\/core\.js|components\/(?:Dropdown|SplitListDetail|anchor)\./.test(source)),
    'the room reuses the host primitives instead of bundling their dependency graph',
  );
  // 96 KB (minified) since 0.8.11's flags room: the flag sheet with staged edits and their review (FlagSheet), the rule
  // editor and the experiment's comparison and verdict ship in the one component a room is. It loads only when the room
  // is opened, never on an App's first paint; every source in it is still the room's own, which the check above holds.
  assert.ok(Buffer.byteLength(script) < 96_000, 'the room stays a small component, not a second client');
  assert.ok(Buffer.byteLength(compiled.files[`${entry.js}.map`]) < 330_000, 'the map contains only component sources');
  assert.ok(entry.css && compiled.files[entry.css], 'the scoped stylesheet ships with the room');

  // Only the emitted loader and its normal source-mode signal exist here:
  // no src, node_modules, compiler or application modules can rescue a load.
  const dir = await mkdtemp(join(tmpdir(), 'tw-console-package-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const server = join(dir, 'dist/server'),
    room = join(server, 'console');
  await mkdir(room, { recursive: true });
  await writeFile(join(dir, 'package.json'), '{"type":"module"}');
  await installEngine(dir);
  for (const file of ['console/components']) {
    const source = await readFile(new URL(`../packages/mistri/src/server/${file}.ts`, import.meta.url), 'utf8');
    await writeFile(join(server, `${file}.js`), transpile(source, { module: 'esnext' }));
  }
  await writeFile(join(room, 'components.json'), JSON.stringify(compiled));
  const moduleUrl = pathToFileURL(join(room, 'components.js')).href;
  const output = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import { createHash } from 'node:crypto';
    const { consoleComponents } = await import(${JSON.stringify(moduleUrl)});
    const first = consoleComponents();
    assert.equal(consoleComponents(), first);
    console.log(createHash('sha256').update(JSON.stringify(await first)).digest('hex'));
  `,
    ],
    { cwd: tmpdir(), encoding: 'utf8' },
  );
  assert.equal(output.trim(), createHash('sha256').update(JSON.stringify(compiled)).digest('hex'));

  await rm(join(room, 'components.json'));
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    const { consoleComponents } = await import(${JSON.stringify(moduleUrl)});
    await assert.rejects(consoleComponents(), { code: 'ENOENT' });
  `,
    ],
    { cwd: tmpdir(), encoding: 'utf8' },
  );
});
