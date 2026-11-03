/**
 * A host product that runs the engine from npm says its own version once (`setProduct(name, version)`), and what
 * the process reports (`--version`, MCP's serverInfo, telemetry: all `packageVersion`) is that. Left out, it is the
 * engine's, so mistri's own start is unchanged.
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { packageVersion } from '../packages/engine/src/server/cli/usage.js';
import { productVersion, setProduct } from '../packages/engine/src/server/product.js';
import { runtimeVersion } from '../packages/engine/src/server/packageVersion.js';

afterEach(() => setProduct('mistri'));

test("a host's own version is what the process reports, and the engine's stays the engine's", async () => {
  assert.equal(await packageVersion(), runtimeVersion(), 'mistri reports the package version');
  setProduct('tablewalk', '9.8.7');
  assert.equal(productVersion(), '9.8.7');
  assert.equal(await packageVersion(), '9.8.7');
  assert.notEqual(runtimeVersion(), '9.8.7', 'the build pin still reads the engine');
  setProduct('tablewalk');
  assert.equal(await packageVersion(), runtimeVersion(), 'a host that gives none reports the engine');
});
