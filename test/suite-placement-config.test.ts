/** Placement enrollment captures operator secrets without adopting account authority. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { suitePlacementConfiguration } from '../packages/mistri/src/server/cli/suitePlacementConfig.js';

const definition = () => ({
  issuerId: 'keystone',
  activeKey: 'one',
  keys: [{ id: 'one', secretEnv: 'PLACEMENT_KEY', issueFrom: 0 }],
  sources: [{ app: 'site', source: 'main', identity: 'keystone-records-v1' }],
});
const secret = randomBytes(32).toString('base64url');
const environment = { PLACEMENT_KEY: secret };
const normalize = (input: unknown, env = environment) => suitePlacementConfiguration(input, env, ['site'], 'https://staff.example');

test('placement source and dedicated issuer configuration are detached before startup awaits', () => {
  const input = definition(),
    env = { ...environment };
  const captured = normalize(input, env)!;
  input.sources[0].identity = 'replacement';
  input.keys[0].id = 'other';
  env.PLACEMENT_KEY = randomBytes(32).toString('base64url');
  assert.equal(captured.issuer.keys[0].secret, secret);
  assert.equal(captured.issuer.keys[0].id, 'one');
  assert.equal(captured.sources[0].identity, 'keystone-records-v1');
  assert.ok(Object.isFrozen(captured));
  assert.ok(Object.isFrozen(captured.issuer.keys));
  assert.ok(Object.isFrozen(captured.sources[0]));
  assert.equal(normalize(undefined), undefined);
});

test('missing keys, account-secret reuse, foreign sources and unbounded or open declarations refuse without secret leakage', () => {
  const input = definition();
  const rejects = (work: () => unknown) =>
    assert.throws(work, (error) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes(secret));
      assert.equal(error.cause, undefined);
      return true;
    });
  for (const malformed of [
    { ...input, extra: true },
    { ...input, activeKey: 'missing' },
    { ...input, keys: [] },
    { ...input, keys: [...input.keys, ...input.keys, ...input.keys] },
    { ...input, sources: [] },
    { ...input, sources: [...input.sources, ...input.sources] },
    { ...input, sources: [{ ...input.sources[0], app: 'other' }] },
    { ...input, sources: [{ ...input.sources[0], identity: 'postgres://private.example/data' }] },
    { ...input, keys: [{ ...input.keys[0], issueFrom: NaN }] },
    { ...input, keys: [{ ...input.keys[0], secretEnv: 'MISSING' }] },
    { ...input, keys: [{ ...input.keys[0], secret }] },
  ])
    rejects(() => normalize(malformed));
  rejects(() => normalize(input, { PLACEMENT_KEY: 'invalid-key' }));
  rejects(() => suitePlacementConfiguration(input, environment, ['site'], undefined));
  rejects(() => suitePlacementConfiguration(input, environment, ['site'], 'https://staff.example', [secret]));
  rejects(() => suitePlacementConfiguration(input, { ...environment, BETTER_AUTH_SECRET: secret }, ['site'], 'https://staff.example'));
  let accessed = false;
  rejects(() =>
    normalize(
      Object.defineProperty({ ...input }, 'keys', {
        enumerable: true,
        get() {
          accessed = true;
          return input.keys;
        },
      }),
    ),
  );
  assert.equal(accessed, false);
});

test('recovery-only origins retain a bounded deadline independently of active host mappings', () => {
  const origin = { app: 'site', origin: 'https://retired.example', recoverUntil: Date.now() + 60_000 };
  const captured = normalize({ ...definition(), recoveryOrigins: [origin] })!;
  assert.deepEqual(captured.recoveryOrigins, [origin]);
  origin.origin = 'https://replacement.example';
  assert.equal(captured.recoveryOrigins![0].origin, 'https://retired.example');
  for (const retained of [
    { ...origin, app: 'foreign' },
    { ...origin, origin: 'https://staff.example' },
    { ...origin, origin: 'http://retired.example' },
    { ...origin, recoverUntil: Date.now() + 25 * 60 * 60 * 1000 },
  ]) {
    assert.throws(() => normalize({ ...definition(), recoveryOrigins: [retained] }));
  }
});
