/** The configured shared identity path, including operator bootstrap and restart. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { connect } from 'node:net';
import { once } from 'node:events';
import { test } from 'node:test';
import { startConfiguredSuite } from '../packages/mistri/src/server/cli/suiteCommand.js';
import { changeSuiteGrant } from '../packages/mistri/src/server/cli/suiteGrant.js';
import { openSuiteAuthorityStore } from '../packages/mistri/src/server/auth/suiteAuthority.js';

test('shared suite config persists explicit grants, scopes the chooser and refuses store collisions', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-suite-shared-cli-'));
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
    const db = new DatabaseSync(join(home, 'business.db'));
    db.exec("CREATE TABLE note(id INTEGER PRIMARY KEY, body TEXT); INSERT INTO note VALUES (1, 'original')");
    db.close();
    writeFileSync(
      join(home, 'app.json'),
      JSON.stringify({
        id,
        name: id,
        resources: { note: { access: 'write' } },
        auth: { providers: ['email'], roles: { reader: { read: true }, writer: { read: true, write: ['note'] } } },
        views: { notes: { kind: 'list', from: 'note' } },
        home: 'notes',
      }),
    );
    writeFileSync(
      join(home, 'connections.json'),
      JSON.stringify({ connections: [{ name: 'data', url: join(home, 'business.db'), writable: true }] }),
    );
    apps.push({ id, directory: `./${id}`, config: `./${id}/connections.json`, mount: `/${id}` });
  }
  const config = {
    port,
    basePath: '/tools',
    apps,
    identity: {
      id: 'shared',
      name: 'Shared Suite',
      store: './identity.db',
      grants: './grants.db',
      environment: { BETTER_AUTH_SECRET: 'SECRET' },
    },
  };
  const file = join(dir, 'suite.json');
  writeFileSync(file, JSON.stringify(config));
  const environment = { SECRET: 'test-only-suite-secret-at-least-thirty-two-characters' };
  suite = await startConfiguredSuite(file, environment);
  const origin = suite.publicURL;
  const call = async (path: string, cookie = '', body?: unknown, extra: Record<string, string> = {}) => {
    const response = await fetch(`${origin}/tools${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { origin, cookie, 'content-type': 'application/json', ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: JSON.parse(text),
      text,
      cookies: response.headers.getSetCookie(),
      cookie: response.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; '),
    };
  };
  const credentials = { name: 'Reader', email: 'reader@example.test', password: 'password-long-enough' };
  assert.equal((await call('/beta/api/auth/sign-up/email', '', { ...credentials, role: 'admin' })).status, 400);
  const account = await call('/beta/api/auth/sign-up/email', '', credentials);
  assert.equal(account.status, 200, account.text);
  assert.ok(account.cookies.some((cookie) => /Path=\/tools(?:;|$)/.test(cookie)));
  const subjectId = account.body.user.id,
    cookie = account.cookie;
  assert.deepEqual((await call('/api/suite/apps', cookie)).body.apps, []);
  const grant = { appId: 'alpha', subjectId, roles: ['writer'], expectedRevision: 0 };
  await assert.rejects(changeSuiteGrant(file, { ...grant, subjectId: 'reader@example.test' }, environment), /stable account id/);
  await changeSuiteGrant(file, grant, environment);
  assert.deepEqual((await call('/api/suite/apps', cookie)).body.apps, [{ id: 'alpha', name: 'alpha', href: '/tools/alpha/' }]);
  assert.equal((await call('/alpha/api/schema', cookie)).status, 200);
  assert.equal((await call('/beta/api/schema', cookie)).status, 401);
  for (const path of ['/api/auth/admin/list-users', '/alpha/api/auth/admin/list-users', '/api/auth/link-social']) {
    assert.equal((await call(path, cookie)).status, 404);
  }
  await assert.rejects(changeSuiteGrant(file, grant, environment), /grant changed/);
  await suite.close();
  suite = undefined;
  // What each App granted is kept start by start, beside the identity store, for the Console's Governance room.
  const authority = () => {
    const db = new DatabaseSync(join(dir, 'identity.db.authority'));
    try {
      return openSuiteAuthorityStore(db, 'shared').previous('alpha');
    } finally {
      db.close();
    }
  };
  assert.equal(authority(), undefined, 'one start has nothing earlier to compare');
  const alpha = JSON.parse(readFileSync(join(dir, 'alpha', 'app.json'), 'utf8'));
  alpha.auth.roles.auditor = { read: true };
  writeFileSync(join(dir, 'alpha', 'app.json'), JSON.stringify(alpha));
  const restarted = Date.now();
  suite = await startConfiguredSuite(file, environment);
  assert.equal((await call('/alpha/api/schema', cookie)).status, 200, 'the same login and grant survive suite restart');
  const earlier = authority();
  assert.ok(earlier && earlier.at >= restarted && !earlier.report.includes('auditor'), 'a changed App records what it granted before');
  const peer = await call('/api/auth/sign-up/email', '', { name: 'Peer', email: 'peer@example.test', password: 'password-long-enough' });
  assert.equal(peer.status, 200, peer.text);
  const change = { subjectId: peer.body.user.id, roles: ['reader'], expectedRevision: 0 };
  const accountHeader = { 'x-mistri-account': subjectId };
  assert.equal((await call('/alpha/api/suite/grants', cookie, change, accountHeader)).status, 403);
  await changeSuiteGrant(file, { ...grant, roles: ['admin'], expectedRevision: 1 }, environment);
  assert.equal(
    (await call('/beta/api/suite/grants', cookie, change, accountHeader)).status,
    403,
    'alpha administration never grants beta administration',
  );
  assert.equal(
    (await call('/alpha/api/suite/grants', cookie, change, { ...accountHeader, origin: 'http://attacker.invalid' })).status,
    403,
  );
  assert.equal((await call('/alpha/api/suite/grants', cookie, change, accountHeader)).status, 200);
  assert.equal((await call('/alpha/api/schema', peer.cookie)).status, 200);
  assert.equal((await call('/beta/api/schema', peer.cookie)).status, 401);
  assert.equal((await call('/alpha/api/suite/grants', cookie, change, accountHeader)).status, 409);
  const invitationRequest = { ...change, expiresAt: Date.now() + 60000 };
  assert.equal((await call('/beta/api/suite/invitations/issue', cookie, invitationRequest, accountHeader)).status, 403);
  await changeSuiteGrant(file, { ...grant, appId: 'beta', roles: ['admin'], expectedRevision: 0 }, environment);
  const invitation = await call('/beta/api/suite/invitations/issue', cookie, invitationRequest, accountHeader);
  assert.equal(invitation.status, 200, invitation.text);
  assert.match(invitation.body.acceptUrl, /^\/tools\/_mistri\/apps#invite=beta\./);
  assert.equal((await call('/beta/api/schema', peer.cookie)).status, 401, 'issuance alone grants no access');
  const accept = { appId: 'beta', token: invitation.body.token },
    peerHeader = { 'x-mistri-account': peer.body.user.id };
  assert.equal((await call('/api/suite/invitations/accept', cookie, accept, accountHeader)).status, 409);
  assert.equal((await call('/api/suite/invitations/accept', peer.cookie, { ...accept, appId: 'alpha' }, peerHeader)).status, 409);
  assert.equal(
    (await call('/api/suite/invitations/accept', peer.cookie, accept, { ...peerHeader, origin: 'http://attacker.invalid' })).status,
    403,
  );
  assert.equal((await call('/api/suite/invitations/accept', peer.cookie, accept, peerHeader)).status, 200);
  assert.equal((await call('/beta/api/schema', peer.cookie)).status, 200);
  assert.equal((await call('/api/suite/invitations/accept', peer.cookie, accept, peerHeader)).status, 409);
  await changeSuiteGrant(file, { ...grant, appId: 'beta', roles: [], expectedRevision: 1 }, environment);
  await changeSuiteGrant(file, { ...grant, roles: [], expectedRevision: 2 }, environment);
  assert.equal((await call('/alpha/api/schema', cookie)).status, 401);
  assert.deepEqual((await call('/api/suite/apps', cookie)).body.apps, []);
  // Even without App grants a person can terminate their central login.
  assert.equal((await call('/api/auth/sign-out', cookie, {}, { 'x-mistri-account': 'stale-subject' })).status, 409);
  assert.equal((await call('/api/suite/apps', cookie)).status, 200);
  assert.equal((await call('/api/auth/sign-out', cookie, {})).status, 200);
  assert.equal((await call('/api/suite/apps', cookie)).status, 401);
  const arrived = once(suite.server, 'request');
  const stalled = connect(port, '127.0.0.1');
  stalled.on('error', () => {});
  await once(stalled, 'connect');
  stalled.write(
    `POST /tools/api/auth/sign-up/email HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${origin}\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"name":`,
  );
  await arrived;
  let forced = false;
  const cutoff = setTimeout(() => {
    forced = true;
    suite?.server.closeAllConnections();
    stalled.destroy();
  }, 2000);
  try {
    await suite.close();
  } finally {
    clearTimeout(cutoff);
    stalled.destroy();
  }
  assert.equal(forced, false, 'shutdown aborts incomplete identity bodies before draining native auth');
  suite = undefined;
  for (const path of ['identity.db', 'grants.db', 'identity.db.authority']) {
    writeFileSync(
      join(dir, 'alpha', 'connections.json'),
      JSON.stringify({ connections: [{ name: 'data', url: join(dir, path), writable: true }] }),
    );
    await assert.rejects(startConfiguredSuite(file, environment), /Authentication storage must remain separate/);
  }
});
