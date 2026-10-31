import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { publishedDeclarations } from './support/installedTablewalk.js';
import * as policy from '../packages/mistri/src/server/policy.js';
import { defineAppRowPolicy } from '../packages/mistri/src/server/policy/appRowPolicy.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { published } from '../scripts/pack-manifest.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const auth = () => ({ rows: 'policy', roles: { staff: { read: true } } });
/** Every App names its home; these tests are about something else, so their Apps get this one list, named as the home. */
const start = () => ({ views: { tickets: { kind: 'list', from: 'ticket' } }, home: 'tickets' });
const manifest = () => ({
  name: 'Desk',
  sources: { operations: { connection: 'desk' } },
  resources: { ticket: {} },
  ...start(),
  auth: auth(),
});
const parse = (raw: unknown) => parseAppConfig(raw, 'app.ts');

test('public row-policy enrollment lowers auth.rows policy and resolves named source defaults', () => {
  const input = manifest();
  const before = structuredClone(input);
  const app = parse(input);
  assert.equal(app.auth?.rows, 'policy');
  assert.equal(app.sources?.operations.default, true);
  assert.deepEqual(input, before);
  const multi = parse({ ...input, sources: { ...input.sources, inventory: { connection: 'assets', default: true } } });
  assert.equal(multi.auth?.rows, 'policy');
  assert.deepEqual([multi.sources?.inventory.default, multi.sources?.operations.default], [true, false]);
});

test('a root "access" block is an unknown key: rows are enrolled by auth.rows', () => {
  const legacy = {
    name: 'Desk',
    auth: {},
    sources: { operations: { connection: 'desk' } },
    ...start(),
    access: { rowPolicy: true, read: ['ticket'], roles: { staff: { read: true } } },
  };
  assert.throws(() => parse(legacy), /has no "access"\. "access" belongs inside a resource block\. It takes: /);
});

test('omitting enrollment preserves ordinary access and single-connection Apps', () => {
  const ordinary = parse({ name: 'Desk', connection: 'desk', resources: { ticket: {} }, ...start(), auth: { roles: { staff: {} } } });
  assert.equal(ordinary.auth?.rows, 'all');
  assert.deepEqual(ordinary.sources, { desk: { connection: 'desk', default: true } });
  assert.equal(parse({ name: 'Browser', connection: 'desk', resources: { ticket: {} }, ...start() }).auth, undefined);
  // An explicitly present undefined is the default scope, every row: no enrollment.
  assert.equal(parse({ ...manifest(), auth: { ...auth(), rows: undefined } }).auth?.rows, 'all');
});

test('enrollment rejects every value outside the row scope vocabulary', () => {
  for (const rows of [false, true, 'true', 'false', 'policy.ts', 0, 1, null, {}, [], () => ({})]) {
    assert.throws(() => parse({ ...manifest(), auth: { ...auth(), rows } }), /"auth" has a "rows" of .*Use "all", "policy" or "tenant"/);
  }
});

test('enrollment requires role grants and named sources with a valid resolved default', () => {
  assert.throws(
    () => parse({ name: 'Desk', sources: { operations: { connection: 'desk' } }, ...start(), auth: { rows: 'policy' } }),
    /"rows": "policy".*needs "auth\.roles"/,
  );
  assert.throws(() => parse({ ...manifest(), sources: undefined }), /"rows": "policy", which requires named "sources"/);
  // A root connection is a named source when its name can be one; 'desk-db' cannot.
  assert.doesNotThrow(() => parse({ ...manifest(), sources: undefined, connection: 'desk' }));
  assert.throws(
    () => parse({ ...manifest(), sources: undefined, connection: 'desk-db' }),
    /"rows": "policy", which requires named "sources"/,
  );
  assert.throws(() => parse({ ...manifest(), sources: {} }), /sources.*non-empty/);
  assert.throws(
    () => parse({ ...manifest(), sources: { operations: { connection: 'desk', default: 'missing' } } }),
    /"default" that is not true/,
  );
  // Without a default every resource is qualified, so the manifest's bare ones name no source.
  assert.throws(
    () => parse({ ...manifest(), sources: { operations: { connection: 'desk' }, inventory: { connection: 'assets' } } }),
    /bare name, and no source says "default: true"/,
  );
});

test('enrollment preserves strict root, auth and role fields and existing access ownership rules', () => {
  assert.throws(() => parse({ ...manifest(), rowPolicy: true }), /has no "rowPolicy"/);
  for (const extra of ['rowPolicies', 'resolveRows', 'policyFile']) {
    assert.throws(() => parse({ ...manifest(), auth: { ...auth(), [extra]: true } }), new RegExp(`"auth" has no "${extra}"`));
  }
  assert.throws(
    () => parse({ ...manifest(), auth: { ...auth(), roles: { staff: { rowPolicy: true } } } }),
    /role "staff" has no "rowPolicy"/,
  );
  assert.throws(() => parse({ ...manifest(), writable: false }), /has no "writable"\. It takes: /);
  assert.throws(() => parse({ ...manifest(), auth: { roles: { staff: { writable: false } } } }), /role "staff" has no "writable"/);
  // Enrollment itself does not constrain the existing private write/command contract.
  const app = parse({
    ...manifest(),
    resources: { ticket: { access: 'write' } },
    auth: { ...auth(), roles: { staff: { read: true, write: true, commands: ['assign'] } } },
  });
  assert.deepEqual(app.auth?.roles?.staff.commands, ['assign']);
  assert.equal(app.resources?.ticket.access, 'write');
});

test('JSON schema exposes enrollment as a closed auth.rows vocabulary', () => {
  const schema = JSON.parse(readFileSync(join(root, 'packages/mistri/schema/app.schema.json'), 'utf8'));
  assert.deepEqual(schema.$defs.auth.properties.rows.enum, ['all', 'policy', 'tenant']);
  assert.ok(!(schema.$defs.auth.required ?? []).includes('rows'));
  assert.equal(schema.additionalProperties, false);
  assert.equal(Object.hasOwn(schema.properties, 'access'), false);
  assert.equal(schema.$defs.auth.additionalProperties, false);
  const role = schema.$defs.roleGrant;
  assert.equal(role.additionalProperties, false);
  assert.equal(Object.hasOwn(role.properties, 'rowPolicy'), false);
  // The named-sources prerequisite is the parser's: the schema does not carry it as a conditional.
});

test('server-only policy runtime exports definition helpers without loaders or deployments', () => {
  assert.deepEqual(Object.keys(policy).sort(), ['defineAppRowPolicy', 'defineAppTenantPolicy']);
  assert.equal(policy.defineAppRowPolicy, defineAppRowPolicy);
  let calls = 0;
  const defined = policy.defineAppRowPolicy({
    appId: 'app-desk',
    resolveRows: () => {
      calls++;
      return { ticket: false };
    },
  });
  assert.equal(calls, 0);
  assert.ok(Object.isFrozen(defined));
});

test('published policy declaration graph supports consumer types without exposing private APIs', () => {
  const pkg = published(JSON.parse(readFileSync(join(root, 'packages/mistri/package.json'), 'utf8')));
  assert.deepEqual(pkg.exports['./policy'], {
    types: './dist/server/policy.d.ts',
    default: './dist/server/policy.js',
  });
  const config = JSON.parse(readFileSync(join(root, 'config/tsconfig.commands.json'), 'utf8')) as { include: string[] };
  assert.ok(config.include.includes('../packages/mistri/src/server/policy.ts'));
  const { report, exports } = publishedDeclarations(
    `
    import { type AppConfig, type TypedAppConfig } from '@mistriwork/mistri/app';
    import { defineAppRowPolicy, type AppRowPolicy, type DeletedPolicyRecord, type PolicyPrincipal, type RowScope } from '@mistriwork/mistri/policy';
    import * as publicPolicy from '@mistriwork/mistri/policy';
    const auth = { rows: 'policy', roles: { staff: { read: true } } } satisfies NonNullable<AppConfig['auth']>;
    const typed: TypedAppConfig<{ ticket: 'id' | 'owner_id' }>['auth'] = { ...auth, roles: { staff: { read: ['ticket'] } } };
    const principal: PolicyPrincipal = { id: 'user', appId: 'app-desk', roles: ['staff'] };
    const rows: RowScope = { ticket: { groups: [[{ column: 'owner_id', op: '=', value: principal.id }]] } };
    const sync: AppRowPolicy = defineAppRowPolicy({ appId: principal.appId, resolveRows: p => p.roles.length ? rows : { ticket: false } });
    const asyncPolicy: AppRowPolicy = defineAppRowPolicy({ appId: principal.appId, resolveRows: async p => ({ ticket: p.id === principal.id }) });
    const deleted: DeletedPolicyRecord = { table: 'ticket', key: { id: 1 }, row: { id: 1, owner_id: principal.id, note: null } };
    const historyPolicy: AppRowPolicy = defineAppRowPolicy({ appId: principal.appId, resolveRows: () => rows,
      authorizeDeletedRecord: (p, record) => record.table === 'ticket' && record.row.owner_id === p.id });
    historyPolicy.authorizeDeletedRecord!(principal, deleted);
    // @ts-expect-error Deleted history authorization must be synchronous.
    const asyncHistory: AppRowPolicy['authorizeDeletedRecord'] = async () => true;
    // @ts-expect-error Callback results must be exact booleans.
    const truthyHistory: AppRowPolicy['authorizeDeletedRecord'] = () => 'yes';
    // @ts-expect-error Captured row values are immutable.
    deleted.row.owner_id = 'another-account';
    // @ts-expect-error Captured keys are immutable.
    deleted.key.id = 2;
    // @ts-expect-error Raw nested values are not stored scalar images.
    const nested: DeletedPolicyRecord = { table: 'ticket', key: { id: 1 }, row: { id: 1, note: {} } };
    // @ts-expect-error Enrollment is a row scope word, never a boolean.
    const disabled: AppConfig['auth'] = { ...auth, rows: false };
    // @ts-expect-error A policy module path is never public manifest data.
    const path: AppConfig['auth'] = { ...auth, rows: './policy.ts' };
    // @ts-expect-error Typed Apps preserve the row scope vocabulary.
    const typedDisabled: typeof typed = { ...typed, rows: true };
    // @ts-expect-error Unknown auth fields remain rejected.
    const extra: AppConfig['auth'] = { ...auth, policyFile: './policy.ts' };
    // @ts-expect-error Principals expose immutable verified roles.
    principal.roles.push('admin');
    // @ts-expect-error Raw data resources are not part of the principal.
    principal.resources;
    // @ts-expect-error Loaders remain private.
    publicPolicy.loadAppRowPolicy;
    // @ts-expect-error Deployment remains private.
    publicPolicy.deployAppRowPolicy;
  `,
    join('@mistriwork/mistri', pkg.exports['./policy'].types),
  );
  assert.equal(report, '');
  assert.deepEqual(exports, [
    'AppRowPolicy',
    'AppTenantPolicy',
    'DeletedPolicyRecord',
    'FixedPublicForm',
    'PlacedPublicForm',
    'PolicyDb',
    'PolicyPrincipal',
    'PolicyReadContext',
    'PublicEligibilityAnchor',
    'PublicFormAdmission',
    'PublicPlacementIntent',
    'RowScope',
    'TenantDeletedRecordPolicy',
    'TenantHistoryImage',
    'TenantMembershipEvidence',
    'TenantPolicyOwnership',
    'defineAppRowPolicy',
    'defineAppTenantPolicy',
  ]);
});
