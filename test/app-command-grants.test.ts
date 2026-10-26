import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { typecheck } from './support/tsc.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { appCommandGrants, parseAppConfig, resolveAppAccess } from '../packages/mistri/src/shared/app.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

/** Every App names its home; these tests are about something else, so their Apps get this one list, named as the home. */
const loans = { views: { loans: { kind: 'list', from: 'loan' } }, home: 'loans' };
// Roles need a ceiling to grant within; the grants here name none of it, so
// the one read-only resource keeps generic CRUD out of every assertion.
const app = (roles: Record<string, unknown>) =>
  parseAppConfig(
    {
      name: 'Command workspace',
      resources: { loan: {} },
      auth: { roles },
      ...loans,
    },
    'commands.ts',
  );

test('command grants normalize explicit IDs without mutating authorship or inventing omitted grants', () => {
  const input = { reader: {}, approver: { commands: ['approve-loan', 'Review_2'] }, empty: { commands: [] } };
  const parsed = app(input);
  assert.deepEqual(parsed.auth?.roles, {
    reader: { read: false, write: false },
    approver: { read: false, write: false, commands: ['approve-loan', 'Review_2'] },
    empty: { read: false, write: false, commands: [] },
  });
  input.approver.commands.push('later-change');
  assert.deepEqual(parsed.auth?.roles?.approver.commands, ['approve-loan', 'Review_2']);
  assert.deepEqual(input.reader, {});
});

test('command grant parser rejects wildcard, duplicate, malformed and reserved command IDs', () => {
  for (const commands of [
    true,
    false,
    null,
    {},
    'approve',
    ['*'],
    ['approve', 'approve'],
    [1],
    Array(1),
    [''],
    [' approve'],
    ['approve '],
    ['approve.loan'],
    ['approve/loan'],
    ['approve:loan'],
    ['1approve'],
    ['constructor'],
    ['prototype'],
    ['__proto__'],
    ['toString'],
    ['hasOwnProperty'],
  ]) {
    assert.throws(() => app({ approver: { commands } }), /commands/);
  }
});

test('verified role unions default deny and cannot increase generic CRUD grants', () => {
  const parsed = app({
    reader: {},
    approver: { commands: ['approve-loan'] },
    reviewer: { commands: ['review-loan', 'approve-loan'] },
  });
  for (const roles of [[], ['unknown'], ['constructor'], ['toString'], ['reader']]) {
    assert.deepEqual(appCommandGrants(parsed, roles), new Set());
  }
  assert.deepEqual(appCommandGrants(parsed, ['approver', 'unknown', 'reviewer', 'approver']), new Set(['approve-loan', 'review-loan']));
  const schema = {
    tables: [{ id: 'loan', name: 'loan', columns: [{ name: 'id', primaryKey: true }] }],
    foreignKeys: [],
  } as unknown as DatabaseSchema;
  assert.deepEqual(resolveAppAccess(parsed, schema, ['approver', 'reviewer']), { readable: new Set(), writable: new Set() });
  assert.deepEqual(
    appCommandGrants(parseAppConfig({ name: 'Trusted app', resources: { loan: {} }, ...loans }, 'app.ts'), ['admin']),
    new Set(),
  );
  assert.deepEqual(
    appCommandGrants(parseAppConfig({ name: 'Sign-in only', auth: {}, resources: { loan: {} }, ...loans }, 'app.ts'), ['admin']),
    new Set(),
  );
});

test('command resolution revalidates inactive grants and rejects invalid policy ownership', () => {
  const parsed = app({ agent: { commands: ['approve-loan'] }, inactive: {} });
  parsed.auth!.roles!.inactive.commands = ['*'];
  assert.throws(() => appCommandGrants(parsed, []), /commands/);
  // Without sign-in no role holds anything: the grants go with `auth`.
  assert.deepEqual(appCommandGrants({ ...app({ agent: { commands: ['approve-loan'] } }), auth: undefined }, ['agent']), new Set());
});

test('manifest command ID validation matches the server-only command registry', () => {
  const definition = defineCommand({
    targets: 'none',
    source: 'operations',
    target: 'loan',
    read: ['loan'],
    write: ['loan'],
    input: {},
    output: { parse: (value: unknown) => value },
    handle: (_context, input): unknown => input,
  });
  for (const id of [
    'approve-loan',
    'Approve_2',
    'a',
    '*',
    'approve.loan',
    ' approve',
    '1approve',
    'constructor',
    'prototype',
    'toString',
    '__proto__',
  ]) {
    let registryAccepts = false;
    try {
      defineCommands({ [id]: definition });
      registryAccepts = true;
    } catch {
      /* Invalid IDs must agree across layers. */
    }
    if (registryAccepts) assert.deepEqual(appCommandGrants(app({ agent: { commands: [id] } }), ['agent']), new Set([id]));
    else assert.throws(() => app({ agent: { commands: [id] } }), /commands/);
  }
});

test('JSON schema exposes explicit unique command grants, with no boolean or wildcard shorthand', () => {
  const json = JSON.parse(readFileSync(new URL('../packages/mistri/schema/app.schema.json', import.meta.url), 'utf8'));
  assert.equal(json.$defs.auth.properties.roles.additionalProperties.$ref, '#/$defs/roleGrant');
  assert.deepEqual(json.$defs.roleGrant.properties.commands, { $ref: '#/$defs/commandGrants', default: [] });
  assert.equal(json.$defs.commandGrants.type, 'array');
  assert.equal(json.$defs.commandGrants.uniqueItems, true);
  const identifier = json.$defs.roleName;
  assert.equal(json.$defs.commandGrants.items.$ref, '#/$defs/roleName');
  assert.ok(new RegExp(identifier.pattern).test('approve-loan'));
  assert.ok(!new RegExp(identifier.pattern).test('*'));
  assert.ok(identifier.not.enum.includes('constructor'));
});

test('TS DSL accepts named command lists independently of resource names and rejects boolean grants', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const filename = join(root, 'test', '.app-command-grants-typecheck.ts');
  const source = [
    'import { listView, type TypedAppConfig } from "@mistriwork/mistri/app";',
    'type App = TypedAppConfig<{ loan: "id" | "status" }>;',
    'const app = { name: "Loans", resources: { loan: {} }, views: { loans: listView("Loans", "loan") }, home: "loans", auth: { roles: { approver: { commands: ["approve-loan"] } } } } satisfies App;',
    'type Auth = NonNullable<App["auth"]>;',
    'const named: Auth = { roles: { approver: { commands: ["approve-loan", "review-loan"] } } };',
    '// @ts-expect-error Commands require explicit lists, never a wildcard boolean.',
    'const wildcard: Auth = { roles: { approver: { commands: true } } };',
    '// @ts-expect-error Command identifiers are strings.',
    'const numeric: Auth = { roles: { approver: { commands: [42] } } };',
  ].join('\n');
  assert.equal(typecheck(filename, { files: { [filename]: source } }), '');
});
