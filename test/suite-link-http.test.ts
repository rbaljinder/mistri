import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { startConfiguredSuite } from '../packages/mistri/src/server/cli/suiteCommand.js';
import { changeSuiteGrant } from '../packages/mistri/src/server/cli/suiteGrant.js';
import { provisionSqliteTenantStore, TENANT_TABLES } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { bindAppTarget } from '../packages/engine/src/shared/appLinks.js';

async function fixture(t: TestContext, base: string, tenant = false, shared = true) {
  const directory = mkdtempSync(join(tmpdir(), 'suite-link-http-'));
  let suite: Awaited<ReturnType<typeof startConfiguredSuite>> | undefined;
  t.after(async () => {
    await suite?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const deployments = [];
  const targetDb = join(directory, 'target', 'business.db');
  for (const id of ['source', 'target']) {
    const home = join(directory, id);
    mkdirSync(home);
    const database = join(home, 'business.db');
    const db = new DatabaseSync(database);
    db.exec(`CREATE TABLE note(id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE review(id TEXT PRIMARY KEY NOT NULL, body TEXT NOT NULL);
      CREATE TABLE secret(id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, body TEXT NOT NULL);
      INSERT INTO note VALUES('one', 'north', 'visible'), ('two', 'south', 'hidden'), ('9007199254740993', 'north', 'large key');`);
    db.close();
    const tenancy = tenant && id === 'target';
    if (tenancy) {
      provisionSqliteTenantStore(database, { appId: id, source: { id: 'data', connection: 'data' }, storeId: 'store' });
      const seed = new DatabaseSync(database);
      seed.exec(
        `INSERT INTO "${TENANT_TABLES.tenant}" VALUES('north','active','1','tenant'),('south','active','1','tenant'),('@platform','active','1','platform')`,
      );
      seed.close();
    }
    const to = (kind: string, value = {}) => ({ app: 'target', kind, ...value });
    const declarations = [
      to('home'),
      to('view', { view: 'notes' }),
      to('view', { view: 'secrets' }),
      to('record', { resource: 'secret', key: { id: 'literal' } }),
      ...(tenant
        ? [
            to('home', { tenant: { kind: 'choose' } }),
            to('home', { tenant: { kind: 'tenant', id: 'north' } }),
            to('home', { tenant: { kind: 'tenant', id: 'south' } }),
            to('home', { tenant: { kind: 'platform' } }),
            to('view', { view: 'reviews', tenant: { kind: 'platform' } }),
          ]
        : []),
    ];
    const resource = { ...(tenancy ? { owner: 'tenant', fields: { read: ['id', 'body'] } } : {}) };
    const manifest = {
      id,
      name: id,
      ...(tenancy ? { sources: { data: { connection: 'data' } } } : {}),
      auth: {
        store: join(home, 'auth.db'),
        providers: ['email'],
        signUp: 'open',
        ...(tenancy ? { rows: 'tenant', tenancy: { platform: { label: 'Platform' } } } : {}),
        roles: {
          reader: { read: ['note'], ...(tenancy ? { realm: 'tenant' } : {}) },
          full: { read: true, ...(tenancy ? { realm: 'tenant' } : {}) },
          ...(tenancy ? { manager: { read: true, realm: 'platform' } } : {}),
        },
      },
      resources: { note: resource, secret: resource, ...(tenancy ? { review: { owner: 'platform' } } : {}) },
      views: {
        /* The whole target's first list over notes is one only `full` is served: a reader's link is the record
           under the list they are served, /work, as their browser there says it. */
        ...(id === 'target' && !tenancy ? { 'all-notes': { kind: 'list', from: 'note', path: 'everything', roles: ['full'] } } : {}),
        notes: { kind: 'list', from: 'note', path: 'work' },
        secrets: { kind: 'list', from: 'secret', path: 'vault' },
        ...(tenancy ? { reviews: { kind: 'list', from: 'review', realm: 'platform' } } : {}),
        ...(id === 'source'
          ? {
              desk: {
                kind: 'dashboard',
                label: 'Desk',
                sections: declarations.map((target) => ({ kind: 'note', text: 'Open', action: { label: 'Open', to: target } })),
              },
            }
          : {}),
      },
      home: 'notes',
      nav: tenancy
        ? [
            { id: 'tenant', label: 'Tenant', realm: 'tenant', children: ['notes', 'secrets'] },
            { id: 'platform', label: 'Platform', realm: 'platform', children: ['reviews'] },
          ]
        : [...(id === 'target' ? ['all-notes'] : []), 'notes', 'secrets', ...(id === 'source' ? ['desk'] : [])],
      ...(id === 'source'
        ? {
            pages: {
              note: {
                base: 'note',
                sections: [
                  {
                    kind: 'note',
                    text: 'Open record',
                    action: {
                      label: 'Record',
                      to: to('record', {
                        resource: 'note',
                        key: { id: { column: 'id' } },
                        ...(tenant ? { tenant: { kind: 'tenant', id: { column: 'tenant_id' } } } : {}),
                      }),
                    },
                  },
                  {
                    kind: 'headline',
                    show: ['body'],
                    links: [{ label: 'Headline record', to: to('record', { resource: 'note', key: { id: { column: 'id' } } }) }],
                  },
                ],
              },
            },
          }
        : {}),
    };
    writeFileSync(join(home, 'app.json'), JSON.stringify(manifest));
    writeFileSync(join(home, 'connections.json'), JSON.stringify({ connections: [{ name: 'data', url: database }] }));
    if (tenancy)
      writeFileSync(
        join(home, 'policy.mjs'),
        `export default {kind:'tenant',appId:'target',storeId:'store',
      ownership:{note:{kind:'tenant',column:'tenant_id'},secret:{kind:'tenant',column:'tenant_id'},review:{kind:'platform'}},
      resolveMembershipRows:()=>({note:true,secret:true}),resolveRows:()=>({note:true,secret:true}),
      resolvePlatformRows:()=>({note:true,secret:true,review:true})};`,
      );
    deployments.push({
      id,
      directory: home,
      config: join(home, 'connections.json'),
      mount: id === 'target' && !tenant ? '/' : id === 'target' ? '/dealer' : '/desk',
      ...(tenancy ? { policy: join(home, 'policy.mjs') } : {}),
      environment: { BETTER_AUTH_SECRET: 'SECRET' },
    });
  }
  const environment = { SECRET: 'suite-link-test-secret-longer-than-thirty-two-characters' };
  const file = join(directory, 'suite.json');
  writeFileSync(
    file,
    JSON.stringify({
      port,
      basePath: base,
      apps: deployments,
      ...(shared
        ? {
            identity: {
              id: 'shared',
              store: './identity.db',
              grants: './grants.db',
              environment: { BETTER_AUTH_SECRET: 'SECRET' },
            },
          }
        : {}),
    }),
  );
  suite = await startConfiguredSuite(file, environment);
  const origin = suite.publicURL;
  const call = async (path: string, cookie = '', body?: unknown, headers: Record<string, string> = {}) => {
    const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      const req = request(
        `${origin}${base}${path}`,
        { method: body === undefined ? 'GET' : 'POST', headers: { origin, cookie, 'content-type': 'application/json', ...headers } },
        resolve,
      );
      req.on('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
    let text = '';
    for await (const chunk of response) text += chunk.toString();
    return {
      status: response.statusCode!,
      body: (() => {
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      })(),
      text,
      cache: response.headers['cache-control'],
      cookie: (response.headers['set-cookie'] ?? []).map((value) => value.split(';')[0]).join('; '),
    };
  };
  const signup = (path = '/api/auth/sign-up/email') =>
    call(path, '', { name: 'Reader', email: 'same@example.test', password: 'test-password-long-enough' });
  const grant = (subjectId: string, appId: string, roles: string[], expectedRevision: number) =>
    changeSuiteGrant(file, { subjectId, appId, roles, expectedRevision }, environment);
  return { call, signup, grant, targetDb, directory, close: () => suite!.close() };
}

for (const base of ['', '/tools/team'])
  test(`suite links use target grants and canonical root mounts (${base || 'root'})`, async (t) => {
    const f = await fixture(t, base);
    const account = await f.signup();
    assert.equal(account.status, 200, account.text);
    const id = account.body.user.id,
      headers = { 'x-mistri-account': id };
    const ask = (target: unknown, extra = {}) =>
      f.call('/api/suite/links/resolve', account.cookie, { sourceApp: 'source', target }, { ...headers, ...extra });
    const note = { app: 'target', kind: 'view', view: 'notes' };
    const unavailable = await ask(note);
    assert.equal(unavailable.status, 404);
    assert.equal(unavailable.cache, 'no-store');
    await f.grant(id, 'source', ['full'], 0);
    assert.equal((await ask(note)).status, 404, 'source role grants no target authority');
    await f.grant(id, 'target', ['reader'], 0);
    const allowed = await ask(note);
    assert.equal(allowed.status, 200, allowed.text);
    assert.equal(allowed.cache, 'no-store');
    assert.deepEqual(allowed.body, { accountId: id, href: `${base}/work` });
    assert.equal((await ask({ app: 'target', kind: 'home' })).body.href, `${base}/?app=target`);
    assert.equal(
      (await ask({ app: 'target', kind: 'record', resource: 'note', key: { id: 'a/b?c' } })).body.href,
      `${base}/work/a%2Fb%3Fc`,
    );
    assert.equal((await ask({ app: 'target', kind: 'view', view: 'secrets' })).status, 404, 'target role hides a declared view');
    assert.equal((await ask({ app: 'target', kind: 'record', resource: 'secret', key: { id: 'literal' } })).status, 404);
    await f.grant(id, 'target', ['full'], 1);
    assert.equal((await ask({ app: 'target', kind: 'view', view: 'secrets' })).status, 200);
    assert.equal((await ask({ app: 'target', kind: 'record', resource: 'secret', key: { id: 'literal' } })).status, 200);
    for (const target of [
      { app: 'target', kind: 'record', resource: 'secret', key: { id: 'changed-literal' } },
      { app: 'unknown', kind: 'home' },
      { app: 'source', kind: 'home' },
    ])
      assert.equal((await ask(target)).status, 404);
    assert.equal((await ask(note, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await ask(note, { host: 'evil.example', 'x-forwarded-host': 'localhost' })).status, 403);
    assert.equal((await ask(note, { 'x-mistri-account': 'stale' })).status, 409);
    for (const body of [
      null,
      [],
      {},
      { sourceApp: 'source' },
      { sourceApp: 'source', target: null },
      { sourceApp: 'source', target: note, href: '/forged' },
      { sourceApp: 'source', target: { ...note, key: {} } },
      { sourceApp: 'source', target: { app: 'target', kind: 'record', resource: 'note', key: { id: { column: 'id' } } } },
    ]) {
      assert.equal((await f.call('/api/suite/links/resolve', account.cookie, body, headers)).status, 400, JSON.stringify(body));
    }
    assert.equal((await f.call('/api/suite/links/resolve', account.cookie, { sourceApp: 'source', target: note })).status, 409);
    await f.grant(id, 'target', [], 2);
    assert.equal((await ask(note)).status, 404, 'revocation removes availability immediately');
    await f.grant(id, 'target', ['reader'], 3);
    assert.equal((await f.call('/api/auth/sign-out', account.cookie, {}, headers)).status, 200);
    assert.equal((await ask(note)).status, 401, 'logout invalidates the native proof');
  });

test('suite record pages serve note and headline bindings with lossless large keys', async (t) => {
  const f = await fixture(t, '/tools');
  const account = await f.signup();
  assert.equal(account.status, 200, account.text);
  const id = account.body.user.id,
    headers = { 'x-mistri-account': id };
  await f.grant(id, 'source', ['full'], 0);
  await f.grant(id, 'target', ['reader'], 0);
  const response = await f.call('/desk/api/pages?app=source', account.cookie, undefined, headers);
  assert.equal(response.status, 200, response.text);
  assert.equal(response.body.pages.length, 1, 'authored pages must reach the child HTTP server');
  const page = response.body.pages[0];
  assert.deepEqual(
    page.sections.map((section: { kind: string }) => section.kind),
    ['note', 'fields'],
  );
  assert.deepEqual(page.sections[0].action.to.key, { id: { column: 'id' } });
  assert.deepEqual(page.sections[1].actions[0].to.key, { id: { column: 'id' } });
  const composed = await f.call(
    '/desk/api/pages/compose',
    account.cookie,
    { app: 'source', page: page.id, key: { id: '9007199254740993' } },
    headers,
  );
  assert.equal(composed.status, 200, composed.text);
  assert.equal(composed.body.planned, true);
  const headlineRead = composed.body.reads.find(
    (read: { body: { view?: { id: string } } }) => read.body.view?.id === `page:${page.id}:row`,
  );
  assert.ok(headlineRead, composed.text);
  assert.equal(headlineRead.reply.rows[0].id, '9007199254740993', 'unshown headline binding is fetched without numeric coercion');
  const noteRead = await f.call(
    '/desk/api/view/run',
    account.cookie,
    {
      app: 'source',
      count: 'none',
      view: {
        id: `page:${page.id}:link`,
        name: 'Note',
        base: 'note',
        columns: [{ path: 'id' }],
        limit: 1,
        filter: { groups: [[{ path: 'id', op: '=', value: '9007199254740993' }]] },
      },
    },
    headers,
  );
  assert.equal(noteRead.status, 200, noteRead.text);
  assert.deepEqual(noteRead.body.rows, [{ id: '9007199254740993' }]);
  for (const [action, row] of [
    [page.sections[0].action, noteRead.body.rows[0]],
    [page.sections[1].actions[0], headlineRead.reply.rows[0]],
  ]) {
    const target = bindAppTarget(action.to, row, Object.keys(row));
    assert.deepEqual(target, { app: 'target', kind: 'record', resource: 'note', key: { id: '9007199254740993' } });
    const resolved = await f.call('/api/suite/links/resolve', account.cookie, { sourceApp: 'source', target }, headers);
    assert.deepEqual(resolved.body, { accountId: id, href: '/tools/work/9007199254740993' });
  }
});

test('equal emails in independent App identity stores do not enable suite link availability', async (t) => {
  const f = await fixture(t, '', false, false);
  const source = await f.signup('/desk/api/auth/sign-up/email'),
    target = await f.signup('/api/auth/sign-up/email');
  assert.equal(source.status, 200);
  assert.equal(target.status, 200);
  assert.notEqual(source.body.user.id, target.body.user.id);
  const response = await f.call(
    '/api/suite/links/resolve',
    `${source.cookie}; ${target.cookie}`,
    { sourceApp: 'source', target: { app: 'target', kind: 'home' } },
    { 'x-mistri-account': source.body.user.id },
  );
  assert.ok(response.status >= 400);
  assert.equal(response.body.href, undefined);
});

test('tenant destinations require target memberships, preserve explicit intent, and never inherit source contexts', async (t) => {
  const f = await fixture(t, '/suite', true);
  const account = await f.signup();
  assert.equal(account.status, 200, account.text);
  const id = account.body.user.id,
    headers = { 'x-mistri-account': id };
  await f.grant(id, 'source', ['full'], 0);
  await f.grant(id, 'target', ['reader'], 0);
  const ask = (target: unknown, extra = {}) =>
    f.call('/api/suite/links/resolve', account.cookie, { sourceApp: 'source', target }, { ...headers, ...extra });
  const home = { app: 'target', kind: 'home' };
  assert.equal((await ask(home)).status, 404, 'an App grant is not membership');
  const db = new DatabaseSync(f.targetDb);
  t.after(() => db.close());
  db.prepare(
    `INSERT INTO "${TENANT_TABLES.membership}" VALUES('member', 'north', ?, 'active', '1', '["reader"]', ?, 'member', NULL, NULL, NULL)`,
  ).run(id, Date.now() + 120000);
  const chosen = await ask({ ...home, tenant: { kind: 'tenant', id: 'north' } });
  assert.equal(chosen.status, 200, chosen.text);
  assert.equal(chosen.body.href, '/suite/dealer?tenant=north');
  assert.equal((await ask({ ...home, tenant: { kind: 'tenant', id: 'south' } })).status, 404);
  const forgedContext = {
    'x-mistri-context': 'source-context',
    'x-mistri-tab': 'source-tab',
    'x-mistri-lease-revision': '9',
    'x-tenant-id': 'south',
  };
  assert.equal((await ask(home, forgedContext)).body.href, '/suite/dealer', 'no hint opens target chooser without inherited selectors');
  assert.equal((await ask({ ...home, tenant: { kind: 'choose' } }, forgedContext)).body.href, '/suite/dealer');
  const record = { app: 'target', kind: 'record', resource: 'note', key: { id: 'one' }, tenant: { kind: 'tenant', id: 'north' } };
  assert.equal((await ask(record, forgedContext)).body.href, '/suite/dealer/work/one?tenant=north');
  assert.equal(
    (await ask({ ...record, key: { id: 'missing' } }, forgedContext)).body.href,
    '/suite/dealer/work/missing?tenant=north',
    'availability checks the target resource, not record existence',
  );
  assert.equal(
    (await ask({ app: 'target', kind: 'view', view: 'notes' }, forgedContext)).body.href,
    '/suite/dealer/work',
    'selectorless views use target membership without copying source context',
  );
  assert.equal((await ask({ ...record, tenant: { kind: 'tenant', id: 'south' } })).status, 404);
  const secrets = { app: 'target', kind: 'view', view: 'secrets' };
  await f.grant(id, 'target', ['full'], 1);
  assert.equal((await ask(secrets)).status, 404, 'a broad suite grant cannot widen native membership roles');
  db.exec(`UPDATE "${TENANT_TABLES.membership}" SET roles_json='["full"]', version='2' WHERE id='member'`);
  assert.equal((await ask(secrets)).status, 200, 'target metadata uses current membership roles');
  const platform = { ...home, tenant: { kind: 'platform' } };
  assert.equal((await ask(platform)).status, 404, 'tenant membership does not authorize platform');
  await f.grant(id, 'target', ['full', 'manager'], 2);
  assert.equal((await ask(platform)).status, 404, 'platform App role does not substitute for platform membership');
  db.prepare(
    `INSERT INTO "${TENANT_TABLES.membership}" VALUES('platform-member', '@platform', ?, 'active', '1', '["manager"]', ?, 'member', NULL, NULL, NULL)`,
  ).run(id, Date.now() + 120000);
  const platformHome = await ask(platform);
  assert.equal(platformHome.status, 200, platformHome.text);
  assert.equal(platformHome.body.href, '/suite/dealer?realm=platform');
  assert.equal(
    (await ask({ app: 'target', kind: 'view', view: 'reviews', tenant: { kind: 'platform' } })).body.href,
    '/suite/dealer/reviews?realm=platform',
  );
  db.exec(`UPDATE "${TENANT_TABLES.membership}" SET status='invited', version='3' WHERE id='member'`);
  assert.equal(
    (await ask(home)).body.href,
    '/suite/dealer',
    'a platform-only member may open the native chooser without forced tenant context',
  );
  assert.equal((await ask({ ...home, tenant: { kind: 'tenant', id: 'north' } })).status, 404);
  db.exec(`UPDATE "${TENANT_TABLES.membership}" SET status='invited', version='3'`);
  assert.equal((await ask(home)).status, 404, 'fresh discovery observes membership removal');
  assert.equal((await ask(platform)).status, 404, 'platform membership revocation removes availability');
  await f.grant(id, 'target', [], 3);
  assert.equal((await ask(home)).status, 404);
});
