import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { typecheck } from './support/tsc.js';
import { appAllowsWrite, parseAppConfig, resolveAppAccess } from '../packages/mistri/src/shared/app.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

const schema: DatabaseSchema = {
  label: 'Atlas',
  dialect: 'sqlite',
  readAt: '2026-09-06',
  foreignKeys: [],
  tables: ['incident', 'service', 'inventory.asset', 'secret'].map((id) => ({
    id,
    name: id.split('.').at(-1)!,
    schema: '',
    columns: [],
    isView: false,
  })),
};
// `inventory.asset` is a secondary source's resource: a dot always names a declared source.
const sources = { main: { connection: 'atlas', default: true }, inventory: { connection: 'atlas-inventory' } };
/** Every App names its home; these tests are about something else, so their Apps get this one list, named as the home. */
const incidents = { views: { incidents: { kind: 'list', from: 'incident' } }, home: 'incidents' };
type Ceilings = Record<string, 'read' | 'write'>;
const blocks = (ceilings: Ceilings) =>
  Object.fromEntries(Object.entries(ceilings).map(([name, access]) => [name, access === 'write' ? { access } : {}]));
const parse = (ceilings: Ceilings, roles: unknown, extra: object = {}) =>
  parseAppConfig({ name: 'Atlas', sources, resources: blocks(ceilings), auth: { roles }, ...incidents, ...extra }, 'app.ts');
const policy = () =>
  [
    { incident: 'write', service: 'read', 'inventory.asset': 'read' },
    { user: { read: true }, agent: { read: true, write: true }, none: {} },
  ] as const;

test('resource ceilings and role grants lower to explicit, default-deny access without mutating authorship', () => {
  const input = { name: 'Atlas', resources: { incident: {} }, auth: { roles: { user: { read: true }, none: {} } }, ...incidents };
  const before = structuredClone(input);
  const parsed = parseAppConfig(input, 'app.ts');
  assert.deepEqual(parsed.resources, { incident: {} });
  assert.deepEqual(parsed.auth?.roles, { user: { read: true, write: false }, none: { read: false, write: false } });
  assert.deepEqual(input, before);
  assert.deepEqual(resolveAppAccess(parse({ incident: 'read' }, { user: {} }), schema, ['user']), {
    readable: new Set(),
    writable: new Set(),
  });
});

test('role grants require sign-in; without it the declared resources are the whole App, and a root access block is refused', () => {
  // Without auth, the ceilings are the App's write scope and grant nothing per role.
  const trusted = parseAppConfig({ name: 'Atlas', sources, resources: blocks(policy()[0]), ...incidents }, 'app.ts');
  assert.equal(trusted.auth, undefined);
  assert.deepEqual(resolveAppAccess(trusted, schema, []).writable, new Set(['incident']));
  assert.throws(
    () => parseAppConfig({ name: 'Atlas', sources, resources: blocks(policy()[0]), auth: null, ...incidents }, 'app.ts'),
    /"auth" is not an object/,
  );
  assert.throws(() => parse(...policy(), { writable: true }), /has no "writable"\. It takes: /);
  assert.throws(() => parse(...policy(), { writable: false }), /has no "writable"\. It takes: /);
  assert.throws(() => parse(policy()[0], {}), /"auth" has "roles" that are not a non-empty object/);
  assert.throws(
    () => parseAppConfig({ name: 'Atlas', auth: {}, access: { read: ['incident'], roles: { user: { read: true } } } }, 'app.ts'),
    /has no "access"\. "access" belongs inside a resource block\. It takes: /,
  );
  assert.equal(
    parseAppConfig({ name: 'Sign-in only', auth: {}, resources: { incident: {} }, ...incidents }, 'app.ts').auth?.roles,
    undefined,
  );
  // An App that declares no ceiling reads what it declares, writes nothing, and reads no other table of the connection.
  assert.deepEqual(resolveAppAccess(parseAppConfig({ name: 'Trusted', resources: { incident: {} }, ...incidents }, 'app.ts'), schema, []), {
    readable: new Set(['incident']),
    writable: new Set(),
  });
});

test('ceiling and grant shapes, role keys, duplicates and unknown properties are rejected', () => {
  const base = { name: 'Atlas', resources: { incident: {} }, ...incidents };
  for (const app of [
    { ...base, resources: { incident: { access: null } }, auth: { roles: { user: {} } } },
    { ...base, resources: { incident: { access: true } }, auth: { roles: { user: {} } } },
    { ...base, resources: { incident: { access: 'all' } }, auth: { roles: { user: {} } } },
    { ...base, resources: {}, auth: { roles: { user: {} } } },
    { ...base, auth: { roles: {} } },
    { ...base, auth: { roles: [] } },
    { ...base, auth: { roles: { user: true } } },
    { ...base, resources: { ' ': {} }, auth: { roles: { user: {} } } },
    { ...base, resources: { ' incident ': {} }, auth: { roles: { user: {} } } },
    { ...base, auth: { roles: { user: { read: ['incident', ' incident '] } } } },
    { ...base, auth: { roles: { user: { read: null } } } },
    { ...base, auth: { roles: { user: { write: null } } } },
    { ...base, auth: { roles: { user: { delete: true } } } },
    { ...base, auth: { roles: { user: {} }, default: 'allow' } },
    { ...base, resources: { incident: { default: 'allow' } }, auth: { roles: { user: {} } } },
  ])
    assert.throws(() => parseAppConfig(app, 'app.ts'), Error, JSON.stringify(app));
  for (const role of ['constructor', '__proto__', 'prototype', 'toString', 'hasOwnProperty', '', ' user ', 'user,admin']) {
    assert.throws(() => parse({ incident: 'read' }, Object.fromEntries([[role, {}]])), /safe identifiers/);
  }
});

test('role grants cannot widen the ceiling or write resources they cannot read', () => {
  for (const [ceilings, roles] of [
    [{ incident: 'read' }, { user: { read: ['service'] } }],
    [{ incident: 'read' }, { user: { read: true, write: ['incident'] } }],
    [{ incident: 'write' }, { user: { write: true } }],
    [{ incident: 'write', service: 'read' }, { user: { read: ['service'], write: ['incident'] } }],
  ] as [Ceilings, unknown][]) {
    assert.throws(
      () => parse(ceilings, roles),
      /\[outside-ceiling\]: a role (reads|writes) only a resource whose own access allows it|which the role does not read/,
    );
  }
});

test('every role grant that is refused is said in one load, and several refusals of one role together', () => {
  assert.throws(
    () =>
      parse(
        { incident: 'write', service: 'read' },
        {
          // Creates what it does not write; narrows a resource it does not read; writes what it does not read.
          clerk: { read: ['incident'], write: ['incident'], create: ['service'], fields: { service: { read: ['id'] } } },
          other: { read: ['incident'], write: ['service'] },
        },
      ),
    (error: Error) => {
      const lines = error.message.split('\n');
      assert.equal(lines.length, 3, error.message);
      assert.match(lines[0]!, /role "clerk", "create" names "service", which the role does not write/);
      assert.match(lines[1]!, /role "clerk", "fields" names "service", which the role does not read/);
      assert.match(lines[2]!, /role "other", "write" names "service"/);
      return true;
    },
  );
});

test('verified role names grant only explicit resources; unknown identities and magic admin deny', () => {
  const app = parse(...policy());
  assert.deepEqual(resolveAppAccess(app, schema, ['user']), {
    readable: new Set(['incident', 'service', 'inventory.asset']),
    writable: new Set(),
  });
  assert.deepEqual(resolveAppAccess(app, schema, ['agent', 'unknown', 'agent']), {
    readable: new Set(['incident', 'service', 'inventory.asset']),
    writable: new Set(['incident']),
  });
  for (const roles of [[], ['none'], ['unknown'], ['admin'], ['constructor'], ['Agent'], ['user,agent']]) {
    assert.deepEqual(resolveAppAccess(app, schema, roles), { readable: new Set(), writable: new Set() });
  }
  assert.equal(appAllowsWrite(app, schema, 'incident', 'agent'), true);
  assert.equal(appAllowsWrite(app, schema, 'secret', 'agent'), false);
  assert.equal(appAllowsWrite(app, schema, undefined, 'agent'), false);
});

test('multiple known roles union their bounded grants without granting other resources', () => {
  const app = parse(
    { incident: 'write', 'inventory.asset': 'read' },
    {
      operations: { read: ['incident'], write: ['incident'] },
      inventory: { read: ['inventory.asset'] },
    },
  );
  assert.deepEqual(resolveAppAccess(app, schema, ['operations', 'inventory']), {
    readable: new Set(['incident', 'inventory.asset']),
    writable: new Set(['incident']),
  });
});

test('missing, ambiguous and noncanonical resources fail before role evaluation', () => {
  for (const resource of ['missing', 'asset']) {
    const app = parse({ incident: 'read', [resource]: 'read' }, { user: { read: ['incident'] }, inactive: { read: [resource] } });
    assert.throws(() => resolveAppAccess(app, schema, ['user']), new RegExp(`resources "${resource}" is not a table in this catalog`));
  }
  // An engine-schema id is never a resource name: the parser refuses it before anything resolves.
  assert.throws(
    () => parse({ incident: 'read', 'public.incident': 'read' }, { user: { read: ['incident'] } }),
    /a dot in a resource name always qualifies it by source/,
  );
  const app = parse(...policy());
  app.auth!.roles!.inactive = { read: ['secret'], write: false };
  assert.throws(() => resolveAppAccess(app, schema, []), /outside its access ceiling/);
});

test('a root or role writable is refused; role writes narrow within the write ceiling and unknown roles deny', () => {
  assert.throws(
    () => parseAppConfig({ name: 'Legacy', writable: ['incident'], auth: { roles: { agent: { writable: true } } } }, 'app.ts'),
    /has no "writable"\. It takes: /,
  );
  assert.throws(() => parse({ incident: 'write' }, { agent: { writable: true } }), /role "agent" has no "writable"/);
  const app = parse({ incident: 'write', service: 'read' }, { agent: { read: true, write: true }, reader: { read: true } });
  assert.equal(appAllowsWrite(app, schema, 'incident', 'agent'), true);
  assert.equal(appAllowsWrite(app, schema, 'service', 'agent'), false);
  assert.equal(appAllowsWrite(app, schema, 'incident', 'reader'), false);
  assert.equal(appAllowsWrite(app, schema, 'incident', 'unknown'), false);
  assert.equal(appAllowsWrite(app, schema, 'incident'), false);
  // A ceiling that writes nothing: even a role granted `write: true` writes nothing.
  assert.equal(appAllowsWrite(parse({ incident: 'read' }, { admin: { read: true, write: true } }), schema, 'incident', 'admin'), false);
  assert.equal(
    appAllowsWrite(
      parseAppConfig({ name: 'Trusted', resources: { incident: { access: 'write' } }, ...incidents }, 'app.ts'),
      schema,
      'incident',
    ),
    true,
  );
  assert.equal(
    appAllowsWrite(parseAppConfig({ name: 'Trusted', resources: { incident: {} }, ...incidents }, 'app.ts'), schema, 'incident'),
    false,
  );
});

test('JSON schema puts ceilings on the resource and default-deny grants under auth', () => {
  const json = JSON.parse(readFileSync(new URL('../packages/mistri/schema/app.schema.json', import.meta.url), 'utf8'));
  assert.equal(json.additionalProperties, false);
  assert.equal(json.properties.access, undefined, 'no root access: ceilings live with the resource');
  assert.equal(json.properties.writable, undefined);
  assert.deepEqual(json.$defs.resource.properties.access.enum, ['write']);
  assert.equal(json.$defs.resource.properties.fields.$ref, '#/$defs/fieldCeiling');
  assert.deepEqual(json.$defs.fieldCeiling.required, ['read']);
  assert.equal(json.$defs.auth.properties.roles.minProperties, 1);
  assert.equal(json.$defs.auth.properties.roles.additionalProperties.$ref, '#/$defs/roleGrant');
  assert.equal(json.$defs.roleGrant.properties.read.default, false);
  assert.equal(json.$defs.roleGrant.properties.write.default, false);
  assert.equal(json.$defs.roleGrant.additionalProperties, false);
});

test('TS DSL types both ceilings and role grants against logical resource names', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const filename = join(root, 'test', '.app-access-typecheck.ts');
  const source = [
    'import { listView, type AppRoleGrant, type TypedAppConfig } from "@mistriwork/mistri/app";',
    'type App = TypedAppConfig<{ incident: "id" | "name"; "inventory.asset": "id" | "tag" }>;',
    'const app = { name: "Atlas", sources: { main: { connection: "atlas", default: true }, inventory: { connection: "inventory" } },',
    '  resources: { incident: { access: "write", fields: { read: ["id", "name"], write: ["name"] } }, "inventory.asset": {} },',
    '  auth: { roles: { user: { read: true }, agent: { read: ["incident"], write: true } } },',
    '  views: { incidents: listView("Incidents", "incident") }, home: "incidents" } satisfies App;',
    'const empty: AppRoleGrant = {};',
    '// @ts-expect-error A bare secondary name is not a logical resource address.',
    'const badRead: App = { name: "x", views: { incidents: listView("Incidents", "incident") }, home: "incidents", resources: { incident: {} }, auth: { roles: { user: { read: ["asset"] } } } };',
    '// @ts-expect-error Role writes name known resources too.',
    'const badWrite: App = { name: "x", views: { incidents: listView("Incidents", "incident") }, home: "incidents", resources: { incident: { access: "write" } }, auth: { roles: { user: { read: true, write: ["missing"] } } } };',
    '// @ts-expect-error A ceiling is read or write.',
    'const badCeiling: App = { name: "x", views: { incidents: listView("Incidents", "incident") }, home: "incidents", resources: { incident: { access: "delete" } } };',
    "// @ts-expect-error Column ceilings name the resource's own columns.",
    'const badColumn: App = { name: "x", views: { incidents: { kind: "list", from: "incident" } }, home: "incidents", resources: { incident: { fields: { read: ["tag"] } } } };',
  ].join('\n');
  assert.equal(typecheck(filename, { files: { [filename]: source } }), '');
});
