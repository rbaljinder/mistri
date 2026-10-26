/** Suite login: one sign-in, landing by the account's grants, a deep link
 * carried only where its App admits the account, and one sign-out. Sharing the
 * identity must never widen what any App lets an account do. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import type { LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import { readSuiteConfiguration } from '../packages/mistri/src/server/cli/suiteConfig.js';
import { openSuiteIdentity } from '../packages/mistri/src/server/auth/suiteIdentity.js';
import { landingFor, suiteDeepLink } from '../packages/mistri/src/server/auth/suiteLanding.js';
import { startSuiteLogin, type SuiteLogin } from './support/suiteLoginFixture.js';

const page = { accept: 'text/html,application/xhtml+xml', 'sec-fetch-dest': 'document' };
async function call(suite: SuiteLogin, path: string, cookie = '', headers: Record<string, string> = {}, body?: unknown) {
  const response = await fetch(`${suite.origin}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    redirect: 'manual',
    headers: { origin: suite.origin, cookie, 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  return { status: response.status, location: response.headers.get('location'), text };
}

test('one sign-in lands each Keystone-shaped account by its grants; several Apps ask and none says so', async (t) => {
  const suite = await startSuiteLogin();
  t.after(() => suite.close());
  const { officer, manager, agent, borrower, nobody } = suite.accounts;
  assert.equal((await call(suite, '/', '', page)).location, '/_mistri/apps?entry=1', 'signed out: the suite sign-in');
  const officerRoot = await call(suite, '/', officer.cookie, page);
  assert.equal(officerRoot.status, 200, 'the officer rule names the root App, served in place');
  assert.equal(officerRoot.location, null);
  assert.equal((await call(suite, '/', manager.cookie, page)).location, '/dealer/', 'the manager rule, over the Leads grant');
  assert.equal((await call(suite, '/', borrower.cookie, page)).location, '/customer/', 'the default rule');
  assert.equal((await call(suite, '/', agent.cookie, page)).location, '/_mistri/apps', 'two Apps, no rule: the chooser');
  assert.equal((await call(suite, '/', nobody.cookie, page)).location, '/_mistri/apps', 'no App: the chooser');
  const listed = async (cookie: string) =>
    (JSON.parse((await call(suite, '/api/suite/apps', cookie)).text).apps as { id: string }[]).map((app) => app.id).sort();
  assert.deepEqual(await listed(agent.cookie), ['dealer', 'leads']);
  /* An App that declares a logo arrives with its drawing as path data; one that does not, with none. */
  const marks = (JSON.parse((await call(suite, '/api/suite/apps', agent.cookie)).text).apps as { id: string; icon?: string[] }[]).map(
    (app) => [app.id, Boolean(app.icon?.length && app.icon.every((d) => typeof d === 'string'))],
  );
  assert.deepEqual(marks.sort(), [
    ['dealer', true],
    ['leads', false],
  ]);
  assert.deepEqual(await listed(nobody.cookie), [], 'the chooser lists nothing, and says so');
  const chooser = await call(suite, '/_mistri/apps', nobody.cookie, page);
  assert.match(chooser.text, /No App access has been granted yet/);
  assert.match(chooser.text, /Sign out of the suite/);

  // A saved default is the account's own choice and outranks the operator's rules.
  const headers = { 'x-mistri-account': manager.id };
  assert.equal(
    (await call(suite, '/api/suite/preferences', manager.cookie, headers, { defaultApp: 'leads', expectedRevision: 0 })).status,
    200,
  );
  assert.equal((await call(suite, '/', manager.cookie, page)).location, '/leads/');
});

test('a deep link opens only where its App admits the account; APIs and other Apps stay closed', async (t) => {
  const suite = await startSuiteLogin();
  t.after(() => suite.close());
  const { officer, manager, borrower } = suite.accounts;
  assert.equal((await call(suite, '/dealer/notes/1', manager.cookie, page)).status, 200);
  assert.equal((await call(suite, '/leads/notes', manager.cookie, page)).status, 200);
  // Lender's pages and API, after the manager's shared sign-in.
  assert.equal((await call(suite, '/notes/1', manager.cookie, page)).location, '/_mistri/apps?next=%2Fnotes%2F1');
  assert.equal(
    (await call(suite, '/notes?search=fixture', manager.cookie, { accept: 'text/html' })).location,
    '/_mistri/apps?next=%2Fnotes%3Fsearch%3Dfixture',
  );
  assert.equal((await call(suite, '/customer/notes', manager.cookie, page)).location, '/_mistri/apps?next=%2Fcustomer%2Fnotes');
  for (const path of ['/api/schema', '/customer/api/schema']) assert.equal((await call(suite, path, manager.cookie)).status, 401, path);
  const who = JSON.parse((await call(suite, '/api/whoami', manager.cookie)).text);
  assert.equal(who.signedIn, false, 'Lender does not know the manager');
  assert.equal(JSON.parse((await call(suite, '/dealer/api/whoami', manager.cookie)).text).accountId, manager.id);
  // Not a page navigation: the App answers for itself, unchanged.
  assert.equal((await call(suite, '/notes/1', manager.cookie, { accept: 'application/json' })).location, null);
  // Signed out, a private App keeps its own door, which returns to the same address after sign-in.
  assert.equal((await call(suite, '/notes/1', '', page)).status, 200);

  const denied = await call(suite, '/_mistri/apps?next=%2Fnotes%2F1', manager.cookie, page);
  assert.equal(denied.status, 200);
  assert.match(denied.text, /Your account has no access to Lender\./);
  assert.equal((await call(suite, '/_mistri/apps?next=%2Fnotes%2F1', officer.cookie, page)).location, '/notes/1');
  assert.equal((await call(suite, '/_mistri/apps?next=%2Fdealer%2Fnotes%2F1', manager.cookie, page)).location, '/dealer/notes/1');
  assert.equal((await call(suite, '/_mistri/apps?next=%2Fdealer%2Fnotes%2F1', borrower.cookie, page)).location, null);
  const signedOut = await call(suite, '/_mistri/apps?next=%2Fnotes%2F1', '', page);
  assert.equal(signedOut.status, 200);
  assert.doesNotMatch(signedOut.text, /no access to/, 'nothing is said about an App before sign-in');

  // Open-redirect attempts: never followed, for an account that could open every real target.
  for (const next of [
    'https://evil.test/',
    '//evil.test/notes',
    '/\\evil.test',
    '\\\\evil.test',
    '/%2F%2Fevil.test',
    '/%5cevil.test',
    '/notes/../_mistri/apps',
    '/notes/%2e%2e/api/schema',
    '/api/schema',
    '/dealer/api/schema',
    '/assets/x.js',
    '/_mistri/apps',
    'javascript:alert(1)',
    ' /notes',
    '/notes#x',
    '/notes\t',
    'notes',
    '',
  ]) {
    const answer = await call(suite, `/_mistri/apps?next=${encodeURIComponent(next)}`, officer.cookie, page);
    assert.equal(answer.status, 200, next);
    assert.equal(answer.location, null, next);
  }
  const twice = await call(suite, '/_mistri/apps?next=%2Fnotes&next=%2Fnotes', officer.cookie, page);
  assert.equal(twice.location, null, 'one carried link or none');
});

test('signing out of any App ends the one session in every App and the chooser', async (t) => {
  const suite = await startSuiteLogin();
  t.after(() => suite.close());
  const { manager } = suite.accounts;
  const login = await fetch(`${suite.origin}/dealer/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { origin: suite.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ email: manager.email, password: 'suite-login-password-long-enough' }),
  });
  assert.equal(login.status, 200, 'an App door signs in to the suite');
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  for (const path of ['/dealer/api/schema', '/leads/api/schema', '/api/suite/apps'])
    assert.equal((await call(suite, path, cookie)).status, 200, path);
  assert.equal((await call(suite, '/leads/api/auth/sign-out', cookie, { 'x-mistri-account': manager.id }, {})).status, 200);
  for (const path of ['/dealer/api/schema', '/leads/api/schema', '/api/suite/apps'])
    assert.equal((await call(suite, path, cookie)).status, 401, path);
  assert.equal((await call(suite, '/', cookie, page)).location, '/_mistri/apps?entry=1');
  // The manager's other session (from sign-up) is its own and stays until it signs out too.
  assert.equal((await call(suite, '/dealer/api/schema', manager.cookie)).status, 200);
});

const app = (id: string, auth: Record<string, unknown> = { providers: ['email'], roles: { reader: { read: true } } }): LoadedApp => ({
  path: id,
  pages: [],
  sources: {},
  app: parseAppConfig(
    { id, name: id, resources: { note: {} }, auth, views: { notes: { kind: 'list', from: 'note' } }, home: 'notes' },
    'suite login test',
  ),
});

test('deep links are local paths into one App, written as a browser sends them', () => {
  const deployments = [
    { app: app('lender'), basePath: '/tools' },
    { app: app('dealer'), basePath: '/tools/dealer' },
  ];
  const owner = (value: unknown) => suiteDeepLink(value, deployments, '/tools')?.deployment.app.app.id;
  assert.equal(owner('/tools/notes/1'), 'lender');
  assert.equal(owner('/tools'), 'lender');
  assert.equal(owner('/tools/dealer/notes?search=a%20b'), 'dealer');
  assert.equal(owner('/tools/dealers'), 'lender', 'a mount is a whole segment');
  for (const value of [
    undefined,
    7,
    '/notes',
    '/toolsx/notes',
    '/tools/api/schema',
    '/tools/dealer/assets/x.js',
    '/tools/_mistri/apps',
    '/tools/dealer/../api/schema',
    '/tools/./notes',
    '/tools/%2e%2e/x',
    '/tools/%2Fevil',
    '/tools/notes?',
    '/tools/notés',
    `/tools/${'a'.repeat(2048)}`,
  ])
    assert.equal(owner(value), undefined, String(value).slice(0, 40));
});

test('landing rules read the grant, then the roles, then a tenant App’s own membership count', async () => {
  const deployments = [{ app: app('leads') }, { app: app('dealer') }];
  const grants: Record<string, { revision: number; roles: string[] }> = {
    leads: { revision: 1, roles: ['reader'] },
    dealer: { revision: 2, roles: ['admin'] },
  };
  const read = (target: LoadedApp['app']) => grants[target.id] ?? { revision: 0, roles: [] };
  let asked = 0;
  const count = (value: number) => async () => {
    asked++;
    return value;
  };
  const rules = [{ app: 'leads', member: true as const }, { app: 'dealer', roles: ['reader'] }, { app: 'dealer' }];
  assert.equal((await landingFor(rules, deployments, read, count(0)))?.app.app.id, 'dealer', 'no membership, and not a reader');
  assert.equal(asked, 1);
  assert.equal((await landingFor(rules, deployments, read, count(2)))?.app.app.id, 'leads');
  grants.leads = { revision: 2, roles: [] };
  asked = 0;
  assert.equal((await landingFor(rules.slice(0, 2), deployments, read, count(5)))?.app.app.id, undefined);
  assert.equal(asked, 0, 'membership is never asked of an App the account has no grant in');
  grants.dealer = { revision: 3, roles: ['admin', 'retired'] };
  assert.equal(await landingFor(rules, deployments, read, count(0)), undefined, 'a malformed grant opens nothing');
});

test('landing configuration names the suite’s own Apps, their roles, and puts its default last', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-suite-landing-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const environment = { SECRET: 'suite-landing-config-secret-longer-than-thirty-two-characters' };
  const read = (landing: unknown) => {
    const file = join(dir, 'suite.json');
    writeFileSync(
      file,
      JSON.stringify({
        apps: [
          { id: 'lender', directory: './lender', config: './c.json', mount: '/' },
          { id: 'dealer', directory: './dealer', config: './c.json', mount: '/dealer' },
        ],
        identity: { id: 's', store: './i.db', grants: './g.db', environment: { BETTER_AUTH_SECRET: 'SECRET' }, landing },
      }),
    );
    return readSuiteConfiguration(file, environment);
  };
  const config = await read([{ app: 'dealer', roles: ['manager'] }, { app: 'lender' }]);
  assert.deepEqual(config.identity?.landing, [{ app: 'dealer', roles: ['manager'] }, { app: 'lender' }]);
  for (const [landing, message] of [
    [[], /1 to 64 rules/],
    [{ app: 'lender' }, /1 to 64 rules/],
    [[{ app: 'site' }], /"site" is not one of the suite's Apps/],
    [[{ app: 'lender' }, { app: 'dealer', roles: ['manager'] }], /no condition, so it must be the last/],
    [[{ app: 'lender', roles: [] }], /nonempty list/],
    [[{ app: 'lender', roles: ['a', 'a'] }], /distinct/],
    [[{ app: 'lender', member: false }], /member may only be true/],
    [[{ app: 'lender', when: 'always' }], /unsupported field "when"/],
  ] as const)
    await assert.rejects(read(landing), message, JSON.stringify(landing));

  const base = {
    port: 1,
    basePath: '',
    apps: [],
    identity: {
      id: 's',
      name: 'S',
      store: join(dir, 'i.db'),
      grants: join(dir, 'g.db'),
      environment: { BETTER_AUTH_SECRET: environment.SECRET },
    },
  };
  const deployments = [{ app: app('lender'), basePath: '', environment: {}, connections: [] }];
  for (const [landing, message] of [
    [[{ app: 'lender', roles: ['manager'] }], /declares no role "manager"/],
    [[{ app: 'lender', member: true }], /needs a tenant App/],
  ] as const)
    await assert.rejects(openSuiteIdentity({ ...base, identity: { ...base.identity, landing } }, deployments), message);
});
