import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { suiteControlConfiguration } from '../packages/mistri/src/server/cli/suiteControlConfig.js';
import { resolveExperimentSource } from '../packages/mistri/src/server/experiments/sourceConfiguration.js';
import { experimentDeclaration, experimentFlag } from './support/experimentRuntimeFixture.js';

const source = {
  appId: 'desk',
  flagId: 'copy',
  tenantId: null,
  sourceId: 'data',
  storeId: 'app:desk',
  commandIds: ['submit'],
  maxClockSkewMs: 1000,
};
const controls = {
  flags: { store: 'postgres://owner@localhost/flags', environment: 'production', deploymentId: 'flags' },
  experiments: { store: 'postgres://owner@localhost/experiments', deploymentId: 'experiments', sources: [source] },
};

test('explicit experiment source configuration is bounded, scoped and detached', () => {
  const configured = suiteControlConfiguration(controls, true).experiments!;
  assert.deepEqual(configured.sources, [source]);
  assert.ok(Object.isFrozen(configured.sources![0].commandIds));
  for (const replacement of [
    [],
    [source, source],
    [{ ...source, commandIds: [] }],
    [{ ...source, maxClockSkewMs: 120001 }],
    [{ ...source, controlTenantId: 'foreign' }],
    [{ ...source, url: '/injected.db' }],
  ]) {
    assert.throws(() => suiteControlConfiguration({ ...controls, experiments: { ...controls.experiments, sources: replacement } }, true));
  }
  const tenant = { ...source, tenantId: 'north', controlTenantId: null, storeId: 'tenant-store' };
  assert.deepEqual(
    suiteControlConfiguration({ ...controls, experiments: { ...controls.experiments, sources: [tenant] } }, true).experiments!.sources,
    [tenant],
  );
});

test('source resolves the actual connection id and canonical deployed SQLite path', () => {
  const app = parseAppConfig(
    {
      id: 'desk',
      name: 'Desk',
      sources: { data: { connection: 'primary' } },
      resources: { item: {} },
      views: { items: { kind: 'list', from: 'item' } },
      home: 'items',
      flags: { copy: experimentFlag },
      experiments: { copy: experimentDeclaration() },
    },
    'experiment source fixture',
  );
  const owner = { app, connections: [{ id: 'primary', name: 'Display name', url: 'sqlite:./fixture.db' }], environment: {} };
  assert.equal(resolveExperimentSource(source, owner).url, resolve('fixture.db'));
  assert.throws(() => resolveExperimentSource({ ...source, storeId: 'wrong' }, owner));
  assert.throws(() => resolveExperimentSource({ ...source, tenantId: 'north' }, owner));
  assert.throws(() => resolveExperimentSource({ ...source, sourceId: 'foreign' }, owner));
  assert.throws(() => resolveExperimentSource(source, { ...owner, connections: [{ id: 'wrong', name: 'primary', url: './fixture.db' }] }));
  assert.equal(
    resolveExperimentSource(source, {
      ...owner,
      connections: [{ id: 'primary', name: 'Display', url: '${BUSINESS_DB}' }],
      environment: { BUSINESS_DB: 'postgres://owner@localhost/business' },
    }).url,
    'postgres://owner@localhost/business',
  );
});
