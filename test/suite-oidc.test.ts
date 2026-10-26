/**
 * OIDC as a suite's shared identity: the single App's provider code (state,
 * nonce and PKCE, issuer and audience checks, linking only on a verified
 * email, just-in-time sign-up) behind the suite's one sign-in, and App access
 * still from per-App grants: an App that maps roles from claims has its grant
 * derived at each sign-in, audited, revoked when the claim goes, and never
 * widened past what an administrator set by hand.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { startConfiguredSuite } from '../packages/mistri/src/server/cli/suiteCommand.js';
import { changeSuiteGrant } from '../packages/mistri/src/server/cli/suiteGrant.js';
import { startMockOidc, type MockOidc, type NextSignIn } from './support/mockOidc.js';

let directory: string, file: string, idp: MockOidc, origin: string;
let suite: Awaited<ReturnType<typeof startConfiguredSuite>>;
const environment: NodeJS.ProcessEnv = {
  SECRET: 'test-only-suite-oidc-secret-longer-than-thirty-two',
  IDP_SECRET: 'mock-client-secret-0123456789',
};

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'tablewalk-suite-oidc-'));
  idp = await startMockOidc();
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const apps = [];
  for (const [id, mapped] of [
    ['crew', true],
    ['books', false],
  ] as const) {
    const home = join(directory, id);
    mkdirSync(home);
    const database = join(home, 'business.db');
    const db = new DatabaseSync(database);
    db.exec('CREATE TABLE note(id INTEGER PRIMARY KEY, body TEXT)');
    db.close();
    writeFileSync(
      join(home, 'app.json'),
      JSON.stringify({
        id,
        name: id,
        resources: { note: {} },
        auth: {
          providers: mapped ? ['email', 'oidc:workforce'] : ['email'],
          roles: mapped
            ? { viewer: { read: true }, dispatcher: { read: true, claims: { groups: ['dispatch'] } } }
            : { user: { read: true } },
        },
        views: { notes: { kind: 'list', from: 'note' } },
        home: 'notes',
      }),
    );
    writeFileSync(join(home, 'connections.json'), JSON.stringify({ connections: [{ name: 'data', url: database }] }));
    apps.push({ id, directory: `./${id}`, config: `./${id}/connections.json`, mount: `/${id}`, environment: {} });
  }
  file = join(directory, 'suite.json');
  writeFileSync(
    file,
    JSON.stringify({
      port,
      apps,
      identity: {
        id: 'suite',
        store: './identity.db',
        grants: './grants.db',
        environment: { BETTER_AUTH_SECRET: 'SECRET', WORKFORCE_SECRET: 'IDP_SECRET' },
        providers: ['email', 'oidc:workforce'],
        signUp: 'open',
        services: [
          {
            name: 'workforce',
            kind: 'oidc',
            issuer: idp.issuer,
            clientId: idp.clientId,
            clientSecret: '${WORKFORCE_SECRET}',
            label: 'Crew SSO',
            insecure: true,
          },
        ],
      },
    }),
  );
  suite = await startConfiguredSuite(file, environment);
  origin = suite.publicURL;
});

after(async () => {
  await suite?.close();
  await idp?.close();
  rmSync(directory, { recursive: true, force: true });
});

const call = async (url: string, init: RequestInit & { cookie?: string } = {}) => {
  const headers: Record<string, string> = { origin, ...((init.headers as Record<string, string>) ?? {}) };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.body) headers['content-type'] = 'application/json';
  const res = await fetch(url.startsWith('http') ? url : `${origin}${url}`, { ...init, headers, redirect: 'manual' });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return {
    status: res.status,
    json,
    text,
    location: res.headers.get('location'),
    cookies: res.headers.getSetCookie().map((c) => c.split(';')[0]),
  };
};
const jar = (...lists: string[][]) => {
  const kept = new Map<string, string>();
  for (const cookie of lists.flat()) {
    const [name] = cookie.split('=');
    kept.set(name, cookie);
  }
  return [...kept.values()].filter((cookie) => !cookie.endsWith('=')).join('; ');
};

/** The whole flow from an App's door: ask, let the provider answer, follow it to the suite's callback. */
async function signIn(who: NextSignIn, door = '/crew') {
  const started = await call(`${door}/api/auth/sign-in/social`, {
    method: 'POST',
    body: JSON.stringify({ provider: 'workforce', callbackURL: `${origin}${door}/`, errorCallbackURL: `${origin}${door}/` }),
  });
  assert.equal(started.status, 200, started.text);
  const authorize = new URL(String(started.json.url));
  idp.next(who);
  const answered = await call(authorize.href);
  assert.equal(answered.status, 302, answered.text);
  const back = await call(answered.location!, { cookie: jar(started.cookies) });
  const landed = new URL(back.location ?? '', origin);
  return { authorize, landed, error: landed.searchParams.get('error'), session: jar(started.cookies, back.cookies) };
}
const grants = () => {
  const db = new DatabaseSync(join(directory, 'grants.db'), { readOnly: true });
  try {
    return {
      grants: db.prepare('SELECT app_id, subject_id, revision, roles FROM suite_grant ORDER BY app_id').all(),
      audit: db.prepare('SELECT app_id, actor_id, before_roles, after_roles FROM suite_grant_audit ORDER BY app_id, revision').all(),
    };
  } finally {
    db.close();
  }
};
const account = (email: string) => {
  const db = new DatabaseSync(join(directory, 'identity.db'), { readOnly: true });
  try {
    const user = db.prepare('SELECT id, emailVerified FROM "user" WHERE email = ?').get(email) as { id: string } | undefined;
    const methods = user
      ? db
          .prepare('SELECT providerId FROM account WHERE userId = ? ORDER BY providerId')
          .all(user.id)
          .map((row) => row.providerId)
      : [];
    return { user, methods };
  } finally {
    db.close();
  }
};
const whoami = async (path: string, session: string) => (await call(`${path}/api/whoami`, { cookie: session })).json;

test('the suite door names the provider by its label; a first sign-in is made just in time through PKCE, state and nonce', async () => {
  const door = await call('/crew/api/whoami');
  const info = door.json.signIn as Record<string, unknown>;
  assert.deepEqual(info.labels, { 'oidc:workforce': 'Crew SSO' });
  for (const secret of [idp.issuer, idp.clientSecret]) assert.equal(door.text.includes(secret), false);
  const done = await signIn({
    sub: 'u-ada',
    email: 'ada@crew.example',
    email_verified: true,
    name: 'Ada',
    claims: { groups: ['dispatch'] },
  });
  assert.equal(done.error, null, done.landed.href);
  const asked = done.authorize.searchParams;
  assert.equal(asked.get('code_challenge_method'), 'S256');
  assert.ok(asked.get('code_challenge') && asked.get('nonce') && asked.get('state'));
  // The callback is the suite's own, one per suite, whichever App's door the sign-in began at.
  assert.equal(asked.get('redirect_uri'), `${origin}/api/auth/callback/workforce`);
  const { user } = account('ada@crew.example');
  assert.ok(user);
  // The claims gave crew its grant, derived and audited; books maps nothing, so grants nothing.
  const state = grants();
  assert.deepEqual(
    state.grants.map((row) => [row.app_id, row.roles]),
    [['crew', '["dispatcher"]']],
  );
  assert.deepEqual(
    state.audit.map((row) => [row.app_id, row.actor_id, row.after_roles]),
    [['crew', 'provider:workforce', '["dispatcher"]']],
  );
  assert.equal((await whoami('/crew', done.session)).signedIn, true);
  assert.equal((await whoami('/books', done.session)).signedIn, false, 'a suite account is no grant');
});

test('a derived grant is revoked when the claim goes, and returns with it', async () => {
  const gone = await signIn({ sub: 'u-ada', email: 'ada@crew.example', email_verified: true, claims: { groups: [] } });
  assert.equal(gone.error, null);
  assert.deepEqual(
    grants().grants.map((row) => [row.app_id, row.roles]),
    [['crew', '[]']],
  );
  assert.equal((await whoami('/crew', gone.session)).signedIn, false);
  const back = await signIn({ sub: 'u-ada', email: 'ada@crew.example', email_verified: true, claims: { groups: ['dispatch'] } });
  assert.deepEqual(
    grants().grants.map((row) => [row.app_id, row.roles]),
    [['crew', '["dispatcher"]']],
  );
  assert.equal((await whoami('/crew', back.session)).signedIn, true);
});

test('claims never change a grant an administrator set by hand', async () => {
  const { user } = account('ada@crew.example');
  const revision = Number(grants().grants[0].revision);
  await changeSuiteGrant(
    file,
    { appId: 'crew', subjectId: user!.id, expectedRevision: revision, roles: ['viewer'], actor: 'operator' },
    environment,
  );
  await signIn({ sub: 'u-ada', email: 'ada@crew.example', email_verified: true, claims: { groups: ['dispatch'] } });
  assert.deepEqual(
    grants().grants.map((row) => [row.app_id, row.roles]),
    [['crew', '["viewer"]']],
  );
  await signIn({ sub: 'u-ada', email: 'ada@crew.example', email_verified: true, claims: { groups: [] } });
  assert.deepEqual(
    grants().grants.map((row) => [row.app_id, row.roles]),
    [['crew', '["viewer"]']],
    'nor narrows it',
  );
  // The hand-set change is the operator's in the audit; the provider's actor name is reserved to derivation (suiteGrantStore.ts).
  assert.match(String(grants().audit.at(-1)!.actor_id), /^(?!provider:)/);
});

test('a token from another issuer, or for another audience, signs no one in', async () => {
  for (const tamper of [{ issuer: 'https://elsewhere.example' }, { audience: 'another-client' }]) {
    const refused = await signIn({
      sub: 'u-eve',
      email: 'eve@crew.example',
      email_verified: true,
      claims: { groups: ['dispatch'] },
      tamper,
    });
    assert.notEqual(refused.error, null, JSON.stringify(tamper));
    assert.equal(account('eve@crew.example').user, undefined);
  }
});

test('an account is linked only on a verified email, and what an unverified address held ends', async () => {
  const made = await call('/api/auth/sign-up/email', {
    method: 'POST',
    body: JSON.stringify({ name: 'Bob', email: 'bob@crew.example', password: 'a-test-only-password' }),
  });
  assert.equal(made.status, 200, made.text);
  const before = account('bob@crew.example');
  const unverified = await signIn({ sub: 'u-bob', email: 'bob@crew.example', email_verified: false, claims: { groups: ['dispatch'] } });
  assert.notEqual(unverified.error, null, 'an unverified address never links');
  assert.deepEqual(account('bob@crew.example').methods, ['credential']);
  const verified = await signIn({ sub: 'u-bob', email: 'bob@crew.example', email_verified: true, claims: { groups: ['dispatch'] } });
  assert.equal(verified.error, null);
  const linked = account('bob@crew.example');
  assert.equal(linked.user!.id, before.user!.id, 'the same suite account');
  assert.deepEqual(linked.methods, ['workforce'], 'the never-verified password went with the proof');
});

test('a grant derived from claims holds only for a session its provider opened, never a password session of the same account', async () => {
  const made = await call('/api/auth/sign-up/email', {
    method: 'POST',
    body: JSON.stringify({ name: 'Cy', email: 'cy@crew.example', password: 'a-test-only-password' }),
  });
  assert.equal(made.status, 200, made.text);
  // A proven address: the provider's sign-in links to it and the password stays, so the account has two ways in.
  const db = new DatabaseSync(join(directory, 'identity.db'));
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.prepare('UPDATE "user" SET emailVerified = 1 WHERE email = ?').run('cy@crew.example');
  } finally {
    db.close();
  }
  const sso = await signIn({ sub: 'u-cy', email: 'cy@crew.example', email_verified: true, claims: { groups: ['dispatch'] } });
  assert.equal(sso.error, null);
  assert.deepEqual(account('cy@crew.example').methods, ['credential', 'workforce']);
  assert.equal((await whoami('/crew', sso.session)).signedIn, true, "the provider's session holds what its claims gave");
  /* The same account by its password: after the IdP removed the group, a
     password session would otherwise keep the role until the next IdP sign-in. */
  const password = await call('/api/auth/sign-in/email', {
    method: 'POST',
    body: JSON.stringify({ email: 'cy@crew.example', password: 'a-test-only-password' }),
  });
  assert.equal(password.status, 200, password.text);
  assert.equal((await whoami('/crew', jar(password.cookies))).signedIn, false, "a derived grant is the provider's, never the password's");
  // The provider's session still holds it, and a hand-set grant holds for any session.
  assert.equal((await whoami('/crew', sso.session)).signedIn, true);
  const cy = account('cy@crew.example').user!;
  const row = new DatabaseSync(join(directory, 'grants.db'), { readOnly: true });
  const revision = Number(
    (row.prepare('SELECT revision FROM suite_grant WHERE app_id = ? AND subject_id = ?').get('crew', cy.id) as { revision: number })
      .revision,
  );
  row.close();
  await changeSuiteGrant(
    file,
    { appId: 'crew', subjectId: cy.id, expectedRevision: revision, roles: ['viewer'], actor: 'operator' },
    environment,
  );
  assert.equal((await whoami('/crew', jar(password.cookies))).signedIn, true);
});

test('an App whose door names a provider the suite lacks is refused at startup', async () => {
  const home = join(directory, 'crew');
  const manifest = join(home, 'app.json');
  const { readFileSync } = await import('node:fs');
  const original = readFileSync(manifest, 'utf8');
  const changed = JSON.parse(original);
  changed.auth.providers = ['email', 'oidc:elsewhere'];
  writeFileSync(manifest, JSON.stringify(changed));
  try {
    await assert.rejects(startConfiguredSuite(file, environment), /signs people in through the suite's providers/);
  } finally {
    writeFileSync(manifest, original);
  }
});
