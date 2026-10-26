import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { readSuiteConfiguration } from '../packages/mistri/src/server/cli/suiteConfig.js';
import {
  createTenantHostRouter,
  getTenantHostIntent,
  inheritTenantHostIntent,
  normalizeSuitePublicOrigin,
  validateTenantHosts,
} from '../packages/mistri/src/server/http/tenantHosts.js';

test('internal requests inherit admitted host intent, never a copied header or a conflicting owner', () => {
  const request = (host: string) => {
    const req = new IncomingMessage(new Socket());
    req.headers.host = host;
    req.rawHeaders = ['Host', host];
    return req;
  };
  const router = createTenantHostRouter(
    validateTenantHosts(
      [
        { host: 'north.example', app: 'site', tenant: 'north' },
        { host: 'south.example', app: 'site', tenant: 'south' },
      ],
      ['site'],
    ),
  );
  const parent = request('north.example'),
    child = request('north.example'),
    foreign = request('south.example');
  assert.equal(getTenantHostIntent(child), undefined);
  assert.equal(router.accept(parent), true);
  inheritTenantHostIntent(parent, child);
  assert.equal(getTenantHostIntent(child), getTenantHostIntent(parent));
  assert.equal(router.accept(foreign), true);
  assert.throws(() => inheritTenantHostIntent(foreign, child), /conflicts/);
  assert.equal(getTenantHostIntent(child)?.tenant, 'north');
});

test('operator host mappings canonicalize names and preserve opaque tenant ids', () => {
  const hosts = validateTenantHosts([{ host: 'Dealer.Example', app: 'store', tenant: 'opaque:tenant/42' }], ['store']);
  assert.deepEqual(hosts, [{ host: 'dealer.example', app: 'store', tenant: 'opaque:tenant/42' }]);
  assert.ok(Object.isFrozen(hosts));
  assert.ok(Object.isFrozen(hosts[0]));
  for (const host of [
    'https://dealer.example',
    'user@dealer.example',
    '*.example',
    'dealer.example:443',
    'dealer.example/path',
    'dealer.example?x',
    'dealer.example#x',
    'dealer.example.',
    ' dealer.example',
    'dealer..example',
    '-dealer.example',
    'localhost',
    '127.0.0.1',
    '[::1]',
    '127.1',
    '2130706433',
    '0x7f000001',
    'staff.example',
  ]) {
    assert.throws(() => validateTenantHosts([{ host, app: 'store', tenant: 'opaque' }], ['store'], 'https://staff.example'), Error, host);
  }
  const mapping = { host: 'dealer.example', app: 'store', tenant: 'tenant' };
  assert.throws(() => validateTenantHosts([mapping, { ...mapping, host: 'DEALER.EXAMPLE' }], ['store']), /duplicated/);
  assert.throws(() => validateTenantHosts([{ ...mapping, app: 'missing' }], ['store']), /unknown App/);
  for (const tenant of ['', ' ', ' t', 't\n', null, 7]) {
    assert.throws(() => validateTenantHosts([{ ...mapping, tenant }], ['store']), /tenant id/);
  }
  assert.throws(() => validateTenantHosts([{ ...mapping, custom_domain: 'ignored.example' }], ['store']), /Invalid/);
});

test('publicOrigin is a normalized HTTPS origin, with HTTP limited to loopback', () => {
  assert.equal(normalizeSuitePublicOrigin('https://Staff.Example:443/'), 'https://staff.example');
  assert.equal(normalizeSuitePublicOrigin('https://staff.example:8443'), 'https://staff.example:8443');
  for (const origin of ['http://localhost:4111', 'http://127.0.0.1:4111', 'http://[::1]:4111']) {
    assert.equal(normalizeSuitePublicOrigin(origin), origin);
  }
  for (const origin of [
    'http://staff.example',
    'https://user:password@staff.example',
    'https://@staff.example',
    'https://staff.example/tools',
    'https://staff.example?x',
    'https://staff.example#x',
    'https://staff.example?',
    'https://staff.example#',
    'https://staff.example\\other',
    'https://sta\nff.example',
    'https://%73taff.example',
    'ftp://staff.example',
    '//staff.example',
    'https://*.example',
    ' https://staff.example',
  ]) {
    assert.throws(() => normalizeSuitePublicOrigin(origin), Error, origin);
  }
});

test('suite configuration reads hosts and publicOrigin without enrolling arbitrary fields', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'tablewalk-host-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'suite.json');
  const config = {
    apps: [{ id: 'store', directory: '.', config: 'connections.json', mount: '/store' }],
    publicOrigin: 'https://STAFF.example/',
    hosts: [{ host: 'Store.Example', app: 'store', tenant: 'tenant:opaque' }],
  };
  await writeFile(file, JSON.stringify(config));
  const read = await readSuiteConfiguration(file, {});
  assert.equal(read.publicOrigin, 'https://staff.example');
  assert.deepEqual(read.hosts, [{ host: 'store.example', app: 'store', tenant: 'tenant:opaque' }]);
  await writeFile(file, JSON.stringify({ apps: config.apps }));
  const local = await readSuiteConfiguration(file, {});
  assert.equal(local.publicOrigin, undefined);
  assert.equal(local.hosts, undefined);
  await writeFile(file, JSON.stringify({ ...config, hosts: [{ ...config.hosts[0], host: 'staff.example' }] }));
  await assert.rejects(readSuiteConfiguration(file, {}), /collides/);
});
