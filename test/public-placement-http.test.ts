/** Real HTTP, real SQLite and the suite's pre-session placement interception. */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { CommandTransactionFailure, migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { provisionSqlitePublicPlacementJournal } from '../packages/mistri/src/adapters/commands/publicPlacementJournal.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { defineCommand, defineCommands, withCommandVersions } from '../packages/mistri/src/server/commands/businessCommands.js';
import { shape, text } from '../packages/mistri/src/server/commands/commandShapes.js';
import { createPublicPlacementBindingIssuer } from '../packages/mistri/src/server/forms/publicPlacementBinding.js';
import { createTenantHostRouter } from '../packages/mistri/src/server/http/tenantHosts.js';
import { createApp } from './support/createApp.js';
import { firstPaint } from '../packages/engine/src/server/http/firstPaint.js';
import { APP_PAINT_ROOMS, placedPublicFormPage } from '../packages/mistri/src/server/http/firstPaintRooms.js';
import { resetPublicFormLimits } from '../packages/engine/src/server/http/rateLimit.js';
import { captureHttpPublicPlacement, type HttpPublicPlacementOptions } from '../packages/mistri/src/server/http/publicPlacement.js';
import { loadHttpAppPolicy, type HttpAppPolicy } from '../packages/mistri/src/server/policy/appPolicyHttp.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { parseTestApp } from './support/commandCatalog.js';
import { commandsOf } from '../packages/mistri/src/server/stores/commandStores.js';
import type { CompiledComponents } from '../packages/mistri/src/server/app/appComponents.js';

const canonical = 'https://staff.example',
  north = 'https://north.example',
  south = 'https://south.example';
const basePath = '/apps/site';
interface Placement {
  version: 1;
  binding: string;
  submission: string;
  expiresAt: string;
  recoverUntil: string;
  recoveryUrl: string;
}
interface Response {
  status: number;
  body: any;
  text: string;
  headers: IncomingHttpHeaders;
}
const placedBody = (placement: Placement, name = 'Visitor', dealer = 'north') => ({
  input: { name, dealer },
  submission: placement.submission,
  placement: { version: 1, binding: placement.binding },
});
const receiptBody = (placement: Placement) => ({ submission: placement.submission, placement: { version: 1, binding: placement.binding } });

async function fixture(t: TestContext, options: { lostAcknowledgement?: boolean } = {}) {
  resetPublicFormLimits();
  const directory = mkdtempSync(join(tmpdir(), 'tw-placement-http-')),
    file = join(directory, 'data.db');
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE dealer(id TEXT PRIMARY KEY NOT NULL, active INTEGER NOT NULL);
    CREATE TABLE storefront(dealer TEXT PRIMARY KEY NOT NULL REFERENCES dealer(id), published INTEGER NOT NULL);
    CREATE TABLE lead(id INTEGER PRIMARY KEY, dealer TEXT NOT NULL REFERENCES dealer(id), name TEXT NOT NULL);
    INSERT INTO dealer VALUES('north',1),('south',1);
    INSERT INTO storefront VALUES('north',1),('south',1);`);
  migrateSqliteCommandJournal(file);
  provisionSqlitePublicPlacementJournal(file);
  const registry = new Registry();
  registry.add({ id: 'data', name: 'Data', url: file, writable: true, source: 'config' });
  const raw = (await registry.open('data')).adapter;
  if (options.lostAcknowledgement) {
    const transaction = commandsOf(raw).publicPlacementCommandTransaction!.bind(raw);
    let lost = false;
    raw.publicPlacementCommandTransaction = async (rows, admission, run) => {
      const result = await transaction(rows, admission, run);
      if (!lost) {
        lost = true;
        throw new CommandTransactionFailure(new Error('lost commit acknowledgement'), 'unknown');
      }
      return result;
    };
  }
  const state = {
    calls: 0,
    sessions: 0,
    verifierCalls: 0,
    issued: 0,
    receiptReleases: 0,
    now: Date.parse('2026-09-30T12:00:00Z'),
    pause: undefined as (() => Promise<void>) | undefined,
  };
  t.mock.method(Date, 'now', () => state.now);
  const issuer = createPublicPlacementBindingIssuer(
    { issuerId: 'family', activeKey: 'one', keys: [{ id: 'one', secret: randomBytes(32).toString('base64url'), issueFrom: 0 }] },
    () => state.now,
  );
  const countedIssuer = {
    ...issuer,
    issue: (scope: Parameters<typeof issuer.issue>[0]) => {
      state.issued++;
      return issuer.issue(scope);
    },
  };
  let policy: HttpAppPolicy,
    child: ReturnType<typeof createApp>,
    generation = 0;
  let placementOptions: HttpPublicPlacementOptions;
  let router = createTenantHostRouter([], canonical);
  const bound = { host: '127.0.0.1', port: 0, allowedHosts: ['staff.example', 'north.example', 'south.example'] };
  const policies: HttpAppPolicy[] = [];
  const reload = async (
    settings: {
      remap?: boolean;
      removed?: boolean;
      version?: number;
      sourceIdentity?: string;
      retained?: boolean;
      origins?: readonly string[];
      recoveryOrigins?: HttpPublicPlacementOptions['recoveryOrigins'];
      /** The placed form draws the App's own input component for its name, compiled as below. */
      inputs?: boolean;
    } = {},
  ) => {
    await policy?.retire();
    const input = { name: { type: 'text', label: 'Name' }, dealer: { type: 'text', label: 'Dealer' } } as const;
    const version = settings.version ?? 1;
    const form = {
      kind: 'form',
      public: true,
      label: 'Contact',
      command: { id: 'contact', version, input },
      ...(settings.inputs ? { inputs: { name: { id: 'swatch', module: './widgets/Swatch.jsx', kind: 'input' } } } : {}),
    };
    // What a compile of the App's components left: one input the form draws, and one it does not.
    const components = {
      entries: {
        swatch: { kind: 'input', js: 'swatch-1a2b.js', css: 'swatch-1a2b.css' },
        chart: { kind: 'block', js: 'chart-3c4d.js' },
      },
      files: { 'swatch-1a2b.js': 'export default 1', 'swatch-1a2b.css': '', 'chart-3c4d.js': 'export default 2' },
    } as unknown as CompiledComponents;
    const app = parseTestApp(
      {
        id: 'site',
        name: 'Site',
        sources: { main: { connection: 'data' } },
        auth: { rows: 'policy', roles: { staff: { read: true } } },
        resources: { dealer: {}, storefront: {}, lead: { access: 'write' } },
        views: { leads: { kind: 'list', from: 'lead' }, ...(settings.removed ? {} : { contact: form, legacy: form }) },
        home: 'leads',
        nav: ['leads'],
      },
      'placement HTTP fixture',
    );
    const commands = settings.removed
      ? undefined
      : withCommandVersions(
          defineCommands({
            contact: defineCommand({
              public: true,
              source: 'main',
              target: 'lead',
              targets: 'none',
              read: ['dealer'],
              input,
              output: shape({ reference: text() }),
              async handle(context, value) {
                state.calls++;
                assert.equal(context.actor.kind, 'public');
                assert.deepEqual(context.actor.roles, []);
                if (context.placement) {
                  assert.ok(Object.isFrozen(context.placement));
                  assert.deepEqual(Object.keys(context.placement), ['tenantId']);
                  assert.ok(['north', 'south'].includes(context.placement.tenantId));
                } else assert.equal(context.actor.form, 'legacy');
                await context.tx.insert({ table: 'lead', values: { dealer: value.dealer, name: value.name } });
                await state.pause?.();
                return { reference: `LEAD-${state.calls}` };
              },
            }),
          }),
          () => version,
        );
    const host: AppHost = {
      app: { path: join(directory, 'app.ts'), app, pages: [], sources: {}, ...(settings.inputs ? { components } : {}) },
      pages: [],
      auth: {
        spec: app.auth!,
        store: join(directory, 'auth.db'),
        close: async () => {},
        session: async () => {
          state.sessions++;
          return { id: 'staff-user', who: 'staff@example', role: 'staff' };
        },
        handler: async (_req, res) => {
          res.setHeader('set-cookie', 'must-not-run=yes');
          res.end();
        },
      },
    };
    const module = `export default { appId:'site', resolveRows(){throw Error('private rows must not run')},
      resolvePublicRows(){return {}}, ${
        settings.removed
          ? ''
          : `resultReferences:{}, publicForms:{
      legacy:{rows:{lead:{groups:[[{column:'dealer',op:'=',value:'north'}]]},dealer:{groups:[[{column:'id',op:'=',value:'north'}]]}},resultReferences:()=>[]},
      contact:{kind:'placement',source:'main',resultReferences:()=>[],async resolvePlacement(intent,{db}){
        const dealer=await db.dealer.find({id:intent.tenant}), site=await db.storefront.find({dealer:intent.tenant});
        if(!dealer || dealer.active!==1 || !site || site.published!==1) throw Error('unpublished');
        const rows={}; for(const [table,column] of [['dealer','id'],['storefront','dealer'],['lead','dealer']]) rows[table]={groups:[[{column,op:'=',value:intent.tenant}]]};
        return {rows,anchors:[{table:'dealer',key:{id:intent.tenant},expected:{active:1}},
          {table:'storefront',key:{dealer:intent.tenant},expected:{published:1}}]};
      }}}`
      } };`;
    const policyFile = join(directory, `policy-${++generation}.mjs`);
    writeFileSync(policyFile, module);
    placementOptions = {
      issuer: countedIssuer,
      sourceIdentities: new Map([['main', settings.sourceIdentity ?? 'source-original']]),
      epoch: randomUUID(),
      policyRevision: createHash('sha256').update(module).digest('hex'),
      publicOrigin: canonical,
      basePath,
      origins: settings.origins ?? [north, south],
      recoveryOrigins: settings.recoveryOrigins,
      ...(settings.retained
        ? {
            acquireReceiptSources: async () => ({
              sources: new Map([['source-original', raw]]),
              release() {
                state.receiptReleases++;
              },
            }),
          }
        : {}),
    };
    policy = await loadHttpAppPolicy({
      app,
      registry,
      file: policyFile,
      commands,
      verifySession: async () => {
        state.verifierCalls++;
        throw new Error('private verifier must not run');
      },
      publicPlacement: placementOptions,
      ...(settings.inputs ? { components: () => components } : {}),
    });
    policies.push(policy);
    child = createApp({ registry, bound, apps: [host], policy, sourceClient: false, addresses: { base: basePath } });
    router = createTenantHostRouter(
      [
        { host: 'north.example', app: 'site', tenant: settings.remap ? 'south' : 'north' },
        { host: 'south.example', app: 'site', tenant: 'south' },
      ].filter((host) => placementOptions.origins.includes(`https://${host.host}`)),
      canonical,
    );
  };
  await reload();
  // Exactly the narrow integration the suite owner installs: directory first,
  // placement next, then the ordinary App server for every other request.
  const server = createServer((req, res) => {
    if (!router.accept(req)) {
      res.writeHead(403).end();
      return;
    }
    void (async () => {
      if (await policy.publicPlacement!.handle(req, res)) return;
      child.emit('request', req, res);
    })().catch((error) => {
      res.writeHead(500).end(String(error));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  bound.port = address.port;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.all(policies.map((value) => value.retire()));
    await registry.closeAll();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const call = (
    origin: string,
    path = '/api/forms/contact',
    body?: unknown,
    settings: { method?: string; headers?: Record<string, string | string[] | undefined> } = {},
  ): Promise<Response> =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const headers: Record<string, string | string[] | number | undefined> = {
        host: new URL(origin).host,
        origin,
        'content-type': 'application/json',
        'accept-encoding': 'identity',
        cookie: 'mistri-staff.session_token=staff-cookie',
        'x-forwarded-user': 'staff@example',
        ...settings.headers,
        ...(payload === undefined ? {} : { 'content-length': Buffer.byteLength(payload) }),
      };
      for (const key of Object.keys(headers)) if (headers[key] === undefined) delete headers[key];
      const req = request(
        {
          hostname: '127.0.0.1',
          port: bound.port,
          path: `${basePath}${path}`,
          method: settings.method ?? (body === undefined ? 'GET' : 'POST'),
          headers,
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (part) => {
            text += part;
          });
          res.on('error', reject);
          res.on('end', () => {
            let body: unknown;
            try {
              body = JSON.parse(text);
            } catch {
              /* HTML or HEAD */
            }
            resolve({ status: res.statusCode!, body, text, headers: res.headers });
          });
        },
      );
      req.setTimeout(10_000, () => req.destroy(new Error('HTTP test timed out')));
      req.on('error', reject);
      req.end(payload);
    });
  const prepare = async (origin = north) => {
    const response = await call(origin);
    assert.equal(response.status, 200, response.text);
    return response.body.placement as Placement;
  };
  return {
    state,
    db,
    registry,
    call,
    prepare,
    reload,
    policy: () => policy,
    placementOptions: () => placementOptions,
    count: () => db.prepare('SELECT COUNT(*) AS n FROM lead').get()!.n,
  };
}

test('placed HTTP prepares from the actual storefront, ignores staff credentials and returns only opaque receipts', async (t) => {
  const f = await fixture(t),
    placed = await f.prepare(),
    other = await f.prepare(south);
  assert.equal(placed.recoveryUrl, `${canonical}${basePath}/api/forms/contact/receipt`);
  const first = await f.call(north, '/api/forms/contact', placedBody(placed));
  assert.equal(first.status, 200, first.text);
  assert.deepEqual(Object.keys(first.body).sort(), ['receipt', 'reference']);
  assert.equal(first.headers['set-cookie'], undefined);
  assert.equal(first.headers['x-mistri-account'], undefined);
  assert.equal(first.headers['cache-control'], 'no-store');
  const replay = await f.call(north, '/api/forms/contact', placedBody(placed));
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, first.body);
  const second = await f.call(south, '/api/forms/contact', placedBody(other, 'Other', 'south'));
  assert.equal(second.status, 200, second.text);
  assert.equal(f.count(), 2);
  assert.equal(f.state.calls, 2);
  const conflict = await f.call(north, '/api/forms/contact', placedBody(placed, 'Changed'));
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'idempotency_conflict');
  assert.equal(conflict.body.outcome, 'unknown');
  assert.equal(f.state.sessions, 0);
  assert.equal(f.state.verifierCalls, 0);
});

test("a placed form's page is told where the App's own input components it draws are served, and nothing else", async (t) => {
  const f = await fixture(t);
  // A form that draws none says none.
  assert.equal((await f.call(north)).body.form.components, undefined);
  await f.reload({ inputs: true });
  const placed = await f.call(north);
  assert.equal(placed.status, 200, placed.text);
  assert.deepEqual(placed.body.form.inputs, { name: { id: 'swatch' } });
  assert.deepEqual(placed.body.form.components, {
    swatch: { href: '/site/_components/swatch-1a2b.js', css: '/site/_components/swatch-1a2b.css' },
  });
  // HEAD says the same form; the block it does not draw is never named.
  const head = await f.call(north, '/api/forms/contact', undefined, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.doesNotMatch(placed.text, /chart/);
  // The storefront's visitor may fetch the input's file, under the mount; never the block's, which no public form draws.
  const file = await f.call(north, '/_components/swatch-1a2b.js');
  assert.equal(file.status, 200, file.text);
  assert.equal((await f.call(north, '/_components/chart-3c4d.js')).status, 404);
  // The value is still the field's kind's to judge: the placed submit parses as before.
  const submitted = await f.call(north, '/api/forms/contact', placedBody(placed.body.placement));
  assert.equal(submitted.status, 200, submitted.text);
});

test('canonical prepare needs placement; HEAD, listings and HTML first paint mint no operation', async (t) => {
  const f = await fixture(t);
  const missing = await f.call(canonical);
  assert.equal(missing.status, 409);
  assert.equal(missing.body.code, 'placement_required');
  assert.equal((await f.call(north, '/api/forms/contact', undefined, { method: 'HEAD' })).status, 200);
  const listing = await f.call(north, '/api/forms');
  assert.equal(listing.status, 200, listing.text);
  assert.equal(listing.headers['set-cookie'], undefined);
  assert.equal(listing.body.placement, undefined);
  assert.equal(f.state.issued, 0);
  assert.equal(placedPublicFormPage('/site/form/contact', f.policy().publicPlacement!.isPlacedForm), true);
  assert.equal(placedPublicFormPage('/site/form/legacy', f.policy().publicPlacement!.isPlacedForm), false);
  assert.equal(f.state.issued, 0);
  const defense = await firstPaint({
    rooms: APP_PAINT_ROOMS,
    path: '/site/form/contact',
    search: '',
    loop: async () => ({
      status: 200,
      carriable: true,
      body: { placement: { binding: 'must-not-inline' } },
    }),
  });
  assert.equal(defense.json, undefined);
});

test('HTTP refuses forged bindings, forms, host/origin changes, selectors and legacy downgrade', async (t) => {
  const f = await fixture(t),
    placement = await f.prepare();
  for (const [origin, path, body, settings] of [
    [south, '/api/forms/contact', placedBody(placement), {}],
    [north, '/api/forms/contact?tenant=south', placedBody(placement), {}],
    [north, '/api/forms/contact?app=site', placedBody(placement), {}],
    [north, '/api/forms/contact', placedBody(placement), { headers: { origin: south } }],
    [north, '/api/forms/contact', placedBody(placement), { headers: { origin: 'https://north.example/path' } }],
    [north, '/api/forms/contact', placedBody(placement), { headers: { origin: undefined } }],
    [north, '/api/forms/contact', placedBody({ ...placement, binding: `${placement.binding}x` }), {}],
  ] as const) {
    const response = await f.call(origin, path, body, settings);
    assert.equal(response.status, 403, response.text);
    assert.equal(response.body.outcome, 'unknown');
  }
  const legacy = await f.call(north, '/api/forms/legacy', placedBody(placement));
  assert.equal(legacy.status, 400);
  const downgrade = await f.call(north, '/api/forms/contact', { input: { name: 'x', dealer: 'north' }, submission: placement.submission });
  assert.equal(downgrade.status, 400);
  assert.equal(downgrade.body.outcome, 'unknown');
  const wrongForm = await f.call(canonical, '/api/forms/other/receipt', receiptBody(placement));
  assert.equal(wrongForm.status, 403);
  const forgedHost = await f.call(north, '/api/forms/contact', undefined, {
    headers: { host: 'evil.example', 'x-forwarded-host': 'north.example' },
  });
  assert.equal(forgedHost.status, 403);
  assert.equal(f.count(), 0);
  const duplicateOrigin = await f.call(north, '/api/forms/contact', placedBody(placement), { headers: { origin: [north, north] } });
  assert.equal(duplicateOrigin.status, 403);
  assert.equal(f.count(), 0);
  const fixed = await f.call(north, '/api/forms/legacy', {
    input: { name: 'Legacy', dealer: 'north' },
    submission: 'legacy-submission-0001',
  });
  assert.equal(fixed.status, 200, fixed.text);
  assert.equal(f.count(), 1);
});

test('receipt recovery authenticates original origin, survives remap/version and needs no current form or handler', async (t) => {
  const f = await fixture(t),
    placement = await f.prepare();
  const first = await f.call(north, '/api/forms/contact', placedBody(placement));
  await f.reload({ remap: true, version: 2 });
  const changed = await f.call(north, '/api/forms/contact', placedBody(placement));
  assert.equal(changed.status, 409);
  assert.equal(changed.body.code, 'placement_changed');
  assert.equal(changed.body.outcome, 'unknown');
  const recovery = await f.call(canonical, '/api/forms/contact/receipt', receiptBody(placement), { headers: { origin: north } });
  assert.equal(recovery.status, 200, recovery.text);
  assert.deepEqual(recovery.body, first.body);
  assert.equal(recovery.headers['access-control-allow-origin'], north);
  assert.equal(recovery.headers['vary'], 'Origin');
  assert.equal(recovery.headers['access-control-allow-credentials'], undefined);
  assert.equal(recovery.headers['set-cookie'], undefined);
  for (const origin of [south, 'https://unconfigured.example']) {
    const denied = await f.call(canonical, '/api/forms/contact/receipt', receiptBody(placement), { headers: { origin } });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers['access-control-allow-origin'], undefined);
  }
  const tampered = await f.call(canonical, '/api/forms/contact/receipt', receiptBody({ ...placement, binding: placement.binding + 'x' }), {
    headers: { origin: north },
  });
  assert.equal(tampered.status, 403);
  assert.equal(tampered.headers['access-control-allow-origin'], undefined);
  assert.equal((await f.call(north, '/api/forms/contact/receipt', receiptBody(placement))).status, 403);
  await f.reload({ removed: true });
  const removed = await f.call(canonical, '/api/forms/contact/receipt', receiptBody(placement));
  assert.equal(removed.status, 200, removed.text);
  assert.deepEqual(removed.body, first.body);
  assert.equal(f.state.calls, 1);
});

test('recovery preflight allows only exact configured origins and JSON POST; malformed recovery is generic', async (t) => {
  const f = await fixture(t),
    placement = await f.prepare();
  const preflight = await f.call(canonical, '/api/forms/contact/receipt', undefined, {
    method: 'OPTIONS',
    headers: {
      origin: north,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], north);
  assert.equal(preflight.headers['access-control-allow-credentials'], undefined);
  const arbitrary = await f.call(canonical, '/api/forms/contact/receipt', undefined, {
    method: 'OPTIONS',
    headers: {
      origin: 'https://evil.example',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  });
  assert.equal(arbitrary.status, 403);
  assert.equal(arbitrary.headers['access-control-allow-origin'], undefined);
  for (const value of [{ submission: placement.submission }, { ...receiptBody(placement), input: {} }]) {
    const response = await f.call(canonical, '/api/forms/contact/receipt', value);
    assert.equal(response.status, 403);
    assert.equal(response.body.code, 'forbidden');
  }
});

test('execution expiry and unpublication preserve old receipts; no receipt is only not_found', async (t) => {
  const f = await fixture(t),
    placement = await f.prepare(),
    absent = await f.prepare();
  const first = await f.call(north, '/api/forms/contact', placedBody(placement));
  f.db.exec("UPDATE storefront SET published=0 WHERE dealer='north'");
  const denied = await f.call(north, '/api/forms/contact', placedBody(absent));
  assert.equal(denied.status, 403);
  assert.equal(denied.body.outcome, 'unknown');
  assert.equal(f.count(), 1);
  assert.equal((await f.call(north)).status, 403);
  f.state.now += 2 * 60 * 60 * 1000;
  const expired = await f.call(north, '/api/forms/contact', placedBody(placement));
  assert.equal(expired.status, 409);
  assert.equal(expired.body.code, 'placement_expired');
  assert.deepEqual((await f.call(canonical, '/api/forms/contact/receipt', receiptBody(placement))).body, first.body);
  assert.deepEqual((await f.call(canonical, '/api/forms/contact/receipt', receiptBody(absent))).body, { status: 'not_found' });
  f.state.now += 22 * 60 * 60 * 1000;
  assert.equal((await f.call(canonical, '/api/forms/contact/receipt', receiptBody(placement))).status, 403);
});

test('durable lost acknowledgement is unknown over HTTP; recovery and exact retry return one committed insert', async (t) => {
  const f = await fixture(t, { lostAcknowledgement: true }),
    placement = await f.prepare();
  const lost = await f.call(north, '/api/forms/contact', placedBody(placement));
  assert.equal(lost.status, 503);
  assert.equal(lost.body.outcome, 'unknown');
  assert.equal(f.count(), 1);
  const recovered = await f.call(canonical, '/api/forms/contact/receipt', receiptBody(placement));
  const replay = await f.call(north, '/api/forms/contact', placedBody(placement));
  assert.equal(recovered.status, 200);
  assert.deepEqual(replay.body, recovered.body);
  assert.equal(f.state.calls, 1);
});

test('retirement drains an accepted HTTP write and closes preparation/recovery without releasing a late success', async (t) => {
  const f = await fixture(t),
    placement = await f.prepare();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((done) => {
      enter = done;
    }),
    held = new Promise<void>((done) => {
      release = done;
    });
  f.state.pause = async () => {
    enter();
    await held;
  };
  const writing = f.call(north, '/api/forms/contact', placedBody(placement));
  await entered;
  let drained = false;
  const retiring = f
    .policy()
    .retire()
    .then(() => {
      drained = true;
    });
  await Promise.resolve();
  assert.equal(drained, false);
  assert.equal((await f.call(north)).status, 503);
  assert.equal((await f.call(canonical, '/api/forms/contact/receipt', receiptBody(placement))).status, 503);
  release();
  const result = await writing;
  await retiring;
  assert.equal(result.status, 503);
  assert.equal(result.body.outcome, 'unknown');
  assert.equal(f.count(), 0);
});

test('source replacement never redirects an old receipt identity; explicit retained readers own a drained lease', async (t) => {
  const f = await fixture(t),
    placement = await f.prepare();
  const first = await f.call(north, '/api/forms/contact', placedBody(placement));
  await f.reload({ sourceIdentity: 'source-replacement' });
  const absentOwner = await f.call(canonical, '/api/forms/contact/receipt', receiptBody(placement));
  assert.equal(absentOwner.status, 503);
  assert.equal(absentOwner.body.outcome, 'unknown');
  await f.reload({ sourceIdentity: 'source-replacement', retained: true, removed: true });
  const recovered = await f.call(canonical, '/api/forms/contact/receipt', receiptBody(placement));
  assert.equal(recovered.status, 200, recovered.text);
  assert.deepEqual(recovered.body, first.body);
  assert.equal(f.state.receiptReleases, 0);
  await f.policy().retire();
  await f.policy().retire();
  assert.equal(f.state.receiptReleases, 1);
});

test('removed storefronts recover through canonical preflight and authenticated POST without regaining a host or writer', async (t) => {
  const f = await fixture(t),
    placement = await f.prepare();
  const first = await f.call(north, '/api/forms/contact', placedBody(placement));
  const recoverUntil = f.state.now + 60_000;
  const retained = [{ origin: north, recoverUntil }];
  await f.reload({ origins: [south], recoveryOrigins: retained });
  // Startup captures the records: mutating the supplied list cannot grant a
  // new origin or keep the removed origin alive after its original deadline.
  retained[0].recoverUntil += 24 * 60 * 60 * 1000;
  retained.push({ origin: 'https://evil.example', recoverUntil });
  const preflight = () =>
    f.call(canonical, '/api/forms/contact/receipt', undefined, {
      method: 'OPTIONS',
      headers: {
        origin: north,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
  const preflighted = await preflight();
  assert.equal(preflighted.status, 204);
  assert.equal(preflighted.headers['access-control-allow-origin'], north);
  const recovered = await f.call(canonical, '/api/forms/contact/receipt', receiptBody(placement), { headers: { origin: north } });
  assert.equal(recovered.status, 200, recovered.text);
  assert.deepEqual(recovered.body, first.body);
  for (const response of [preflighted, recovered]) {
    assert.equal(response.headers['access-control-allow-credentials'], undefined);
    assert.equal(response.headers['set-cookie'], undefined);
    assert.equal(response.headers['vary'], 'Origin');
  }
  assert.equal((await f.call(north)).status, 403);
  assert.equal((await f.call(north, '/api/forms/contact', placedBody(placement))).status, 403);
  const wrongNew = await f.call(canonical, '/api/forms/contact/receipt', receiptBody(placement), { headers: { origin: south } });
  assert.equal(wrongNew.status, 403);
  assert.equal(wrongNew.headers['access-control-allow-origin'], undefined);
  const forged = await f.call(canonical, '/api/forms/contact/receipt', receiptBody({ ...placement, binding: `${placement.binding}x` }), {
    headers: { origin: north },
  });
  assert.equal(forged.status, 403);
  assert.equal(forged.headers['access-control-allow-origin'], undefined);
  const unconfigured = await f.call(canonical, '/api/forms/contact/receipt', receiptBody(placement), {
    headers: { origin: 'https://evil.example' },
  });
  assert.equal(unconfigured.status, 403);
  assert.equal(unconfigured.headers['access-control-allow-origin'], undefined);
  // Retaining a form's receipt route is independent of keeping its handler.
  await f.reload({ origins: [south], recoveryOrigins: [{ origin: north, recoverUntil }], removed: true });
  assert.equal((await preflight()).status, 204);
  assert.deepEqual(
    (await f.call(canonical, '/api/forms/contact/receipt', receiptBody(placement), { headers: { origin: north } })).body,
    first.body,
  );
  f.state.now = recoverUntil;
  const expiredPreflight = await preflight();
  assert.equal(expiredPreflight.status, 403);
  assert.equal(expiredPreflight.headers['access-control-allow-origin'], undefined);
  const expiredOrigin = await f.call(canonical, '/api/forms/contact/receipt', receiptBody(placement), { headers: { origin: north } });
  assert.equal(expiredOrigin.status, 403);
  assert.equal(expiredOrigin.headers['access-control-allow-origin'], undefined);
  assert.deepEqual((await f.call(canonical, '/api/forms/contact/receipt', receiptBody(placement))).body, first.body);
  assert.equal(f.state.calls, 1);
  assert.equal(f.state.sessions, 0);
  assert.equal(f.state.verifierCalls, 0);
});

test('retained-origin grace cannot extend a binding recovery deadline', async (t) => {
  const f = await fixture(t),
    placement = await f.prepare();
  await f.call(north, '/api/forms/contact', placedBody(placement));
  const tokenDeadline = Date.parse(placement.recoverUntil),
    originDeadline = tokenDeadline + 120_000;
  await f.reload({ origins: [south], recoveryOrigins: [{ origin: north, recoverUntil: originDeadline }] });
  f.state.now = tokenDeadline;
  const preflight = () =>
    f.call(canonical, '/api/forms/contact/receipt', undefined, {
      method: 'OPTIONS',
      headers: {
        origin: north,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
  assert.equal((await preflight()).status, 204);
  const expired = await f.call(canonical, '/api/forms/contact/receipt', receiptBody(placement), { headers: { origin: north } });
  assert.equal(expired.status, 403);
  assert.equal(expired.body.code, 'forbidden');
  assert.equal(expired.headers['access-control-allow-origin'], undefined);
  f.state.now = originDeadline;
  assert.equal((await preflight()).status, 403);
  assert.equal(f.count(), 1);
  assert.equal(f.state.calls, 1);
});

test('recovery-origin startup capture refuses malformed, unbounded, executable or canonical-origin records', async (t) => {
  const f = await fixture(t),
    valid = { origin: north, recoverUntil: f.state.now + 60_000 };
  const capture = (value: unknown) =>
    captureHttpPublicPlacement({ ...f.placementOptions(), recoveryOrigins: value as HttpPublicPlacementOptions['recoveryOrigins'] });
  for (const value of [
    null,
    {},
    [valid, valid],
    Array.from({ length: 129 }, (_, i) => ({ ...valid, origin: `https://old${i}.example` })),
    [{ ...valid, origin: canonical }],
    [{ ...valid, origin: `${north}/` }],
    [{ ...valid, unknown: true }],
    ...[NaN, Infinity, -1, 0.5, f.state.now + 24 * 60 * 60 * 1000 + 120_001].map((recoverUntil) => [{ ...valid, recoverUntil }]),
  ]) {
    assert.throws(() => capture(value));
  }
  let touched = 0;
  assert.throws(() =>
    capture([
      {
        origin: north,
        get recoverUntil() {
          touched++;
          return valid.recoverUntil;
        },
      },
    ]),
  );
  assert.throws(() =>
    capture(
      new Proxy([valid], {
        ownKeys() {
          touched++;
          return [];
        },
      }),
    ),
  );
  assert.throws(() =>
    captureHttpPublicPlacement({
      ...f.placementOptions(),
      get recoveryOrigins() {
        touched++;
        return [valid];
      },
    }),
  );
  assert.equal(touched, 0);
  const captured = capture([valid]);
  assert.ok(Object.isFrozen(captured.recoveryOrigins));
  assert.ok(Object.isFrozen(captured.recoveryOrigins![0]));
});
