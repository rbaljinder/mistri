import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, type TestContext } from 'node:test';
import { transpile } from './support/tsc.js';
import { HOST_MODULES, PAGE_EXPORTS, SERVED_MODULES, UI_EXPORTS } from '../packages/mistri/src/shared/uiSdk.js';

// Inspect the actual production packages used by the client build, not a fixed
// list of React names and not the development-only exports of this test runner.
const reactExports = JSON.parse(
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
  import { createRequire } from 'node:module';
  const require = createRequire(${JSON.stringify(import.meta.url)});
  console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(SERVED_MODULES.filter((name) => name !== '@mistriwork/mistri/ui' && name !== '@mistriwork/mistri/page'))}
    .map(name => [name, Object.keys(require(name)).filter(key => /^[A-Za-z_$][\\w$]*$/.test(key) && key !== 'default' && !key.startsWith('__'))]))));
`,
    ],
    { encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production' } },
  ),
) as Record<string, string[]>;
/* The SDK's own modules are their lists, in their order: what the build captures and the server checks. */
const expected = { ...reactExports, '@mistriwork/mistri/ui': UI_EXPORTS, '@mistriwork/mistri/page': PAGE_EXPORTS };

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

async function installed(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'tw-sdk-package-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'dist/server/app'), { recursive: true });
  await mkdir(join(dir, 'dist/shared'), { recursive: true });
  await writeFile(join(dir, 'package.json'), '{"type":"module"}');
  await installEngine(dir);
  for (const file of ['server/app/componentSdk', 'shared/uiSdk']) {
    const source = await readFile(new URL(`../packages/mistri/src/${file}.ts`, import.meta.url), 'utf8');
    await writeFile(join(dir, `dist/${file}.js`), transpile(source, { module: 'esnext' }));
  }
  const manifest = join(dir, 'dist/server/app/component-sdk-exports.json');
  const moduleUrl = pathToFileURL(join(dir, 'dist/server/app/componentSdk.js')).href;
  const run = (code: string) =>
    execFileSync(process.execPath, ['--input-type=module', '-e', code], {
      cwd: tmpdir(),
      encoding: 'utf8',
      env: { ...process.env, NODE_PATH: '' },
    });
  return { dir, manifest, moduleUrl, run };
}

test('packaged SDK bridges use only the captured host exports without installed React', async (t) => {
  const { dir, manifest, moduleUrl, run } = await installed(t);
  await writeFile(manifest, JSON.stringify(expected));
  run(`
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    import { readdirSync, unlinkSync } from 'node:fs';
    const require = createRequire(${JSON.stringify(moduleUrl)});
    /* The engine beneath the package, and nothing else: no React for a bridge to reach. */
    assert.deepEqual(readdirSync(${JSON.stringify(join(dir, 'node_modules'))}), ['@mistriwork']);
    for (const name of ${JSON.stringify(Object.keys(reactExports))}) assert.throws(() => require.resolve(name), { code: 'MODULE_NOT_FOUND' });
    const { hostModuleSource } = await import(${JSON.stringify(moduleUrl)});
    const expected = ${JSON.stringify(expected)};
    globalThis.__mistri = { modules: {} };
    for (const [name, file] of Object.entries(${JSON.stringify(Object.fromEntries(SERVED_MODULES.map((name) => [name, HOST_MODULES[name]])))})) {
      const host = Object.fromEntries(expected[name].map(key => [key, { name, key }]));
      globalThis.__mistri.modules[name] = host;
      const source = hostModuleSource(file);
      assert.equal(hostModuleSource(file), source);
      const bridge = await import('data:text/javascript,' + encodeURIComponent(source));
      assert.deepEqual(Object.keys(bridge).sort(), ['default', ...expected[name]].sort());
      assert.equal(bridge.default, host);
      for (const key of expected[name]) assert.equal(bridge[key], host[key]);
      if (name === 'react') unlinkSync(${JSON.stringify(manifest)}); // All other names come from the cached manifest.
    }
  `);
});

test('packaged SDK refuses missing or malformed manifests and never accepts a module path', async (t) => {
  const { manifest, moduleUrl, run } = await installed(t);
  const invalid = [
    'not json',
    'null',
    '[]',
    '{}',
    JSON.stringify({ ...expected, extra: [] }),
    ...[[], 'useState', ['default'], ['__SECRET_INTERNALS'], ['useState', 'useState'], ['x } = m; console.log(1); //']].map((react) =>
      JSON.stringify({ ...expected, react }),
    ),
    JSON.stringify({ ...expected, '@mistriwork/mistri/ui': ['unexpected'] }),
  ];
  run(`
    import assert from 'node:assert/strict';
    import { writeFileSync } from 'node:fs';
    const missing = await import(${JSON.stringify(moduleUrl)});
    for (const file of ['fs.js', '../react.js', 'react', 'node:fs', ${JSON.stringify(manifest)}, 'component-sdk-exports.json', '__proto__']) {
      assert.equal(missing.hostModuleSource(file), undefined);
    }
    assert.throws(() => missing.hostModuleSource('react.js'), /component SDK refused: component-sdk-exports.json is missing or invalid/);
    let index = 0;
    for (const body of ${JSON.stringify(invalid)}) {
      writeFileSync(${JSON.stringify(manifest)}, body);
      const { hostModuleSource } = await import(${JSON.stringify(moduleUrl)} + '?case=' + index++);
      assert.throws(() => hostModuleSource('react.js'), /component SDK refused: component-sdk-exports.json is missing or invalid/);
      assert.throws(() => hostModuleSource('ui.js'), /component SDK refused: component-sdk-exports.json is missing or invalid/);
    }
  `);
});

test('the build captures exactly the production host module exports', async (t) => {
  const file = new URL('../packages/mistri/dist/server/app/component-sdk-exports.json', import.meta.url);
  if (!existsSync(file)) return t.skip('no build: npm run build captures the host SDK exports');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), expected);
});
