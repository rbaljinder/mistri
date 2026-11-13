/**
 * How long a module may take to load in its worker is the environment's to say (MISTRI_MODULE_LOAD_TIMEOUT, in
 * seconds, 1 to 600, default 10): a busy machine's first compile was stopped at a fixed ten seconds (a field report).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluate } from '../packages/mistri/src/server/app/appPages.js';
import { moduleLoadTimeout } from '../packages/mistri/src/server/app/moduleLoadTimeout.js';

test('the limit is ten seconds until the environment names another, and a value that is not seconds is refused', () => {
  assert.deepEqual(moduleLoadTimeout({}), { ms: 10_000, seconds: 10 });
  assert.deepEqual(moduleLoadTimeout({ MISTRI_MODULE_LOAD_TIMEOUT: '' }), { ms: 10_000, seconds: 10 });
  assert.deepEqual(moduleLoadTimeout({ MISTRI_MODULE_LOAD_TIMEOUT: '45' }), { ms: 45_000, seconds: 45 });
  assert.deepEqual(moduleLoadTimeout({ MISTRI_MODULE_LOAD_TIMEOUT: '1.5' }), { ms: 1500, seconds: 1.5 });
  for (const bad of ['0', '601', 'soon', '-3', '10s'])
    assert.throws(
      () => moduleLoadTimeout({ MISTRI_MODULE_LOAD_TIMEOUT: bad }),
      /MISTRI_MODULE_LOAD_TIMEOUT takes seconds from 1 to 600; ".*" is not one\./,
      bad,
    );
});

test('a module that never finishes loading is given up on at the configured limit, and the answer names the setting', async () => {
  const saved = process.env.MISTRI_MODULE_LOAD_TIMEOUT;
  process.env.MISTRI_MODULE_LOAD_TIMEOUT = '1';
  try {
    const started = Date.now();
    await assert.rejects(
      evaluate('await new Promise(() => {});\nexport default {};'),
      /the page module did not finish loading within 1s \(MISTRI_MODULE_LOAD_TIMEOUT gives a slow machine longer\)/,
    );
    assert.ok(Date.now() - started < 8000, 'the limit named, not the ten seconds');
  } finally {
    if (saved === undefined) delete process.env.MISTRI_MODULE_LOAD_TIMEOUT;
    else process.env.MISTRI_MODULE_LOAD_TIMEOUT = saved;
  }
});
