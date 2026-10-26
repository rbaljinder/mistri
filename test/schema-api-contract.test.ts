/** Real draft validation of complete Apps; semantic boundaries are named,
 * never disguised as JSON Schema shape agreement or executable API routes. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';

// Cross-$ref type/required lint is relaxed, not draft/meta-schema validation.
const ajv = new Ajv2020({ strict: true, strictTypes: false, strictRequired: false });
for (const name of ['theme', 'page', 'app']) {
  const schema = JSON.parse(readFileSync(new URL(`../packages/mistri/schema/${name}.schema.json`, import.meta.url), 'utf8'));
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(ajv.validateSchema(schema), true, ajv.errorsText());
  ajv.addSchema(schema);
}
const validate = ajv.getSchema('app.schema.json')!;
const api = () => ({
  version: 1,
  roles: ['reader'],
  resources: { lead: { fields: ['id', 'status'], filters: ['status'], sorts: ['id'] } },
  views: ['leads'],
});
const document = (exposure: unknown = api()): Record<string, unknown> => ({
  name: 'API contract',
  resources: { lead: {} },
  auth: { roles: { reader: { read: ['lead'] } } },
  views: { leads: { kind: 'list', from: 'lead' } },
  home: 'leads',
  api: exposure,
});
type Case = { name: string; raw: Record<string, unknown>; schema: boolean; runtime: boolean; boundary?: string; refusal?: RegExp };
const accepted = (name: string, exposure: unknown): Case => ({ name, raw: document(exposure), schema: true, runtime: true });
const refused = (name: string, exposure: unknown, refusal: RegExp): Case => ({
  name,
  raw: document(exposure),
  schema: false,
  runtime: false,
  refusal,
});
const semantic = (name: string, exposure: unknown, refusal: RegExp, boundary: string): Case => ({
  name,
  raw: document(exposure),
  schema: true,
  runtime: false,
  refusal,
  boundary,
});
const cases: Case[] = [
  accepted('explicit read fields filters and sorts', api()),
  accepted('optional resource and view exposure lists', { version: 1, roles: ['reader'] }),
  accepted('wrapped view presentation', { ...api(), publicSpec: false, views: [{ view: 'leads', label: 'Public directory' }] }),
  accepted('empty active commands', { ...api(), commands: [] }),
  refused('invalid version', { ...api(), version: 0 }, /version/),
  refused('unsafe version', { ...api(), version: Number.MAX_SAFE_INTEGER + 1 }, /version/),
  refused('empty roles', { ...api(), roles: [] }, /roles/),
  refused('duplicate roles', { ...api(), roles: ['reader', 'reader'] }, /duplicate/),
  refused('nonstring role', { ...api(), roles: [1] }, /role/),
  refused('invalid publicSpec', { ...api(), publicSpec: 'false' }, /publicSpec/),
  refused('unknown root member', { ...api(), routes: [] }, /routes/),
  refused('empty projection', { ...api(), resources: { lead: { fields: [] } } }, /fields/),
  refused('duplicate projection', { ...api(), resources: { lead: { fields: ['id', 'id'] } } }, /duplicate/),
  refused('invalid field path', { ...api(), resources: { lead: { fields: ['id..status'] } } }, /logical name/),
  refused('duplicate filters', { ...api(), resources: { lead: { fields: ['id'], filters: ['id', 'id'] } } }, /duplicate/),
  refused('invalid sort shape', { ...api(), resources: { lead: { fields: ['id'], sorts: 'id' } } }, /list/),
  refused('command activation is unsupported', { ...api(), commands: [{ id: 'refresh', version: 1, input: {} }] }, /command/),
  refused('wrapped view requires view member', { ...api(), views: [{ label: 'Leads' }] }, /view key/),
  semantic('unknown role', { ...api(), roles: ['manager'] }, /not declared/, 'Role membership depends on root auth.roles.'),
  semantic(
    'filter outside projection',
    { ...api(), resources: { lead: { fields: ['id'], filters: ['status'] } } },
    /exposed fields/,
    'Filter subset depends on fields in this exposure.',
  ),
  semantic(
    'sort outside projection',
    { ...api(), resources: { lead: { fields: ['id'], sorts: ['status'] } } },
    /exposed fields/,
    'Sort subset depends on fields in this exposure.',
  ),
  semantic(
    'unknown view',
    { ...api(), views: ['missing'] },
    /existing list view/,
    'View existence and kind depend on contributed definitions.',
  ),
  semantic(
    'mixed duplicate view references',
    { ...api(), views: ['leads', { view: 'leads' }] },
    /duplicate view/,
    'Logical identity ignores view-reference presentation wrappers.',
  ),
];
for (const key of ['version', 'roles', 'publicSpec', 'description'])
  cases.push({
    name: `feature cannot own ${key}`,
    raw: {
      ...document(),
      features: [
        { id: 'api', api: { [key]: key === 'roles' ? ['reader'] : key === 'version' ? 1 : key === 'publicSpec' ? false : 'Docs' } },
      ],
    },
    schema: false,
    runtime: false,
    refusal: /root App only/,
  });
cases.push({
  name: 'feature view contributed separately',
  raw: {
    ...document(),
    features: [
      { id: 'views', views: { archive: { kind: 'list', from: 'lead' } } },
      { id: 'api', api: { views: ['archive'] } },
    ],
  },
  schema: true,
  runtime: true,
});
cases.push({
  name: 'dashboard is not an API list view',
  raw: {
    ...document(),
    views: {
      leads: { kind: 'dashboard', label: 'Dashboard', sections: [{ kind: 'note', text: 'Hello' }] },
    },
  },
  schema: true,
  runtime: false,
  refusal: /existing list view/,
  boundary: 'Cross-reference kind is resolved from the contributed view.',
});
cases.push({
  name: 'a generic update is opted into with true',
  raw: document({ ...api(), resources: { lead: { fields: ['id'], update: true } } }),
  schema: true,
  runtime: true,
});
cases.push({
  name: 'schema column existence remains a later catalog check',
  raw: document({ ...api(), resources: { lead: { fields: ['id', 'catalog_checked_later'] } } }),
  schema: true,
  runtime: true,
  boundary: 'Authored syntax acceptance is not catalog validation or route publication.',
});
const missingRoot = document();
delete missingRoot.api;
cases.push({
  name: 'feature requires explicit root API authority',
  raw: { ...missingRoot, features: [{ id: 'api', api: { views: ['leads'] } }] },
  schema: true,
  runtime: false,
  refusal: /explicit root api/,
  boundary: 'Root-owned exposure authority is cross-contributor semantics.',
});

for (const entry of cases)
  test(`independent active API contract: ${entry.name}`, () => {
    const before = structuredClone(entry.raw);
    assert.equal(validate(entry.raw), entry.schema, ajv.errorsText(validate.errors));
    if (entry.runtime) assert.doesNotThrow(() => parseAppConfig(entry.raw, 'api-contract'));
    else assert.throws(() => parseAppConfig(entry.raw, 'api-contract'), entry.refusal!);
    if (entry.schema !== entry.runtime) assert.ok(entry.boundary);
    assert.deepEqual(entry.raw, before, 'Neither validator may coerce or rewrite authored input.');
  });
