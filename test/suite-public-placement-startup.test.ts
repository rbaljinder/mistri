/** A restart changes execution admission, while dedicated issuer keys remain stable. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { createSuitePublicPlacement } from '../packages/mistri/src/server/cli/suitePublicPlacement.js';
import type { SuiteConfiguration } from '../packages/mistri/src/server/cli/suiteConfig.js';

test('suite activation captures source/origin intent, hashes policy and renews only the execution epoch', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'suite-placement-startup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const policy = join(directory, 'policy.mjs');
  await writeFile(policy, 'export default {};');
  const app = parseAppConfig(
    {
      id: 'site',
      name: 'Site',
      sources: { main: { connection: 'business' } },
      resources: { inbox: {} },
      auth: { rows: 'policy', roles: { staff: { read: true } } },
      views: { inbox: { kind: 'list', from: 'inbox' } },
      home: 'inbox',
    },
    'placement startup test',
  );
  const config: SuiteConfiguration = {
    port: 4880,
    basePath: '/suite',
    apps: [],
    publicOrigin: 'https://staff.example',
    hosts: [{ host: 'north.example', app: 'site', tenant: 'north' }],
    publicPlacement: {
      issuer: { issuerId: 'suite', activeKey: 'one', keys: [{ id: 'one', secret: randomBytes(32).toString('base64url'), issueFrom: 0 }] },
      sources: [{ app: 'site', source: 'main', identity: 'original-database' }],
      recoveryOrigins: [{ app: 'site', origin: 'https://retired.example', recoverUntil: Date.now() + 60_000 }],
    },
  };
  const owner = createSuitePublicPlacement(config)!;
  config.hosts = [{ host: 'replacement.example', app: 'site', tenant: 'south' }];
  const first = (await owner.forApp(app, policy, '/suite/site'))!;
  assert.deepEqual(first.origins, ['https://north.example']);
  assert.equal(first.sourceIdentities.get('main'), 'original-database');
  assert.equal(first.recoveryOrigins![0].origin, 'https://retired.example');
  assert.match(first.policyRevision, /^[a-f0-9]{64}$/);
  assert.equal((await owner.forApp(app, policy, '/suite/site'))!.epoch, first.epoch);
  const restarted = (await createSuitePublicPlacement(config)!.forApp(app, policy, '/suite/site'))!;
  assert.notEqual(restarted.epoch, first.epoch);
  const binding = first.issuer.issue({
    appId: 'site',
    form: 'apply',
    commandId: 'apply',
    commandVersion: 1,
    sourceIdentity: 'original-database',
    tenant: 'north',
    host: 'north.example',
    origin: 'https://north.example',
    epoch: first.epoch,
    formRevision: first.policyRevision,
  });
  assert.equal(restarted.issuer.verifyRecovery(binding.binding, binding.submission, { appId: 'site', form: 'apply' }).epoch, first.epoch);
  await writeFile(policy, 'export default { revised: true };');
  assert.notEqual((await owner.forApp(app, policy, '/suite/site'))!.policyRevision, first.policyRevision);
  await assert.rejects(owner.forApp(app, undefined, '/suite/site'));
  await assert.rejects(owner.forApp({ ...app, sources: {} }, policy, '/suite/site'));
});
