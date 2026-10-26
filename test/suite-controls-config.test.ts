/** Control configuration is explicit, closed, detached and never authority. */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readSuiteConfiguration } from '../packages/mistri/src/server/cli/suiteConfig.js';
import { suiteControlConfiguration } from '../packages/mistri/src/server/cli/suiteControlConfig.js';

const flags = {
  store: 'postgresql://control:private-secret@127.0.0.1/control',
  environment: 'production',
  deploymentId: 'suite-production',
};
test('control config is explicit, immutable, closed and never discloses credentials in refusals', () => {
  assert.deepEqual(suiteControlConfiguration({}, true), {});
  const input = { flags: { ...flags }, console: { enabled: true } };
  const result = suiteControlConfiguration(input, true);
  input.flags.environment = 'changed';
  input.console.enabled = false;
  assert.equal(result.flags!.environment, 'production');
  assert.equal(result.console!.enabled, true);
  assert.ok(Object.isFrozen(result.flags));
  assert.ok(Object.isFrozen(result.console));
  const rejected = (input: Parameters<typeof suiteControlConfiguration>[0], identity = true) =>
    assert.throws(
      () => suiteControlConfiguration(input, identity),
      (error) => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes('private-secret'));
        return true;
      },
    );
  rejected({ flags }, false);
  rejected({ console: { enabled: true } });
  rejected({ flags, console: { enabled: true, admin: true } });
  for (const store of [
    'postgresql://control:private-secret@127.0.0.1',
    'file:control.db',
    '${DATABASE_URL}',
    '',
    flags.store + '#fragment',
  ]) {
    rejected({ flags: { ...flags, store } });
  }
  for (const value of [
    { ...flags, extra: true },
    { ...flags, environment: '' },
    { ...flags, deploymentId: ' ' },
  ])
    rejected({ flags: value });
  let accessed = false;
  rejected({
    flags: Object.defineProperty({ ...flags }, 'store', {
      enumerable: true,
      get() {
        accessed = true;
        return flags.store;
      },
    }),
  });
  assert.equal(accessed, false);
});

test('suite parsing captures controls and reserves the internal Console App id', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'suite-controls-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'suite.json');
  const input = {
    identity: { id: 'suite', store: './accounts.sqlite', grants: './grants.sqlite', environment: { BETTER_AUTH_SECRET: 'SUITE_SECRET' } },
    flags,
    console: { enabled: true },
    apps: [{ id: 'site', mount: '/', directory: './site', config: './site/mistri.json' }],
  };
  await writeFile(file, JSON.stringify(input));
  const parsed = await readSuiteConfiguration(file, { SUITE_SECRET: 'operator-managed-suite-secret', PGDATABASE: 'must-not-be-used' });
  assert.deepEqual(parsed.flags, flags);
  assert.deepEqual(parsed.console, { enabled: true });
  input.apps[0].id = 'mistri-console';
  await writeFile(file, JSON.stringify(input));
  await assert.rejects(readSuiteConfiguration(file, { SUITE_SECRET: 'operator-managed-suite-secret' }), /reserved/);
});

test('experiment evidence explicitly uses a different database from flag controls', () => {
  const experiments = { store: 'postgresql://control:private-secret@127.0.0.1/evidence', deploymentId: 'evidence-production' };
  const captured = suiteControlConfiguration({ flags, experiments }, true);
  assert.deepEqual(captured.experiments, experiments);
  assert.ok(Object.isFrozen(captured.experiments));
  assert.throws(() => suiteControlConfiguration({ experiments }, true));
  for (const store of [flags.store, 'postgres://different-user@127.0.0.1:5432/control', 'file:local.db', '${EXPERIMENTS_URL}']) {
    assert.throws(() => suiteControlConfiguration({ flags, experiments: { ...experiments, store } }, true));
  }
  assert.throws(() => suiteControlConfiguration({ flags, experiments: { ...experiments, implicit: true } }, true));
});

const evidence = { store: 'postgresql://control:private-secret@127.0.0.1/evidence', deploymentId: 'evidence-production' };
const receiptKey = Buffer.alloc(32, 17).toString('base64url');
test('assignment keys are optional for store-only configuration, explicit, canonical, private and immutable', () => {
  const environment = { EXPERIMENT_KEY: receiptKey };
  const configuration = suiteControlConfiguration({ flags, experiments: { ...evidence, assignmentKeyEnv: 'EXPERIMENT_KEY' } }, true, {
    environment,
    forbiddenSecrets: [],
  });
  environment.EXPERIMENT_KEY = Buffer.alloc(32, 18).toString('base64url');
  assert.equal(configuration.experiments!.assignmentKey, receiptKey);
  assert.ok(Object.isFrozen(configuration.experiments));
  assert.equal(Object.getOwnPropertyDescriptor(configuration.experiments!, 'assignmentKey')!.enumerable, false);
  assert.equal(JSON.stringify(configuration).includes(receiptKey), false);
  assert.equal('assignmentKey' in { ...configuration.experiments }, false);
  assert.throws(() => {
    (configuration.experiments as { assignmentKey: string }).assignmentKey = 'changed';
  });
  assert.equal(suiteControlConfiguration({ flags, experiments: evidence }, true).experiments!.assignmentKey, undefined);
  assert.throws(() => suiteControlConfiguration({ flags, experiments: { ...evidence, assignmentKey: receiptKey } }, true));
  assert.throws(() => suiteControlConfiguration({ flags, experiments: { ...evidence, assignmentKeyEnv: 'EXPERIMENT_KEY' } }, true));
});

test('missing, malformed and aliased reused keys fail with sanitized diagnostics', () => {
  const invalid = (key: string | undefined, name: unknown = 'PRIVATE_ENV_ALIAS', forbiddenSecrets: readonly string[] = []) => {
    assert.throws(
      () =>
        suiteControlConfiguration({ flags, experiments: { ...evidence, assignmentKeyEnv: name } }, true, {
          environment: { PRIVATE_ENV_ALIAS: key },
          forbiddenSecrets,
        }),
      (error) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /PRIVATE_ENV_ALIAS|private-secret/);
        if (key) assert.equal(error.message.includes(key), false);
        return true;
      },
    );
  };
  for (const key of [
    undefined,
    '',
    Buffer.alloc(31).toString('base64url'),
    Buffer.alloc(33).toString('base64url'),
    `${receiptKey}=`,
    ` ${receiptKey}`,
    `${receiptKey.slice(0, -1)}B`,
    '+'.repeat(43),
    'private-secret',
  ])
    invalid(key);
  for (const name of [null, '', ' HAS_SPACE', 'BETTER_AUTH_SECRET', '${PRIVATE_ENV_ALIAS}', 1]) invalid(receiptKey, name);
  invalid(receiptKey, 'PRIVATE_ENV_ALIAS', [receiptKey]);
  invalid(Buffer.from('N'.repeat(32)).toString('base64url'), 'PRIVATE_ENV_ALIAS', ['N'.repeat(32)]);
  invalid(receiptKey, 'PRIVATE_ENV_ALIAS', [Buffer.from(receiptKey, 'base64url').toString('base64')]);
  let accessed = false;
  assert.throws(() =>
    suiteControlConfiguration(
      {
        flags,
        experiments: {
          ...evidence,
          get assignmentKeyEnv() {
            accessed = true;
            return 'PRIVATE_ENV_ALIAS';
          },
        },
      },
      true,
      { environment: {}, forbiddenSecrets: [] },
    ),
  );
  assert.equal(accessed, false);
});

test('suite captures the explicit key once and compares actual suite/App identity and active/retained placement secrets across aliases', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'suite-exposure-key-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'suite.json');
  const input = {
    publicOrigin: 'https://suite.example.test',
    identity: {
      id: 'suite',
      store: './accounts.sqlite',
      grants: './grants.sqlite',
      environment: { BETTER_AUTH_SECRET: 'SUITE_SECRET_ALIAS' },
    },
    flags,
    experiments: { ...evidence, assignmentKeyEnv: 'RECEIPT_ALIAS' },
    publicPlacement: {
      issuerId: 'suite',
      activeKey: 'current',
      keys: [
        { id: 'current', secretEnv: 'PLACEMENT_ALIAS', issueFrom: 0 },
        { id: 'old', secretEnv: 'OLD_PLACEMENT_ALIAS', issueFrom: 0, issueUntil: 1 },
      ],
      sources: [{ app: 'site', source: 'business', identity: 'site-business' }],
    },
    apps: [
      {
        id: 'site',
        mount: '/',
        directory: './site',
        config: './site/mistri.json',
        environment: { BETTER_AUTH_SECRET: 'APP_SECRET_ALIAS' },
      },
    ],
  };
  await writeFile(file, JSON.stringify(input));
  const environment = {
    RECEIPT_ALIAS: receiptKey,
    SUITE_SECRET_ALIAS: 'separate-suite-native-secret',
    APP_SECRET_ALIAS: 'separate-app-native-secret',
    PLACEMENT_ALIAS: Buffer.alloc(32, 21).toString('base64url'),
    OLD_PLACEMENT_ALIAS: Buffer.alloc(32, 22).toString('base64url'),
  };
  const pending = readSuiteConfiguration(file, environment);
  environment.RECEIPT_ALIAS = Buffer.alloc(32, 23).toString('base64url');
  const parsed = await pending;
  assert.equal(parsed.experiments!.assignmentKey, receiptKey);
  assert.equal(JSON.stringify(parsed.experiments).includes(receiptKey), false);
  assert.equal(Buffer.from(parsed.experiments!.assignmentKey!, 'base64url').length, 32);
  for (const alias of ['SUITE_SECRET_ALIAS', 'APP_SECRET_ALIAS', 'PLACEMENT_ALIAS', 'OLD_PLACEMENT_ALIAS']) {
    const aliases = { ...environment, RECEIPT_ALIAS: receiptKey, [alias]: receiptKey };
    await assert.rejects(readSuiteConfiguration(file, aliases), (error) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes(receiptKey), false);
      assert.equal(error.message.includes(alias), false);
      assert.doesNotMatch(error.message, /private-secret/);
      return true;
    });
  }
  await assert.rejects(readSuiteConfiguration(file, { ...environment, RECEIPT_ALIAS: undefined }));
  // Provisioning/results-only suites need no serving key and get no fallback.
  const { assignmentKeyEnv: _key, ...storeOnly } = input.experiments;
  await writeFile(file, JSON.stringify({ ...input, experiments: storeOnly }));
  assert.equal((await readSuiteConfiguration(file, environment)).experiments!.assignmentKey, undefined);
});
