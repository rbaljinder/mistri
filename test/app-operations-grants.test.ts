import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { typecheck } from './support/tsc.js';
import { appOperationsGrants, parseAppConfig, resolveAppAccess, OPERATIONS_GRANT_ACTIONS } from '../packages/mistri/src/shared/app.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

/**
 * Operator reads are a third kind of grant beside data and commands: named,
 * default-deny, and never implied by either of the others. A role that may
 * write every table still cannot read a support bundle unless it says so.
 */
const app = (roles: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  parseAppConfig(
    {
      name: 'Operations workspace',
      resources: { loan: {} },
      auth: { roles },
      views: { loans: { kind: 'list', from: 'loan' } },
      home: 'loans',
      ...extra,
    },
    'operations.ts',
  );

const schema: DatabaseSchema = {
  label: 'Ops',
  dialect: 'sqlite',
  readAt: '',
  foreignKeys: [],
  tables: [
    { id: 'loan', name: 'loan', schema: '', isView: false, columns: [{ name: 'id', type: 'INTEGER', nullable: false, primaryKey: true }] },
  ],
};

// Authored `bundle` is the sanitized support bundle; the lowered grant keeps the internal name `support`.
test('operations grants parse as an ordered list of the two named reads and nothing else', () => {
  const input = { viewer: {}, operator: { operations: ['bundle', 'readiness'] }, probe: { operations: ['readiness'] } };
  const parsed = app(input);
  assert.deepEqual(parsed.auth?.roles, {
    viewer: { read: false, write: false },
    operator: { read: false, write: false, operations: ['support', 'readiness'] },
    probe: { read: false, write: false, operations: ['readiness'] },
  });
  input.operator.operations.push('later');
  assert.deepEqual(parsed.auth?.roles?.operator.operations, ['support', 'readiness']);
  assert.deepEqual([...OPERATIONS_GRANT_ACTIONS], ['readiness', 'support', 'workflows', 'jobs', 'deliveries', 'stores', 'analytics']);
});

test('operations grant parser refuses booleans, wildcards, unknown words, duplicates and empty lists', () => {
  for (const operations of [
    true,
    false,
    null,
    {},
    'readiness',
    [],
    ['*'],
    ['all'],
    ['readiness', 'readiness'],
    ['Readiness'],
    ['bundle', 'metrics'],
    [1],
    [''],
    ['readiness '],
  ]) {
    assert.throws(
      () => app({ operator: { operations } }),
      /"operations" (must be a nonempty list from "readiness", "bundle", "workflows", "jobs", "deliveries", "stores", "analytics" and "support"|contains duplicate operations)/,
      JSON.stringify(operations),
    );
  }
  // `support` is the support sessions' history (the old supportLog/supportAudit), which only a platform realm has.
  assert.throws(() => app({ operator: { operations: ['support'] } }), /"operations": \["support"\], which needs the platform realm/);
  assert.throws(() => app({ operator: { operation: ['readiness'] } }), /has no "operation"/);
});

test('verified roles union operator reads and never widen data or command grants', () => {
  const parsed = app({
    admin: { read: true, write: true, commands: ['approve'] },
    probe: { operations: ['readiness'] },
    support: { operations: ['bundle'] },
  });
  assert.deepEqual([...appOperationsGrants(parsed, ['admin'])], [], 'full data and command grants imply no operator read');
  assert.deepEqual([...appOperationsGrants(parsed, ['probe'])], ['readiness']);
  assert.deepEqual([...appOperationsGrants(parsed, ['probe', 'support'])], ['readiness', 'support']);
  assert.deepEqual([...appOperationsGrants(parsed, ['missing'])], []);
  assert.deepEqual([...appOperationsGrants(parsed, [])], []);
  const access = resolveAppAccess(parsed, schema, ['probe', 'support']);
  assert.deepEqual(access.writable, new Set(), 'operator reads grant no writes');
});

test('operator reads require role grants; a root writable is refused and grant-less Apps grant nothing', () => {
  assert.throws(
    () => parseAppConfig({ name: 'Legacy', auth: { roles: { operator: {} } }, writable: true }, 'legacy.ts'),
    /has no "writable"\. It takes: /,
  );
  const loans = { resources: { loan: {} }, views: { loans: { kind: 'list', from: 'loan' } }, home: 'loans', nav: ['loans'] };
  const signedIn = parseAppConfig({ name: 'Signed in', auth: {}, ...loans }, 'signed-in.ts');
  assert.deepEqual([...appOperationsGrants(signedIn, ['operator'])], []);
  const open = parseAppConfig({ name: 'Open', ...loans }, 'open.ts');
  assert.deepEqual([...appOperationsGrants(open, ['operator'])], []);
});

test('JSON schema pins operations to a unique bounded list of the named reads', () => {
  const json = JSON.parse(readFileSync(new URL('../packages/mistri/schema/app.schema.json', import.meta.url), 'utf8'));
  assert.equal(json.$defs.auth.properties.roles.additionalProperties.$ref, '#/$defs/roleGrant');
  const grant = json.$defs.roleGrant.properties.operations;
  assert.deepEqual(grant.items.enum, ['readiness', 'bundle', 'workflows', 'jobs', 'deliveries', 'stores', 'analytics', 'support']);
  assert.equal(grant.uniqueItems, true);
  assert.equal(grant.minItems, 1);
  assert.equal(grant.maxItems, 8);
  assert.equal(json.$defs.roleGrant.additionalProperties, false);
});

test('TS DSL accepts the two read names and rejects booleans and other words', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const filename = join(root, 'test', '.app-operations-grants-typecheck.ts');
  const source = [
    'import { listView, type AppRoleGrant, type TypedAppConfig } from "@mistriwork/mistri/app";',
    'type App = TypedAppConfig<{ loan: "id" | "status" }>;',
    'const app = { name: "Loans", resources: { loan: {} }, views: { loans: listView("Loans", "loan") }, home: "loans", auth: { roles: { operator: { operations: ["readiness", "bundle"] } } } } satisfies App;',
    '// @ts-expect-error Operator reads are named, never a wildcard boolean.',
    'const wildcard: AppRoleGrant = { operations: true };',
    '// @ts-expect-error Only the two read names exist.',
    'const other: AppRoleGrant = { operations: ["metrics"] };',
    '// The support sessions read; the platform realm it needs is judged at load.',
    'const sessions: AppRoleGrant = { operations: ["support"] };',
  ].join('\n');
  assert.equal(typecheck(filename, { files: { [filename]: source } }), '');
});
