import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  defineAppTenantPolicy,
  loadAppTenantPolicy,
  AppTenantPolicyDefinitionError,
  type AppTenantPolicy,
} from '../packages/mistri/src/server/policy/appTenantPolicy.js';
import { AppRowPolicyDefinitionError, loadAppRowPolicy } from '../packages/mistri/src/server/policy/appRowPolicy.js';
import { defineAppTenantPolicy as exported } from '../packages/mistri/src/server/policy.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { refusalReasons } from '../packages/engine/src/shared/refusal.js';
import { MAX_COMMAND_IDS } from '../packages/mistri/src/server/commands/commandLimits.js';

const definition = (): AppTenantPolicy => ({
  kind: 'tenant',
  appId: 'app',
  storeId: 'private-store',
  ownership: { item: { kind: 'tenant', column: 'tenant_id' }, country: { kind: 'global', access: 'read-only' } },
  resolveMembershipRows: () => ({ item: true, country: true }),
  resolveRows: () => ({ item: false, country: true }),
});
const DAY = 24 * 60 * 60 * 1000;
const invitations = {
  id: 'invites',
  version: 'v1',
  maxMembershipLifetimeMs: DAY,
  maxRedemptionLifetimeMs: DAY,
  maxPendingPerTenant: 10,
  operators: [{ accountId: 'operator', tenants: ['north'], operations: ['issueInvitation'], roles: ['reader'] }],
};
const manifest = () => ({
  id: 'app',
  name: 'Tenant app',
  auth: { rows: 'tenant', roles: { reader: { read: true } } },
  sources: { business: { connection: 'db' } },
  resources: { item: { owner: 'tenant' } },
  views: { items: { kind: 'list', from: 'item' } },
  home: 'items',
});
function safe(error: unknown): boolean {
  assert.ok(error instanceof AppTenantPolicyDefinitionError);
  assert.equal(error.message, 'The App tenant policy definition could not be loaded or is invalid.');
  assert.equal('cause' in error, false);
  return true;
}

test('typed tenant marker is preserved and resolves the one named default source', () => {
  const app = parseAppConfig(manifest(), 'fixture');
  assert.equal(app.auth?.rows, 'tenant');
  assert.equal(app.sources?.business.default, true);
});
// Absent `rows` is "all" (the ordinary App, below); anything but the three words is refused.
for (const rows of [false, null, true, 'true', 1, {}, ['tenant', 'policy']])
  test(`tenant marker refuses ${JSON.stringify(rows)}`, () => {
    const input = manifest();
    assert.throws(() => parseAppConfig({ ...input, auth: { ...input.auth, rows } }, 'fixture'), /has a "rows" of/);
  });
for (const patch of [
  { auth: { rows: 'tenant' } },
  { sources: undefined },
  { sources: {} },
  { sources: { business: { connection: 'db', default: true }, other: { connection: 'other' } } },
  { resources: { item: {} } },
  { writable: true },
])
  test(`tenant prerequisites refuse ${JSON.stringify(patch)}`, () => {
    assert.throws(() => parseAppConfig({ ...manifest(), ...patch }, 'fixture'));
  });
test('tenant is auth row enrollment only, not a role grant or provider declaration', () => {
  assert.throws(() => parseAppConfig({ ...manifest(), tenant: true }, 'fixture'));
  assert.throws(() =>
    parseAppConfig({ ...manifest(), auth: { ...manifest().auth, roles: { reader: { read: true, tenant: true } } } }, 'fixture'),
  );
  assert.throws(() => parseAppConfig({ ...manifest(), auth: { ...manifest().auth, storeId: 'private' } }, 'fixture'));
  // An ordinary App's resources say no owner: ownership is a tenant App's word.
  const ordinary = manifest();
  const { rows: _rows, ...auth } = ordinary.auth;
  assert.equal(parseAppConfig({ ...ordinary, auth, resources: { item: {} } }, 'fixture').auth?.rows, 'all');
});
test("JSON schema keeps tenant one optional row scope; single-source enrollment is the parser's", () => {
  const schema = JSON.parse(readFileSync(new URL('../packages/mistri/schema/app.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(schema.$defs.auth.properties.rows.enum, ['all', 'policy', 'tenant']);
  assert.equal((schema.$defs.auth.required ?? []).includes('rows'), false);
});

test('server export captures immutable ownership/functions without running policy code', () => {
  assert.equal(exported, defineAppTenantPolicy);
  let calls = 0;
  const input = {
    ...definition(),
    resolveRows: () => {
      calls++;
      return { item: true };
    },
    resultReferences: {
      assign: () => {
        calls++;
        return [];
      },
    },
  };
  const policy = defineAppTenantPolicy(input);
  (input.ownership as Record<string, { kind: 'tenant'; column: string }>).item = { kind: 'tenant', column: 'changed' };
  input.resultReferences.assign = () => {
    calls++;
    return [];
  };
  assert.equal(policy.ownership.item.kind === 'tenant' && policy.ownership.item.column, 'tenant_id');
  assert.equal(policy.resolveRows, input.resolveRows);
  assert.ok(Object.isFrozen(policy) && Object.isFrozen(policy.ownership) && Object.isFrozen(policy.resultReferences));
  assert.equal(calls, 0);
});

for (const patch of [
  { kind: 'ordinary' },
  { appId: '' },
  { storeId: ' private' },
  { ownership: {} },
  { ownership: { item: { kind: 'global', access: 'read-only' } } },
  { ownership: { item: { kind: 'tenant', column: '' } } },
  { ownership: { item: { kind: 'tenant', column: 'tenant_id', writable: true } } },
  { ownership: { __mistri_secret: { kind: 'tenant', column: 'tenant_id' } } },
  { ownership: { 'business.item': { kind: 'tenant', column: 'tenant_id' } } },
  { ownership: { item: { kind: 'tenant', column: 'tenant_id' }, country: { kind: 'global', access: 'write' } } },
  { verifySession: () => ({ id: 'forged' }) },
  { readMembership: () => [] },
  { resolveRows: null },
  { resolveMembershipRows: undefined },
  { authorizeDeletedRecord: undefined },
  { resultReferences: { assign: null } },
  { resultReferences: { constructor: () => [] } },
  { resultReferences: { 'bad.id': () => [] } },
])
  test(`invalid private tenant policy ${JSON.stringify(patch)}`, () => {
    assert.throws(() => defineAppTenantPolicy({ ...definition(), ...patch } as unknown as AppTenantPolicy), safe);
  });

test('resultReferences takes one id per command an App registers, and refuses one more with the same refusal', () => {
  const commands = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`command${index}`, () => []]));
  const policy = defineAppTenantPolicy({ ...definition(), resultReferences: commands(MAX_COMMAND_IDS) });
  assert.equal(Object.keys(policy.resultReferences!).length, MAX_COMMAND_IDS);
  assert.ok(MAX_COMMAND_IDS >= 1024);
  assert.throws(() => defineAppTenantPolicy({ ...definition(), resultReferences: commands(MAX_COMMAND_IDS + 1) }), safe);
});

test('proxy/accessor declarations and callbacks are never executed', () => {
  let hooks = 0;
  const trap = () => {
    hooks++;
    throw new Error('SECRET');
  };
  const base = definition();
  for (const value of [
    new Proxy(base, { get: trap, ownKeys: trap, getPrototypeOf: trap }),
    Object.defineProperty({ ...base }, 'storeId', { get: trap }),
    { ...base, ownership: new Proxy(base.ownership, { ownKeys: trap }) },
    { ...base, resolveRows: new Proxy(base.resolveRows, { apply: trap }) },
    { ...base, resultReferences: new Proxy({}, { ownKeys: trap }) },
    { ...base, resultReferences: { assign: new Proxy(() => [], { apply: trap }) } },
    { ...base, resultReferences: Object.defineProperty({}, 'assign', { enumerable: true, get: trap }) },
  ]) {
    assert.throws(() => defineAppTenantPolicy(value), safe);
  }
  assert.equal(hooks, 0);
});

test('one loader seam preserves ordinary/tenant kind separation and safe import errors', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tablewalk-tenant-policy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tenant = join(dir, 'tenant.mjs'),
    ordinary = join(dir, 'ordinary.mjs'),
    bad = join(dir, 'bad.mjs');
  writeFileSync(
    tenant,
    `export default {kind:'tenant',appId:'app',storeId:'store',ownership:{item:{kind:'tenant',column:'tenant_id'}},resolveMembershipRows(){return {item:true}},resolveRows(){return {item:true}}}`,
  );
  writeFileSync(ordinary, `export default {appId:'app',resolveRows(){return {item:true}}}`);
  writeFileSync(bad, `throw new Error('PRIVATE_IMPORT_SECRET')`);
  assert.equal((await loadAppTenantPolicy(tenant)).kind, 'tenant');
  assert.equal((await loadAppRowPolicy(ordinary)).appId, 'app');
  await assert.rejects(loadAppRowPolicy(tenant), AppRowPolicyDefinitionError);
  await assert.rejects(loadAppTenantPolicy(ordinary), safe);
  await assert.rejects(loadAppTenantPolicy(bad), safe);
  await assert.rejects(loadAppTenantPolicy(join(dir, 'missing.mjs')), safe);
  await assert.rejects(loadAppTenantPolicy(join(dir, 'bad.json')), safe);
});

test("a refused tenant policy records why, for the operator's console only", async (t) => {
  /* "could not be loaded or is invalid" was all a tenant App's author heard
     (Keystone leads): the sentence stays, and each refusal records its reason. */
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ ownerships: {} }, /names "ownerships", which is not one of kind, appId/],
    [{ kind: 'tenants' }, /has kind: 'tenant'/],
    [
      { ownership: { item: { kind: 'global', access: 'write' } } },
      /ownership\["item"\] is global, and a global table is access: 'read-only'/,
    ],
    [{ ownership: { item: { kind: 'tenant', column: 'tenant_id', label: 'x' } } }, /ownership\["item"\] is not a valid declaration/],
    [{ ownership: { country: { kind: 'global', access: 'read-only' } } }, /no table of kind 'tenant'/],
    [{ resolveRows: 'nope' }, /resolveRows must be a function/],
    [{ ownership: { item: { kind: 'tenant', column: 'tenant_id' }, owner: { kind: 'platform' } } }, /needs resolvePlatformRows/],
    // Each policy section names its key and its limit (a field report found the seven-day cap by reading dist).
    [
      { invitations: { ...invitations, maxRedemptionLifetimeMs: 10 * DAY } },
      /invitations\.maxRedemptionLifetimeMs is 864000000; it is a whole number from 1 to 7 days \(604800000 ms\)/,
    ],
    [{ invitations: { ...invitations, maxPendingPerTenant: 0 } }, /invitations\.maxPendingPerTenant is 0; .* from 1 to 10000/],
    [{ invitations: { id: 'i', version: 'v1' } }, /invitations\.maxMembershipLifetimeMs is missing: it takes id, version/],
    [{ invitations: { ...invitations, operators: [] } }, /invitations\.operators is empty and there are no delegates/],
    [
      { administration: { id: 'a', version: 'v1', maxMembershipLifetimeMs: 400 * DAY, operators: invitations.operators } },
      /administration\.maxMembershipLifetimeMs is 34560000000; .* to 31622400000 ms/,
    ],
    [{ support: { id: 's', version: 'v1', grants: [] } }, /support\.grants is a list of 1 to 256/],
  ];
  for (const [patch, reason] of cases) {
    const error = (() => {
      try {
        defineAppTenantPolicy({ ...definition(), ...patch } as unknown as AppTenantPolicy);
      } catch (e) {
        return e;
      }
    })();
    assert.ok(safe(error));
    assert.match(refusalReasons(error).join(' | '), reason, JSON.stringify(patch));
  }
  const dir = mkdtempSync(join(tmpdir(), 'tablewalk-tenant-reason-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bad = join(dir, 'bad.mjs'),
    ordinary = join(dir, 'ordinary.mjs');
  writeFileSync(bad, `throw new Error('module-own-diagnostic')`);
  writeFileSync(ordinary, `export default {appId:'app',resolveRows(){return {item:true}}}`);
  const reasons = async (file: string) =>
    refusalReasons(
      await loadAppTenantPolicy(file).then(
        () => null,
        (e) => e,
      ),
    );
  const thrown = await reasons(bad);
  assert.match(thrown.join(' | '), /"bad\.mjs" did not load: module-own-diagnostic/);
  // The shared module loader's row-policy sentence is not a tenant App's reason.
  assert.doesNotMatch(thrown.join(' | '), /row policy/);
  assert.match((await reasons(ordinary)).join(' | '), /names "appId"|has kind: 'tenant'/);
  // A module that calls defineAppTenantPolicy refuses while it loads: the reason stays beneath, said once.
  const defined = join(dir, 'defined.mjs');
  writeFileSync(
    defined,
    `import { defineAppTenantPolicy } from ${JSON.stringify(new URL('../packages/mistri/src/server/policy/appTenantPolicy.ts', import.meta.url).href)};
export default defineAppTenantPolicy({ kind: 'tenant', appId: 'app', storeId: 'store', ownership: { item: { kind: 'tenant', column: 'tenant_id' } },
  resolveMembershipRows: () => ({}), resolveRows: () => ({}), invitations: ${JSON.stringify({ ...invitations, maxRedemptionLifetimeMs: 8 * DAY })} });`,
  );
  const said = await reasons(defined);
  assert.match(said.join(' | '), /invitations\.maxRedemptionLifetimeMs is 691200000; .* 7 days/);
  assert.equal(said.filter((reason) => reason.endsWith('could not be loaded or is invalid.')).length, 0, said.join(' | '));
});

test('module default thenable/getter is refused before promise assimilation', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tablewalk-tenant-module-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'hostile.mjs');
  writeFileSync(path, `export let calls=0; export default {get then(){calls++;throw new Error('SECRET')}}`);
  await assert.rejects(loadAppTenantPolicy(path), safe);
  await assert.rejects(loadAppRowPolicy(path), AppRowPolicyDefinitionError);
  assert.equal((await import(path)).calls, 0);
});
