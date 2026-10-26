/** Reviewed mail delivery composed with real suite sessions and grant HTTP. */
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import type { LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import { readSuiteConfiguration } from '../packages/mistri/src/server/cli/suiteConfig.js';
import { openSuiteIdentity } from '../packages/mistri/src/server/auth/suiteIdentity.js';
import { suiteGrantHttp } from '../packages/mistri/src/server/auth/suiteGrantHttp.js';
import { createSuite } from '../packages/mistri/src/server/http/suite.js';

test('suite email config captures a separate environment and requires explicit identity/public origin', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-suite-email-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'suite.json'),
    environment = { SECRET: 'secret', MAIL: 'log:mail.log' };
  const config = {
    publicOrigin: 'https://suite.example.test',
    identity: { id: 'shared', store: './identity.db', grants: './grants.db', environment: { BETTER_AUTH_SECRET: 'SECRET' } },
    apps: [{ id: 'alpha', directory: './alpha', config: './alpha/connections.json', mount: '/' }],
    email: { name: 'mail', kind: 'email', url: '${MAIL_URL}', from: 'Suite <no-reply@example.test>', environment: { MAIL_URL: 'MAIL' } },
  };
  writeFileSync(file, JSON.stringify(config));
  const captured = await readSuiteConfiguration(file, environment);
  environment.MAIL = 'log:changed.log';
  assert.equal(captured.email!.environment.MAIL_URL, 'log:mail.log');
  assert.equal(captured.email!.base, dir);
  assert.equal(captured.email!.environment.BETTER_AUTH_SECRET, undefined);
  assert.equal(captured.identity!.environment.MAIL_URL, undefined);
  for (const value of [
    { ...config, publicOrigin: undefined },
    { ...config, identity: undefined },
    { ...config, email: { ...config.email, recipient: 'client@example.test' } },
    { ...config, email: { ...config.email, environment: { MAIL_URL: 'MISSING' } } },
    { ...config, email: { ...config.email, kind: 'smtp' } },
  ]) {
    writeFileSync(file, JSON.stringify(value));
    await assert.rejects(readSuiteConfiguration(file, environment));
  }
});

test(
  'suite issuance emails the exact native subject at canonical origin, reports delivery independently, and drains accepted sends',
  { timeout: 30_000 },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'tw-suite-email-http-'));
    const reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const businessPath = join(dir, 'business.db'),
      db = new DatabaseSync(businessPath);
    db.exec('CREATE TABLE note(id INTEGER PRIMARY KEY)');
    db.close();
    const file = join(dir, 'suite.json');
    writeFileSync(
      file,
      JSON.stringify({
        port,
        basePath: '/tools',
        publicOrigin: 'https://suite.example.test',
        identity: {
          id: 'shared',
          name: 'Suite',
          store: './identity.db',
          grants: './grants.db',
          environment: { BETTER_AUTH_SECRET: 'SECRET' },
        },
        apps: [{ id: 'alpha', directory: './alpha', config: './alpha/connections.json', mount: '/' }],
        email: {
          name: 'mail',
          kind: 'email',
          url: '${MAIL_URL}',
          from: 'Suite <no-reply@example.test>',
          environment: { MAIL_URL: 'MAIL' },
        },
      }),
    );
    const config = await readSuiteConfiguration(file, {
      SECRET: 'test-email-suite-secret-longer-than-thirty-two-characters',
      MAIL: 'log:mail.log',
    });
    const app: LoadedApp = {
      path: dir,
      pages: [],
      sources: {},
      app: parseAppConfig(
        {
          id: 'alpha',
          name: 'Alpha',
          resources: { note: {} },
          auth: { providers: ['email'], roles: { reader: { read: true } } },
          views: { notes: { kind: 'list', from: 'note' } },
          home: 'notes',
        },
        'suite email test',
      ),
    };
    const deployments = [{ app, basePath: '/tools', environment: {}, connections: [{ name: 'data', url: businessPath }] }];
    const identity = await openSuiteIdentity(config, deployments);
    let sendArrived!: () => void,
      releaseSend!: () => void,
      deliveries = 0,
      closed = false;
    const sending = new Promise<void>((resolve) => {
        sendArrived = resolve;
      }),
      sendGate = new Promise<void>((resolve) => {
        releaseSend = resolve;
      });
    const suite = await createSuite(
      [
        {
          id: 'alpha',
          open: async () => ({ server: createServer((_req, res) => res.end('child')), stop: async () => {}, close: async () => {} }),
        },
      ],
      { base: '/tools', mounts: { alpha: '/' }, publicOrigin: config.publicOrigin },
      {
        route(req, res) {
          if (req.url === '/tools/test-held-send')
            return suiteGrantHttp(req, res, {
              native: identity.native,
              grants: identity.grants,
              bound: { host: '127.0.0.1', port, allowedHosts: ['suite.example.test'] },
              basePath: '/tools',
              target: deployments[0],
              deployments,
              action: 'issue',
              current: () => !closed,
              publicOrigin: config.publicOrigin,
              mail: {
                name: 'held',
                async send() {
                  deliveries++;
                  sendArrived();
                  await sendGate;
                  assert.equal(closed, false);
                },
              },
            });
          return identity.route(req, res);
        },
        entry: identity.entry,
        close() {
          closed = true;
          identity.close();
        },
      },
    );
    t.after(async () => {
      releaseSend();
      await suite.close();
      rmSync(dir, { recursive: true, force: true });
    });
    await new Promise<void>((resolve) => suite.server.listen(port, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${port}`,
      canonical = { host: 'suite.example.test', origin: 'https://suite.example.test' };
    // Node fetch rewrites Host to the dialed origin. Use an actual HTTP request
    // so canonical and storefront-host assertions exercise the received Host.
    const call = (path: string, headers: Record<string, string> = {}, body?: unknown) =>
      new Promise<{ status: number; body: any; text: string; cookie: string }>((resolve, reject) => {
        const req = request(
          `${origin}/tools${path}`,
          {
            method: body === undefined ? 'GET' : 'POST',
            headers: { ...canonical, 'content-type': 'application/json', connection: 'close', ...headers },
          },
          (response) => {
            let text = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => {
              text += chunk;
            });
            response.on('error', reject);
            response.on('end', () => {
              try {
                resolve({
                  status: response.statusCode!,
                  body: text && response.headers['content-type']?.includes('json') ? JSON.parse(text) : {},
                  text,
                  cookie: (response.headers['set-cookie'] ?? []).map((value) => value.split(';')[0]).join('; '),
                });
              } catch (error) {
                reject(error);
              }
            });
          },
        );
        req.on('error', reject);
        req.setTimeout(10000, () => req.destroy(new Error('Suite mail HTTP request timed out.')));
        req.end(body === undefined ? undefined : JSON.stringify(body));
      });
    const account = async (name: string) => {
      const response = await call(
        '/api/auth/sign-up/email',
        {},
        { name, email: `${name}@example.test`, password: 'test-password-long-enough' },
      );
      assert.equal(response.status, 200, response.text);
      return {
        id: response.body.user.id as string,
        headers: { cookie: response.cookie, 'x-mistri-account': response.body.user.id as string },
      };
    };
    const admin = await account('admin'),
      target = await account('target');
    identity.grants.change({
      appId: 'alpha',
      subjectId: admin.id,
      actorId: 'operator',
      expectedRevision: 0,
      roles: ['admin'],
      declaredRoles: ['reader', 'admin'],
    });
    assert.equal((await call('/api/suite/apps', admin.headers)).body.emailAvailable, true);
    assert.equal(
      (await call('/api/suite/apps', { ...admin.headers, host: 'storefront.example.test', origin: 'https://storefront.example.test' }))
        .status,
      403,
    );
    const input = { subjectId: target.id, roles: ['reader'], expectedRevision: 0, expiresAt: Date.now() + 60000 };
    const messages = () =>
      readFileSync(join(dir, 'mail.log'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
    const before = messages().length;
    const link = await call('/api/suite/invitations/issue', admin.headers, input);
    assert.equal(link.status, 200);
    assert.deepEqual(link.body.delivery, { status: 'not-requested' });
    assert.equal(messages().length, before);
    for (const extra of [{ delivery: 'smtp' }, { delivery: null }, { delivery: 'email', email: 'forged@example.test' }]) {
      assert.equal((await call('/api/suite/invitations/issue', admin.headers, { ...input, ...extra })).status, 400);
    }
    assert.equal((await call('/api/suite/invitations/issue', target.headers, { ...input, delivery: 'email' })).status, 403);
    assert.equal(
      (await call('/api/suite/invitations/issue', admin.headers, { ...input, subjectId: 'target@example.test', delivery: 'email' })).status,
      404,
    );
    const issued = await call(
      '/api/suite/invitations/issue',
      { ...admin.headers, host: `127.0.0.1:${port}`, origin },
      { ...input, delivery: 'email' },
    );
    assert.equal(issued.status, 200, issued.text);
    assert.deepEqual(issued.body.delivery, { status: 'accepted' });
    const message = messages().at(-1)!;
    assert.equal(messages().length, before + 1);
    assert.equal(message.to, 'target@example.test');
    assert.ok(message.text.includes(`https://suite.example.test/tools/_mistri/apps#invite=alpha.${issued.body.token}`));
    assert.equal(message.text.includes(origin), false);
    assert.equal((await identity.grants.read(target.id, 'alpha')).revision, 0);
    assert.equal((await call('/api/suite/invitations/accept', admin.headers, { appId: 'alpha', token: issued.body.token })).status, 409);
    // A delivery failure cannot roll back issuance or consume/reissue its token.
    rmSync(join(dir, 'mail.log'));
    mkdirSync(join(dir, 'mail.log'));
    const unknown = await call('/api/suite/invitations/issue', admin.headers, { ...input, delivery: 'email' });
    assert.equal(unknown.status, 200);
    assert.deepEqual(unknown.body.delivery, { status: 'unknown', error: 'email-send-failed' });
    assert.notEqual(unknown.body.id, issued.body.id);
    assert.equal((await identity.grants.read(target.id, 'alpha')).revision, 0);
    assert.equal((await call('/api/suite/invitations/accept', target.headers, { appId: 'alpha', token: unknown.body.token })).status, 200);
    const pending = call('/test-held-send', admin.headers, { ...input, expectedRevision: 1, delivery: 'email' });
    await sending;
    const stopping = suite.close();
    assert.equal(closed, false);
    assert.equal(deliveries, 1);
    releaseSend();
    assert.equal((await pending).status, 200);
    await stopping;
    assert.equal(closed, true);
  },
);
