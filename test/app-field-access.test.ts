import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { typecheck } from './support/tsc.js';
import { parseAppConfig, resolveAppAccess } from '../packages/mistri/src/shared/app.js';
import { authorityReport } from '../packages/mistri/src/shared/appAuthority.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

const schema: DatabaseSchema = {
  label: 'Fields',
  dialect: 'sqlite',
  readAt: '',
  foreignKeys: [],
  tables: ['lead', 'inventory.vehicle'].map((id) => ({
    id,
    name: id.split('.').at(-1)!,
    schema: '',
    isView: false,
    columns: ['id', 'name', 'private_note'].map((name) => ({
      name,
      type: name === 'id' ? 'INTEGER' : 'TEXT',
      primaryKey: name === 'id',
      nullable: false,
    })),
  })),
};
/** Every App names its home; these tests are about something else, so their Apps get this one list, named as the home. */
const leads = { views: { leads: { kind: 'list', from: 'lead' } }, home: 'leads' };
/* The column ceilings, keyed by resource, go on each resource block; a key
   outside the two ceilings becomes a block of its own, for the catalog to judge. */
const parse = (fields: Record<string, unknown> = {}, roles: object = { user: { read: true, write: true } }) => {
  const resources: Record<string, Record<string, unknown>> = { lead: { access: 'write' }, 'inventory.vehicle': {} };
  for (const [name, ceiling] of Object.entries(fields)) resources[name] = { ...(resources[name] ?? {}), fields: ceiling };
  return parseAppConfig(
    {
      name: 'Fields',
      sources: { main: { connection: 'main', default: true }, inventory: { connection: 'inventory' } },
      resources,
      auth: { roles },
      ...leads,
    },
    'field fixture',
  );
};
const parseLead = (ceiling: unknown) =>
  parseAppConfig(
    {
      name: 'Fields',
      resources: { lead: { access: 'write', fields: ceiling } },
      auth: { roles: { user: { read: true } } },
      ...leads,
    },
    'field fixture',
  );

test('field ceilings copy and normalize lists while preserving unrestricted resources', () => {
  const raw = { lead: { read: ['id', 'name'], write: ['name'] } };
  const app = parse(raw);
  raw.lead.read.push('private_note');
  const access = resolveAppAccess(app, schema, ['user']);
  assert.deepEqual(access.fields?.get('lead'), { read: new Set(['id', 'name']), write: new Set(['name']) });
  assert.deepEqual(access.fields?.get('inventory.vehicle'), { read: new Set(['id', 'name', 'private_note']), write: new Set() });
  assert.deepEqual(resolveAppAccess(app, schema, ['unknown']).fields, new Map());
});

test('a role may narrow only write: its read is the resource ceiling', () => {
  const app = parse(
    { lead: { read: ['id', 'name', 'private_note'], write: ['name', 'private_note'] } },
    {
      editor: { read: ['lead'], write: ['lead'], fields: { lead: { write: ['name'] } } },
    },
  );
  assert.deepEqual(resolveAppAccess(app, schema, ['editor']).fields?.get('lead'), {
    read: new Set(['id', 'name', 'private_note']),
    write: new Set(['name']),
  });
  const report = authorityReport(app);
  assert.match(report, /role editor fields lead write name/);
  assert.doesNotMatch(report, /role editor fields lead read/);
  assert.throws(() => parse({}, { editor: { read: true, write: true, fields: { lead: {} } } }), /names read, write or both/);
  assert.throws(
    () =>
      resolveAppAccess(
        parse(
          { lead: { read: ['id', 'name'], write: ['name'] } },
          { editor: { read: true, write: true, fields: { lead: { write: ['private_note'] } } } },
        ),
        schema,
        ['editor'],
      ),
    /outside the write ceiling/,
  );
});

test('role field grants narrow and union without exceeding the app ceiling', () => {
  const app = parse(
    { lead: { read: ['id', 'name', 'private_note'], write: ['name', 'private_note'] } },
    {
      basic: { read: ['lead'], write: true, fields: { lead: { read: ['id', 'name'], write: ['name'] } } },
      private: { read: ['lead'], write: true, fields: { lead: { read: ['id', 'private_note'], write: ['private_note'] } } },
      inherited: { read: true, write: true },
    },
  );
  assert.deepEqual(resolveAppAccess(app, schema, ['basic']).fields?.get('lead'), {
    read: new Set(['id', 'name']),
    write: new Set(['name']),
  });
  assert.deepEqual(resolveAppAccess(app, schema, ['basic', 'private']).fields?.get('lead'), {
    read: new Set(['id', 'name', 'private_note']),
    write: new Set(['name', 'private_note']),
  });
  assert.deepEqual(resolveAppAccess(app, schema, ['inherited']).fields?.get('lead'), {
    read: new Set(['id', 'name', 'private_note']),
    write: new Set(['name', 'private_note']),
  });
});

test('role-only field rules use the resource ceiling and explicit field writes default to none', () => {
  const app = parse(undefined, { user: { read: true, write: true, fields: { lead: { read: ['id', 'name'] } } } });
  assert.deepEqual(resolveAppAccess(app, schema, ['user']).fields?.get('lead'), { read: new Set(['id', 'name']), write: new Set() });
});

test('field policy rejects malformed grants and sparse, duplicate or executable column lists', () => {
  const sparse: string[] = [];
  sparse.length = 1;
  for (const ceiling of [
    null,
    [],
    true,
    {},
    { read: true },
    { read: ['id', 'id'] },
    { read: [' '] },
    { read: ['id'], write: ['name'] },
    { read: ['id'], update: true },
  ])
    assert.throws(
      () => parseLead(ceiling),
      (error) => error instanceof Error && error.message !== 'getter executed',
    );
  assert.throws(() => parse({ ' lead ': { read: ['id'] } }), /needs a logical name/);
  // Sparse, inherited and executable grants, where a role narrows the ceiling.
  for (const fields of [
    { lead: { read: sparse } },
    { lead: Object.create({ read: ['id'] }) },
    {
      lead: {
        get read() {
          throw new Error('getter executed');
        },
      },
    },
    Object.create({ lead: { read: ['id'] } }),
    {
      get lead() {
        throw new Error('getter executed');
      },
    },
  ])
    assert.throws(
      () => parse(undefined, { user: { read: true, fields } }),
      (error) => error instanceof Error && error.message !== 'getter executed',
    );
});

test('all inactive field rules are catalog checked, including source identity and complete keys', () => {
  for (const fields of [
    { missing: { read: ['id'] } },
    { vehicle: { read: ['id'] } },
    { lead: { read: ['id', 'missing'] } },
    { lead: { read: ['name'] } },
    { 'inventory.vehicle': { read: ['id', 'name'], write: ['name'] } },
  ])
    assert.throws(() => resolveAppAccess(parse(fields), schema, []));
  assert.throws(
    () =>
      resolveAppAccess(
        parse(
          { lead: { read: ['id', 'name'] } },
          {
            user: { read: true },
            inactive: { read: true, fields: { lead: { read: ['id', 'private_note'] } } },
          },
        ),
        schema,
        ['user'],
      ),
    /read ceiling/,
  );
  assert.throws(
    () =>
      resolveAppAccess(
        parse(undefined, {
          user: { read: true },
          inactive: { read: ['inventory.vehicle'], fields: { lead: { read: ['id'] } } },
        }),
        schema,
        ['user'],
      ),
    /which the role does not read/,
  );
});

test('field JSON schema mirrors ceiling and role declarations', () => {
  const json = JSON.parse(readFileSync(new URL('../packages/mistri/schema/app.schema.json', import.meta.url), 'utf8'));
  assert.equal(json.$defs.resource.properties.fields.$ref, '#/$defs/fieldCeiling');
  // A role's grant may omit read (the resource's ceiling) to narrow only write; a ceiling may not.
  assert.equal(json.$defs.roleGrant.properties.fields.additionalProperties.$ref, '#/$defs/roleFieldGrant');
  assert.equal(json.$defs.roleFieldGrant.required, undefined);
  assert.equal(json.$defs.roleFieldGrant.additionalProperties, false);
  assert.deepEqual(json.$defs.fieldCeiling.required, ['read']);
  assert.equal(json.$defs.fieldCeiling.additionalProperties, false);
});

test('typed field rules correlate each logical resource with its local columns', () => {
  const file = new URL('.field-access-types.ts', import.meta.url).pathname;
  const source = `import { listView } from '@mistriwork/mistri/app';
import type { TypedAppConfig } from '@mistriwork/mistri/app';
type App = TypedAppConfig<{ lead: 'id'|'name'; 'inventory.vehicle': 'id'|'stock' }>;
const valid: App = { name: 'Fields', resources: { lead: { fields: {read:['id','name']} }, 'inventory.vehicle': {} },
  auth: { roles:{ user:{read:true,fields:{'inventory.vehicle':{read:['id','stock']}}}} },
  views: { leads: listView('Lead', 'lead') }, home: 'leads' };
// @ts-expect-error Column belongs to a different resource.
const wrong: App['resources'] = { lead: { fields: {read:['stock']} } };
// @ts-expect-error Writes also use resource-local columns.
const written: App['resources'] = { lead: { access: 'write', fields: {read:['id'],write:['stock']} } };
// @ts-expect-error Secondary resources require their logical qualifier.
const resource: App['auth'] = { roles:{ user:{read:true,fields:{vehicle:{read:['id']}}} } };`;
  assert.equal(typecheck(file, { files: { [file]: source } }), '');
});
