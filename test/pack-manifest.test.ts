/**
 * The package.json an install unpacks (scripts/pack-manifest.mjs): no script that needs the checkout, every export
 * answering from dist/, and links that go somewhere a person can open.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { BUILT, CHECKOUT_ONLY, builtTarget, published } from '../scripts/pack-manifest.mjs';

const read = (path: string) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')) as Record<string, any>;
const manifests = readdirSync(new URL('../packages/', import.meta.url)).map((dir) => [dir, read(`packages/${dir}/package.json`)] as const);

test('the dev form of an export becomes its built target, and anything else stays as written', () => {
  assert.equal(builtTarget({ [BUILT]: './dist/*', default: './src/*' }), './dist/*');
  assert.deepEqual(builtTarget({ types: './schema/ui.d.ts', [BUILT]: './dist/ui/index.js', default: './src/ui.ts' }), {
    types: './schema/ui.d.ts',
    default: './dist/ui/index.js',
  });
  assert.deepEqual(builtTarget({ [BUILT]: { types: './dist/x.d.ts', default: './dist/x.js' }, default: './src/x.ts' }), {
    types: './dist/x.d.ts',
    default: './dist/x.js',
  });
  assert.equal(builtTarget('./schema/*'), './schema/*');
  assert.deepEqual(builtTarget({ types: './a.d.ts', default: './a.js' }), { types: './a.d.ts', default: './a.js' });
});

for (const [dir, manifest] of manifests)
  test(`${manifest.name}: a pack strips the scripts, names dist/ in every export, and keeps everything else`, () => {
    assert.equal(manifest.scripts.prepack, 'node ../../scripts/pack-manifest.mjs strip');
    assert.equal(manifest.scripts.postpack, 'node ../../scripts/pack-manifest.mjs restore');
    const shipped = published(manifest);
    for (const key of CHECKOUT_ONLY) assert.equal(key in shipped, false, `${key} would ship`);
    assert.deepEqual(
      Object.keys(shipped),
      Object.keys(manifest).filter((key) => !CHECKOUT_ONLY.includes(key)),
    );
    /* A package with no exports (create-mistri: a bin) has no dist/ either. */
    const text = JSON.stringify(shipped.exports) ?? '';
    assert.ok(!text.includes(BUILT), `${dir}: an export still names the checkout's condition`);
    assert.ok(!text.includes('./src/'), `${dir}: an export names src/, which does not ship`);
    if (manifest.exports) assert.ok(manifest.files.includes('dist'), `${dir} ships its dist`);
    assert.ok(
      !manifest.files.some((entry: string) => /^(?:test|e2e|scripts|src|packages)\b/.test(entry)),
      'what the checkout runs does not ship',
    );
  });

test('the links name the repository, its issues and the site', () => {
  for (const [dir, manifest] of manifests) {
    assert.equal(manifest.repository.url, 'git+https://github.com/rbaljinder/mistri.git');
    assert.equal(manifest.repository.directory, `packages/${dir}`);
    assert.equal(manifest.bugs.url, 'https://github.com/rbaljinder/mistri/issues');
    /* The browser keeps its own site; the App framework and its layers are mistri's. */
    assert.equal(manifest.homepage, dir === 'tablewalk' ? 'https://tablewalk.dev' : 'https://mistriwork.dev');
    assert.equal(manifest.engines.node, '>=24.22.1');
  }
});

test('every package carries the workspace version, and names the others at exactly it', () => {
  const { version } = read('package.json');
  const names = new Set(manifests.map(([, manifest]) => manifest.name));
  for (const [dir, manifest] of manifests) {
    assert.equal(manifest.version, version, `packages/${dir}`);
    for (const [name, range] of Object.entries({ ...manifest.dependencies, ...manifest.peerDependencies }))
      if (names.has(name)) assert.equal(range, version, `packages/${dir} depends on ${name}`);
  }
});

test('the engine, the kit and ui name every export: no pattern, in the checkout or in the package', () => {
  for (const [dir, manifest] of manifests) {
    if (!['engine', 'kit', 'ui'].includes(dir)) continue;
    for (const exports of [manifest.exports, published(manifest).exports])
      assert.deepEqual(
        Object.keys(exports).filter((subpath) => subpath.includes('*')),
        [],
        `${manifest.name} exports a pattern`,
      );
  }
});
