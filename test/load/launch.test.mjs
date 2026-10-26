import test from 'node:test';
import assert from 'node:assert/strict';
import { serverLaunch } from './launch.mjs';

test('source remains default and does not inspect or build artifacts', () => {
  assert.deepEqual(
    serverLaunch(false, () => {
      throw new Error('must not inspect');
    }),
    { mode: 'source-dev-vite', entry: ['--import', 'tsx', 'packages/mistri/src/server/index.ts'] },
  );
});
test('production uses only fixed built entry without tsx preload', () => {
  const inspected = [];
  const result = serverLaunch(true, (path) => {
    inspected.push(path);
    return { isFile: () => true };
  });
  assert.deepEqual(result, { mode: 'production-dist', entry: ['--conditions=mistri-built', 'packages/mistri/dist/server/index.js'] });
  assert.equal(inspected.length, 3);
  assert.ok(inspected.every((path) => path.includes('/dist/')));
});
test('missing or nonfile built artifacts fail clearly without launching anything', () => {
  for (const missing of ['index.js', 'devclient.js', 'index.html']) {
    assert.throws(
      () => serverLaunch(true, (path) => ({ isFile: () => !path.endsWith(`/${missing}`) })),
      /requires existing built artifact.*Build separately/,
    );
  }
  assert.throws(
    () =>
      serverLaunch(true, () => {
        throw new Error('ENOENT');
      }),
    /never builds or installs/,
  );
  assert.throws(() => serverLaunch('http://localhost'), /Invalid production mode/);
});
