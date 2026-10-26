import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { flag, experiment } from '../packages/mistri/schema/app.mjs';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { checkedGrants } from '../packages/mistri/src/shared/appAuthGrants.js';
import { authorityDiff, authorityReport } from '../packages/mistri/src/shared/appAuthority.js';
import { composeFeatures } from '../packages/mistri/src/shared/appFeatures.js';
import { servedApp } from '../packages/mistri/src/shared/appPayload.js';
import { normalizeFlagCatalog } from '../packages/mistri/src/shared/appFlags.js';
import { EXPERIMENT_DECLARATION_LIMITS, normalizeExperimentDeclarations } from '../packages/mistri/src/shared/appExperiments.js';
import { EXPERIMENT_STATISTICS_LIMITS } from '../packages/mistri/src/server/experiments/statistics.js';
import { validationCode } from '../packages/mistri/src/server/build/checkProblems.js';
import { normalizeFlagCapabilities } from '../packages/mistri/src/shared/appFlagCapabilities.js';

const epoch = () =>
  experiment({
    version: 'copy-v1',
    unit: 'subject',
    control: 'a',
    startsAt: '2026-11-01T00:00:00.000Z',
    endsAt: '2026-11-15T00:00:00.000Z',
    conversionWindow: '48 hours',
    deliveryGrace: '24 hours',
    eligibility: { rollout: 100 },
    allocation: [
      { value: 'a', weight: 50 },
      { value: 'b', weight: 50 },
    ],
    primary: { conversion: 'applicationSubmitted' },
    guardrails: [{ conversion: 'applicationWithdrawn', maxIncrease: 0.02 }],
  });
const declarations = () => ({
  newFinder: flag.boolean(false, { owner: 'discovery', tenantManaged: true }),
  heroCopy: flag.string('a', { owner: 'discovery', variants: ['a', 'b'], safeValue: 'a', expiry: '2027-01-01T00:00:00.000Z' }),
});
const raw = () => ({
  name: 'Flags',
  resources: { item: {} },
  views: { items: { kind: 'list', from: 'item' } },
  home: 'items',
  flags: declarations(),
  audiences: {
    beta: { rollout: 10 },
    partners: { roles: ['releaseManager'], attributes: { emailDomain: ['partner.example'] } },
  },
  experiments: { heroCopy: epoch() },
  auth: {
    roles: {
      releaseManager: {
        read: false,
        flags: [{ actions: ['view', 'manage'], environments: ['production'], owners: ['discovery'], ids: ['newFinder', 'heroCopy'] }],
        experiments: [{ actions: ['view', 'manage', 'decide'], environments: ['production'], owners: ['discovery'], ids: ['heroCopy'] }],
      },
      onCall: { read: false, flags: [{ actions: ['view', 'killswitch'], environments: ['production'], owners: ['discovery'] }] },
    },
  },
});
const parse = (value: unknown = raw()) => parseAppConfig(value, 'flags-fixture');
const catalog = () => normalizeFlagCatalog({ flags: declarations(), roles: ['releaseManager', 'onCall'], audiences: raw().audiences });
const ajv = new Ajv2020({ strict: true, strictTypes: false, strictRequired: false, allErrors: true });
for (const name of ['theme', 'page'])
  ajv.addSchema(JSON.parse(readFileSync(new URL(`../packages/mistri/schema/${name}.schema.json`, import.meta.url), 'utf8')));
const validate = ajv.compile(JSON.parse(readFileSync(new URL('../packages/mistri/schema/app.schema.json', import.meta.url), 'utf8')));

test('the approved declaration parses through the real App and JSON schema, with captured immutable controls', () => {
  const authored = raw(),
    app = parse(authored);
  assert.equal(validate(authored), true, ajv.errorsText(validate.errors));
  assert.equal(app.flags!.newFinder.safeValue, false);
  assert.deepEqual(app.experiments!.heroCopy, authored.experiments.heroCopy);
  assert.ok(Object.isFrozen(app.experiments!.heroCopy.allocation[0]));
  assert.ok(Object.isFrozen(app.auth!.roles!.onCall.flags![0].actions));
  authored.audiences.partners.roles.push('onCall');
  authored.auth.roles.onCall.flags[0].owners.push('other');
  assert.deepEqual(app.audiences!.partners.roles, ['releaseManager']);
  assert.deepEqual(checkedGrants(app).roles.onCall.flags![0].owners, ['discovery']);
  assert.deepEqual(
    normalizeFlagCatalog({
      flags: { n: flag.number(2, { owner: 'o' }), o: flag.object({ nested: [1, null] }, { owner: 'o' }) },
      roles: [],
      audiences: {},
    }).flags.o.default,
    { nested: [1, null] },
  );
});

test('new declaration locations are closed in the parser and independent schema', () => {
  const changes: ((value: ReturnType<typeof raw>) => void)[] = [
    (value) => Object.assign(value.flags.newFinder, { runtime: true }),
    (value) => Object.assign(value.experiments.heroCopy, { enabled: true }),
    (value) => Object.assign(value.experiments.heroCopy.eligibility, { value: 'b' }),
    (value) => Object.assign(value.experiments.heroCopy.allocation[0], { role: 'admin' }),
    (value) => Object.assign(value.experiments.heroCopy.primary, { query: 'arbitrary' }),
    (value) => Object.assign(value.experiments.heroCopy.guardrails[0], { sql: 'arbitrary' }),
    (value) => Object.assign(value.auth.roles.onCall.flags[0], { realm: 'platform' }),
    (value) => {
      value.auth.roles.onCall.flags[0].owners = ['*'];
    },
    (value) => {
      value.auth.roles.onCall.flags[0].environments = [];
    },
    (value) => {
      value.auth.roles.onCall.flags[0].actions = ['decide'];
    },
    (value) => {
      value.auth.roles.releaseManager.experiments[0].actions = ['killswitch'];
    },
  ];
  for (const change of changes) {
    const value = raw();
    change(value);
    assert.equal(validate(value), false, JSON.stringify(value));
    assert.throws(() => parse(value));
  }
});

test('experiment references, variants, dates and eligibility fail closed', () => {
  const invalid = [
    { ...epoch(), control: 'missing' },
    { ...epoch(), allocation: [{ value: 'a', weight: 100 }] },
    {
      ...epoch(),
      allocation: [
        { value: 'a', weight: 50 },
        { value: 'b', weight: 49 },
      ],
    },
    { ...epoch(), startsAt: '2026-11-31T00:00:00.000Z' },
    { ...epoch(), endsAt: epoch().startsAt },
    { ...epoch(), conversionWindow: '0 hours' },
    { ...epoch(), deliveryGrace: '-1 hours' },
    { ...epoch(), eligibility: { audiences: ['undeclared'] } },
    { ...epoch(), eligibility: { audiences: [] } },
    { ...epoch(), eligibility: { segments: { region: ['east'] } } },
    { ...epoch(), guardrails: [{ conversion: 'applicationSubmitted', maxIncrease: 0.1 }] },
  ];
  for (const value of invalid) assert.throws(() => normalizeExperimentDeclarations({ heroCopy: value }, catalog()), JSON.stringify(value));
  assert.throws(() => normalizeExperimentDeclarations({ unknown: epoch() }, catalog()), /undeclared flag/);
  assert.throws(
    () => parse({ ...raw(), audiences: { partners: { roles: ['auditor'] } } }),
    /audience names the role "auditor", which auth.roles does not declare/,
  );
  // Who is eligible is said only by audiences: a direct role or tenant list points at them.
  for (const key of ['roles', 'tenants'])
    assert.throws(
      () => normalizeExperimentDeclarations({ heroCopy: { ...epoch(), eligibility: { [key]: ['onCall'] } } }, catalog()),
      new RegExp(`declare one with ${key} and list it in eligibility.audiences. \\[experiment-eligibility-audiences-only\\]`),
    );
  assert.doesNotThrow(() =>
    normalizeExperimentDeclarations({ heroCopy: { ...epoch(), eligibility: { audiences: ['beta', 'partners'], rollout: 25 } } }, catalog()),
  );
  // Loading the App says it as a check finding, with the code `mistri check` reports.
  assert.throws(
    () => parse({ ...raw(), experiments: { heroCopy: { ...epoch(), eligibility: { tenants: ['dealer-17'] } } } }),
    (error: Error) => validationCode(error.message) === 'experiment-eligibility-audiences-only',
  );
});

test('declared experiment arm and guardrail caps agree with AN2 at sixteen, without narrowing ordinary flags', () => {
  assert.deepEqual(EXPERIMENT_DECLARATION_LIMITS, EXPERIMENT_STATISTICS_LIMITS);
  for (const size of [16, 17]) {
    const variants = Array.from({ length: size }, (_, i) => `variant-${i}`);
    const value = {
      ...raw(),
      flags: { ...declarations(), heroCopy: flag.string(variants[0], { owner: 'discovery', variants }) },
      experiments: {
        heroCopy: { ...epoch(), control: variants[0], allocation: variants.map((value, i) => ({ value, weight: i < 16 ? 6.25 : 0 })) },
      },
    };
    assert.equal(validate(value), size === 16, ajv.errorsText(validate.errors));
    if (size === 16) assert.doesNotThrow(() => parse(value));
    else assert.throws(() => parse(value), /sixteen arms/);
    // Seventeen ordinary flag variants remain supported by the existing catalog.
    assert.doesNotThrow(() => normalizeFlagCatalog({ flags: value.flags, roles: [], audiences: {} }));
    const guarded = {
      ...raw(),
      experiments: {
        heroCopy: { ...epoch(), guardrails: Array.from({ length: size }, (_, i) => ({ conversion: `guard-${i}`, maxIncrease: 0.02 })) },
      },
    };
    assert.equal(validate(guarded), size === 16, ajv.errorsText(validate.errors));
    if (size === 16) assert.doesNotThrow(() => parse(guarded));
    else assert.throws(() => parse(guarded), /sixteen entries/);
  }
});

test('capture rejects getters, sparse arrays, foreign prototypes, symbols and cycles without executing getters', () => {
  let called = false;
  const getter = {
    ...epoch(),
    get eligibility() {
      called = true;
      return {};
    },
  };
  assert.throws(() => normalizeExperimentDeclarations({ heroCopy: getter }, catalog()));
  assert.equal(called, false);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (const value of [cycle, new Date(), { ...epoch(), [Symbol('hidden')]: true }, { ...epoch(), allocation: Array(2) }]) {
    assert.throws(() => normalizeExperimentDeclarations({ heroCopy: value }, catalog()));
  }
  const capabilities = [
    {
      actions: ['view'],
      environments: ['production'],
      get owners() {
        called = true;
        return ['discovery'];
      },
    },
  ];
  assert.throws(() => normalizeFlagCapabilities(capabilities, 'flags'));
  assert.equal(called, false);
  assert.throws(() =>
    parse({
      ...raw(),
      features: [
        {
          id: 'bad',
          flags: {
            get surprise() {
              called = true;
              return declarations().newFinder;
            },
          },
        },
      ],
    }),
  );
  assert.equal(called, false);
});

test('composition rejects duplicate definitions and credits capability additions to declared roles', () => {
  for (const key of ['flags', 'experiments', 'audiences'] as const) {
    const value = raw();
    assert.throws(() => parse({ ...value, features: [{ id: 'repeat', [key]: value[key] }] }), /declared by the App and features "repeat"/);
  }
  const value = raw();
  const { newFinder, ...flags } = value.flags;
  const input = {
    ...value,
    flags,
    features: [
      {
        id: 'finder',
        flags: { newFinder },
        auth: {
          roles: {
            onCall: {
              flags: [{ actions: ['manage'], environments: ['staging'], owners: ['discovery'], ids: ['newFinder'] }],
            },
          },
        },
      },
    ],
  };
  const app = parse(input);
  assert.equal(app.auth!.roles!.onCall.flags!.length, 2);
  assert.match(authorityReport(app, composeFeatures(input, 'fixture').origins), /role onCall flags .*staging.*features "finder"/);
  assert.throws(
    () => parse({ ...value, features: [{ id: 'wrong', auth: { roles: { nonexistent: { flags: value.auth.roles.onCall.flags } } } }] }),
    /not a role the App declares/,
  );
});

test('all roles and capability references are checked; public grants never gain controls', () => {
  const value = raw();
  value.auth.roles.releaseManager.flags[0].ids.push('unknown');
  assert.throws(() => parse(value), /undeclared/);
  const foreignOwner = raw();
  foreignOwner.auth.roles.onCall.flags[0].owners = ['other'];
  assert.throws(() => parse(foreignOwner), /undeclared owner/);
  const wrongExperiment = raw();
  wrongExperiment.auth.roles.releaseManager.experiments[0].ids = ['newFinder'];
  assert.throws(() => parse(wrongExperiment), /undeclared/);
  assert.throws(
    () => parse({ ...raw(), auth: { ...raw().auth, public: { read: ['item'], flags: raw().auth.roles.onCall.flags } } }),
    /flags/,
  );
  const app = parse();
  app.auth!.roles!.unused = {
    read: false,
    write: false,
    flags: [{ actions: ['view'], environments: ['production'], owners: ['discovery'], ids: ['unknown'] }],
  };
  assert.throws(() => checkedGrants(app), /undeclared/);
});

test('authority locks record capabilities, ownership and experiment classification, not values or rollout', () => {
  const value = raw(),
    before = authorityReport(parse(value));
  const changed = raw();
  changed.auth.roles.onCall.flags[0].environments.push('staging');
  assert.notDeepEqual(authorityDiff(before, authorityReport(parse(changed))), []);
  const moved = raw();
  moved.flags.newFinder.tenantManaged = false;
  assert.notDeepEqual(authorityDiff(before, authorityReport(parse(moved))), []);
  const tuning = raw();
  tuning.flags.newFinder.default = true;
  tuning.experiments.heroCopy.eligibility.rollout = 25;
  tuning.experiments.heroCopy.allocation[0].weight = 70;
  tuning.experiments.heroCopy.allocation[1].weight = 30;
  assert.deepEqual(authorityDiff(before, authorityReport(parse(tuning))), []);
  const extra = raw();
  assert.notDeepEqual(
    authorityDiff(
      before,
      authorityReport(
        parse({
          ...extra,
          experiments: {
            ...extra.experiments,
            newFinder: {
              ...epoch(),
              control: false,
              allocation: [
                { value: false, weight: 50 },
                { value: true, weight: 50 },
              ],
            },
          },
          flags: { ...extra.flags, newFinder: { ...extra.flags.newFinder, variants: [false, true] } },
        }),
      ),
    ),
    [],
  );
});

test('capability declarations preserve tenant role realm ownership', () => {
  const value = raw();
  const tenant = {
    ...value,
    sources: { business: { connection: 'db' } },
    resources: { item: { owner: 'tenant' } },
    auth: {
      ...value.auth,
      rows: 'tenant',
      tenancy: { platform: { label: 'Platform' } },
      roles: {
        releaseManager: { ...value.auth.roles.releaseManager, realm: 'platform' },
        onCall: { ...value.auth.roles.onCall, realm: 'tenant' },
      },
    },
  };
  const app = parse(tenant);
  assert.equal(checkedGrants(app).roles.releaseManager.realm, 'platform');
  assert.equal(checkedGrants(app).roles.onCall.realm, 'tenant');
  assert.throws(
    () => parse({ ...tenant, auth: { ...tenant.auth, roles: { releaseManager: value.auth.roles.releaseManager } } }),
    /no "realm"/,
  );
  assert.throws(
    () =>
      parse({
        ...tenant,
        features: [{ id: 'crossing', auth: { roles: { onCall: { realm: 'platform', flags: value.auth.roles.onCall.flags } } } }],
      }),
    /realm.*differs/,
  );
  assert.throws(
    () =>
      parse({
        ...value,
        audiences: { beta: value.audiences.beta },
        auth: { ...value.auth, roles: { onCall: { ...value.auth.roles.onCall, realm: 'platform' } } },
      }),
    /realm/,
  );
});

test('ordinary browser payloads omit control catalogs, immutable epochs and management capabilities', () => {
  const payload = servedApp(parse(), { label: 'fixture', dialect: 'sqlite', readAt: 'now', tables: [], foreignKeys: [] });
  for (const key of ['flags', 'audiences', 'experiments', 'auth']) assert.equal(Object.hasOwn(payload, key), false);
  assert.doesNotMatch(JSON.stringify(payload), /copy-v1|applicationSubmitted|discovery|killswitch/);
});
