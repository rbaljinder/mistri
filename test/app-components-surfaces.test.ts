/**
 * Custom components past the section and the value (phases 2 and 3): an
 * input where a form draws a field, a list's rows (`customList`), a
 * free-form page (`definePage`, written here as the data it becomes), the egress an App opens for them (`ui.csp`,
 * written as `ui.csp.connect` and `ui.csp.images`), and components on the pages a signed-out visitor reads.
 *
 * Each is checked as data first — what is refused as the App loads, and what
 * authority.lock says — then over HTTP, where the security is: a visitor is
 * served the component's code and nothing it may not read, runs no command,
 * and a page whose reads a role cannot read is not that role's page. The
 * page's policy opens exactly the served Apps' declared origins.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { componentHrefs, type CompiledComponents } from '../packages/mistri/src/server/app/appComponents.js';
import { shellEgress, shellPolicy, withEgress } from '../packages/engine/src/server/clientHttp.js';
import type { AppDef } from '../packages/mistri/src/shared/app.js';
import { appComponents } from '../packages/mistri/src/shared/appComponentPlaces.js';
import { authorityReport } from '../packages/mistri/src/shared/appAuthority.js';
import { parsePagesConfig, type PageDef } from '../packages/engine/src/shared/page.js';
import { parseTestApp } from './support/commandCatalog.js';

const list = { id: 'stream', module: './widgets/Stream.tsx', kind: 'list' };
const header = { id: 'header', module: './widgets/Header.tsx', kind: 'section' };
const walk = { id: 'walk', module: './widgets/Walk.tsx', kind: 'page' };
const swatch = { id: 'swatch', module: './widgets/Swatch.tsx', kind: 'input' };

/* A lot anyone may browse (vehicles and dealers, a dealer's email not), inquiries only by staff. */
const APP = {
  id: 'lot',
  name: 'Lot',
  connection: 'lot-db',
  resources: {
    vehicle: { access: 'write', inputs: { color: swatch } },
    dealer: {},
    inquiry: {},
  },
  auth: {
    roles: { staff: { read: true, write: ['vehicle'] }, buyer: { read: ['vehicle', 'dealer'] } },
    public: { read: ['vehicle', 'dealer'], fields: { dealer: { read: ['id', 'name'] } } },
  },
  views: {
    vehicles: {
      kind: 'list',
      from: 'vehicle',
      label: 'Vehicles',
      presentation: { kind: 'custom', component: list, show: ['make', 'price', 'dealer_id.name'] },
    },
    inquiries: { kind: 'list', from: 'inquiry', label: 'Inquiries' },
    desk: { kind: 'page', label: 'Desk', component: walk, reads: ['vehicle', 'inquiry'], params: ['car'] },
  },
  home: [{ view: 'vehicles', signedOut: true }, { view: 'vehicles' }],
  nav: ['vehicles', 'inquiries', 'desk'],
  ui: { csp: { connect: ['https://api.example.com'], images: ['https://img.example.com/'] } },
};
const SQL = `CREATE TABLE dealer (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT);
  CREATE TABLE vehicle (id INTEGER PRIMARY KEY, make TEXT NOT NULL, color TEXT, price INTEGER, dealer_id INTEGER REFERENCES dealer(id));
  CREATE TABLE inquiry (id INTEGER PRIMARY KEY, vehicle_id INTEGER REFERENCES vehicle(id), email TEXT NOT NULL);
  INSERT INTO dealer VALUES (1, 'North Motors', 'sales@north.test'); INSERT INTO vehicle VALUES (1, 'Toyota', 'red', 14500, 1);
  INSERT INTO inquiry VALUES (1, 1, 'buyer@example.test');`;
const page = (sections: object[]): PageDef =>
  parsePagesConfig({ pages: [{ id: 'vehicle', base: 'vehicle', label: 'Vehicle', sections }] }, 'fixture')[0];

describe('as the App declares them', () => {
  test('an input, a list, a page: each kind placed where it stands, refused where it does not', () => {
    const app = parseTestApp(APP, 'lot');
    assert.deepEqual([...appComponents(app, [], 'lot').keys()].sort(), ['stream', 'swatch', 'walk']);
    const desk = app.views.desk as {
      page?: { reads: string[]; commands: string[]; params: string[] };
      sections: Array<{ kind: string; component?: { id: string } }>;
    };
    assert.deepEqual(desk.page, { reads: ['vehicle', 'inquiry'], commands: [], params: ['car'] });
    assert.equal(desk.sections[0].component?.id, 'walk');
    const refused = (change: Record<string, unknown>, pattern: RegExp) =>
      assert.throws(() => parseTestApp({ ...APP, ...change }, 'lot'), pattern);
    refused(
      { views: { ...APP.views, vehicles: { ...APP.views.vehicles, presentation: { kind: 'custom', component: header, show: ['make'] } } } },
      /customList\(\) takes a component of kind "list"/,
    );
    refused(
      { views: { ...APP.views, vehicles: { ...APP.views.vehicles, presentation: { kind: 'custom', component: list, show: [] } } } },
      /has no "show"/,
    );
    refused({ views: { ...APP.views, desk: { ...APP.views.desk, reads: [] } } }, /\[page-reads\].*has no "reads"/);
    refused({ views: { ...APP.views, desk: { ...APP.views.desk, reads: ['garage'] } } }, /no resource block declares/);
    refused({ views: { ...APP.views, desk: { ...APP.views.desk, params: ['period'] } } }, /\[page-params\].*"period" is a dashboard's/);
    refused(
      { resources: { ...APP.resources, vehicle: { access: 'write', inputs: { color: list } } } },
      /An input takes a component of kind "input"/,
    );
  });

  test("an input names a command's own input; a public form draws none", () => {
    const command = { id: 'note', version: 1, target: 'vehicle', input: { text: { type: 'text' } } };
    const withAction = (inputs: object) =>
      parseTestApp(
        { ...APP, resources: { ...APP.resources, vehicle: { access: 'write', actions: { note: { label: 'Note', command, inputs } } } } },
        'lot',
      );
    assert.equal(withAction({ text: swatch }).resources!.vehicle.actions![0].label, 'Note');
    assert.throws(() => withAction({ other: swatch }), /not one of the command's inputs \(text\)/);
    assert.throws(
      () =>
        parseTestApp(
          {
            ...APP,
            resources: {
              ...APP.resources,
              vehicle: { access: 'write', actions: { red: { label: 'Red', set: { color: 'red' }, inputs: { color: swatch } } } },
            },
          },
          'lot',
        ),
      /only a command's form draws/,
    );
    // An input inside a group is named by its path; the group itself and a path it does not hold are refused.
    const grouped = {
      ...command,
      input: { text: { type: 'text' }, trade: { type: 'group', repeat: { max: 3 }, fields: { vin: { type: 'text' } } } },
    };
    const withGrouped = (inputs: object) =>
      parseTestApp(
        {
          ...APP,
          resources: { ...APP.resources, vehicle: { access: 'write', actions: { note: { label: 'Note', command: grouped, inputs } } } },
        },
        'lot',
      );
    assert.deepEqual(Object.keys((withGrouped({ 'trade.vin': swatch }).resources!.vehicle.actions![0] as { inputs?: object }).inputs!), [
      'trade.vin',
    ]);
    assert.throws(() => withGrouped({ trade: swatch }), /input component for "trade"/);
    assert.throws(() => withGrouped({ 'trade.make': swatch }), /input component for "trade.make"/);
    const signedIn = (inputs: object) => ({
      kind: 'form',
      label: 'Ask',
      command: { id: 'ask', version: 1, input: { trade: { type: 'group', fields: { vin: { type: 'text' } } } } },
      inputs,
    });
    assert.throws(
      () => parseTestApp({ ...APP, views: { ...APP.views, ask: signedIn({ 'trade.make': swatch }) } }, 'lot'),
      /input component for "trade.make"/,
    );
    // A path the form's command holds passes the inputs check, and meets the next rule: nobody is granted the command.
    assert.throws(
      () => parseTestApp({ ...APP, views: { ...APP.views, ask: signedIn({ 'trade.vin': swatch }) } }, 'lot'),
      /which no role in auth.roles is granted/,
    );
    const form = {
      kind: 'form',
      label: 'Ask',
      command: { id: 'ask', version: 1, input: { text: { type: 'text' } } },
      public: true,
      inputs: { text: swatch },
    };
    // A public form names its inputs' components as a signed-in one does: its page loads them (public-form-inputs.test.ts).
    const asked = parseTestApp({ ...APP, views: { ...APP.views, ask: form } }, 'lot').views.ask as {
      inputs?: Record<string, { id: string }>;
    };
    assert.equal(asked.inputs?.text.id, swatch.id);
  });

  test('on a page anyone reads, a component reads within the public grant, or the App does not load', () => {
    const app = parseTestApp(APP, 'lot');
    const custom = (extra: object) => ({ kind: 'custom', component: header, ...extra });
    // The public's own resource and columns, a rollup-free record: drawn for visitors.
    assert.ok(
      appComponents(app, [page([custom({ record: ['make', 'price'], rows: { dealers: { from: 'dealer', show: ['name'] } } })])], 'lot').has(
        'header',
      ),
    );
    assert.throws(
      () => appComponents(app, [page([custom({ rows: { asked: { from: 'inquiry', show: ['email'] } } })])], 'lot'),
      /reads "inquiry", which "auth.public" does not open/,
    );
    assert.throws(
      () => appComponents(app, [page([custom({ rows: { dealers: { from: 'dealer', show: ['name', 'email'] } } })])], 'lot'),
      /shows "email", which "auth.public" leaves out of "dealer"/,
    );
    // A list's presentation over a public resource shows only what the public reads.
    const narrowed = parseTestApp(
      { ...APP, auth: { ...APP.auth, public: { read: ['vehicle', 'dealer'], fields: { vehicle: { read: ['id', 'make'] } } } } },
      'lot',
    );
    assert.throws(() => appComponents(narrowed, [], 'lot'), /presentation shows "price", which "auth.public" leaves out of "vehicle"/);
    // A tenant App places its components too: its host serves them to members, and each read stays in the member's tenant.
    assert.ok(appComponents({ ...app, auth: { rows: 'tenant' } } as AppDef, [], 'lot').size > 0);
  });

  test('egress is a list of origins, each a line of authority.lock beside what a page reads', () => {
    const app = parseTestApp(APP, 'lot');
    assert.deepEqual(app.ui.csp?.connect, ['https://api.example.com']);
    assert.deepEqual(app.ui.csp?.images, ['https://img.example.com']);
    const report = authorityReport(app);
    for (const line of [
      'page desk reads inquiry',
      'page desk reads vehicle',
      'egress connect https://api.example.com',
      'egress images https://img.example.com',
    ]) {
      assert.match(report, new RegExp(`^${line.replace(/[.]/g, '\\.')} — the App$`, 'm'));
    }
    for (const origin of [
      'https://api.example.com/v1',
      'https://*.example.com',
      "https://x.test; script-src 'unsafe-inline'",
      'http://example.com',
      'ftp://x.test',
      'https://',
    ]) {
      assert.throws(
        () => parseTestApp({ ...APP, ui: { csp: { connect: [origin] } } }, 'lot'),
        /origins like "https:\/\/api\.example\.com"/,
        origin,
      );
    }
    // The flat keys are refused with the grouped one.
    assert.throws(
      () => parseTestApp({ ...APP, ui: { connect: ['https://api.example.com'] } }, 'lot'),
      /has "connect", which is now "csp\.connect"/,
    );
    assert.throws(
      () => parseTestApp({ ...APP, ui: { images: ['https://img.example.com'] } }, 'lot'),
      /has "images", which is now "csp\.images"/,
    );
    assert.deepEqual(parseTestApp({ ...APP, ui: { csp: { connect: ['http://localhost:8080'] } } }, 'lot').ui.csp?.connect, [
      'http://localhost:8080',
    ]);
  });

  test("the page's policy opens the served Apps' origins and nothing else, and narrows pictures once a component is served", () => {
    const policy = shellPolicy('<script>boot()</script>');
    assert.equal(withEgress(policy, undefined), policy);
    assert.equal(shellEgress([{ ui: {}, components: false }]), undefined);
    const egress = shellEgress([
      { ui: { csp: { connect: ['https://a.test'] } }, components: true },
      { ui: { csp: { connect: ['https://b.test'], images: ['https://img.test'] } }, components: false },
    ]);
    const opened = withEgress(policy, egress);
    assert.match(opened, /connect-src 'self' https:\/\/a\.test https:\/\/b\.test;/);
    assert.match(opened, /img-src 'self' data: blob: https:\/\/img\.test;/);
    assert.doesNotMatch(opened, /img-src[^;]* https:;/);
    // Without a component, pictures from any https address still load, as a card's image by URL needs.
    assert.match(
      withEgress(policy, shellEgress([{ ui: { csp: { images: ['https://img.test'] } }, components: false }])),
      /img-src 'self' data: blob: https: https:\/\/img\.test;/,
    );
  });
});

/* ---------- over HTTP ---------- */

const FILES: CompiledComponents = {
  entries: {
    stream: { kind: 'list', js: 'stream-0123456789ab.js', sources: ['widgets/Stream.tsx'] },
    walk: { kind: 'page', js: 'walk-0123456789ab.js', sources: ['widgets/Walk.tsx'] },
    swatch: { kind: 'input', js: 'swatch-0123456789ab.js', sources: ['widgets/Swatch.tsx'] },
  },
  files: {
    'stream-0123456789ab.js': 'export default function Stream() { return null; }\n',
    'walk-0123456789ab.js': 'export default function Walk() { return null; }\n',
    'swatch-0123456789ab.js': 'export default function Swatch() { return null; }\n',
  },
};

type Call = (path: string, body?: object, init?: RequestInit) => Promise<{ status: number; body: any; headers: Headers }>;

async function serve(role: string | undefined, run: (call: Call) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-components-http-'));
  const file = join(directory, 'lot.db');
  const db = new DatabaseSync(file);
  db.exec(SQL);
  db.close();
  const registry = new Registry();
  registry.add({ id: 'lot-db', name: 'Lot', url: file, source: 'config', writable: true });
  const definition = parseTestApp(APP, 'lot fixture');
  const pages = parsePagesConfig({ pages: [] }, 'lot pages');
  const host: AppHost = {
    app: { path: 'lot-fixture.ts', app: definition, pages, sources: {}, components: FILES },
    pages,
    auth: {
      spec: definition.auth!,
      store: 'not-used',
      handler: async () => {},
      close: async () => {},
      session: async () => (role ? { id: 'account-1', who: 'person@example.test', role } : null),
    },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], pages });
  server.listen(0, bound.host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  bound.port = address.port;
  const origin = `http://${bound.host}:${bound.port}`;
  try {
    await run(async (path, body, init = {}) => {
      const response = await fetch(`${origin}${path}`, {
        signal: AbortSignal.timeout(5000),
        ...init,
        headers: { 'Content-Type': 'application/json', origin, ...(init.headers ?? {}) },
        ...(body ? { method: 'POST', body: JSON.stringify({ app: 'lot', ...body }) } : {}),
      });
      const text = await response.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* a file, not an answer */
      }
      return { status: response.status, body: parsed, headers: response.headers };
    });
  } finally {
    server.close();
    server.closeAllConnections();
    registry.closeAll?.();
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('served', () => {
  test("a signed-out visitor is served the components and the public grant's rows, and runs nothing", async () => {
    await serve(undefined, async (call) => {
      const served = await call('/api/app?app=lot');
      assert.equal(served.status, 200, JSON.stringify(served.body));
      assert.deepEqual(served.body.app.components, componentHrefs('lot', FILES));
      assert.equal(served.body.app.views.vehicles.presentation.kind, 'custom');
      // The page reads inquiries, which a visitor does not: it is not theirs.
      assert.equal(served.body.app.views.desk, undefined);
      // Served at the root, as the one App on this server (shared/mount.ts); the payload says the inside address.
      const code = await call('/_components/stream-0123456789ab.js');
      assert.equal(code.status, 200);
      assert.match(String(code.body), /export default function Stream/);
      assert.equal((await call('/_components/stream-ffffffffffff.js')).status, 404);
      // What a component's hook asks of the server is the public grant's to answer.
      const cars = await call('/api/view/run', {
        view: { id: 'ui:vehicle', name: 'vehicle', base: 'vehicle', columns: [{ path: 'make' }, { path: 'dealer_id.name' }], limit: 5 },
        count: 'none',
      });
      assert.equal(cars.status, 200, JSON.stringify(cars.body));
      assert.deepEqual(
        cars.body.rows.map((row: Record<string, unknown>) => Object.values(row)),
        [['Toyota', 'North Motors']],
      );
      for (const view of [
        { id: 'ui:inquiry', name: 'inquiry', base: 'inquiry', columns: [{ path: 'email' }], limit: 5 },
        { id: 'ui:dealer', name: 'dealer', base: 'dealer', columns: [{ path: 'email' }], limit: 5 },
      ]) {
        const refused = await call('/api/view/run', { view, count: 'none' });
        assert.ok(refused.status >= 400 || refused.body.errors?.length, JSON.stringify(refused.body));
        assert.doesNotMatch(JSON.stringify(refused.body), /buyer@example|sales@north/);
      }
      // useCommand's run and its availability are a session's: a visitor has none.
      const envelope = {
        command: 'note',
        commandVersion: 1,
        key: { id: 1 },
        expectedVersion: 1,
        idempotencyKey: '00000000-0000-4000-8000-000000000001',
        input: {},
      };
      for (const path of ['/api/commands/execute', '/api/commands/prepare', '/api/commands/availability']) {
        const answer = await call(
          path,
          path.endsWith('availability') ? { checks: [{ command: 'note', commandVersion: 1, keys: [{ id: 1 }] }] } : envelope,
        );
        assert.ok(answer.status === 401 || answer.status === 403, `${path}: ${answer.status} ${JSON.stringify(answer.body)}`);
      }
      // The page's policy opens the App's declared origins, and pictures only from them.
      const shell = await call('/lot/vehicles');
      const policy = shell.headers.get('content-security-policy') ?? '';
      // From source, the dev client's hot-reload socket is named before them (devclient.ts devSocket).
      assert.match(policy, /connect-src 'self'(?: wss?:\/\/\S+)* https:\/\/api\.example\.com(;|$)/);
      assert.match(policy, /img-src 'self' data: blob: https:\/\/img\.example\.com(;|$)/);
    });
  });

  test("a page is a role's only when the role reads everything the page reads", async () => {
    await serve('staff', async (call) => {
      const served = await call('/api/app?app=lot');
      assert.equal(served.status, 200, JSON.stringify(served.body));
      assert.deepEqual(served.body.app.views.desk.page, { reads: ['vehicle', 'inquiry'], commands: [], params: ['car'] });
      assert.ok(served.body.app.nav.some((node: { view?: string }) => node.view === 'desk'));
      assert.equal(served.body.app.resources.vehicle.inputs.color.id, 'swatch');
    });
    await serve('buyer', async (call) => {
      const served = await call('/api/app?app=lot');
      assert.equal(served.status, 200, JSON.stringify(served.body));
      assert.equal(served.body.app.views.desk, undefined, 'a buyer does not read inquiries, so the desk is not theirs');
      assert.ok(!served.body.app.nav.some((node: { view?: string }) => node.view === 'desk'));
    });
  });
});
