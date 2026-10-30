/**
 * `mistri build`, in-process: the lossless JSON a compiled App is written
 * in, the output layout with Rolldown and without it, and every refusal —
 * an --out it must not replace, an App that does not validate, a build from
 * another tablewalk version, a build edited after it was made.
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildApp, BUILD_EXIT, BuildFailure } from '../packages/mistri/src/server/build/build.js';
import { loadRolldown } from '../packages/mistri/src/server/build/bundle.js';
import { decodeLossless, encodeLossless, BUILD_MANIFEST, type BuildManifest } from '../packages/mistri/src/server/app/appBuild.js';
import { runtimeVersion } from '../packages/engine/src/server/packageVersion.js';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';

const work = mkdtempSync(join(tmpdir(), 'tablewalk-build-'));
after(() => rmSync(work, { recursive: true, force: true }));
const FORECOURT = resolve('test/fixtures/apps/forecourt');
const TINY = { id: 'tiny', name: 'Tiny', resources: { ticket: {} }, views: { ticket: { kind: 'list', from: 'ticket' } }, home: 'ticket' };

/** A throwaway App directory holding these files. */
function app(name: string, files: Record<string, string>): string {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
  return dir;
}

const files = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
    .sort();

const refused = (code: number, pattern: RegExp) => (error: unknown) => {
  assert.ok(error instanceof BuildFailure, String(error));
  assert.equal(error.code, code, error.message);
  assert.match(error.message, pattern);
  return true;
};

describe("the compiled App's JSON", () => {
  test('round-trips undefined keys and elements, in their places in the key order', () => {
    const value = {
      a: 1,
      gone: undefined,
      nested: { first: undefined, kept: 'x', last: undefined },
      list: [1, undefined, { deep: undefined }],
      '1': 'integer keys sort first',
      ['__proto__']: undefined,
    };
    Object.defineProperty(value, '__proto__', { value: 'an own key', enumerable: true });
    const { tree, undefinedAt } = encodeLossless(value);
    const back = decodeLossless(JSON.parse(JSON.stringify(tree)), JSON.parse(JSON.stringify(undefinedAt))) as typeof value;
    assert.deepStrictEqual(back, value);
    assert.deepEqual(Object.keys(back), Object.keys(value));
    assert.deepEqual(Object.keys(back.nested), ['first', 'kept', 'last']);
    assert.equal(Object.getPrototypeOf(back), Object.prototype);
  });

  test('refuses what JSON cannot carry exactly, as a bug in tablewalk', () => {
    const sparse = [1];
    sparse[2] = 3;
    for (const bad of [
      { at: new Map() },
      { at: new Date(0) },
      { at: Number.NaN },
      { at: -0 },
      { at: () => 1 },
      { at: Object.create(null) },
      { at: sparse },
      { at: 1n },
      { at: new (class Thing {})() },
    ]) {
      assert.throws(() => encodeLossless(bad), /cannot hold .* at "\/at" exactly as JSON\. This is a bug in mistri/);
    }
  });
});

describe('a build', () => {
  test("with Rolldown: the layout, the manifest, and a load that is the build's", async () => {
    const { out, manifest } = await buildApp(
      { app: FORECOURT, out: join(work, 'forecourt'), commands: join(FORECOURT, 'commands.ts') },
      { bundler: loadRolldown, typecheck: false },
    );
    assert.deepEqual(files(out), [
      'app.json',
      'authority.lock',
      'definition/app.mjs',
      'definition/app.mjs.map',
      BUILD_MANIFEST,
      'server/commands.mjs',
      'server/commands.mjs.map',
    ]);
    assert.equal(manifest.format, 1);
    assert.equal(manifest.mistri, runtimeVersion());
    assert.equal(manifest.node, process.version);
    assert.deepEqual(manifest.app, { id: 'forecourt', name: 'Forecourt', manifest: 'app.ts' });
    assert.equal(manifest.bundler.name, 'rolldown');
    assert.deepEqual(manifest.entries, { commands: 'server/commands.mjs' });
    assert.deepEqual(manifest.outputs, { manifest: 'app.json', definition: 'definition/app.mjs' });
    assert.deepEqual(manifest.checks.database, { status: 'skipped', detail: 'no --config; the catalog checks run when the build starts' });
    assert.deepEqual(
      Object.keys(manifest.sha256),
      files(out).filter((file) => file !== BUILD_MANIFEST),
    );
    assert.deepEqual(JSON.parse(readFileSync(join(out, BUILD_MANIFEST), 'utf8')), manifest);
    // No Node-only name for the server graph: @mistriwork/mistri/commands stays bare, answered by the serving tablewalk (buildResolution.ts).
    assert.match(readFileSync(join(out, 'server/commands.mjs'), 'utf8'), /from "@mistriwork\/mistri\/commands"/);
    assert.doesNotMatch(readFileSync(join(out, 'server/commands.mjs'), 'utf8'), /from "@mistriwork\/mistri\/app"/);

    const loaded = await loadApp(out);
    assert.equal(loaded.path, join(out, 'app.json'));
    assert.deepEqual(loaded.build, {
      dir: out,
      mistri: runtimeVersion(),
      node: process.version,
      entries: { commands: join(out, 'server/commands.mjs') },
      id: manifest.id,
    });
    assert.ok(
      Object.values(loaded.sources).every((file) => file === loaded.path),
      'a build defines every page in app.json',
    );
    assert.equal(loaded.authority?.lockPath, join(out, 'authority.lock'));
  });

  test('without Rolldown: each module type-stripped on its own, and said so', async () => {
    const said: string[] = [];
    const { out, manifest } = await buildApp(
      { app: FORECOURT, out: join(work, 'forecourt-stripped'), commands: join(FORECOURT, 'commands.ts') },
      { bundler: async () => undefined, typecheck: false },
      (line) => said.push(line),
    );
    assert.deepEqual(manifest.bundler, { name: 'strip-types', node: process.version });
    assert.ok(
      said.some(
        (line) =>
          /bundle: fallback succeeded — rolldown is not installed: each module was type-stripped on its own with node:module's stripTypeScriptTypes, not bundled/.test(
            line,
          ) && /build still runs, but ships separate modules/.test(line),
      ),
    );
    const held = files(out);
    for (const file of [
      'definition/app.mjs',
      'definition/mistri-app.mjs',
      'definition/src/app.mjs',
      'server/commands.mjs',
      'server/src/commands.mjs',
      'server/src/inquiry.mjs',
    ])
      assert.ok(held.includes(file), `${file} in ${held.join(', ')}`);
    assert.ok(!held.some((file) => file.endsWith('.map')), 'strip mode keeps every line and column, so no map is written');
    assert.equal(
      readFileSync(join(out, 'server/commands.mjs'), 'utf8'),
      "export * from './src/commands.mjs';\nexport { default } from './src/commands.mjs';\n",
    );
    // Relative imports now name the emitted files.
    assert.match(readFileSync(join(out, 'server/src/commands.mjs'), 'utf8'), /from '\.\/inquiry\.mjs'/);
    assert.ok((await loadApp(out)).build);
  });

  test('replaces an earlier build whole, and refuses an --out that is anything else', async () => {
    const dir = app('tiny', { 'app.json': JSON.stringify(TINY) });
    const out = join(work, 'tiny-out');
    await buildApp({ app: dir, out }, { typecheck: false });
    writeFileSync(join(out, 'stale.txt'), 'from before');
    await buildApp({ app: dir, out }, { typecheck: false });
    assert.equal(existsSync(join(out, 'stale.txt')), false);
    assert.deepEqual(files(out), ['app.json', BUILD_MANIFEST], 'an app.json App has nothing to bundle');

    const occupied = join(work, 'occupied');
    mkdirSync(occupied);
    writeFileSync(join(occupied, 'keep.txt'), 'mine');
    await assert.rejects(
      buildApp({ app: dir, out: occupied }, { typecheck: false }),
      refused(BUILD_EXIT.couldNotBuild, /is not an earlier build, so it is not replaced/),
    );
    assert.equal(readFileSync(join(occupied, 'keep.txt'), 'utf8'), 'mine');
    await assert.rejects(
      buildApp({ app: dir, out: join(dir, 'build') }, { typecheck: false }),
      refused(BUILD_EXIT.couldNotBuild, /overlaps the App directory/),
    );
    await assert.rejects(
      buildApp({ app: dir, out: work }, { typecheck: false }),
      refused(BUILD_EXIT.couldNotBuild, /overlaps the App directory/),
    );
    await assert.rejects(buildApp({ app: out }, { typecheck: false }), refused(BUILD_EXIT.couldNotBuild, /is already a build/));
    // An App at the package root, built from there with no --out: beside it, not inside where it is refused.
    const was = process.cwd();
    process.chdir(dir);
    try {
      const built = await buildApp({ app: '.' }, { typecheck: false });
      // The working directory is the real path (/private/var on macOS), so the build is named from it.
      assert.equal(built.out, join(realpathSync(work), 'tiny-build'));
      assert.ok(existsSync(join(work, 'tiny-build', BUILD_MANIFEST)));
      assert.equal(existsSync(join(dir, 'build')), false);
    } finally {
      process.chdir(was);
    }
    await assert.rejects(
      buildApp({ app: join(dir, 'app.json') }, { typecheck: false }),
      refused(BUILD_EXIT.couldNotBuild, /is not a directory/),
    );
  });

  test('an App that does not validate is a validation failure, and leaves nothing staged', async () => {
    const dir = app('invalid', { 'app.json': JSON.stringify({ ...TINY, home: 'missing' }) });
    await assert.rejects(
      buildApp({ app: dir, out: join(work, 'invalid-out') }, { typecheck: false }),
      refused(BUILD_EXIT.validation, /validation failed: .*missing/),
    );
    assert.deepEqual(
      readdirSync(work).filter((name) => name.startsWith('invalid-out')),
      [],
    );
  });

  test('a relative auth.store is refused: the next build would delete it', async () => {
    const dir = app('relative-store', { 'app.json': JSON.stringify({ ...TINY, auth: { providers: ['email'], store: './sessions.db' } }) });
    await assert.rejects(
      buildApp({ app: dir, out: join(work, 'relative-store-out') }, { typecheck: false }),
      refused(BUILD_EXIT.validation, /"auth\.store" is the relative path "\.\/sessions\.db"/),
    );
  });

  test('an unresolved command import is refused during registry validation', async () => {
    const dir = app('unresolved', { 'app.json': JSON.stringify(TINY), 'commands.mjs': "import './missing.mjs';\nexport default {};\n" });
    for (const bundler of [loadRolldown, async () => undefined]) {
      await assert.rejects(
        buildApp({ app: dir, out: join(work, 'unresolved-out'), commands: join(dir, 'commands.mjs') }, { bundler, typecheck: false }),
        refused(BUILD_EXIT.validation, /commands module could not be loaded/),
      );
    }
  });
});

describe('a build, served', () => {
  const edited = async (change: (out: string, manifest: BuildManifest) => void) => {
    const out = join(work, `edited-${Math.random().toString(36).slice(2)}`);
    const { manifest } = await buildApp({ app: app('served', { 'app.json': JSON.stringify(TINY) }), out }, { typecheck: false });
    change(out, manifest);
    return out;
  };

  test('is refused by any other tablewalk version, with the fix', async () => {
    const out = await edited((dir, manifest) => writeFileSync(join(dir, BUILD_MANIFEST), JSON.stringify({ ...manifest, mistri: '0.0.1' })));
    await assert.rejects(
      loadApp(out),
      new RegExp(
        `was built by mistri 0\\.0\\.1; this is mistri ${runtimeVersion().replaceAll('.', '\\.')}\\. ` +
          'A build is pinned to the version that made it: rebuild it',
      ),
    );
  });

  test('is refused when a file changed or went missing since it was built', async () => {
    const changed = await edited((dir) =>
      writeFileSync(join(dir, 'app.json'), readFileSync(join(dir, 'app.json'), 'utf8').replace('Tiny', 'Tine')),
    );
    await assert.rejects(loadApp(changed), /app\.json has changed since it was built \(its content hash differs\)\. Rebuild it/);
    const missing = await edited((dir) => rmSync(join(dir, 'app.json')));
    await assert.rejects(loadApp(missing), /app\.json is missing\. Rebuild it/);
    const unknown = await edited((dir, manifest) => writeFileSync(join(dir, BUILD_MANIFEST), JSON.stringify({ ...manifest, format: 2 })));
    await assert.rejects(loadApp(unknown), /is not a build this mistri reads \(format 2\)/);
  });
});
