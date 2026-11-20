/**
 * `api.service`: the service roles a tenant's administrator may hand to a program in a tenant service token (#251,
 * from a field report). What it may say, and the two check codes that keep it a tenant's and a program's.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiServiceProblems, parseAppApi } from '../packages/mistri/src/shared/appApi.js';
import { apiAuthorityFacts } from '../packages/mistri/src/shared/apiAuthority.js';
import { validationCode } from '../packages/mistri/src/server/build/checkProblems.js';
import { parseTestApp } from './support/commandCatalog.js';

const roles = ['staff', 'device_bridge'];
const base = { version: 1, roles: ['staff'], resources: { reading: { fields: ['id', 'value'] } } };
const parse = (service: unknown) => parseAppApi({ ...base, service }, roles, 'fixture.api');
const codes = (problems: readonly string[]) => problems.map(validationCode);

const tenantRoles = { staff: { read: true }, device_bridge: { service: true as const, read: true } };

test('api.service names declared roles and a label, and is absent unless written', () => {
  assert.equal(parseAppApi(base, roles, 'fixture.api')!.service, undefined);
  assert.deepEqual(parse({ roles: ['device_bridge'], label: ' Device bridge ' })!.service, {
    roles: ['device_bridge'],
    label: 'Device bridge',
  });
  assert.throws(() => parse({ roles: ['robot'], label: 'Robot' }), /role is not declared by the App/);
  assert.throws(() => parse({ roles: [], label: 'Robot' }), /roles must not be empty/);
  assert.throws(() => parse({ roles: ['device_bridge', 'device_bridge'], label: 'Robot' }), /duplicate/);
  // The label is what a tenant's audit shows for every write the token makes, so it is never left to a default.
  assert.throws(() => parse({ roles: ['device_bridge'] }), /label names the program in the audit/);
  assert.throws(() => parse({ roles: ['device_bridge'], label: '  ' }), /nonempty text/);
  assert.throws(() => parse({ roles: ['device_bridge'], label: 'x', tenant: 't1' }), /unknown property "tenant"/);
});

test('[api-service-role]: every role it names is one no person holds', () => {
  const api = parse({ roles: ['staff', 'device_bridge'], label: 'Device bridge' })!;
  const problems = apiServiceProblems(api, { rows: 'tenant', roles: tenantRoles });
  assert.deepEqual(codes(problems), ['api-service-role']);
  assert.match(problems[0]!, /"staff" is not a service role/);
  assert.match(problems[0]!, /auth\.roles\.staff\.service: true/);
  const fine = parse({ roles: ['device_bridge'], label: 'Device bridge' })!;
  assert.deepEqual(apiServiceProblems(fine, { rows: 'tenant', roles: tenantRoles }), []);
});

test('[api-service-tenant]: a service token is bound to a tenant, so only a tenant App declares one', () => {
  const api = parse({ roles: ['device_bridge'], label: 'Device bridge' })!;
  for (const rows of ['all', 'policy', undefined]) {
    assert.deepEqual(codes(apiServiceProblems(api, { ...(rows ? { rows } : {}), roles: tenantRoles })), ['api-service-tenant']);
  }
  assert.deepEqual(apiServiceProblems(parseAppApi(base, roles)!, { rows: 'all', roles: tenantRoles }), []);
});

test('the App parse refuses api.service outside a tenant App, with its code', () => {
  let message = '';
  try {
    parseTestApp(
      {
        id: 'meters',
        name: 'Meters',
        resources: { reading: {} },
        auth: { roles: tenantRoles },
        views: { readings: { kind: 'list', from: 'reading' } },
        home: 'readings',
        api: { ...base, service: { roles: ['device_bridge'], label: 'Device bridge' } },
      },
      'fixture',
    );
  } catch (error) {
    message = (error as Error).message;
  }
  assert.equal(validationCode(message), 'api-service-tenant', message);
});

test('a service role is authority the lock names; an App without api.service keeps the lock it had', () => {
  const facts = (api: ReturnType<typeof parseAppApi>) => apiAuthorityFacts(api, {}).map((entry) => entry.fact);
  assert.ok(!facts(parseAppApi(base, roles)).some((fact) => fact.includes('service')));
  assert.ok(facts(parse({ roles: ['device_bridge'], label: 'Device bridge' })).includes('api service role device_bridge'));
});

test('[api-service-unreachable]: a service role reads a table or runs an exposed command', () => {
  const api = parse({ roles: ['device_bridge'], label: 'Device bridge' })!;
  const withGrant = (grant: Record<string, unknown>) =>
    codes(apiServiceProblems(api, { rows: 'tenant', roles: { ...tenantRoles, device_bridge: { service: true, ...grant } as never } }));
  assert.deepEqual(withGrant({ read: false }), ['api-service-unreachable']);
  assert.deepEqual(withGrant({ read: [] }), ['api-service-unreachable']);
  // A command it may run but the API does not expose is not reachable by its token.
  assert.deepEqual(withGrant({ read: false, commands: ['record_reading'] }), ['api-service-unreachable']);
  assert.deepEqual(withGrant({ read: ['reading'] }), []);
  // A registered command is the catalog's question; here only its id is read.
  const exposing = { ...api, commands: [{ command: { id: 'record_reading' } }] } as unknown as typeof api;
  const reachable = apiServiceProblems(exposing, {
    rows: 'tenant',
    roles: { ...tenantRoles, device_bridge: { service: true, read: false, commands: ['record_reading'] } },
  });
  assert.deepEqual(reachable, []);
});

test("[api-service-role]: a role the token store's subject grammar cannot hold is refused before Settings offers it", () => {
  const api = parseAppApi({ ...base, service: { roles: ['DeviceBridge'], label: 'Device bridge' } }, ['staff', 'DeviceBridge'])!;
  const problems = apiServiceProblems(api, {
    rows: 'tenant',
    roles: { staff: { read: true }, DeviceBridge: { service: true, read: true } },
  });
  assert.deepEqual(codes(problems), ['api-service-role']);
  assert.match(problems[0]!, /cannot name a service token's subject/);
  assert.match(problems[0]!, /such as "devicebridge"/);
});
