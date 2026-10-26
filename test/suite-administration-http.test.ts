/** Same-App stable-subject reads, with real cookies and held request bodies. */
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Script, runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { startConfiguredSuite } from '../packages/mistri/src/server/cli/suiteCommand.js';
import { changeSuiteGrant } from '../packages/mistri/src/server/cli/suiteGrant.js';
import { openSuiteGrantStore, provisionSuiteGrantStore } from '../packages/mistri/src/server/auth/suiteGrantStore.js';
import { suiteChooserPage } from '../packages/mistri/src/server/auth/suiteChooser.js';
import type { SuiteGrantView, SuiteInvitationsView } from '../packages/mistri/src/shared/suiteAdministration.js';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test('suite administration reads are same-App, account-bound, strict, and revalidate after body awaits', { timeout: 30_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-suite-administration-'));
  let suite: Awaited<ReturnType<typeof startConfiguredSuite>> | undefined;
  t.after(async () => {
    await suite?.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const apps = [];
  for (const id of ['alpha', 'beta']) {
    const home = join(dir, id);
    mkdirSync(home);
    const db = new DatabaseSync(join(home, 'data.db'));
    db.exec('CREATE TABLE note(id INTEGER PRIMARY KEY)');
    db.close();
    writeFileSync(
      join(home, 'app.json'),
      JSON.stringify({
        id,
        name: id,
        resources: { note: {} },
        auth: { providers: ['email'], roles: { reader: { read: true } } },
        views: { notes: { kind: 'list', from: 'note' } },
        home: 'notes',
      }),
    );
    writeFileSync(join(home, 'connections.json'), JSON.stringify({ connections: [{ name: 'data', url: join(home, 'data.db') }] }));
    apps.push({ id, directory: `./${id}`, config: `./${id}/connections.json`, mount: `/${id}` });
  }
  const file = join(dir, 'suite.json'),
    environment = { SECRET: 'test-suite-administration-secret-at-least-thirty-two-characters' };
  writeFileSync(
    file,
    JSON.stringify({
      port,
      basePath: '/tools',
      apps,
      identity: { id: 'shared', store: './identity.db', grants: './grants.db', environment: { BETTER_AUTH_SECRET: 'SECRET' } },
    }),
  );
  suite = await startConfiguredSuite(file, environment);
  const origin = suite.publicURL;
  const call = async (path: string, headers: Record<string, string> = {}, body?: unknown) => {
    const response = await fetch(`${origin}/tools${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { origin, 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5000),
    });
    return {
      status: response.status,
      body: await response.json(),
      cache: response.headers.get('cache-control'),
      cookie: response.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; '),
    };
  };
  const account = async (name: string) => {
    const answer = await call(
      '/api/auth/sign-up/email',
      {},
      { name, email: `${name}@example.test`, password: 'test-password-long-enough' },
    );
    assert.equal(answer.status, 200);
    return { id: answer.body.user.id as string, headers: { cookie: answer.cookie, 'x-mistri-account': answer.body.user.id as string } };
  };
  const admin = await account('admin'),
    target = await account('target');
  const grant = (subjectId: string, roles: string[], expectedRevision: number, appId = 'alpha') =>
    changeSuiteGrant(file, { subjectId, roles, expectedRevision, appId }, environment);
  await grant(admin.id, ['admin'], 0);
  await grant(admin.id, ['reader'], 0, 'beta');
  const chooser = await call('/api/suite/apps', admin.headers);
  assert.deepEqual(chooser.body.apps, [
    { id: 'alpha', name: 'alpha', href: '/tools/alpha/', manageHref: '/tools/_mistri/apps#manage=alpha' },
    { id: 'beta', name: 'beta', href: '/tools/beta/' },
  ]);
  const readPath = '/alpha/api/suite/grants/read',
    listPath = '/alpha/api/suite/invitations/list';
  const read = await call(readPath, admin.headers, { subjectId: target.id });
  assert.equal(read.status, 200);
  assert.equal(read.cache, 'no-store');
  assert.deepEqual(read.body satisfies SuiteGrantView, {
    accountId: admin.id,
    appId: 'alpha',
    subjectId: target.id,
    revision: 0,
    roles: [],
    assignableRoles: ['reader', 'user', 'admin'],
  });
  for (const [path, body] of [
    [readPath, { subjectId: target.id }],
    [listPath, { subjectId: target.id, offset: 0 }],
  ] as const) {
    assert.equal((await call(path, {}, body)).status, 401);
    assert.equal((await call(path, target.headers, { unknown: true })).status, 403, 'authority precedes body validation');
    assert.equal((await call(path.replace('/alpha/', '/beta/'), admin.headers, body)).status, 403);
    assert.equal((await call(path, { ...admin.headers, origin: 'http://foreign.invalid' }, body)).status, 403);
    assert.equal((await call(path, { ...admin.headers, 'content-type': 'text/plain' }, body)).status, 403);
    assert.equal((await call(path, { ...admin.headers, 'x-mistri-account': target.id }, body)).status, 409);
    assert.equal((await call(path, admin.headers)).status, 405);
    assert.equal((await call(path, admin.headers, { ...body, extra: true })).status, 400);
    assert.equal((await call(path, admin.headers, { ...body, subjectId: 'missing' })).status, 404);
    assert.equal((await call(path, admin.headers, { ...body, subjectId: 'target@example.test' })).status, 404, 'no email lookup');
    for (const subjectId of ['', ' padded', 'bad\u0000id', 'x'.repeat(1025)])
      assert.equal((await call(path, admin.headers, { ...body, subjectId })).status, 400);
  }
  for (const offset of [-1, 0.5, '0', 1_000_001, null])
    assert.equal((await call(listPath, admin.headers, { subjectId: target.id, offset })).status, 400);
  assert.equal((await call(listPath, admin.headers, { subjectId: target.id })).status, 400);
  assert.equal(
    (
      await call('/alpha/api/suite/invitations/issue', admin.headers, {
        subjectId: target.id,
        roles: ['reader'],
        expectedRevision: 0,
        expiresAt: Date.now() + 60000,
        delivery: 'email',
      })
    ).status,
    400,
    'email mode refuses before issuance when no suite transport is configured',
  );
  const issued = await call('/alpha/api/suite/invitations/issue', admin.headers, {
    subjectId: target.id,
    roles: ['reader'],
    expectedRevision: 0,
    expiresAt: Date.now() + 60000,
  });
  assert.equal(issued.status, 200);
  const list = await call(listPath, admin.headers, { subjectId: target.id, offset: 0 });
  const listed = list.body as SuiteInvitationsView;
  assert.equal(list.status, 200);
  assert.equal(listed.invitations[0].status, 'pending');
  assert.equal(listed.invitations[0].id, issued.body.id);
  assert.equal(JSON.stringify(listed).includes(issued.body.token), false);
  assert.equal(JSON.stringify(listed).includes('token'), false);
  await grant(target.id, ['reader'], 0);
  await grant(target.id, [], 1);
  assert.equal((await call(readPath, admin.headers, { subjectId: target.id })).body.revision, 2);
  assert.equal((await call(listPath, admin.headers, { subjectId: target.id, offset: 0 })).body.invitations[0].status, 'target-changed');
  assert.equal((await call('/alpha/api/suite/invitations/revoke', admin.headers, { id: issued.body.id })).status, 200);
  assert.equal((await call(listPath, admin.headers, { subjectId: target.id, offset: 0 })).body.invitations[0].status, 'revoked');

  // The barrier is the body iterator, reached only after the original actor
  // revision was captured. Revocation during this await must fence the reply.
  const held = async (path: string, body: unknown, during: () => Promise<unknown>) => {
    const reading = deferred<void>();
    suite!.server.prependOnceListener('request', (req) => {
      const iterator = req[Symbol.asyncIterator].bind(req);
      req[Symbol.asyncIterator] = () => {
        reading.resolve();
        return iterator();
      };
    });
    const text = JSON.stringify(body),
      reply = deferred<number>();
    const pending = request(
      `${origin}/tools${path}`,
      {
        method: 'POST',
        headers: { origin, ...admin.headers, 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) },
      },
      (response) => {
        response.resume();
        response.on('end', () => reply.resolve(response.statusCode!));
      },
    );
    pending.on('error', reply.reject);
    pending.setTimeout(5000, () => pending.destroy(new Error('Held request timed out.')));
    pending.write(text.slice(0, 1));
    try {
      await reading.promise;
      await during();
      pending.end(text.slice(1));
      return await reply.promise;
    } finally {
      pending.destroy();
    }
  };
  assert.equal(
    await held(readPath, { subjectId: 'missing' }, () => grant(admin.id, [], 1)),
    409,
    'recheck precedes missing-account disclosure',
  );
  assert.equal(
    (await call('/api/suite/apps', admin.headers)).body.apps.some((app: { manageHref?: string }) => app.manageHref),
    false,
  );
  await grant(admin.id, ['admin'], 2);
  const sessionDenied = await held(listPath, { subjectId: target.id, offset: 0 }, () => call('/api/auth/sign-out', admin.headers, {}));
  assert.ok(sessionDenied >= 400, 'session retirement during a body await refuses a read');
});

test('invitation summaries are bounded and classify terminal, expiry, role and revision states without secrets', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  provisionSuiteGrantStore(db, 'shared');
  const store = openSuiteGrantStore(db, 'shared'),
    declaredRoles = ['reader', 'admin', 'retired'];
  const admin = { appId: 'alpha', subjectId: 'admin', actorId: 'operator', expectedRevision: 0, roles: ['admin'], declaredRoles };
  store.change(admin);
  store.change({ ...admin, subjectId: 'issuer' });
  const authority = { administratorRevision: 1 },
    now = 1000;
  const issue = (subjectId: string, roles = ['reader']) =>
    store.issueInvitation({ ...admin, subjectId, actorId: 'issuer', roles, expiresAt: now + 100 }, authority, now);
  const list = (subjectId: string, at = now, declared = declaredRoles, offset = 0) =>
    store.listInvitations({ appId: 'alpha', subjectId, actorId: 'admin', declaredRoles: declared, offset }, authority, at);
  const pending = issue('pending');
  assert.equal(list('pending').invitations[0].status, 'pending');
  assert.equal(list('pending', now - 1).invitations[0].status, 'not-yet-valid');
  assert.equal(list('pending', now + 100).invitations[0].status, 'expired');
  issue('role', ['retired']);
  assert.equal(list('role', now, ['admin', 'reader']).invitations[0].status, 'roles-changed');
  const consumed = issue('consumed');
  store.acceptInvitation({ appId: 'alpha', subjectId: 'consumed', token: consumed.token, declaredRoles }, now);
  assert.equal(list('consumed', now + 100).invitations[0].status, 'consumed');
  assert.equal(list('consumed').invitations[0].canRevoke, false);
  const revoked = issue('revoked');
  store.revokeInvitation({ appId: 'alpha', id: revoked.id, actorId: 'admin' }, authority, now);
  assert.equal(list('revoked', now + 100).invitations[0].status, 'revoked');
  assert.equal(list('revoked').invitations[0].canRevoke, false);
  issue('changed');
  store.change({ ...admin, subjectId: 'changed', roles: [] });
  assert.equal(list('changed').invitations[0].status, 'target-changed');
  for (let index = 0; index < 27; index++) issue('paged');
  const page = list('paged'),
    second = list('paged', now, declaredRoles, 25);
  assert.equal(page.total, 27);
  assert.equal(page.invitations.length, 25);
  assert.equal(second.invitations.length, 2);
  assert.equal(new Set([...page.invitations, ...second.invitations].map((item) => item.id)).size, 27);
  const before = db.prepare('SELECT count(*) AS n FROM suite_invitation_audit').get()!.n;
  assert.equal(JSON.stringify(list('pending')).includes(pending.token), false);
  assert.deepEqual(
    Object.keys(list('pending').invitations[0]).sort(),
    ['id', 'roles', 'expectedRevision', 'actorId', 'issuedAt', 'expiresAt', 'status', 'canRevoke'].sort(),
  );
  store.change({ ...admin, subjectId: 'issuer', roles: [], expectedRevision: 1 });
  store.change({ ...admin, subjectId: 'issuer', expectedRevision: 2 });
  assert.equal(list('pending').invitations[0].status, 'issuer-changed');
  assert.equal(db.prepare('SELECT count(*) AS n FROM suite_invitation_audit').get()!.n, before);
  assert.throws(() => list('paged', now, declaredRoles, 1_000_001));
  assert.throws(() => store.readAdministration({ appId: 'beta', subjectId: 'pending', actorId: 'admin', declaredRoles }, authority));
  store.change({ ...admin, roles: [], expectedRevision: 1 });
  assert.throws(() => list('pending'));
  assert.equal(db.prepare('SELECT version FROM suite_binding').get()!.version, 1);
});

test('chooser embeds a syntactically valid administration script and escapes suite names', () => {
  const html = suiteChooserPage('<unsafe>', '/tools', 'test');
  assert.ok(html.includes('&lt;unsafe&gt;'));
  const script = /<script nonce="test">([\s\S]*)<\/script>/.exec(html)![1];
  assert.doesNotThrow(() => new Script(script));
});

test('chooser entry continuation accepts only the fixed root and a single matching selector, with hash priority', () => {
  const html = suiteChooserPage('Suite', '/tools/team', 'test', 'lender');
  const entry = /function entryFromAddress\(\)\{[\s\S]*?\n\}/.exec(html)![0];
  const continuation = (search: string, hash = '', base = '/tools/team') =>
    runInNewContext(`${entry}; entryFromAddress()`, {
      base,
      rootAppId: 'lender',
      URLSearchParams,
      location: { search, hash },
    });
  assert.equal(continuation('?entry=1'), '/tools/team/');
  assert.equal(continuation('?entry=1&app=lender'), '/tools/team/?app=lender');
  assert.equal(continuation('?entry=1&app=lender', '', ''), '/?app=lender');
  for (const search of [
    '',
    '?entry=0',
    '?entry=1&entry=1',
    '?entry=1&app=benefits',
    '?entry=1&app=',
    '?entry=1&app=lender&app=lender',
    '?entry=1&%61pp=lender&app=lender',
    '?entry=1&returnTo=https://evil.test',
  ]) {
    assert.equal(continuation(search), null, search);
  }
  for (const hash of ['#manage=lender', `#invite=benefits.${'A'.repeat(43)}`, '#unknown']) {
    assert.equal(continuation('?entry=1&app=lender', hash), null, hash);
  }
});
