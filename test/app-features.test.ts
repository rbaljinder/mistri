/**
 * Composition: an App's features merge into one flat App at load, by rules
 * that name every contributor involved. Identical facts merge, conflicting
 * ones are refused, ids are global, and a feature's authority only adds to
 * roles the App declares, within the ceilings the App states. The authority
 * report reads the merged grants with who contributes each, and the typed
 * layer checks a feature's references where every contributor is known.
 */
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { typecheck } from './support/tsc.js';
import { commandForm, defineFeature, navGroup, step } from '@mistriwork/mistri/app';
import { composeFeatures } from '../packages/mistri/src/shared/appFeatures.js';
import { locateProblem } from '../packages/mistri/src/shared/appProvenance.js';
import { authorityDiff, authorityReport } from '../packages/mistri/src/shared/appAuthority.js';
import { parseAppConfig, parseAppPages } from '../packages/mistri/src/shared/app.js';
import { withCommandCatalog } from '../packages/mistri/src/shared/command.js';
import { catalogOf } from './support/commandCatalog.js';

const WHERE = 'test/app.json';
type Raw = Record<string, unknown>;
const LEADS = { kind: 'list', from: 'lead' };
const VEHICLES = { kind: 'list', from: 'vehicle' };
const DESK = { kind: 'dashboard', label: 'Desk', sections: [{ kind: 'note', text: 'Today' }] };

/** The App every case composes onto: two resources under ceilings, two roles, one view of its own. */
const app = (extra: Raw = {}): Raw => ({
  name: 'Lending',
  resources: { lead: { access: 'write' }, vehicle: {} },
  auth: { roles: { clerk: { read: ['lead'], write: ['lead'] }, manager: { read: true } } },
  views: { leads: LEADS },
  home: [{ view: 'leads' }],
  ...extra,
});
/** Features with one view each and a fragment of it. */
const inventory = (extra: Raw = {}): Raw => ({ id: 'inventory', views: { vehicles: VEHICLES }, nav: ['vehicles'], ...extra });
const desk = (extra: Raw = {}): Raw => ({ id: 'desk', views: { desk: DESK }, nav: ['desk'], ...extra });
const parse = (raw: Raw) => parseAppConfig(raw, WHERE);
const refuses = (raw: Raw, message: RegExp) => assert.throws(() => parse(raw), message);
const facts = (report: string) => report.split('\n').filter((line) => line && !line.startsWith('#'));

describe('feature role realms remain root-owned', () => {
  const tenant = (rootRealm: unknown, featureGrant: Raw): Raw => ({
    id: 'lending',
    name: 'Lending',
    sources: { business: { connection: 'db' } },
    resources: { lead: { owner: 'tenant' } },
    auth: {
      rows: 'tenant',
      ...(rootRealm === undefined ? {} : { tenancy: { label: 'Dealer', platform: { label: 'Lender' } } }),
      roles: { reader: { read: ['lead'], ...(rootRealm === undefined ? {} : { realm: rootRealm }) } },
    },
    views: { leads: LEADS },
    home: 'leads',
    features: [{ id: 'desk', auth: { roles: { reader: featureGrant } } }],
  });
  test('an identical explicit realm restatement preserves the flat definition and authority', () => {
    const raw = tenant('tenant', { realm: 'tenant', read: ['lead'] });
    const flat = { ...raw, features: undefined };
    assert.deepEqual(parse(raw), parse(flat));
    assert.deepEqual(facts(authorityReport(parse(raw))), facts(authorityReport(parse(flat))));
  });
  test('omitting a feature realm preserves the root default', () => {
    assert.equal(parse(tenant(undefined, { read: ['lead'] })).auth?.roles?.reader.realm, undefined);
  });
  test('an explicit platform restatement also composes without granting realm authority', () => {
    const raw = tenant('platform', { realm: 'platform' });
    const { root } = composeFeatures(raw, WHERE);
    assert.deepEqual((root as Raw).auth, raw.auth);
  });
  test('identical malformed realm spellings still meet the normal parser refusal', () => {
    refuses(tenant('global', { realm: 'global' }), /realm.*tenant.*platform/);
  });
  for (const realm of ['tenant', 'platform']) {
    test(`a feature cannot introduce ${realm}, even when the root realm is implicit`, () => {
      refuses(tenant(undefined, { realm }), /features "desk".*"realm" is not declared by the App/);
    });
    test(`a feature cannot change the root ${realm} realm`, () => {
      refuses(tenant(realm, { realm: realm === 'tenant' ? 'platform' : 'tenant' }), /features "desk".*"realm" differs from the App's/);
    });
  }
  test('one feature cannot establish a realm for another to restate', () => {
    const raw = tenant(undefined, { realm: 'tenant' });
    (raw.features as Raw[]).push({ id: 'other', auth: { roles: { reader: { realm: 'tenant' } } } });
    refuses(raw, /"realm" is not declared by the App/);
  });
  test('removed members grants are refused, not silently composed', () => {
    refuses(tenant('tenant', { members: { grant: ['reader'] } }), /features "desk".*has no "members"/);
    const raw = tenant('tenant', {});
    (raw.auth as { roles: { reader: Raw } }).roles.reader.members = { grant: ['reader'] };
    refuses(raw, /has no "members"/);
  });
});

describe('features merge into one App', () => {
  test('a root without features passes through untouched', () => {
    const raw = app({ nav: ['leads'] });
    const { root, origins } = composeFeatures(raw, WHERE);
    assert.equal(root, raw);
    assert.deepEqual(origins, { features: [], views: {}, pages: {}, authority: {}, nav: [], resources: {} });
  });

  test('a composed App is the flat App it spells, pages included', () => {
    const display = { name: { tone: { sold: 'good' } } };
    const page = { base: 'vehicle' };
    const flat = app({
      resources: { lead: { access: 'write' }, vehicle: { display } },
      views: { leads: LEADS, vehicles: VEHICLES },
      pages: { vehicle: page },
      nav: ['leads', navGroup('stock', 'Stock', ['vehicles'])],
    });
    const composed = app({
      nav: ['leads', { feature: 'inventory' }],
      features: [
        inventory({ resources: { vehicle: { display } }, pages: { vehicle: page }, nav: [navGroup('stock', 'Stock', ['vehicles'])] }),
      ],
    });
    assert.deepEqual(parse(composed), parse(flat));
    assert.deepEqual(parseAppPages(composed, WHERE), parseAppPages(flat, WHERE));
  });

  test('a record name keeps its feature provenance for catalog diagnostics', () => {
    const raw = app({ features: [inventory({ resources: { vehicle: { recordLabel: 'model.name' } } })] });
    const { origins } = composeFeatures(raw, WHERE);
    assert.equal(
      locateProblem(origins, 'resources "vehicle": recordLabel "model.name": no such path'),
      'features "inventory", resources "vehicle": recordLabel "model.name": no such path',
    );
  });

  test('identical facts merge; actions and validation run the App first, then each feature', () => {
    const tone = { tone: { new: 'info' } };
    const finish = { label: 'Finish', set: { status: 'done' }, when: 'status = new' };
    const named = { must: 'name is not empty', message: 'A lead has a name.' };
    const lead = {
      access: 'write',
      display: { status: tone },
      labels: { name: 'Applicant' },
      form: { show: ['name'] },
      actions: { finish },
      validation: [named],
    };
    const composed = parse(
      app({
        resources: { lead, vehicle: {} },
        features: [
          inventory({
            resources: {
              lead: {
                ...lead,
                actions: { finish, drop: { label: 'Drop', set: { status: 'dropped' } } },
                validation: [named, { must: 'status is not empty', message: 'A lead has a status.' }],
              },
            },
          }),
        ],
      }),
    );
    const merged = composed.resources!.lead;
    assert.deepEqual(
      merged.actions?.map((action) => action.label),
      ['Finish', 'Drop'],
    );
    assert.deepEqual(
      merged.validation?.map((rule) => rule.message),
      ['A lead has a name.', 'A lead has a status.'],
    );
    assert.deepEqual(
      [merged.access, merged.display, merged.labels, merged.form?.show],
      ['write', { status: { ...tone, humanize: true } }, { name: 'Applicant' }, ['name']],
    );
  });
});

describe('conflicting facts are refused, naming both contributors', () => {
  const approve = (version: number) => ({ id: 'approve', version, target: 'lead', input: {} });
  const cases: Array<[string, Raw, RegExp]> = [
    [
      'a display rule',
      app({
        resources: { lead: { access: 'write', display: { name: { format: 'number' } } }, vehicle: {} },
        features: [inventory({ resources: { lead: { display: { name: { format: 'money' } } } } })],
      }),
      /: resources "lead" display "name" is set by the App and features "inventory", differently\. One rule per column/,
    ],
    [
      'a caption, between two features',
      app({
        features: [
          inventory({ resources: { vehicle: { labels: { name: 'Model' } } } }),
          desk({ resources: { vehicle: { labels: { name: 'Vehicle' } } } }),
        ],
      }),
      /: resources "vehicle" labels "name" is set by features "inventory" and features "desk", differently\. One caption per column/,
    ],
    [
      'a record name',
      app({
        features: [
          inventory({ resources: { vehicle: { recordLabel: 'model' } } }),
          desk({ resources: { vehicle: { recordLabel: 'vin' } } }),
        ],
      }),
      /: resources "vehicle" recordLabel is declared by features "inventory" and features "desk", differently\. A resource has one record name/,
    ],
    [
      'a New form',
      app({
        resources: { lead: { access: 'write', form: { show: ['name'] } }, vehicle: {} },
        features: [inventory({ resources: { lead: { form: { show: ['status'] } } } })],
      }),
      /: resources "lead" form is declared by the App and features "inventory", differently\. A New form is one per resource/,
    ],
    [
      'the page records open through',
      app({ features: [inventory({ resources: { vehicle: { page: 'stock' } } }), desk({ resources: { vehicle: { page: 'sales' } } })] }),
      /: resources "vehicle" page is declared by features "inventory" and features "desk", differently/,
    ],
    [
      'an action under one id',
      app({
        resources: { lead: { access: 'write', actions: { finish: { label: 'Finish', set: { status: 'done' } } } }, vehicle: {} },
        features: [
          inventory({ resources: { lead: { actions: { finish: { label: 'Finish', set: { status: 'done' }, when: 'status = new' } } } } }),
        ],
      }),
      /: resources "lead" has the action "finish" from the App and features "inventory", and they differ in "when"\. An id names one action on a resource/,
    ],
    [
      'a command reference',
      app({
        resources: { lead: { access: 'write', actions: { approve: { label: 'Approve', command: approve(1) } } }, vehicle: {} },
        features: [inventory({ resources: { lead: { actions: { approveAll: { label: 'Approve all', command: approve(2) } } } } })],
      }),
      /the command "approve" is referenced by the App \(resources "lead", action "approve"\) and features "inventory" \(resources "lead", action "approveAll"\), and the references differ in "version"/,
    ],
    [
      'a restated ceiling',
      app({
        resources: { lead: { access: 'write' }, vehicle: { physical: 'stock.vehicle' } },
        features: [inventory({ resources: { vehicle: { physical: 'other.vehicle' } } })],
      }),
      /: resources "vehicle" physical is stated by the App and features "inventory", differently\. A feature restates the App's bindings and ceilings exactly, and never widens them\./,
    ],
    [
      'a column grant',
      app({
        auth: { roles: { clerk: { read: ['lead'], fields: { lead: { read: ['id', 'name'] } } }, manager: { read: true } } },
        features: [inventory({ auth: { roles: { clerk: { fields: { lead: { read: ['id'] } } } } } })],
      }),
      /: "auth", role "clerk" fields "lead" are granted by the App and features "inventory", differently\. A column grant is one fact/,
    ],
  ];
  for (const [what, raw, message] of cases) test(what, () => refuses(raw, message));
});

describe('ids are global across the App and its features', () => {
  test('a view key, between the App and a feature, and between two features', () => {
    refuses(
      app({ features: [inventory({ views: { leads: LEADS, vehicles: VEHICLES } })] }),
      /: views "leads" is declared by the App and features "inventory"\. A view key is its address, so it is declared once across the App and its features: rename one\./,
    );
    refuses(
      app({ features: [inventory(), desk({ views: { vehicles: VEHICLES } })] }),
      /: views "vehicles" is declared by features "inventory" and features "desk"\./,
    );
  });

  test('a page key, and a nav group id', () => {
    const page = { base: 'vehicle' };
    refuses(
      app({ pages: { vehicle: page }, features: [inventory({ pages: { vehicle: page } })] }),
      /: pages "vehicle" is declared by the App and features "inventory"\./,
    );
    refuses(
      app({
        nav: [navGroup('stock', 'Stock', ['leads']), { feature: 'inventory' }],
        features: [inventory({ nav: [navGroup('stock', 'More stock', ['vehicles'])] })],
      }),
      /: the nav group "stock" is declared by the App and features "inventory"\. A group id is unique across the App's nav and every fragment in it\./,
    );
  });

  test('a feature id', () => refuses(app({ features: [inventory(), inventory()] }), /: features 1 and 2 both have the id "inventory"\./));
});

describe("a feature's authority only adds, and only to what the App declares", () => {
  test("grants add to the App's roles, by name", () => {
    const composed = parse(
      app({
        features: [
          inventory({
            auth: {
              roles: {
                clerk: { read: ['vehicle'], commands: ['sell'] },
                manager: { read: ['vehicle'], operations: ['readiness'] },
              },
            },
          }),
        ],
      }),
    );
    assert.deepEqual(composed.auth?.roles, {
      clerk: { read: ['lead', 'vehicle'], write: ['lead'], commands: ['sell'] },
      manager: { read: true, write: false, operations: ['readiness'] },
    });
  });

  test('a feature never creates a role, never grants a whole ceiling, and never reaches past one', () => {
    const grant = (roles: Raw, extra: Raw = {}) => app({ ...extra, features: [inventory({ auth: { roles } })] });
    refuses(
      grant({ auditor: { read: ['lead'] } }),
      /: features "inventory", "auth", role "auditor" is not a role the App declares; a feature grants to the App's roles and never creates one\. The App declares: clerk, manager\./,
    );
    refuses(
      grant({ clerk: { read: true } }),
      /role "clerk", "read" is true\. A feature grants the resources its content needs by name; true, the App's whole ceiling, is the App's to grant\./,
    );
    refuses(
      grant({ clerk: { read: ['vehicle'], write: ['vehicle'] } }),
      /role "clerk", "write" names "vehicle", which is outside the App's write ceiling\. A feature grants within the ceilings the App states, and never widens them\. Resources with access 'write': lead\./,
    );
    refuses(grant({ clerk: { read: ['dealer'] } }), /"read" names "dealer", which is outside the App's read ceiling/);
    refuses(
      grant({ clerk: { read: ['vehicle'] } }, { auth: undefined }),
      /features "inventory", "auth" grants to roles, and the App declares none in auth\.roles\. A feature grants to the App's roles and never creates one\./,
    );
  });

  test("a binding or ceiling a feature states is the App's own, exactly", () => {
    refuses(
      app({ features: [inventory({ resources: { dealer: { access: 'write' } } })] }),
      /: features "inventory", resources "dealer" has "access", which the App does not state\. A feature restates the App's bindings and ceilings and never widens them: state it in the App's resources\.dealer, or drop it from the feature\./,
    );
    refuses(
      app({ features: [inventory({ resources: { vehicle: { physical: 'stock.vehicle' } } })] }),
      /resources "vehicle" has "physical", which the App does not state/,
    );
    assert.equal(parse(app({ features: [inventory({ resources: { vehicle: {} } })] })).resources?.vehicle.access, undefined);
  });
});

describe('home rules append after the App', () => {
  test('in features order, and the parser judges the combined list', () => {
    const composed = parse(
      app({
        home: [{ view: 'leads', roles: ['clerk'] }],
        features: [inventory({ home: [{ view: 'vehicles', roles: ['manager'] }] }), desk({ home: [{ view: 'desk' }] })],
      }),
    );
    assert.deepEqual(composed.home, [{ view: 'leads', roles: ['clerk'] }, { view: 'vehicles', roles: ['manager'] }, { view: 'desk' }]);
  });

  test("no rule follows another contributor's rule that already matches everyone", () => {
    refuses(
      app({ home: 'leads', features: [inventory({ home: [{ view: 'vehicles' }] })] }),
      /: home rule 1 of features "inventory" can never match: rule 1 of the App has no condition and matches every visitor first\./,
    );
    refuses(
      app({
        home: [{ view: 'leads', roles: ['clerk'] }],
        features: [inventory({ home: [{ view: 'vehicles' }] }), desk({ home: [{ view: 'desk', roles: ['manager'] }] })],
      }),
      /: home rule 1 of features "desk" can never match: rule 1 of features "inventory" has no condition/,
    );
  });
});

describe("{ feature } places a fragment in the App's nav", () => {
  test('at the root and inside a group; without an App nav, fragments are the menu in order', () => {
    assert.deepEqual(parse(app({ nav: ['leads', { feature: 'inventory' }], features: [inventory()] })).nav, [
      { view: 'leads' },
      { view: 'vehicles' },
    ]);
    assert.deepEqual(
      parse(
        app({
          nav: [navGroup('work', 'Work', ['leads', { feature: 'inventory' }])],
          features: [inventory({ nav: [navGroup('stock', 'Stock', ['vehicles'])] })],
        }),
      ).nav,
      [
        {
          group: 'work',
          label: 'Work',
          children: [{ view: 'leads' }, { group: 'stock', label: 'Stock', children: [{ view: 'vehicles' }] }],
        },
      ],
    );
    assert.deepEqual(parse(app({ features: [inventory(), desk()] })).nav, [{ view: 'vehicles' }, { view: 'desk' }]);
  });

  test('each fragment is placed once, by a feature the App lists', () => {
    refuses(
      app({ nav: ['leads', { feature: 'stock' }], features: [inventory()] }),
      /: nav entry 2 places features "stock", which the App does not list\. It lists: inventory\./,
    );
    refuses(
      app({ nav: [{ feature: 'inventory' }, { feature: 'inventory' }], features: [inventory()] }),
      /: nav entry 2 places features "inventory" a second time; a fragment is placed once\./,
    );
    refuses(
      app({ nav: ['leads', 'vehicles'], features: [inventory()] }),
      /: features "inventory" has a nav fragment that the App's nav does not place\. Put \{ feature: 'inventory' \} where it belongs, or drop the feature's nav\./,
    );
    refuses(
      app({
        nav: ['leads', 'vehicles', { feature: 'desk' }],
        features: [inventory({ nav: undefined }), desk({ nav: undefined, home: [{ view: 'desk' }] })],
        home: [{ view: 'leads', roles: ['clerk'] }],
      }),
      /: nav entry 3 places features "desk", which has no nav fragment to place/,
    );
    refuses(app({ nav: [{ feature: 'inventory' }] }), /: "nav" places \{ feature: 'inventory' \}, and the App lists no "features"\./);
  });

  test('a fragment arranges its own views, and places nothing', () => {
    refuses(
      app({ features: [inventory({ nav: ['vehicles', 'leads'] })] }),
      /: features "inventory", nav entry 2 names the view "leads", which the App declares\. A feature's nav arranges its own views; arrange across features in the App's nav\./,
    );
    refuses(
      app({ features: [inventory({ nav: ['vehicles', 'desk'] }), desk()] }),
      /nav entry 2 names the view "desk", which features "desk" declares/,
    );
    refuses(
      app({ features: [inventory({ nav: [navGroup('stock', 'Stock', [{ feature: 'desk' }])] }), desk()] }),
      /: features "inventory", nav entry 1 \(stock\): nav entry 1 places features "desk"\. Placing a fragment is the App's nav's work/,
    );
  });
});

describe('a feature says only what a feature may', () => {
  test("the App's keys are refused with where they go", () => {
    refuses(
      app({ features: [inventory({ name: 'Stock' })] }),
      /: features "inventory" has "name", which is the App's: an App is named once, in its own name\./,
    );
    refuses(app({ features: [inventory({ ui: {} })] }), /features "inventory" has "ui", which is the App's: chrome is one per App/);
    refuses(app({ features: [inventory({ sources: {} })] }), /features "inventory" has "sources", which is the App's/);
    refuses(app({ features: [inventory({ features: [] })] }), /has "features", which is the App's: composition is one level/);
    refuses(
      app({ features: [inventory({ auth: { rows: 'all', roles: { clerk: { read: ['vehicle'] } } } })] }),
      /: features "inventory", "auth" has "rows", which is the App's: sign-in and row scoping are one security manifest, in the App's auth\./,
    );
  });

  test('anything else is refused with what its place takes; an empty feature is refused', () => {
    refuses(
      app({ features: [inventory({ labels: {} })] }),
      /: features "inventory" has no "labels"\. "labels" belongs inside a resource block\. It takes: id, resources, auth, views, pages, nav, home, api, flags, audiences, experiments, analytics\./,
    );
    refuses(
      app({ features: [inventory({ resources: { vehicle: { lable: {} } } })] }),
      /: features "inventory", resources "vehicle" has no "lable"\. Did you mean "labels"\? It takes: physical, access/,
    );
    refuses(app({ features: [{ id: 'empty' }] }), /: features "empty" contributes nothing/);
    refuses(app({ features: [{ id: 'Stock', views: {} }] }), /: features 1 needs an "id" of lowercase letters, digits and hyphens/);
    refuses(app({ features: {} }), /"features" must be a list of at most 64 features/);
  });

  test("validation's cap is the merged list's, counted by contributor", () => {
    const rules = (n: number, from: string) =>
      Array.from({ length: n }, (_, i) => ({ must: 'name is not empty', message: `${from} ${i}` }));
    refuses(
      app({
        resources: { lead: { access: 'write', validation: rules(100, 'app') }, vehicle: {} },
        features: [inventory({ resources: { lead: { validation: rules(29, 'feature') } } })],
      }),
      /: resources "lead" has 129 validation rules \(the App 100, features "inventory" 29\); the limit is 128\./,
    );
  });

  test('defineFeature returns exactly the data it is given', () => {
    const feature = inventory();
    assert.equal(defineFeature(feature as never), feature);
  });
});

describe('the authority report', () => {
  test('one fact per line, sorted, each naming who contributes it', () => {
    const raw = app({ features: [inventory({ resources: { vehicle: {} }, auth: { roles: { clerk: { read: ['vehicle'] } } } })] });
    const { root, origins } = composeFeatures(raw, WHERE);
    const report = authorityReport(parseAppConfig(root, WHERE), origins);
    assert.deepEqual(facts(report), [
      'auth providers email — the App',
      'auth sign-up invite — the App',
      'auth default-role user — the App',
      'auth rows all — the App',
      'scope roles: every read and write is granted by role, within the ceilings — the App',
      'resource lead access write — the App',
      'role clerk read lead — the App',
      'role clerk read vehicle — features "inventory"',
      'role clerk write lead — the App',
      'role manager read lead — the App',
      'role manager read vehicle — the App',
    ]);
    /* The flat App granting the same: the same facts, other contributors. */
    const flat = authorityReport(
      parse(app({ auth: { roles: { clerk: { read: ['lead', 'vehicle'], write: ['lead'] }, manager: { read: true } } }, nav: [] })),
    );
    assert.deepEqual(authorityDiff(flat, report, 'facts'), []);
    assert.deepEqual(authorityDiff(flat, report), [
      '- role clerk read vehicle — the App',
      '+ role clerk read vehicle — features "inventory"',
    ]);
  });

  test('a public form is authority, named by the feature that brings it', () => {
    const commands = catalogOf({ apply: { public: true, input: { name: { label: 'Name', type: 'text', optional: true } } } });
    const raw = app({
      home: [{ view: 'finance', signedOut: true }, { view: 'leads' }],
      features: [{ id: 'public', views: { finance: commandForm('Apply', 'apply', [step('You', ['name'])], { public: true }) } }],
    });
    const { root, origins } = withCommandCatalog(commands, () => composeFeatures(raw, WHERE));
    assert.ok(
      facts(authorityReport(parseAppConfig(root, WHERE, { commands }), origins)).includes(
        'public form finance runs command apply version 1 — features "public"',
      ),
    );
  });

  test('without role grants, the scope says who decides, and each declared resource is a read', () => {
    const open = (resources: Raw) => facts(authorityReport(parse({ name: 'Open', resources, views: { leads: LEADS }, home: 'leads' })));
    assert.deepEqual(open({ lead: {} }), [
      'auth none — the App',
      "scope ceilings: the declared resources read, and only those with access 'write' write — the App",
      'resource lead reads — the App',
    ]);
    assert.ok(
      open({ lead: { access: 'write' } }).includes(
        "scope ceilings: the declared resources read, and only those with access 'write' write — the App",
      ),
    );
  });
});

describe('a refusal about what a feature wrote names the feature', () => {
  test('a view, an unreferenced view and a page', () => {
    refuses(
      app({ features: [inventory({ views: { vehicles: { ...VEHICLES, lable: 'Stock' } } })] }),
      /test\/app\.json: features "inventory", views "vehicles" has no "lable"\./,
    );
    refuses(
      app({
        features: [
          inventory({
            views: { vehicles: VEHICLES, spare: { kind: 'dashboard', label: 'Spare', sections: [{ kind: 'note', text: 'hi' }] } },
          }),
        ],
      }),
      /test\/app\.json: features "inventory", views "spare" is referenced by nothing/,
    );
    refuses(
      app({ features: [inventory({ pages: { vehicle: { base: 'vehicle', bogus: true } } })] }),
      /test\/app\.json: features "inventory", pages "vehicle" \("Vehicle"\) has no "bogus"/,
    );
  });

  test('a nav entry, numbered as its fragment has it, at the root, inside groups and without an App nav', () => {
    const bare = { to: 'vehicles' } as never; // a menu-only word without its label: the parser's to refuse
    refuses(
      app({ nav: ['leads', { feature: 'inventory' }], features: [inventory({ nav: [bare] })] }),
      /test\/app\.json: features "inventory", nav entry 1: \{ label, to \} needs a non-blank label/,
    );
    refuses(
      app({
        nav: [navGroup('work', 'Work', ['leads', { feature: 'inventory' }])],
        features: [inventory({ nav: [navGroup('stock', 'Stock', [bare])] })],
      }),
      /test\/app\.json: features "inventory", nav entry 1 \(stock\): nav entry 1: \{ label, to \}/,
    );
    refuses(app({ features: [desk(), inventory({ nav: [bare] })] }), /test\/app\.json: features "inventory", nav entry 1: \{ label, to \}/);
  });

  test('a home rule, a resource fact, an action and a role grant, each at its own number', () => {
    refuses(
      app({
        home: [{ view: 'leads', roles: ['clerk'] }],
        features: [inventory({ home: [{ view: 'vehicles', roles: ['nobody'] }, { view: 'vehicles' }] })],
      }),
      /test\/app\.json: features "inventory", "home", rule 1 names the role "nobody", which auth\.roles does not declare/,
    );
    refuses(
      app({ features: [inventory({ resources: { vehicle: { display: { name: { format: 'bogus' } } } } })] }),
      /test\/app\.json: features "inventory", resources "vehicle", display "name" has a "format" of "bogus"/,
    );
    refuses(
      app({
        resources: { lead: { access: 'write', actions: { finish: { label: 'Finish', set: { status: 'done' } } } }, vehicle: {} },
        features: [inventory({ resources: { lead: { actions: { drop: { label: 'Drop' } } } } })],
      }),
      /test\/app\.json: features "inventory", resources "lead", action "drop" has no "set"/,
    );
    refuses(
      app({
        auth: { roles: { clerk: { read: ['lead'], write: ['lead'] }, manager: { read: true }, auditor: { read: ['vehicle'] } } },
        features: [inventory({ auth: { roles: { auditor: { write: ['lead'] } } } })],
      }),
      /test\/app\.json: features "inventory", "auth", role "auditor", "write" names "lead", which the role does not read\./,
    );
  });

  test("the App's own words read as they did", () => {
    refuses(
      app({ views: { leads: { ...LEADS, lable: 'L' } }, features: [inventory()] }),
      /test\/app\.json: views "leads" has no "lable"\./,
    );
  });
});

test('defineFeature and defineApp check what a feature contributes', () => {
  const filename = new URL('./.app-features-types.ts', import.meta.url).pathname;
  const source = `import { defineApp, defineFeature, dashboard, navGroup, action, page, type TypedAppConfig, type TypedFeature, listView, queue, embed } from '@mistriwork/mistri/app';
    type Tables = { lead: 'id' | 'name' | 'status'; vehicle: 'id' | 'name' | 'price' };
    type App = TypedAppConfig<Tables>;
    type Feature = TypedFeature<Tables>;

    // A feature is typed like an App: the schema layer by satisfies, its fragment by defineFeature.
    export const inventory = defineFeature({ id: 'inventory',
      resources: { vehicle: { display: { price: { format: 'money' } }, actions: { sell: action('Sell', { set: { name: 'sold' } }) } } },
      auth: { roles: { clerk: { read: ['vehicle'], realm: 'tenant' } } },
      views: {
        vehicles: listView('Vehicle', 'vehicle', { filters: ['name'] }),
        'for-sale': listView('Vehicle', 'vehicle', { presentation: queue('name'), actions: ['sell'] }),
      },
      pages: { vehicle: page('vehicle', []) },
      nav: [navGroup('stock', 'Stock', ['vehicles', 'for-sale'])],
    } satisfies Feature);
    // Its dashboard embeds another feature's list view, and its home rule names its own: checked where every feature is known.
    export const desk = defineFeature({ id: 'desk', views: { desk: dashboard('Desk', [embed('vehicles')]) }, home: [{ view: 'desk' }] } satisfies Feature);

    export const composed = defineApp({ name: 'Lending',
      resources: { lead: { access: 'write' }, vehicle: {} },
      auth: { roles: { clerk: { read: ['lead'], write: ['lead'] } } },
      views: { leads: listView('Lead', 'lead') },
      features: [inventory, desk],
      home: [{ view: 'leads', roles: ['clerk'] }],
      nav: ['leads', { feature: 'inventory' }, 'desk'],
    } satisfies App);
    // A list of features built beforehand still checks, and a group takes a placement.
    const all = [inventory, desk];
    export const listed = defineApp({ name: 'Lending', features: all, home: 'desk', nav: [navGroup('work', 'Work', [{ feature: 'inventory' }, 'desk'])] });

    // @ts-expect-error A fragment arranges the feature's own views.
    export const foreignNav = defineFeature({ id: 'x', views: { a: listView('T', 't') }, nav: ['b'] });
    // @ts-expect-error A fragment places no feature: placing is the App's nav's work.
    export const nestedPlacement = defineFeature({ id: 'x', views: { a: listView('T', 't') }, nav: ['a', { feature: 'y' }] });
    // @ts-expect-error A name is the App's.
    export const named = defineFeature({ id: 'x', name: 'X', views: { a: listView('T', 't') } });
    // @ts-expect-error Row scoping is the App's.
    export const scoped = defineFeature({ id: 'x', auth: { rows: 'all', roles: { clerk: { read: ['t'] } } } });
    // @ts-expect-error A feature grants by name; true is the App's whole ceiling.
    export const everything = defineFeature({ id: 'x', auth: { roles: { clerk: { read: true } } } });
    // @ts-expect-error A realm is one of the two supported names.
    export const badRealm = { id: 'x', auth: { roles: { clerk: { realm: 'global' } } } } satisfies Feature;
    // @ts-expect-error Feature member administration is reserved, not supported authoring syntax.
    export const members = { id: 'x', auth: { roles: { clerk: { members: { grant: ['clerk'] } } } } } satisfies Feature;
    // @ts-expect-error A display rule is keyed by a column of its resource.
    export const badColumn = defineFeature({ id: 'x', resources: { vehicle: { display: { nope: { format: 'money' } } } } } satisfies Feature);
    // @ts-expect-error A placement names a feature that brings a fragment.
    export const noFragment = defineApp({ name: 'x', features: [inventory, desk], home: 'vehicles', nav: [{ feature: 'desk' }] });
    // @ts-expect-error nav names a view that no contributor declares.
    export const unknownView = defineApp({ name: 'x', features: [inventory], home: 'vehicles', nav: ['nope'] });
    // @ts-expect-error A feature's dashboard embeds a list view that some contributor declares.
    export const badEmbed = defineApp({ name: 'x', features: [inventory, { id: 'y', views: { d: dashboard('D', [embed('nope')]) } }], home: 'd' });
    // @ts-expect-error A feature's home names a view that some contributor declares.
    export const badHome = defineApp({ name: 'x', features: [inventory, { id: 'y', home: [{ view: 'nope' }] }], home: 'vehicles' });
    // @ts-expect-error A selector names an action some contributor offers on that resource.
    export const badSelector = defineApp({ name: 'x', features: [inventory, { id: 'y', views: { q: listView('Vehicle', 'vehicle', { presentation: queue('name'), actions: ['Buy'] }) } }], home: 'q' });
  `;
  assert.equal(typecheck(filename, { files: { [filename]: source } }), '');
});
