/**
 * Command forms at the door. On an App that signs people in, the gate
 * opens exactly `/api/forms` and `/api/forms/<key>` signed out — and only
 * for a public form the App declares, never a signed-in form's key;
 * `/api/app`, the tables, the commands and any other path stay 401. The
 * public route answers presentation only, submits through the command
 * executor under a public principal — for someone signed in too — replays
 * on the same key, and rate limits the address with a Retry-After,
 * counting only the POSTs it runs. A signed-in form is served, with its nav
 * entry, only to a role granted its command, and runs through the
 * signed-in command route with the empty key only a form's command takes.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { refuse } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { shape, text } from '../packages/mistri/src/server/commands/commandShapes.js';
import { PUBLIC_FORM_SUBMIT_TOTAL, publicFormLimiter, resetPublicFormLimits } from '../packages/engine/src/server/http/rateLimit.js';
import { publicFormRoute } from '../packages/mistri/src/server/http/gate.js';
import { parseTrustedProxies } from '../packages/engine/src/server/http/trust.js';
import { parseTestApp } from './support/commandCatalog.js';

/* Each form's input is declared once and read by the form and its command's registration alike. */
const enrolInput = {
  name: { label: 'Name', type: 'text', max: 20 },
  age: { label: 'Age', type: 'number', integer: true, min: 18, optional: true },
} as const;
const logInput = { name: { label: 'Name', type: 'text' } } as const;
const publicForm = {
  kind: 'form',
  label: 'Apply',
  public: true,
  description: 'Say hello.',
  submitLabel: 'Send',
  done: { title: 'Thanks' },
  command: { id: 'enrol', version: 1, input: enrolInput },
  steps: [
    { id: 'who', label: 'Who', fields: ['name'] },
    { id: 'how-old', label: 'How old', fields: ['age'] },
  ],
};
const signedInForm = {
  kind: 'form',
  label: 'Log an enrolment',
  done: { title: 'Logged' },
  command: { id: 'logEnrolment', version: 1, input: logInput },
  steps: [{ id: 'who', label: 'Who', fields: ['name'] }],
};

interface Fixture {
  base: string;
  db: DatabaseSync;
  calls: number[];
  actors: string[];
}

async function fixture(
  run: (f: Fixture) => Promise<void>,
  options: { form?: boolean; trustProxy?: string[]; role?: string } = { form: true },
) {
  resetPublicFormLimits();
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-forms-http-'));
  const file = join(directory, 'forms.db');
  const db = new DatabaseSync(file);
  const registry = new Registry();
  db.exec(`CREATE TABLE enrolment(id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER, reference TEXT NOT NULL UNIQUE);
    CREATE TABLE loan(id INTEGER PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0); INSERT INTO loan VALUES (1, 0);`);
  migrateSqliteCommandJournal(file);
  registry.add({ id: 'private-db', name: 'Private', url: file, writable: true, source: 'config' });
  const app = parseTestApp(
    {
      id: 'enrolments',
      name: 'Enrolments',
      auth: { roles: { manager: { read: true, commands: ['assign'] }, clerk: { read: true, commands: ['logEnrolment'] } } },
      sources: { main: { connection: 'private-db' } },
      resources: {
        enrolment: { access: 'write' },
        loan: {
          access: 'write',
          actions: { assign: { label: 'Assign', command: { id: 'assign', version: 1, target: 'loan', input: {} } } },
        },
      },
      views: {
        enrolments: { kind: 'list', from: 'enrolment' },
        loans: { kind: 'list', from: 'loan' },
        ...(options.form ? { apply: publicForm, log: signedInForm } : {}),
      },
      home: 'enrolments',
      nav: ['enrolments', 'loans', ...(options.form ? ['log'] : [])],
      ui: { theme: { accent: '#123456' } },
    },
    'forms HTTP fixture',
  );
  const calls: number[] = [];
  const actors: string[] = [];
  const commands = defineCommands({
    enrol: defineCommand({
      targets: 'none',
      source: 'main',
      target: 'enrolment',
      read: ['enrolment'],
      write: ['enrolment'],
      public: true,
      input: enrolInput,
      output: shape({ reference: text() }),
      async handle(context, input) {
        calls.push(input.age ?? 0);
        actors.push(context.actor.id);
        if (input.name === 'nobody') refuse('invalid_input', 'name');
        const reference = `ENR-${calls.length.toString().padStart(4, '0')}`;
        await context.tx.insert({ table: 'enrolment', values: { name: input.name, age: input.age ?? null, reference } });
        return { reference, secret: 'never echoed' };
      },
    }),
    logEnrolment: defineCommand({
      targets: 'none',
      source: 'main',
      target: 'enrolment',
      read: ['enrolment'],
      write: ['enrolment'],
      input: logInput,
      output: shape({ reference: text() }),
      async handle(context, input) {
        actors.push(context.actor.id);
        const reference = `LOG-${actors.length.toString().padStart(4, '0')}`;
        await context.tx.insert({ table: 'enrolment', values: { name: input.name, age: null, reference } });
        return { reference };
      },
    }),
    assign: defineCommand({
      source: 'main',
      target: 'loan',
      input: {},
      output: { parse: (value: unknown) => value },
      async handle(): Promise<unknown> {
        return {};
      },
    }),
  });
  const host: AppHost = {
    app: { app, path: '/private/app.ts', pages: [], sources: {} },
    pages: [],
    auth: {
      spec: app.auth!,
      store: '/private/auth.db',
      close() {},
      handler: async () => {},
      session: async () => (options.role ? { id: 'account-1', who: 'clerk@example.test', role: options.role } : null),
    },
  };
  const bound = { host: '127.0.0.1', port: 0, trustedProxies: parseTrustedProxies(options.trustProxy ?? []).ranges };
  const server = createApp({ registry, bound, apps: [host], commands: { appId: 'enrolments', registry: commands } });
  try {
    server.listen(0, bound.host);
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    bound.port = address.port;
    await run({ base: `http://${bound.host}:${bound.port}`, db, calls, actors });
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    db.close();
    rmSync(directory, { recursive: true, force: true });
    resetPublicFormLimits();
  }
}

async function call(
  base: string,
  path: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
  headers: Record<string, string> = {},
) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', origin: base, ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    signal: AbortSignal.timeout(3_000),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: response.status, headers: response.headers, body: parsed as Record<string, unknown>, text };
}

const key = (n: number) => `submission-key-${String(n).padStart(6, '0')}`;
const rows = (f: Fixture) => f.db.prepare('SELECT count(*) AS n FROM enrolment').get()!.n;
type Served = { views: Record<string, Record<string, unknown>>; nav: Array<{ view?: string; label: string }> };

test(
  "the gate opens a public form's GET and POST signed out and nothing else: not a signed-in form, not a mistyped key",
  { timeout: 8000 },
  async () => {
    await fixture(async (f) => {
      const list = await call(f.base, '/api/forms');
      assert.equal(list.status, 200);
      assert.deepEqual(list.body, {
        app: { id: 'enrolments', name: 'Enrolments', theme: { accent: '#123456' } },
        forms: [
          {
            id: 'apply',
            label: 'Apply',
            description: 'Say hello.',
            submitLabel: 'Send',
            done: { title: 'Thanks' },
            // Served as the list the form reads: named, labelled, required unless optional.
            input: [
              { name: 'name', label: 'Name', required: true, type: 'text', maxLength: 20 },
              { name: 'age', label: 'Age', type: 'number', integer: true, min: 18 },
            ],
            steps: [
              { id: 'who', label: 'Who', fields: ['name'] },
              { id: 'how-old', label: 'How old', fields: ['age'] },
            ],
          },
        ],
      });
      assert.equal(list.headers.get('cache-control'), 'no-store');
      assert.doesNotMatch(list.text, /roles|access|nav|schema|private-db|enrolment"|logEnrolment|Log an enrolment/);
      const one = await call(f.base, '/api/forms/apply');
      assert.equal(one.status, 200);
      assert.equal((one.body.form as { id: string }).id, 'apply');
      // A key that names no public form — mistyped, or a signed-in form's —
      // is not opened: it reads exactly as every closed path does.
      const closed = await call(f.base, '/api/app');
      for (const path of ['/api/forms/nope', '/api/forms/log']) {
        const refused = await call(f.base, path);
        assert.equal(refused.status, 401, path);
        assert.deepEqual(refused.body, closed.body, path);
        assert.equal((await call(f.base, path, { input: { name: 'x' }, submission: key(1) })).status, 401, path);
      }
      for (const path of [
        '/api/app',
        '/api/table/enrolment',
        '/api/schema',
        '/api/forms/apply/extra',
        '/api/formz',
        '/api/intake',
        '/api/intake/apply',
      ]) {
        const refused = await call(f.base, path);
        assert.equal(refused.status, 401, path);
        assert.equal((refused.body as { error: string }).error, 'Sign in to continue.');
      }
      assert.equal((await call(f.base, '/api/commands/execute', { command: 'enrol' })).status, 401);
      const logged = await call(f.base, '/api/commands/execute', {
        command: 'logEnrolment',
        commandVersion: 1,
        key: {},
        expectedVersion: 0,
        idempotencyKey: key(2),
        input: { name: 'x' },
      });
      assert.equal(logged.status, 401);
      assert.deepEqual(f.actors, []);
      const whoami = await call(f.base, '/api/whoami');
      assert.equal(whoami.status, 200);
      assert.equal(whoami.body.signedIn, false);
    });
  },
);

test('an App without a public form opens none of it', { timeout: 8000 }, async () => {
  await fixture(
    async (f) => {
      for (const path of ['/api/forms', '/api/forms/apply']) {
        const refused = await call(f.base, path);
        assert.equal(refused.status, 401, path);
        const posted = await call(f.base, path, { input: { name: 'x' }, submission: key(1) });
        assert.equal(posted.status, 401, path);
      }
      assert.equal(publicFormRoute(undefined, '/api/forms'), false);
    },
    { form: false },
  );
});

test(
  'a submission runs the public command: a reference, a receipt, a replay on the same key, a 409 on different input',
  { timeout: 8000 },
  async () => {
    await fixture(async (f) => {
      const first = await call(f.base, '/api/forms/apply', { input: { name: 'Ada', age: 30 }, submission: key(10) });
      assert.equal(first.status, 200, first.text);
      assert.deepEqual(Object.keys(first.body).sort(), ['receipt', 'reference']);
      assert.equal(first.body.reference, 'ENR-0001');
      assert.equal((first.body.receipt as { status: string }).status, 'applied');
      assert.doesNotMatch(first.text, /never echoed|Ada/);
      const again = await call(f.base, '/api/forms/apply', { input: { name: 'Ada', age: 30 }, submission: key(10) });
      assert.equal(again.status, 200);
      assert.deepEqual(again.body, first.body);
      assert.deepEqual(f.calls, [30]);
      assert.deepEqual(f.actors, ['public:apply']);
      const conflict = await call(f.base, '/api/forms/apply', { input: { name: 'Ada', age: 31 }, submission: key(10) });
      assert.equal(conflict.status, 409);
      assert.equal(conflict.body.code, 'idempotency_conflict');
      assert.equal(rows(f), 1);
    });
  },
);

test(
  'the declared field rules are enforced before the handler, naming the field; the handler may name one too',
  { timeout: 8000 },
  async () => {
    await fixture(async (f) => {
      const missing = await call(f.base, '/api/forms/apply', { input: { age: 30 }, submission: key(20) });
      assert.equal(missing.status, 400);
      assert.deepEqual(missing.body, {
        code: 'invalid_input',
        message: 'The command input is invalid.',
        error: 'The command input is invalid.',
        field: 'name',
      });
      const long = await call(f.base, '/api/forms/apply', { input: { name: 'x'.repeat(21) }, submission: key(21) });
      assert.equal(long.body.field, 'name');
      const young = await call(f.base, '/api/forms/apply', { input: { name: 'Kid', age: 12 }, submission: key(22) });
      assert.equal(young.body.field, 'age');
      const fraction = await call(f.base, '/api/forms/apply', { input: { name: 'Kid', age: 18.5 }, submission: key(23) });
      assert.equal(fraction.body.field, 'age');
      const extra = await call(f.base, '/api/forms/apply', { input: { name: 'Ada', role: 'admin' }, submission: key(24) });
      assert.equal(extra.status, 400);
      assert.equal(extra.body.field, undefined);
      assert.deepEqual(f.calls, []);
      resetPublicFormLimits();
      const handler = await call(f.base, '/api/forms/apply', { input: { name: 'nobody' }, submission: key(25) });
      assert.equal(handler.status, 400);
      assert.equal(handler.body.field, 'name');
      assert.equal(rows(f), 0);
    });
  },
);

test(
  'the envelope is exactly input and submission, the key is opaque and bounded, and the body has a ceiling',
  { timeout: 8000 },
  async () => {
    await fixture(async (f) => {
      for (const body of [
        { input: { name: 'a' } },
        { input: { name: 'a' }, submission: 'short' },
        { input: { name: 'a' }, submission: key(1), actor: 'x' },
        [1],
        'not json',
        { input: { name: 'a' }, submission: 'has spaces in it!!' },
      ]) {
        const refused = await call(f.base, '/api/forms/apply', body);
        assert.equal(refused.status, 400, JSON.stringify(body));
        resetPublicFormLimits();
      }
      // Refused by its Content-Length before the human check or the body is read: 413, as the forms page says.
      const huge = await call(f.base, '/api/forms/apply', { input: { name: 'a', pad: 'x'.repeat(70_000) }, submission: key(2) });
      assert.equal(huge.status, 413);
      const put = await call(f.base, '/api/forms/apply', { input: { name: 'a' }, submission: key(3) }, 'PUT');
      assert.equal(put.status, 405);
      assert.deepEqual(f.calls, []);
    });
  },
);

test('submissions are rate limited per address with a Retry-After', { timeout: 8000 }, async () => {
  await fixture(async (f) => {
    for (let n = 1; n <= 5; n++)
      assert.equal((await call(f.base, '/api/forms/apply', { input: { name: `p${n}` }, submission: key(100 + n) })).status, 200);
    const sixth = await call(f.base, '/api/forms/apply', { input: { name: 'p6' }, submission: key(106) });
    assert.equal(sixth.status, 429);
    assert.match(sixth.headers.get('retry-after') ?? '', /^\d+$/);
    assert.equal(sixth.body.code, 'rate_limited');
    assert.equal(sixth.body.retryAfter, Number(sixth.headers.get('retry-after')));
    assert.equal(f.calls.length, 5);
    // Reads have their own, wider window: still open after the submissions.
    assert.equal((await call(f.base, '/api/forms/apply')).status, 200);
    publicFormLimiter('read').reset();
    for (let n = 0; n < 60; n++) assert.equal((await call(f.base, '/api/forms')).status, 200);
    assert.equal((await call(f.base, '/api/forms')).status, 429);
  });
});

test('behind a proxy on this machine each forwarded client has its own window', { timeout: 8000 }, async () => {
  await fixture(async (f) => {
    // The test's own socket is loopback, which is what a proxy beside the server looks like.
    const from = (client: string, n: number) =>
      call(f.base, '/api/forms/apply', { input: { name: `c${n}` }, submission: key(200 + n) }, 'POST', {
        'x-forwarded-for': `198.51.100.99, ${client}`,
      });
    for (let n = 1; n <= 5; n++) assert.equal((await from('203.0.113.7', n)).status, 200);
    const sixth = await from('203.0.113.7', 6);
    assert.equal(sixth.status, 429);
    assert.equal(sixth.body.code, 'rate_limited');
    // Another applicant through the same proxy is not refused for the first one's submissions,
    // and the proxy's own address (no header) is a third, untouched window.
    assert.equal((await from('203.0.113.8', 7)).status, 200);
    assert.equal((await call(f.base, '/api/forms/apply', { input: { name: 'local' }, submission: key(208) })).status, 200);
    assert.equal(f.calls.length, 7);
  });
});

/* A real socket from a non-loopback address is impractical here (it needs a
   second interface the test can bind and reach), so the proxy on another
   host is the hop the loopback proxy appended: a chain of two proxies, the
   far one at 10.0.0.5. trust-proxy.test.ts covers a non-loopback socket
   peer through the same resolution function. */
const viaRemote = (f: { base: string }, client: string, proxy: string, n: number) =>
  call(f.base, '/api/forms/apply', { input: { name: `r${n}` }, submission: key(400 + n) }, 'POST', {
    'x-forwarded-for': `198.51.100.99, ${client}, ${proxy}`,
  });

test(
  'with --trust-proxy naming a proxy on another host, the walk passes it to the applicant it forwarded for',
  { timeout: 8000 },
  async () => {
    await fixture(
      async (f) => {
        for (let n = 1; n <= 5; n++) assert.equal((await viaRemote(f, '203.0.113.7', '10.0.0.5', n)).status, 200);
        const sixth = await viaRemote(f, '203.0.113.7', '10.0.0.5', 6);
        assert.equal(sixth.status, 429);
        assert.equal(sixth.body.code, 'rate_limited');
        // Another applicant through the same remote proxy keeps a window of its own,
        // and the first one is the same client through another listed proxy.
        assert.equal((await viaRemote(f, '203.0.113.8', '10.0.0.5', 7)).status, 200);
        assert.equal((await viaRemote(f, '203.0.113.7', '10.0.0.6', 8)).status, 429);
        assert.equal(f.calls.length, 6);
      },
      { form: true, trustProxy: ['10.0.0.0/8'] },
    );
  },
);

test('without --trust-proxy, every applicant behind a proxy on another host shares its one budget', { timeout: 8000 }, async () => {
  await fixture(async (f) => {
    for (let n = 1; n <= 5; n++) assert.equal((await viaRemote(f, `203.0.113.${n}`, '10.0.0.5', n)).status, 200);
    const sixth = await viaRemote(f, '203.0.113.6', '10.0.0.5', 6);
    assert.equal(sixth.status, 429, "a new applicant is refused for the others' submissions");
    assert.equal(f.calls.length, 5);
  });
});

test('a method the route does not run is refused before it spends the submit budget', { timeout: 8000 }, async () => {
  await fixture(async (f) => {
    for (let n = 0; n < 6; n++) {
      const put = await call(f.base, '/api/forms/apply', { input: { name: 'a' }, submission: key(300 + n) }, 'PUT');
      assert.equal(put.status, 405);
      assert.equal(put.headers.get('allow'), 'GET, HEAD, POST');
    }
    for (const method of ['DELETE', 'PATCH']) assert.equal((await call(f.base, '/api/forms/apply', {}, method)).status, 405);
    assert.equal((await call(f.base, '/api/forms', {}, 'POST')).status, 405);
    const post = await call(f.base, '/api/forms/apply', { input: { name: 'after' }, submission: key(310) });
    assert.equal(post.status, 200, post.text);
    assert.equal(f.calls.length, 1);
  });
});

/* Signed out, the gate answers a key that names no form before the route (401): only a signed-in visitor reaches it. */
test(
  "a key that names no form is answered 404 before the ceiling every visitor shares, so it never spends a person's submission",
  { timeout: 8000 },
  async () => {
    await fixture(
      async (f) => {
        const total = publicFormLimiter('submit');
        // Others have spent all but one of the App-wide ceiling.
        for (let n = 0; n < PUBLIC_FORM_SUBMIT_TOTAL[0].limit - 1; n++) assert.equal((await total.take(`other-${n}`, 'all')).ok, true);
        for (let n = 0; n < 4; n++) {
          const missing = await call(f.base, `/api/forms/no-such-${n}`, { input: { name: 'x' }, submission: key(320 + n) });
          assert.equal(missing.status, 404, missing.text);
          assert.equal(missing.body.code, 'no_such_form');
        }
        const post = await call(f.base, '/api/forms/apply', { input: { name: 'person' }, submission: key(330) });
        assert.equal(post.status, 200, post.text);
        assert.equal(f.calls.length, 1);
      },
      { form: true, role: 'clerk' },
    );
  },
);

/* ---------- signed in ---------- */

const logEnvelope = (n: number, extra: Record<string, unknown> = {}) => ({
  command: 'logEnrolment',
  commandVersion: 1,
  key: {},
  expectedVersion: 0,
  idempotencyKey: key(500 + n),
  input: { name: 'Clerked' },
  ...extra,
});

test(
  'a signed-in form is served with its nav entry to the role granted its command, and runs through that grant naming no record',
  { timeout: 8000 },
  async () => {
    await fixture(
      async (f) => {
        const payload = await call(f.base, '/api/app');
        assert.equal(payload.status, 200, payload.text);
        const served = payload.body.app as Served;
        // The public form is no room: it is read from its own route, like the landing.
        assert.deepEqual(Object.keys(served.views).sort(), ['enrolments', 'loans', 'log']);
        assert.equal(served.views.log.label, 'Log an enrolment');
        assert.equal((served.views.log.command as { id: string }).id, 'logEnrolment');
        assert.deepEqual(served.views.log.steps, [{ id: 'who', label: 'Who', fields: ['name'] }]);
        assert.deepEqual(served.views.log.done, { title: 'Logged' });
        assert.deepEqual(
          served.nav.map((node) => node.view),
          ['enrolments', 'loans', 'log'],
        );
        const first = await call(f.base, '/api/commands/execute', logEnvelope(1));
        assert.equal(first.status, 200, first.text);
        assert.equal(first.body.status, 'applied');
        assert.deepEqual(first.body.result, { reference: 'LOG-0001' });
        const again = await call(f.base, '/api/commands/execute', logEnvelope(1));
        assert.equal(again.body.receiptId, first.body.receiptId);
        // A form's command names no record: a key is refused before its handler runs.
        const keyed = await call(f.base, '/api/commands/execute', logEnvelope(2, { key: { id: 1 } }));
        assert.equal(keyed.status, 400);
        assert.deepEqual(f.actors, ['account-1']);
        // The public route never serves it; to someone signed in a key it lacks is said plainly.
        for (const path of ['/api/forms/log', '/api/forms/nope']) {
          const missing = await call(f.base, path);
          assert.equal(missing.status, 404, path);
          assert.equal(missing.body.code, 'no_such_form', path);
        }
        // A public form submitted by someone signed in is still a public submission.
        const applied = await call(f.base, '/api/forms/apply', { input: { name: 'Ada' }, submission: key(600) });
        assert.equal(applied.status, 200, applied.text);
        assert.deepEqual(f.actors, ['account-1', 'public:apply']);
        assert.equal(rows(f), 2);
      },
      { form: true, role: 'clerk' },
    );
  },
);

test(
  'a role not granted the command is served no form and cannot submit it; no other command takes an empty key',
  { timeout: 8000 },
  async () => {
    await fixture(
      async (f) => {
        const served = (await call(f.base, '/api/app')).body.app as Served;
        assert.deepEqual(Object.keys(served.views).sort(), ['enrolments', 'loans']);
        assert.deepEqual(
          served.nav.map((node) => node.view),
          ['enrolments', 'loans'],
        );
        const refused = await call(f.base, '/api/commands/execute', logEnvelope(3));
        assert.equal(refused.status, 403);
        assert.equal(refused.body.code, 'forbidden');
        const empty = await call(f.base, '/api/commands/execute', {
          command: 'assign',
          commandVersion: 1,
          key: {},
          expectedVersion: 0,
          idempotencyKey: key(700),
          input: {},
        });
        assert.equal(empty.status, 400);
        assert.equal(empty.body.code, 'invalid_input');
        assert.deepEqual(f.actors, []);
        assert.equal(rows(f), 0);
      },
      { form: true, role: 'manager' },
    );
  },
);
