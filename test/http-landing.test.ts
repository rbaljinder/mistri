/**
 * The public landing at the door. On an App that signs people in, the gate
 * opens exactly `/api/landing` signed out, and only when the App declares a
 * landing; `/api/app`, the tables and the commands stay 401. The answer is
 * the author's content beside the App's id, name and theme — nothing of the
 * schema, roles or navigation — with a validator. Every server here runs
 * with no connection registered at all: nothing on the landing path reads a
 * database, which is also why a row-policy App may serve it.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { parseAppConfig, type AppDef } from '../packages/mistri/src/shared/app.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { publicLandingRoute } from '../packages/mistri/src/server/http/gate.js';
import type { HttpAppPolicy } from '../packages/mistri/src/server/policy/appPolicyHttp.js';

const landing = {
  label: 'Enrol',
  hero: { heading: 'Enrol today', description: 'Two steps.', actions: [{ label: 'Staff sign in', signIn: true }] },
  sections: [{ kind: 'faq', items: [{ question: 'Is it free?', answer: 'Yes.' }] }],
};
const STAFF = { id: 'staff-1', who: 'staff@example.test', role: 'manager' };

function app(options: { landing?: boolean; rowPolicy?: boolean; hero?: object } = {}): AppDef {
  return parseAppConfig(
    {
      id: 'enrolments',
      name: 'Enrolments',
      ui: { theme: { accent: '#123456' } },
      sources: { main: { connection: 'private-db' } },
      resources: { enrolment: { access: 'write' } },
      auth: { ...(options.rowPolicy ? { rows: 'policy' } : {}), roles: { manager: { read: true } } },
      views: {
        enrolments: { kind: 'list', from: 'enrolment' },
        ...(options.landing === false
          ? {}
          : { welcome: { kind: 'landing', ...landing, ...(options.hero ? { hero: { ...landing.hero, ...options.hero } } : {}) } }),
      },
      home: options.landing === false ? 'enrolments' : [{ view: 'welcome', signedOut: true }, { view: 'enrolments' }],
      nav: ['enrolments'],
    },
    'landing HTTP fixture',
  );
}

async function serve(
  def: AppDef,
  run: (call: (path: string, init?: RequestInit) => Promise<Response>) => Promise<void>,
  session: typeof STAFF | null = null,
  policy?: HttpAppPolicy,
) {
  const host: AppHost = {
    app: { app: def, path: '/private/app.ts', pages: [], sources: {} },
    pages: [],
    auth: {
      spec: def.auth!,
      store: '/private/auth.db',
      close() {},
      handler: async () => {},
      session: async () => session,
    },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry: new Registry(), bound, apps: [host], ...(policy ? { policy } : {}) });
  try {
    server.listen(0, bound.host);
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    bound.port = address.port;
    const base = `http://${bound.host}:${bound.port}`;
    await run((path, init = {}) =>
      fetch(`${base}${path}`, { ...init, headers: { origin: base, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(3_000) }),
    );
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
  }
}

test('the gate opens the landing signed out, answers content only, and opens nothing beside it', { timeout: 8000 }, async () => {
  await serve(app(), async (call) => {
    const answer = await call('/api/landing');
    assert.equal(answer.status, 200);
    const text = await answer.text();
    assert.deepEqual(JSON.parse(text), {
      app: { id: 'enrolments', name: 'Enrolments', theme: { accent: '#123456' } },
      view: 'welcome',
      landing,
    });
    assert.doesNotMatch(text, /roles|access|"nav"|schema|private-db|enrolment"|sources/);
    assert.equal(answer.headers.get('cache-control'), 'public, no-cache');
    const etag = answer.headers.get('etag')!;
    assert.match(etag, /^"[\w-]{32}"$/);
    const again = await call('/api/landing', { headers: { 'if-none-match': etag } });
    assert.equal(again.status, 304);
    assert.equal(await again.text(), '');
    const head = await call('/api/landing', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    const post = await call('/api/landing', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET, HEAD');
    for (const path of [
      '/api/landing/extra',
      '/api/landings',
      '/api/app',
      '/api/table/enrolment',
      '/api/schema',
      '/api/forms',
      '/api/runtime',
    ]) {
      const refused = await call(path);
      assert.equal(refused.status, 401, path);
      assert.equal((await refused.json()).error, 'Sign in to continue.', path);
    }
    const whoami = await (await call('/api/whoami')).json();
    assert.equal(whoami.signedIn, false);
    assert.equal(whoami.home, 'welcome', 'the signed-out home is the landing, named by its view key');
  });
});

test('signed in, the same content — kept out of shared caches, since it carries the account header', { timeout: 8000 }, async () => {
  await serve(
    app(),
    async (call) => {
      const answer = await call('/api/landing');
      assert.equal(answer.status, 200);
      assert.equal((await answer.json()).landing.hero.heading, 'Enrol today');
      assert.equal(answer.headers.get('cache-control'), 'private, no-cache');
      assert.equal(answer.headers.get('x-mistri-account'), 'staff-1');
    },
    STAFF,
  );
});

test('an App without a landing opens none of it', { timeout: 8000 }, async () => {
  await serve(app({ landing: false }), async (call) => {
    const refused = await call('/api/landing');
    assert.equal(refused.status, 401);
    assert.equal((await refused.json()).error, 'Sign in to continue.');
  });
  await serve(
    app({ landing: false }),
    async (call) => {
      const missing = await call('/api/landing');
      assert.equal(missing.status, 404);
      assert.equal(missing.headers.get('cache-control'), 'no-store');
    },
    STAFF,
  );
});

test('a row-policy App serves its landing: it reads no row, so no principal is resolved for it', { timeout: 8000 }, async () => {
  /* A deployment that counts every principal it is asked to resolve and
     grants nothing: every data read goes through it, the landing never does. */
  let resolved = 0;
  const policy = {
    appId: 'enrolments',
    matches: (def: AppDef) => def.id === 'enrolments',
    writableTables: () => [],
    retire: async () => {},
    withContext: async () => {
      resolved++;
      throw new Error('No rows for anyone.');
    },
  } as unknown as HttpAppPolicy;
  await serve(
    app({ rowPolicy: true }),
    async (call) => {
      assert.equal((await call('/api/landing')).status, 200);
      assert.equal((await call('/api/app')).status, 401);
    },
    null,
    policy,
  );
  assert.equal(resolved, 0);
  await serve(
    app({ rowPolicy: true }),
    async (call) => {
      const answer = await call('/api/landing');
      assert.equal(answer.status, 200);
      assert.equal(answer.headers.get('cache-control'), 'private, no-cache');
      assert.equal(resolved, 0, 'the landing resolved no principal');
      assert.notEqual((await call('/api/app')).status, 200);
    },
    STAFF,
    policy,
  );
});

test('publicLandingRoute is exactly /api/landing, and only for an App with a landing', () => {
  const host = (def: AppDef) => ({ app: { app: def, path: '/private/app.ts', pages: [], sources: {} }, pages: [] }) as unknown as AppHost;
  assert.equal(publicLandingRoute(undefined, '/api/landing'), false);
  assert.equal(publicLandingRoute(host(app({ landing: false })), '/api/landing'), false);
  assert.equal(publicLandingRoute(host(app()), '/api/landing'), true);
  for (const path of ['/api/landing/', '/api/landing/x', '/api/landings', '/api/app', '/landing'])
    assert.equal(publicLandingRoute(host(app()), path), false, path);
});

test("the glyphs of the hero's badge and icon rows ride with the App's, so the first paint draws them", async () => {
  const hero = { badge: { text: 'Open all year', icon: 'calendar' }, points: [{ icon: 'shield-check', text: 'Your details stay here' }] };
  await serve(app({ hero }), async (call) => {
    const answer = await call('/api/landing');
    assert.equal(answer.status, 200);
    const body = (await answer.json()) as { app: { icons?: Record<string, unknown> }; landing: { hero: typeof hero } };
    assert.deepEqual(body.landing.hero.badge, hero.badge);
    assert.deepEqual(body.landing.hero.points, hero.points);
    assert.ok(body.app.icons?.calendar && body.app.icons['shield-check'], JSON.stringify(Object.keys(body.app.icons ?? {})));
  });
});
