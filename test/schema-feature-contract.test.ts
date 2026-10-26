/** A deliberately small independent oracle: real draft validation, not key-set agreement.
 * Cross-contributor authority rules need the App checker; future syntax is explicitly
 * classified rather than pretending every schema-accepted document can run today. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';

const readSchema = (name: string) =>
  JSON.parse(readFileSync(new URL(`../packages/mistri/schema/${name}.schema.json`, import.meta.url), 'utf8'));
// These two lint rules cannot follow a type supplied by $ref or a required key
// declared outside a `not` subschema. Draft/meta-schema and keyword checks stay on.
const validator = new Ajv2020({ strict: true, strictTypes: false, strictRequired: false, allErrors: true });
validator.addSchema(readSchema('theme'));
validator.addSchema(readSchema('page'));
const validate = validator.compile(readSchema('app'));

test('related empty guidance agrees across the schema and parser, including a matched list', () => {
  const empty = { title: 'No tasks yet', action: { label: 'Browse tasks', to: 'tasks' } };
  const raw = (section: Record<string, unknown>) => ({
    name: 'Example',
    resources: { task: {}, customer: {} },
    views: { tasks: { kind: 'list', from: 'task' } },
    home: 'tasks',
    nav: ['tasks'],
    pages: { customer: { base: 'customer', sections: [section] } },
  });
  const related = raw({ kind: 'list', from: 'task', whose: 'customer_id', empty });
  assert.equal(validate(related), true, JSON.stringify(validate.errors));
  assert.doesNotThrow(() => parseAppConfig(related, 'test'));
  const similar = raw({ kind: 'list', from: 'customer', same: ['name'], empty });
  assert.equal(validate(similar), true, JSON.stringify(validate.errors));
  assert.doesNotThrow(() => parseAppConfig(similar, 'test'));
  const added = raw({ kind: 'list', from: 'customer', same: ['name'], create: 'Add' });
  assert.equal(validate(added), false);
  assert.throws(() => parseAppConfig(added, 'test'), /create/);
});

type Raw = Record<string, unknown>;
const document = (grant: Raw = {}, rootRealm: unknown = 'tenant', menuSearch?: unknown): Raw => ({
  id: 'lending',
  name: 'Lending',
  sources: { business: { connection: 'db' } },
  resources: { lead: { owner: 'tenant' } },
  auth: {
    rows: 'tenant',
    ...(rootRealm === undefined ? {} : { tenancy: { label: 'Dealer', platform: { label: 'Lender' } } }),
    roles: { reader: { read: ['lead'], ...(rootRealm === undefined ? {} : { realm: rootRealm }) } },
  },
  views: { leads: { kind: 'list', from: 'lead' } },
  home: 'leads',
  features: [{ id: 'desk', auth: { roles: { reader: grant } } }],
  ...(menuSearch === undefined ? {} : { ui: { shell: { menuSearch } } }),
});
type Case = { name: string; raw: Raw; schema: boolean; boundary?: string } & ({ runtime: true } | { runtime: false; refusal: RegExp });
const cases: Case[] = [
  { name: 'omitted realm', raw: document(), schema: true, runtime: true },
  { name: 'identical explicit realm', raw: document({ realm: 'tenant' }), schema: true, runtime: true },
  { name: 'named additive read', raw: document({ read: ['lead'], realm: 'tenant' }), schema: true, runtime: true },
  { name: 'unknown grant member', raw: document({ realms: 'tenant' }), schema: false, runtime: false, refusal: /realms/ },
  { name: 'invalid realm enum', raw: document({ realm: 'global' }), schema: false, runtime: false, refusal: /realm/ },
  { name: 'invalid realm type', raw: document({ realm: null }), schema: false, runtime: false, refusal: /realm/ },
  { name: 'whole ceiling refused on feature', raw: document({ read: true }), schema: false, runtime: false, refusal: /whole ceiling/ },
  {
    name: 'feature member administration is not a key',
    raw: document({ members: { grant: ['reader'] } }),
    schema: false,
    runtime: false,
    refusal: /has no "members"/,
  },
  {
    name: 'root realm cannot be changed',
    raw: document({ realm: 'platform' }),
    schema: true,
    runtime: false,
    refusal: /realm.*differs from the App/,
    boundary: 'Cross-contributor equality is intentionally checked by the App checker.',
  },
  { name: 'menuSearch true', raw: document({}, 'tenant', true), schema: true, runtime: true },
  { name: 'menuSearch false', raw: document({}, 'tenant', false), schema: true, runtime: true },
  { name: 'menuSearch nonboolean', raw: document({}, 'tenant', 'false'), schema: false, runtime: false, refusal: /menuSearch/ },
];
const absentRoot = document({ realm: 'tenant' });
delete (absentRoot.auth as { roles: { reader: Raw } }).roles.reader.realm;
cases.push({
  name: 'feature cannot supply absent root realm',
  raw: absentRoot,
  schema: true,
  runtime: false,
  refusal: /realm.*not declared by the App/,
  boundary: 'Cross-contributor authority ownership is intentionally checked by the App checker.',
});
/* A key declared ahead of its feature and only ever refused is sprawl: neither the root nor a feature declares `members`. */
const futureRoot = document();
(futureRoot.auth as { roles: { reader: Raw } }).roles.reader.members = { grant: ['reader'] };
cases.push({
  name: 'root member administration is not a key',
  raw: futureRoot,
  schema: false,
  runtime: false,
  refusal: /has no "members"/,
});

test('schemas compile against their declared 2020-12 meta-schema', () => {
  for (const name of ['app', 'page', 'theme']) {
    const schema = readSchema(name);
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.equal(validator.validateSchema(schema), true, validator.errorsText());
    assert.equal(typeof validator.getSchema(schema.$id), 'function');
  }
});
for (const entry of cases)
  test(`independent feature contract: ${entry.name}`, () => {
    const before = structuredClone(entry.raw);
    assert.equal(validate(entry.raw), entry.schema, validator.errorsText(validate.errors));
    if (entry.runtime) assert.doesNotThrow(() => parseAppConfig(entry.raw, 'feature-contract'));
    else assert.throws(() => parseAppConfig(entry.raw, 'feature-contract'), entry.refusal);
    if (entry.runtime !== entry.schema) assert.ok(entry.boundary, 'Every intentional schema/runtime distinction must be named.');
    assert.deepEqual(entry.raw, before, 'Validation must not coerce or rewrite authored definitions.');
  });
