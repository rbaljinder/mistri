import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { servedApp } from '../packages/mistri/src/shared/appPayload.js';
import { normalizeAppFlagGate } from '../packages/mistri/src/shared/appFlagGates.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { appCommandCatalog } from '../packages/mistri/src/server/commands/commandContracts.js';
import { captureAppFlagCatalog, validateAppCommandFlagGates } from '../packages/mistri/src/server/flags/appCatalog.js';
import { matchFlagCapabilities } from '../packages/mistri/src/server/flags/authority.js';

const manifest = () => ({
  id: 'desk',
  name: 'Desk',
  sources: { data: { connection: 'db' } },
  resources: { item: { access: 'write' } },
  views: { items: { kind: 'list', from: 'item' } },
  home: 'items',
  flags: {
    enabled: { type: 'boolean', default: false, owner: 'team', tenantManaged: true },
    copy: { type: 'string', default: 'a', variants: ['a', 'b'], owner: 'team' },
    count: { type: 'number', default: 1, variants: [1, 2], owner: 'team' },
    freeText: { type: 'string', default: 'unbounded', owner: 'team' },
    config: { type: 'object', default: { private: 'metadata' }, owner: 'team' },
  },
  audiences: { releases: { roles: ['release'] } },
  experiments: {
    copy: {
      version: 'copy-v1',
      unit: 'subject',
      control: 'a',
      startsAt: '2026-11-01T00:00:00.000Z',
      endsAt: '2026-11-15T00:00:00.000Z',
      conversionWindow: '48 hours',
      deliveryGrace: '24 hours',
      eligibility: { rollout: 100 },
      allocation: [
        { value: 'a', weight: 50 },
        { value: 'b', weight: 50 },
      ],
      primary: { conversion: 'submitted' },
    },
  },
  auth: {
    roles: {
      admin: { read: false },
      release: {
        read: true,
        commands: ['apply'],
        flags: [{ actions: ['manage'], environments: ['production'], owners: ['team'] }],
        experiments: [{ actions: ['manage'], environments: ['production'], owners: ['team'], ids: ['copy'] }],
      },
    },
  },
});
const parse = (input: unknown = manifest()) => parseAppConfig(input, 'catalog-fixture');
const commands = (enabledBy: { flag: string; is: boolean | string | number }) =>
  defineCommands({
    apply: defineCommand({
      source: 'data',
      target: 'item',
      enabledBy,
      handle() {},
    }),
  });

test('the private App graph supplies exact evaluation and authority projections with no admin shortcut', () => {
  const app = parse(),
    graph = captureAppFlagCatalog(app);
  assert.equal(graph.declared, true);
  assert.equal(graph.tenantApp, false);
  assert.deepEqual(Object.keys(graph.catalog).sort(), ['audiences', 'flags', 'roles']);
  assert.deepEqual(graph.catalog.roles, ['admin', 'release']);
  assert.deepEqual(graph.authorityCatalog.experiments!.copy, {
    version: 'copy-v1',
    weights: [
      { value: 'a', weight: 50 },
      { value: 'b', weight: 50 },
    ],
  });
  assert.deepEqual(Object.keys(graph.roles.release).sort(), ['experiments', 'flags']);
  const request = {
    scope: { appId: 'desk', environment: 'production', tenantId: null },
    flagId: 'copy',
    owner: 'team',
    requiredCapabilities: ['flags.manage', 'experiments.manage'],
  } as const;
  assert.equal(matchFlagCapabilities(graph.roles, ['admin'], 'app', request), false);
  assert.equal(matchFlagCapabilities(graph.roles, ['release'], 'app', request), true);
  assert.equal(matchFlagCapabilities(graph.roles, ['release', 'unknown'], 'app', request), false);
  assert.ok(Object.isFrozen(graph.authorityCatalog.experiments!.copy.weights[0]));
  assert.ok(Object.isFrozen(graph.roles.release.flags![0].owners));
  app.auth!.roles!.release.flags = [{ actions: ['view'], environments: ['staging'], owners: ['team'] }];
  assert.deepEqual(graph.roles.release.flags![0].actions, ['manage']);
  const payload = servedApp(app, { label: 'fixture', dialect: 'sqlite', readAt: 'now', tables: [], foreignKeys: [] });
  assert.doesNotMatch(JSON.stringify(payload), /copy-v1|submitted|conversionWindowHours|production|metadata/);
});

test('public catalogs have no synthetic roles and explicit empty declarations remain distinguishable', () => {
  const base = { name: 'Public', resources: { item: {} }, views: { items: { kind: 'list', from: 'item' } }, home: 'items' };
  const absent = captureAppFlagCatalog(parse(base));
  assert.equal(absent.declared, false);
  assert.deepEqual(absent.roles, {});
  assert.deepEqual(absent.catalog.roles, []);
  assert.equal(captureAppFlagCatalog(parse({ ...base, flags: {} })).declared, true);
  const published = captureAppFlagCatalog(parse({ ...base, flags: manifest().flags }));
  assert.equal(published.declared, true);
  assert.deepEqual(published.roles, {});
  const signInOnly = captureAppFlagCatalog(parse({ ...base, flags: manifest().flags, auth: { providers: ['email'] } }));
  assert.deepEqual(signInOnly.catalog.roles, []);
});

test('existing tenancy semantics canonicalize implicit tenant roles and preserve explicit two-realm roles', () => {
  const value = manifest();
  const tenant = { ...value, resources: { item: { access: 'write', owner: 'tenant' } }, auth: { ...value.auth, rows: 'tenant' } };
  const graph = captureAppFlagCatalog(parse(tenant));
  assert.equal(graph.tenantApp, true);
  assert.equal(graph.roles.admin.realm, 'tenant');
  assert.equal(graph.roles.release.realm, 'tenant');
  const two = {
    ...tenant,
    auth: {
      ...tenant.auth,
      tenancy: { platform: { label: 'Platform' } },
      roles: {
        admin: { ...value.auth.roles.admin, realm: 'tenant' },
        release: { ...value.auth.roles.release, realm: 'platform' },
      },
    },
  };
  assert.equal(captureAppFlagCatalog(parse(two)).roles.release.realm, 'platform');
  const invalid = parse(two);
  delete invalid.auth!.roles!.release.realm;
  assert.throws(() => captureAppFlagCatalog(invalid), /no "realm"/);
  const native = parse();
  native.auth!.roles!.release.realm = 'platform';
  assert.throws(() => captureAppFlagCatalog(native), /realm/);
});

test('startup checks all immutable registered command gates with exact scalar equality', () => {
  const app = parse();
  for (const enabledBy of [
    { flag: 'enabled', is: true },
    { flag: 'enabled', is: false },
    { flag: 'copy', is: 'b' },
    { flag: 'count', is: 2 },
  ]) {
    assert.doesNotThrow(() => captureAppFlagCatalog(app, commands(enabledBy)));
  }
  for (const enabledBy of [
    { flag: 'unknown', is: true },
    { flag: 'count', is: '2' },
    { flag: 'copy', is: 'c' },
    { flag: 'freeText', is: 'unbounded' },
    { flag: 'config', is: true },
  ]) {
    assert.throws(() => captureAppFlagCatalog(app, commands(enabledBy)), /enabledBy/);
  }
  const registry = commands({ flag: 'enabled', is: true });
  assert.throws(
    () =>
      validateAppCommandFlagGates(
        { apply: { ...registry.apply, enabledBy: { flag: 'enabled', is: true } } },
        captureAppFlagCatalog(app).catalog,
      ),
    /captured/,
  );
  let called = false;
  const bad = {
    ...registry.apply,
    get enabledBy() {
      called = true;
      return { flag: 'enabled', is: true };
    },
  };
  assert.throws(() => validateAppCommandFlagGates({ apply: bad }, captureAppFlagCatalog(app).catalog), /data property/);
  assert.equal(called, false);
});

test('command catalog references retain captured gates, and App parsing checks even undisplayed commands', () => {
  const value = manifest(),
    registry = commands({ flag: 'enabled', is: true });
  const withAction = { ...value, resources: { item: { access: 'write', actions: { apply: { label: 'Apply', command: 'apply' } } } } };
  const app = parseAppConfig(withAction, 'catalog-fixture', { commands: appCommandCatalog(registry, parse()) });
  assert.deepEqual(app.resources!.item.actions![0].command!.enabledBy, { flag: 'enabled', is: true });
  assert.ok(Object.isFrozen(app.resources!.item.actions![0].command!.enabledBy));
  assert.throws(
    () => parseAppConfig(value, 'catalog-fixture', { commands: appCommandCatalog(commands({ flag: 'count', is: '2' }), parse()) }),
    /enabledBy/,
  );
  const catalog = captureAppFlagCatalog(app).catalog;
  for (const gate of [
    { flag: 'enabled', is: {} },
    { flag: 'count', is: NaN },
    { flag: 'enabled', is: true, extra: 'hidden' },
    { flag: 'enabled' },
  ]) {
    assert.throws(() => normalizeAppFlagGate(gate, catalog));
  }
});
