/**
 * Where a visitor starts, as the server resolves it: the home rules read in
 * order, the first match winning; roles from the verified session, or in a
 * tenant App from the current membership; a signed-out visitor told a
 * public home and nothing else; and a view a principal cannot open giving
 * way to the next rule that matches, so nobody starts on a room that is not
 * there for them.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import { type AppDef } from '../packages/mistri/src/shared/app.js';
import { homeRuleMatches, parseHome, publicHome, resolveHome, type HomePrincipal } from '../packages/mistri/src/shared/appHome.js';
import { appProblems, loadApp, type AppHost } from '../packages/mistri/src/server/app/apps.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { projectTenantMetadata } from '../packages/mistri/src/server/tenant/tenantMetadata.js';
import type { ColumnMeta, DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { APPLICANTS_SCHEMA } from '../examples/databases/ignition/schema.mjs';
import { ignitionTenantFixture } from './support/ignitionTenantFixture.js';
import { parseTestApp } from './support/commandCatalog.js';

const signedIn = (...roles: string[]): HomePrincipal => ({ signedIn: true, roles });
const signedOut: HomePrincipal = { signedIn: false };

describe('the rules', () => {
  const app: Pick<AppDef, 'home'> = {
    home: [
      { view: 'welcome', signedOut: true },
      { view: 'desk', roles: ['boss'] },
      { view: 'queue', roles: ['clerk', 'boss'] },
      { view: 'overview' },
    ],
  };

  test('are read in order, and the first that matches wins', () => {
    assert.equal(resolveHome(app, signedIn('boss')), 'desk', 'boss matches desk and queue; desk comes first');
    assert.equal(resolveHome(app, signedIn('clerk')), 'queue');
    assert.equal(resolveHome(app, signedIn('guest')), 'overview');
    assert.equal(resolveHome(app, signedIn()), 'overview');
    const reversed = { home: [app.home[2], app.home[1], app.home[3]] };
    assert.equal(resolveHome(reversed, signedIn('boss')), 'queue', 'the same rules the other way round');
  });

  test('a roles rule matches a signed-in visitor holding any of its roles; a person with two takes the first rule either matches', () => {
    assert.equal(resolveHome(app, signedIn('clerk', 'boss')), 'desk');
    assert.equal(resolveHome(app, signedIn('guest', 'clerk')), 'queue');
    assert.equal(homeRuleMatches({ view: 'desk', roles: ['boss'] }, signedOut), false, 'a signed-out visitor holds no role');
  });

  test('a signedOut rule matches only a visitor with no session; a rule with no condition matches everyone', () => {
    assert.equal(resolveHome(app, signedOut), 'welcome');
    for (const principal of [signedIn(), signedIn('boss')])
      assert.equal(homeRuleMatches({ view: 'welcome', signedOut: true }, principal), false);
    for (const principal of [signedOut, signedIn(), signedIn('boss')]) assert.equal(homeRuleMatches({ view: 'overview' }, principal), true);
  });

  test('a string home is one rule, the same view for everyone', () => {
    const one = parseTestApp(
      { name: 'x', resources: { task: {} }, views: { tasks: { kind: 'list', from: 'task' } }, home: 'tasks' },
      'string home',
    );
    assert.deepEqual(one.home, [{ view: 'tasks' }]);
    for (const principal of [signedOut, signedIn(), signedIn('boss')]) assert.equal(resolveHome(one, principal), 'tasks');
  });

  test('a rule whose view the principal cannot open gives way to the next that matches; none left is no home', () => {
    assert.equal(
      resolveHome(app, signedIn('boss'), (view) => view !== 'desk'),
      'queue',
    );
    assert.equal(
      resolveHome(app, signedIn('boss'), (view) => view === 'overview'),
      'overview',
    );
    assert.equal(
      resolveHome(app, signedIn('boss'), () => false),
      undefined,
    );
  });
});

/* ---------- on the wire ---------- */

const LANDING = { kind: 'landing', label: 'Welcome', hero: { heading: 'Welcome in', actions: [{ label: 'Staff sign in', signIn: true }] } };
const FORM = {
  kind: 'form',
  label: 'Apply',
  public: true,
  steps: [{ id: 'you', label: 'You', fields: ['applicant'] }],
  command: { id: 'apply', version: 1, input: { applicant: { label: 'Name', type: 'text' } } },
};
/* boss reads everything; clerk every table but not a lead's private note,
   so the desk, which shows it, is withheld from a clerk; visitor and guest
   read leads alone. */
const manifest = {
  id: 'home-fixture',
  name: 'Home fixture',
  connection: 'home-db',
  resources: { lead: {}, activity: {} },
  auth: {
    roles: {
      boss: { read: true },
      clerk: { read: true, fields: { lead: { read: ['id', 'name', 'status'] } } },
      visitor: { read: ['lead'] },
      guest: { read: ['lead'] },
    },
  },
  views: {
    welcome: LANDING,
    leads: { kind: 'list', from: 'lead' },
    activities: { kind: 'list', from: 'activity' },
    desk: { kind: 'dashboard', label: 'Desk', sections: [{ kind: 'rows', title: 'Notes', from: 'lead', show: ['name', 'private_note'] }] },
    overview: { kind: 'dashboard', label: 'Overview', sections: [{ kind: 'metric', title: 'Activity', from: 'activity' }] },
  },
  home: [
    { view: 'welcome', signedOut: true },
    { view: 'desk', roles: ['boss', 'clerk'] },
    { view: 'activities', roles: ['clerk'] },
    { view: 'welcome', roles: ['visitor'] },
    { view: 'overview' },
  ],
  nav: ['leads', 'activities', 'desk', 'overview'],
};
const definition = (extra: Record<string, unknown> = {}) => parseTestApp({ ...manifest, ...extra }, 'home fixture');

type Call = (path: string) => Promise<{ status: number; text: string; body: Record<string, any> }>;
async function serve(def: AppDef, run: (call: Call, as: (role: string | null) => void) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-home-'));
  const file = join(directory, 'home.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE lead (id INTEGER PRIMARY KEY, name TEXT NOT NULL, status TEXT, private_note TEXT);
    CREATE TABLE activity (id INTEGER PRIMARY KEY, lead_id INTEGER REFERENCES lead(id), detail TEXT);
    INSERT INTO lead VALUES (1, 'First lead', 'new', 'private'); INSERT INTO activity VALUES (1, 1, 'Called');`);
  db.close();
  const registry = new Registry();
  registry.add({ id: 'home-db', name: 'home-db', url: file, source: 'config', writable: false });
  let role: string | null = null;
  const host: AppHost = {
    app: { app: def, path: '/private/app.ts', pages: [], sources: {} },
    pages: [],
    auth: {
      spec: def.auth!,
      store: 'not-used',
      close() {},
      handler: async () => {},
      session: async () => (role === null ? null : { id: 'person-1', who: 'person@example.test', role }),
    },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host] });
  try {
    server.listen(0, bound.host);
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    bound.port = address.port;
    await run(
      async (path) => {
        const response = await fetch(`http://${bound.host}:${bound.port}${path}`, { signal: AbortSignal.timeout(5000) });
        const text = await response.text();
        return { status: response.status, text, body: JSON.parse(text) };
      },
      (next) => {
        role = next;
      },
    );
  } finally {
    const closed = new Promise<void>((done) => server.close(() => done()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('served', () => {
  test("/api/app carries each principal's home, after the views it cannot open are gone", async () => {
    await serve(definition(), async (call, as) => {
      const homeOf = async (role: string) => {
        as(role);
        const reply = await call('/api/app');
        assert.equal(reply.status, 200, reply.text);
        return reply.body.app;
      };
      assert.equal((await homeOf('boss')).home, 'desk');
      /* The clerk's rule names the desk, withheld from a clerk for the note it
         shows: the next rule the clerk matches is the one it starts on. */
      const clerk = await homeOf('clerk');
      assert.equal(Object.hasOwn(clerk.views, 'desk'), false);
      assert.equal(clerk.home, 'activities');
      /* One person, two roles: the first rule either matches, which boss's
         unrestricted read of the note lets them open. */
      assert.equal((await homeOf('clerk,boss')).home, 'desk');
      /* The landing as a signed-in home: a public view is always open, and
         is never among the views. */
      const visitor = await homeOf('visitor');
      assert.deepEqual([visitor.home, Object.hasOwn(visitor.views, 'welcome')], ['welcome', false]);
    });
  });

  test('a role whose read grants exclude the matched view never gets it', async () => {
    /* Refused at load for a roles rule... */
    assert.throws(
      () => definition({ home: [{ view: 'overview', roles: ['guest'] }, { view: 'leads' }] }),
      /the role "guest" does not read "activity", which the view "overview" shows/,
    );
    /* ...and at run time the rule for everyone, whose view reads what the
       guest may not, is no home for the guest: none is served, and the
       client draws the App's home card. */
    await serve(definition(), async (call, as) => {
      as('guest');
      const guest = (await call('/api/app')).body.app;
      assert.deepEqual([Object.hasOwn(guest.views, 'overview'), Object.hasOwn(guest, 'home')], [false, false]);
      assert.ok(Object.hasOwn(guest.views, 'leads'), 'the guest still has the App');
    });
  });

  test("the signed-out who-am-I carries the public home and nothing else about the App's views", async () => {
    await serve(definition(), async (call) => {
      const reply = await call('/api/whoami');
      assert.equal(reply.status, 200);
      assert.deepEqual(Object.keys(reply.body).sort(), [
        'accountId',
        'appId',
        'header',
        'home',
        'landingView',
        'signIn',
        'signedIn',
        'who',
      ]);
      assert.deepEqual([reply.body.signedIn, reply.body.home], [false, 'welcome']);
      /* The public home only: who-am-I names the landing's view key, and
         nothing else about the App's views. */
      assert.equal(reply.body.landingView, 'welcome');
      assert.doesNotMatch(reply.text, /desk|overview|activities|leads|boss|clerk/);
      assert.equal((await call('/api/app')).status, 401, 'the App itself stays behind sign-in');
    });
    /* Signed out on a view only a signed-in visitor opens: the sign-in
       screen first, and who-am-I names no view at all. */
    await serve(definition({ home: 'leads' }), async (call) => {
      const reply = await call('/api/whoami');
      assert.equal(Object.hasOwn(reply.body, 'home'), false);
      assert.doesNotMatch(reply.text, /leads/);
    });
    /* A public form is a public home too, named by its key. */
    const form = definition({
      views: { ...manifest.views, finance: FORM },
      home: [{ view: 'finance', signedOut: true }, { view: 'leads' }],
    });
    assert.equal(publicHome(form), 'finance');
    await serve(form, async (call) => {
      assert.equal((await call('/api/whoami')).body.home, 'finance');
    });
  });
});

describe('a tenant App', () => {
  const col = (name: string): ColumnMeta => ({ name, type: 'TEXT', nullable: name !== 'id', primaryKey: name === 'id', writable: false });
  const schema = (): DatabaseSchema => ({
    label: 'Tenant home',
    dialect: 'sqlite',
    readAt: '2026-09-11T00:00:00.000Z',
    foreignKeys: [],
    tables: [
      { id: 'item', name: 'item', schema: '', isView: false, insertable: false, deletable: false, columns: [col('id'), col('name')] },
      { id: 'note', name: 'note', schema: '', isView: false, insertable: false, deletable: false, columns: [col('id'), col('name')] },
    ],
  });
  test("the current membership's roles pick the home, so one person starts differently in each tenant", () => {
    const app = parseTestApp(
      {
        id: 'tenant-home',
        name: 'Tenant home',
        sources: { business: { connection: 'PRIVATE_CONNECTION' } },
        resources: { item: { physical: 'physical_item', owner: 'tenant' }, note: { physical: 'physical_note', owner: 'tenant' } },
        auth: { rows: 'tenant', roles: { operator: { read: true }, viewer: { read: ['item'] } } },
        views: { items: { kind: 'list', from: 'item' }, notes: { kind: 'list', from: 'note' } },
        home: [{ view: 'notes', roles: ['operator'] }, { view: 'items' }],
        nav: ['items', 'notes'],
      },
      'tenant home',
    );
    /* The same account: an operator in north, a viewer in south. */
    const memberships = { north: ['operator'], south: ['viewer'] };
    const homes = Object.fromEntries(
      Object.entries(memberships).map(([tenant, roles]) => [tenant, projectTenantMetadata(app, [], schema(), undefined, roles).app.home]),
    );
    assert.deepEqual(homes, { north: 'notes', south: 'items' });
  });
});

describe('Ignition', () => {
  /* Ignition is a tenant App, so its home is decided by the realm of the lease
     and then by the roles a verified membership admitted, rather than by a
     session's single role. The two agree — only a platform membership holds
     `manager`, only a dealership's holds `dealer_staff` — but the realm is what
     the projection is given, and the roles only choose among that realm's own
     rules. So each realm is asked for its home here, and asked again with the
     other realm's roles: a platform role carried into a tenant lease gets the
     dealership's home, never the lender's. That is the projection the tenant
     host serves, and it is what this reads — over the SQLite mirror of the
     sample's own schema, so the views are checked against real columns. Which
     rows each realm may then see is the tenant suites' subject, not this
     file's. */
  test("the lender's people start on the Portfolio, a dealership's on its own home, a signed-out visitor on the landing — each on a view drawn whole", async (t) => {
    const seeded = await ignitionTenantFixture(t);
    // The platform-only source, tables and no rows: the home views read its schema.
    const applicants = join(seeded.directory, 'applicants.db');
    const mirror = new DatabaseSync(applicants);
    try {
      mirror.exec(APPLICANTS_SCHEMA.replaceAll('public.', ''));
    } finally {
      mirror.close();
    }
    const registry = new Registry();
    t.after(() => registry.closeAll());
    registry.add({ id: 'loans', name: 'loans', url: seeded.path, source: 'config', writable: false });
    registry.add({ id: 'applicants', name: 'applicants', url: applicants, source: 'config', writable: false });
    const loaded = await loadApp(resolve('test/fixtures/apps/ignition'));
    const resources = await loadAppRuntimeResources(registry, loaded.app, 'loans');
    assert.deepEqual(appProblems(loaded, resources.schema), []);
    /* Signed out there is no membership and so no realm: the landing, and the
       App's own rules never reach a room. */
    assert.equal(publicHome(loaded.app), 'welcome');
    for (const [realm, roles, expected] of [
      ['platform', ['platform_admin'], 'portfolio'],
      ['platform', ['manager'], 'portfolio'],
      ['platform', ['reviewer'], 'portfolio'],
      ['tenant', ['dealer_admin'], 'dealer-home'],
      ['tenant', ['dealer_staff'], 'dealer-home'],
      ['tenant', ['dealer_viewer'], 'dealer-home'],
      /* One person, two dealerships, two roles in the same realm: still the
         dealership's home, because both rules that could match name it. */
      ['tenant', ['dealer_staff', 'dealer_viewer'], 'dealer-home'],
      /* And each realm's home rules are its own. The other realm's roles cannot
         reach across: the lender's rule is not in a dealership's surface at all,
         so the catch-all that is answers, and a dealership's rule is not in the
         lender's. No membership issues these pairings; the projection refusing
         them is what keeps the realm the lease's rather than the roles'. */
      ['tenant', ['manager'], 'dealer-home'],
      /* And on the lender's lease a dealership's role matches nothing: the
         App's rule list ends unconditionally, but that catch-all is the
         dealership's own rule and belongs to the dealership's surface. No home
         is the honest answer — the shell draws the App's home card. */
      ['platform', ['dealer_admin'], undefined],
    ] as const) {
      const where = `${realm}: ${roles.join(',')}`;
      const served = projectTenantMetadata(loaded.app, loaded.pages, resources.schema, undefined, roles, realm).app;
      assert.equal(served.home, expected, where);
      if (expected !== undefined) {
        const view = served.views[expected];
        assert.ok(view && 'sections' in view && !view.error, `${where}: ${expected} is drawn whole`);
      }
      // Neither realm's rooms include the other realm's home.
      const other = realm === 'platform' ? 'dealer-home' : 'portfolio';
      assert.equal(Object.hasOwn(served.views, other), false, `${where}: "${other}" is the other realm's room`);
    }
  });
});

describe('parsing', () => {
  test('a second signed-out rule can never match, and is refused', () => {
    const views = new Map([
      ['welcome', { kind: 'landing', tables: [] }],
      ['apply', { kind: 'form', tables: [], public: true }],
      ['tasks', { kind: 'list', tables: ['task'] }],
    ]);
    const parse = (rules: unknown) => parseHome(rules, 'app.ts', views as never, {} as never, ['task'], 'Rules');
    assert.throws(
      () => parse([{ view: 'welcome', signedOut: true }, { view: 'apply', signedOut: true }, { view: 'tasks' }]),
      /rule 2 can never match: rule 1 already sends every signed-out visitor to its view/,
    );
    assert.deepEqual(
      parse([{ view: 'welcome', signedOut: true }, { view: 'tasks' }]).map((rule) => rule.view),
      ['welcome', 'tasks'],
    );
  });
});
