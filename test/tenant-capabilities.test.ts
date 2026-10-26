import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAppConfig, resolveAppAccess } from '../packages/mistri/src/shared/app.js';
import { setFieldCeilings } from './support/appCeilings.js';
import type { DatabaseSchema, TableMeta } from '../packages/engine/src/shared/schema.js';
import { mapScopeCatalog } from '../packages/engine/src/shared/scopeCatalog.js';
import { projectTenantCapabilities, type TenantCapabilityOptions } from '../packages/mistri/src/server/tenant/tenantCapabilities.js';
import { TenantContextError } from '../packages/engine/src/server/evidence.js';
import { MAX_COMMAND_IDS } from '../packages/mistri/src/server/commands/commandLimits.js';
import { tenantDeleteEligible } from '../packages/mistri/src/server/tenant/tenantInverseImages.js';
import { captureTenantOwnership } from '../packages/mistri/src/server/tenant/tenantOwnership.js';

const columns = () => [
  { name: 'id', type: 'TEXT', nullable: false, primaryKey: true },
  { name: 'tenant_id', type: 'TEXT', nullable: false, primaryKey: false },
  { name: 'name', type: 'TEXT', nullable: false, primaryKey: false },
  { name: 'note', type: 'TEXT', nullable: true, primaryKey: false },
];
function fixture(): TenantCapabilityOptions {
  const resources = { item: 'db_item', other: 'db_other', country: 'db_country' };
  const physicalSchema: DatabaseSchema = {
    dialect: 'sqlite',
    label: 'PRIVATE_DATABASE',
    readAt: '',
    foreignKeys: [],
    tables: Object.values(resources).map((id) => ({ id, name: id, schema: 'main', isView: false, columns: columns() })),
  };
  const schema = mapScopeCatalog(physicalSchema, new Map(Object.entries(resources).map(([logical, physical]) => [physical, logical])));
  const ownership = captureTenantOwnership({
    appId: 'app',
    source: { id: 'business', connection: 'PRIVATE_CONNECTION' },
    schema,
    physicalSchema,
    resources,
    ownership: {
      item: { kind: 'tenant', column: 'tenant_id' },
      other: { kind: 'tenant', column: 'tenant_id' },
      country: { kind: 'global', access: 'read-only' },
    },
  });
  const app = parseAppConfig(
    {
      id: 'app',
      name: 'Capability fixture',
      sources: { business: { connection: ownership.source.connection } },
      // Deletion is opt-in per resource; each refusal below is still the tenancy rule's.
      // A global resource is read-only in the DSL itself; the capability rule
      // still refuses a global's writes on its own (resolveAppAccess is not asked).
      resources: Object.fromEntries(
        Object.entries(resources).map(([name, physical]) => [
          name,
          name === 'country' ? { physical, owner: 'global' } : { physical, access: 'write', delete: true, owner: 'tenant' },
        ]),
      ),
      auth: {
        rows: 'tenant',
        roles: {
          reader: { read: ['item', 'country'] },
          editor: { read: ['item', 'country'], write: ['item'] },
          operator: { read: ['other'], commands: ['advance', 'unregistered'] },
          admin: { read: true, write: true },
        },
      },
      views: { items: { kind: 'list', from: 'item' } },
      home: 'items',
    },
    'capability test',
  );
  return {
    app,
    ownership,
    principal: {
      appId: 'app',
      source: ownership.source,
      accountId: 'alice',
      tenantId: 'north',
      deployment: 'deployment',
      membershipId: 'north-alice',
      membershipVersion: '1',
      tenantVersion: '1',
      roles: ['editor'],
      verifiedAt: 100,
      validUntil: 1000,
    },
    services: { recordWrites: true, deletedRecordPolicy: true, commands: ['advance'] },
  };
}
const plain = <T>(value: T): T => structuredClone(value);
const project = (input = fixture()) => plain(projectTenantCapabilities(input));
function mutable() {
  return plain(fixture());
}
function allAccess(input: TenantCapabilityOptions) {
  return resolveAppAccess(input.app, input.ownership.schema, ['admin']);
}
function safe(error: unknown): boolean {
  assert.ok(error instanceof TenantContextError);
  assert.equal(error.message, 'The tenant context could not be verified.');
  assert.equal('cause' in error, false);
  assert.equal(JSON.stringify(error).includes('PRIVATE_'), false);
  return true;
}

test('current membership projects only readable logical resources and never global/managed writes', () => {
  assert.deepEqual(project(), {
    resources: {
      item: { write: ['id', 'name', 'note'], insertable: true, deletable: true },
      country: { write: [], insertable: false, deletable: false },
    },
    writable: ['item'],
    grantedCommands: [],
  });
});

test('same account in a different membership receives only that membership role capabilities', () => {
  const input = fixture();
  const south = { ...input, principal: { ...input.principal, tenantId: 'south', membershipId: 'south-alice', roles: ['reader'] } };
  assert.deepEqual(project(south), {
    resources: {
      item: { write: [], insertable: false, deletable: false },
      country: { write: [], insertable: false, deletable: false },
    },
    writable: [],
    grantedCommands: [],
  });
  assert.deepEqual(project(input).writable, ['item']);
});

test('command-only grants intersect deployed IDs and never imply generic CRUD', () => {
  const input = fixture();
  const result = project({ ...input, principal: { ...input.principal, roles: ['operator'] } });
  assert.deepEqual(result, {
    resources: { other: { write: [], insertable: false, deletable: false } },
    writable: [],
    grantedCommands: ['advance'],
  });
});

test('role unions combine explicit CRUD and command grants independently', () => {
  const input = fixture();
  const result = project({ ...input, principal: { ...input.principal, roles: ['operator', 'editor'] } });
  assert.deepEqual(result.writable, ['item']);
  assert.deepEqual(result.grantedCommands, ['advance']);
  assert.equal(result.resources.other.insertable, false);
});

test('absent record writer suppresses CRUD without suppressing separately deployed commands', () => {
  const input = fixture();
  const result = project({
    ...input,
    principal: { ...input.principal, roles: ['editor', 'operator'] },
    services: { ...input.services, recordWrites: false },
  });
  assert.deepEqual(result.writable, []);
  assert.deepEqual(result.grantedCommands, ['advance']);
  for (const resource of Object.values(result.resources)) assert.deepEqual(resource, { write: [], insertable: false, deletable: false });
});

test('no deleted-record policy suppresses Delete only; no command registry suppresses commands', () => {
  const input = fixture();
  const result = project({
    ...input,
    principal: { ...input.principal, roles: ['editor', 'operator'] },
    services: { ...input.services, deletedRecordPolicy: false, commands: [] },
  });
  assert.deepEqual(result.writable, ['item']);
  assert.deepEqual(result.grantedCommands, []);
  assert.equal(result.resources.item.insertable, true);
  assert.equal(result.resources.item.deletable, false);
});

for (const roles of [[], ['unknown']])
  test(`ungranted roles ${JSON.stringify(roles)} never inherit root ceilings`, () => {
    const input = fixture();
    assert.deepEqual(project({ ...input, principal: { ...input.principal, roles } }), { resources: {}, writable: [], grantedCommands: [] });
  });

test('root field ceiling hides only the managed owner without disabling full normal-field Delete', () => {
  const input = mutable();
  setFieldCeilings(input.app, { item: { read: ['id', 'name', 'note'], write: ['id', 'name', 'note'] } });
  assert.deepEqual(project(input).resources.item, { write: ['id', 'name', 'note'], insertable: true, deletable: true });
});

for (const kind of ['hidden-normal', 'readonly-normal', 'readonly-PK'])
  test(`${kind} keeps partial creation but refuses full inverse Delete`, () => {
    const input = mutable();
    setFieldCeilings(input.app, {
      item: {
        read: kind === 'hidden-normal' ? ['id', 'name'] : ['id', 'name', 'note'],
        write: kind === 'readonly-PK' ? ['name', 'note'] : ['id', 'name'],
      },
    });
    const result = project(input);
    assert.equal(result.resources.item.deletable, false);
    assert.equal(result.resources.item.insertable, true);
    assert.equal(result.resources.item.write.includes('tenant_id'), false);
  });

test('active role fields narrow root grants and inactive role fields cannot leak into them', () => {
  const input = mutable();
  setFieldCeilings(input.app, { item: { read: ['id', 'name', 'note'], write: ['id', 'name', 'note'] } });
  input.app.auth!.roles!.editor.fields = { item: { read: ['id', 'name'], write: ['name'] } };
  const result = project(input);
  assert.deepEqual(result.resources.item.write, ['name']);
  assert.equal(result.resources.item.deletable, false);
});

test('read-only field rule does not regain writes from a resource grant', () => {
  const input = mutable();
  setFieldCeilings(input.app, { item: { read: ['id', 'name', 'note'] } });
  const result = project(input);
  assert.deepEqual(result.writable, []);
  assert.deepEqual(result.resources.item, { write: [], insertable: false, deletable: false });
});

test('invalid inactive role field ceiling fails safely before projection', () => {
  const input = mutable();
  input.app.auth!.roles!.admin.fields = { item: { read: ['id', 'PRIVATE_UNKNOWN'], write: [] } };
  assert.throws(() => project(input), safe);
});

test('complete owner composite key remains readable and immutable; hidden owner PK refuses', () => {
  const input = mutable();
  for (const schema of [input.ownership.schema, input.ownership.physicalSchema]) schema.tables[0].columns[1].primaryKey = true;
  setFieldCeilings(input.app, { item: { read: ['tenant_id', 'id', 'name', 'note'], write: ['tenant_id', 'id', 'name', 'note'] } });
  const result = project(input);
  assert.equal(result.resources.item.insertable, true);
  assert.equal(result.resources.item.deletable, true);
  assert.equal(result.resources.item.write.includes('tenant_id'), false);
  input.app.resources!.item.fields = { read: ['id', 'name', 'note'], write: ['id', 'name', 'note'] };
  assert.throws(() => project(input), safe);
});

test('keyless resource gets no insert/delete presentation; owned views refuse before projection', () => {
  const input = mutable();
  for (const schema of [input.ownership.schema, input.ownership.physicalSchema]) schema.tables[0].columns[0].primaryKey = false;
  const result = project(input);
  assert.equal(result.resources.item.insertable, false);
  assert.equal(result.resources.item.deletable, false);
  for (const schema of [input.ownership.schema, input.ownership.physicalSchema]) schema.tables[0].isView = true;
  assert.throws(() => project(input), safe);
});

test('metadata result is detached deeply frozen data with no methods, private source or principal', () => {
  const input = mutable(),
    result = projectTenantCapabilities(input);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.resources));
  assert.ok(Object.isFrozen(result.resources.item));
  assert.ok(Object.isFrozen(result.resources.item.write));
  assert.ok(Object.isFrozen(result.writable));
  assert.ok(Object.isFrozen(result.grantedCommands));
  assert.equal(Reflect.set(result.resources.item, 'deletable', false), false);
  input.app.auth!.roles!.editor.write = false;
  input.ownership.schema.tables[0].columns[2].name = 'PRIVATE_CHANGED';
  assert.deepEqual([...result.resources.item.write], ['id', 'name', 'note']);
  assert.deepEqual(Object.keys(result).sort(), ['grantedCommands', 'resources', 'writable']);
  assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
  assert.equal(JSON.stringify(result).includes('north'), false);
});

for (const field of ['app', 'ownership', 'principal', 'services'] as const)
  test(`${field} getter/proxy input executes no hooks`, () => {
    let calls = 0;
    for (const mode of ['getter', 'proxy']) {
      const input = fixture();
      if (mode === 'getter')
        Object.defineProperty(input, field, {
          enumerable: true,
          get() {
            calls++;
            throw new Error('PRIVATE_GETTER');
          },
        });
      else
        Reflect.set(
          input,
          field,
          new Proxy(input[field], {
            get() {
              calls++;
              throw new Error('PRIVATE_PROXY');
            },
            ownKeys() {
              calls++;
              return [];
            },
          }),
        );
      assert.throws(() => project(input), safe);
    }
    assert.equal(calls, 0);
  });

for (const patch of [
  { appId: 'other' },
  { tenantId: 'North' },
  { tenantId: 'north ' },
  { accountId: '' },
  { source: { id: 'business', connection: 'other' } },
  { source: { id: 'alias', connection: 'PRIVATE_CONNECTION' } },
  { roles: ['editor', 'editor'] },
  { roles: 'editor' },
  { validUntil: 100 },
  { verifiedAt: -1 },
  { membershipVersion: '01' },
  { tenantVersion: 'PRIVATE_bad' },
  { extra: 'PRIVATE_secret' },
])
  test(`malformed principal ${JSON.stringify(patch)} refuses safely`, () => {
    const input = fixture();
    assert.throws(() => project({ ...input, principal: { ...input.principal, ...patch } as typeof input.principal }), safe);
  });

test('App/source/mapping changes refuse rather than interpreting matching role names elsewhere', () => {
  for (const change of ['app', 'source', 'mapping']) {
    const input = mutable();
    if (change === 'app') input.app.id = 'other';
    if (change === 'source') input.app.sources!.business.connection = 'other';
    if (change === 'mapping')
      input.app.resources = {
        item: { source: 'business', physical: 'db_other' },
        other: { source: 'business', physical: 'db_item' },
        country: { source: 'business', physical: 'db_country' },
      };
    assert.throws(() => project(input), safe);
  }
});

test('availability is strict bounded data, never callbacks or implicit truthy grants', () => {
  for (const patch of [
    { recordWrites: 'true' },
    { deletedRecordPolicy: () => assert.fail('policy invoked') },
    { commands: new Set(['advance']) },
    { commands: ['advance', 'advance'] },
    { commands: [''] },
    { commands: Array.from({ length: MAX_COMMAND_IDS + 1 }, (_, i) => `command${i}`) },
    { writer: true },
  ]) {
    const input = fixture();
    assert.throws(() => project({ ...input, services: { ...input.services, ...patch } as typeof input.services }), safe);
  }
  let calls = 0;
  const input = fixture();
  Object.defineProperty(input.services, 'commands', {
    enumerable: true,
    get() {
      calls++;
      return [];
    },
  });
  assert.throws(() => project(input), safe);
  assert.equal(calls, 0);
  // A large App registers more commands than it has roles: the 256 on roles is not the commands' bound.
  const large = fixture();
  assert.doesNotThrow(() =>
    project({ ...large, services: { ...large.services, commands: Array.from({ length: 300 }, (_, i) => `command${i}`) } }),
  );
});

for (const metadata of ['foreignKey', 'column'] as const)
  test(`mapped inbound ${metadata} dependency suppresses Delete`, () => {
    const input = mutable();
    for (const [schema, child, parent] of [
      [input.ownership.schema, 'other', 'item'],
      [input.ownership.physicalSchema, 'db_other', 'db_item'],
    ] as const) {
      if (metadata === 'foreignKey')
        schema.foreignKeys.push({ name: 'incoming', from: { table: child, columns: ['name'] }, to: { table: parent, columns: ['id'] } });
      else schema.tables[1].columns[2].references = { table: parent, column: 'id' };
    }
    assert.equal(project(input).resources.item.deletable, false);
  });

for (const metadata of ['foreignKey', 'column'] as const)
  test(`shared Delete predicate retains private/unmapped inbound ${metadata} dependencies`, () => {
    const input = mutable(),
      access = allAccess(input);
    const child: TableMeta = { id: '__mistri_private', name: '__mistri_private', schema: 'main', isView: false, columns: columns() };
    if (metadata === 'foreignKey')
      input.ownership.physicalSchema.foreignKeys.push({
        name: 'private-incoming',
        from: { table: child.id, columns: ['name'] },
        to: { table: 'db_item', columns: ['id'] },
      });
    else child.columns[2].references = { table: 'db_item', column: 'id' };
    input.ownership.physicalSchema.tables.push(child);
    // This pure gate also serves already captured writer contexts. Ownership
    // admission may independently refuse a cross-boundary catalog first.
    assert.equal(tenantDeleteEligible(input.ownership, access, 'item', true), undefined);
    assert.throws(() => project(input), safe);
  });

for (const metadata of ['foreignKey', 'column'] as const)
  test(`outbound ${metadata} target must remain resource/field-readable`, () => {
    const input = mutable();
    for (const [schema, child, parent] of [
      [input.ownership.schema, 'item', 'country'],
      [input.ownership.physicalSchema, 'db_item', 'db_country'],
    ] as const) {
      if (metadata === 'foreignKey')
        schema.foreignKeys.push({ name: 'parent', from: { table: child, columns: ['name'] }, to: { table: parent, columns: ['note'] } });
      else schema.tables[0].columns[2].references = { table: parent, column: 'note' };
    }
    assert.equal(project(input).resources.item.deletable, true);
    // The global target's column ceiling hides `note`; a read-only global has no write list.
    setFieldCeilings(input.app, { country: { read: ['id', 'name'] } });
    assert.equal(project(input).resources.item.deletable, false);
    setFieldCeilings(input.app, undefined);
    input.app.auth!.roles!.editor = { read: ['item'], write: ['item'] };
    assert.equal(project(input).resources.item.deletable, false);
  });

/* A tag's link row carries its tenant's key, `tenant_id` → the tenancy's profile, which no member reads: that one
   parent is the row's own tenant and does not keep the row from being taken off (G58). Any other unread parent does. */
test("the tenant's own profile is no unread parent: a row whose tenant column references it is deletable", () => {
  const input = mutable(),
    access = resolveAppAccess(input.app, input.ownership.schema, ['editor']);
  const owned = input.ownership as unknown as {
    physicalSchema: DatabaseSchema;
    resources: Record<string, string>;
    ownership: Record<string, unknown>;
    profile?: string;
  };
  owned.physicalSchema.tables.push({ id: 'db_customer', name: 'db_customer', schema: 'main', isView: false, columns: columns() });
  owned.resources.customer = 'db_customer';
  owned.ownership.customer = { kind: 'platform' };
  owned.physicalSchema.foreignKeys.push({
    name: 'tenant',
    from: { table: 'db_item', columns: ['tenant_id'] },
    to: { table: 'db_customer', columns: ['id'] },
  });
  assert.equal(tenantDeleteEligible(input.ownership, access, 'item', true), undefined);
  owned.profile = 'customer';
  assert.equal(tenantDeleteEligible(input.ownership, access, 'item', true)?.id, 'item');
  // Only through the ownership column: another column naming the profile is a parent like any other.
  owned.physicalSchema.foreignKeys.push({
    name: 'other',
    from: { table: 'db_item', columns: ['name'] },
    to: { table: 'db_customer', columns: ['id'] },
  });
  assert.equal(tenantDeleteEligible(input.ownership, access, 'item', true), undefined);
});

test('structural predicate refuses unknown/private/global/view targets and missing policy', () => {
  const input = mutable(),
    access = allAccess(input);
  for (const id of ['unknown', '__proto__', '__mistri_private', 'country', null]) {
    assert.equal(tenantDeleteEligible(input.ownership, access, id, true), undefined);
  }
  assert.equal(tenantDeleteEligible(input.ownership, access, 'item', false), undefined);
  assert.equal(tenantDeleteEligible(input.ownership, access, 'item', true)?.id, 'item');
  input.ownership.schema.tables[0].isView = true;
  assert.equal(tenantDeleteEligible(input.ownership, access, 'item', true), undefined);
});
