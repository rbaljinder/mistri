/**
 * A public page's door (P1): `definePage({ public: true, commands })` runs the public commands it names for a
 * signed-out visitor through `/api/pages/<page>/commands/<name>`, under the stock public form's rules. Each abuse
 * case the design names has its fixture here: no session (the door is open, and only this door), the submit budget
 * shared with forms, a ticket missing, forged, too young or too old, the App's human check, a body past the
 * envelope, a replayed submission key, an input member the command does not declare, a cross-origin post, and the
 * public principal kept for a caller with a session too. And the stock public form's decoy: a filled honeypot is
 * answered as accepted and writes nothing.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { addSink } from '../packages/engine/src/adapters/telemetry/trace.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { shape, text } from '../packages/mistri/src/server/commands/commandShapes.js';
import { defineChallenges } from '../packages/mistri/src/server/commands/challenges.js';
import { resetPublicFormLimits } from '../packages/engine/src/server/http/rateLimit.js';
import { parseTrustedProxies } from '../packages/engine/src/server/http/trust.js';
import { issueTicket, ticketKeyStart, ticketRefusal, TICKET_MAX_AGE_MS } from '../packages/mistri/src/server/forms/publicTicket.js';
import { pageCommandRoutes, publicPageCommandRoute } from '../packages/mistri/src/server/http/pageCommandRoutes.js';
import { vouchForOrigin } from '../packages/engine/src/server/http/trust.js';
import type { RequestContext } from '../packages/engine/src/server/http/context.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseTestApp } from './support/commandCatalog.js';

const enrolInput = { name: { label: 'Name', type: 'text', max: 20 } } as const;
const component = (key: string) => ({ id: `page-${key}`, module: `./pages/${key}.page.tsx`, kind: 'page' });
const CONTRACTS = {
  enrol: { public: true, input: enrolInput },
  logEnrolment: { input: enrolInput },
};

const RAW = {
  id: 'enrolments',
  name: 'Enrolments',
  sources: { main: { connection: 'private-db' } },
  auth: {
    roles: { clerk: { read: true, commands: ['logEnrolment'] } },
    public: { read: ['desk'] },
  },
  resources: { enrolment: { access: 'write' }, desk: {} },
  views: {
    enrolments: { kind: 'list', from: 'enrolment' },
    lobby: { kind: 'page', label: 'Lobby', component: component('lobby'), reads: ['desk'], commands: ['enrol'], public: true },
    quiet: { kind: 'page', label: 'Quiet', component: component('quiet'), reads: ['desk'], public: true },
    desk: { kind: 'page', label: 'Desk', component: component('desk'), reads: ['enrolment'], commands: ['logEnrolment'] },
    apply: {
      kind: 'form',
      label: 'Apply',
      public: true,
      done: { title: 'Thanks' },
      command: 'enrol',
    },
  },
  home: [{ view: 'lobby', signedOut: true }, { view: 'enrolments' }],
  nav: ['enrolments', 'desk', 'quiet'],
};

interface Fixture {
  base: string;
  db: DatabaseSync;
  actors: string[];
  host: AppHost;
  registry: Registry;
  bound: { host: string; port: number; trustedProxies: ReturnType<typeof parseTrustedProxies>['ranges'] };
  asked: string[];
}

async function fixture(run: (f: Fixture) => Promise<void>, options: { challenge?: (token: string) => boolean; session?: boolean } = {}) {
  const asked: string[] = [];
  const app = parseTestApp(
    options.challenge ? { ...RAW, auth: { ...RAW.auth, challenge: 'verifyHuman' } } : RAW,
    'page door fixture',
    CONTRACTS,
  );
  resetPublicFormLimits();
  const directory = mkdtempSync(join(tmpdir(), 'mistri-page-door-'));
  const file = join(directory, 'door.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE enrolment(id INTEGER PRIMARY KEY, name TEXT NOT NULL, reference TEXT NOT NULL UNIQUE);
    CREATE TABLE desk(id INTEGER PRIMARY KEY, name TEXT NOT NULL); INSERT INTO desk VALUES (1, 'North');`);
  migrateSqliteCommandJournal(file);
  const registry = new Registry();
  registry.add({ id: 'private-db', name: 'Private', url: file, writable: true, source: 'config' });
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
        actors.push(context.actor.id);
        const reference = `ENR-${actors.length.toString().padStart(4, '0')}`;
        await context.tx.insert({ table: 'enrolment', values: { name: input.name, reference } });
        return { reference };
      },
    }),
    logEnrolment: defineCommand({
      targets: 'none',
      source: 'main',
      target: 'enrolment',
      read: ['enrolment'],
      write: ['enrolment'],
      input: enrolInput,
      output: shape({ reference: text() }),
      async handle(context, input) {
        actors.push(context.actor.id);
        await context.tx.insert({ table: 'enrolment', values: { name: input.name, reference: `LOG-${actors.length}` } });
        return { reference: `LOG-${actors.length}` };
      },
    }),
  });
  const challenge = options.challenge;
  const host: AppHost = {
    app: {
      app,
      path: '/private/app.ts',
      pages: [],
      sources: {},
      ...(challenge
        ? {
            challenges: defineChallenges({
              verifyHuman: {
                verify: async (token: string) => {
                  asked.push(token);
                  return challenge(token);
                },
              },
            }),
          }
        : {}),
    },
    pages: [],
    auth: {
      spec: app.auth!,
      store: '/private/auth.db',
      close() {},
      handler: async () => {},
      session: async () => (options.session ? { id: 'account-1', who: 'clerk@example.test', role: 'clerk' } : null),
    },
  };
  const bound = { host: '127.0.0.1', port: 0, trustedProxies: parseTrustedProxies([]).ranges };
  const server = createApp({ registry, bound, apps: [host], commands: { appId: 'enrolments', registry: commands } });
  try {
    server.listen(0, bound.host);
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    bound.port = address.port;
    await run({ base: `http://${bound.host}:${bound.port}`, db, actors, host, registry, bound, asked });
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

/* A ticket old enough to be a person's: issued in this process, under the key the server signs with. */
const aged = (page = 'lobby', age = 5_000) => issueTicket('enrolments', page, Date.now() - age);
const key = (n: number) => `submission-key-${String(n).padStart(6, '0')}`;

async function call(base: string, path: string, body?: unknown, headers: Record<string, string> = {}, method?: string) {
  const response = await fetch(`${base}${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { 'content-type': 'application/json', origin: base, ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    signal: AbortSignal.timeout(8_000),
  });
  const raw = await response.text();
  let parsed: unknown = raw;
  try {
    parsed = JSON.parse(raw);
  } catch {
    /* not JSON */
  }
  return { status: response.status, headers: response.headers, body: parsed as Record<string, unknown>, text: raw };
}

const submit = (f: Fixture, input: unknown, n: number, headers: Record<string, string> = { 'x-mistri-ticket': aged() }) =>
  call(f.base, '/api/pages/lobby/commands/enrol', { input, submission: key(n) }, headers);
const rows = (f: Fixture) => (f.db.prepare('SELECT count(*) AS n FROM enrolment').get() as { n: number }).n;

test('check: a public page runs only public commands that make their record, and needs auth', () => {
  const page = (commands: string[]) => ({ ...RAW, views: { ...RAW.views, lobby: { ...RAW.views.lobby, commands } } });
  assert.throws(() => parseTestApp(page(['logEnrolment']), 'x', CONTRACTS), /\[page-commands\].*"logEnrolment", which is not public/);
  assert.throws(
    () => parseTestApp(page(['assign']), 'x', { ...CONTRACTS, assign: { public: true, target: 'enrolment' } }),
    /\[page-commands\].*"assign", which names a record/,
  );
  // A signed-in page keeps its rule: its commands are granted to roles.
  assert.ok(parseTestApp(RAW, 'x', CONTRACTS));
});

test('signed out, the door and its ticket open for a public page and its named command only', { timeout: 15_000 }, async () => {
  await fixture(async (f) => {
    const ticket = await call(f.base, '/api/pages/lobby/ticket');
    assert.equal(ticket.status, 200, ticket.text);
    assert.equal(typeof ticket.body.ticket, 'string');
    assert.equal(ticket.headers.get('cache-control'), 'no-store');
    assert.equal(ticketRefusal(ticket.body.ticket, 'enrolments', 'lobby'), 'early', 'a fresh ticket is too young to submit with');
    // Not a door: a page with no commands, a signed-in page, a command the page does not name, a page that is not there.
    for (const path of [
      '/api/pages/quiet/ticket',
      '/api/pages/desk/ticket',
      '/api/pages/desk/commands/logEnrolment',
      '/api/pages/lobby/commands/logEnrolment',
      '/api/pages/nope/ticket',
    ]) {
      const refused = await call(f.base, path, path.includes('/commands/') ? { input: { name: 'x' }, submission: key(1) } : undefined);
      assert.equal(refused.status, 401, path);
    }
    const applied = await submit(f, { name: 'Ada' }, 2);
    assert.equal(applied.status, 200, applied.text);
    assert.deepEqual(Object.keys(applied.body).sort(), ['receipt', 'reference']);
    assert.equal(applied.body.reference, 'ENR-0001');
    assert.doesNotMatch(applied.text, /Ada/, 'the answer never echoes the input');
    assert.deepEqual(f.actors, ['public:lobby']);
    assert.equal(rows(f), 1);
    // A GET on the command and a POST on the ticket are the wrong verbs.
    assert.equal((await call(f.base, '/api/pages/lobby/commands/enrol')).status, 405);
    assert.equal((await call(f.base, '/api/pages/lobby/ticket', {})).status, 405);
  });
  assert.equal(publicPageCommandRoute(undefined, '/api/pages/lobby/ticket'), false);
});

test(
  'the ticket: missing, forged, for another door, too young or too old is refused before the body is read',
  { timeout: 15_000 },
  async () => {
    await fixture(async (f) => {
      const cases: Array<[string, Record<string, string>, number]> = [
        ['missing', {}, 403],
        ['forged', { 'x-mistri-ticket': `${aged().split('.')[0]}.AAAA` }, 403],
        ['another door', { 'x-mistri-ticket': aged('quiet') }, 403],
        ['too young', { 'x-mistri-ticket': issueTicket('enrolments', 'lobby') }, 425],
        ['too old', { 'x-mistri-ticket': aged('lobby', TICKET_MAX_AGE_MS + 60_000) }, 403],
      ];
      let n = 10;
      for (const [what, headers, status] of cases) {
        const refused = await submit(f, { name: 'Ada' }, n++, headers);
        assert.equal(refused.status, status, what);
        assert.equal(refused.body.code, 'ticket_refused', what);
      }
      assert.equal(rows(f), 0);
      assert.deepEqual(f.actors, []);
    });
  },
);

test('a replayed submission key is the same receipt and one row; different input under it is a conflict', { timeout: 15_000 }, async () => {
  await fixture(async (f) => {
    const first = await submit(f, { name: 'Ada' }, 20);
    const again = await submit(f, { name: 'Ada' }, 20);
    assert.equal(again.status, 200);
    assert.deepEqual(again.body, first.body);
    const conflict = await submit(f, { name: 'Bea' }, 20);
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, 'idempotency_conflict');
    assert.equal(rows(f), 1);
    assert.deepEqual(f.actors, ['public:lobby']);
  });
});

test('the submit budget is the public form budget, shared: a page and a form spend one allowance', { timeout: 20_000 }, async () => {
  await fixture(async (f) => {
    for (let n = 1; n <= 3; n++) assert.equal((await submit(f, { name: `p${n}` }, 30 + n)).status, 200);
    for (let n = 4; n <= 5; n++)
      assert.equal((await call(f.base, '/api/forms/apply', { input: { name: `f${n}` }, submission: key(30 + n) })).status, 200);
    const sixth = await submit(f, { name: 'p6' }, 36);
    assert.equal(sixth.status, 429);
    assert.equal(sixth.body.code, 'rate_limited');
    assert.match(sixth.headers.get('retry-after') ?? '', /^\d+$/);
    assert.equal(rows(f), 5);
  });
});

test(
  'size and shape: a body past 64 KB is a 413; an undeclared member, a missing key or a non-JSON body writes nothing',
  { timeout: 15_000 },
  async () => {
    await fixture(async (f) => {
      const huge = await submit(f, { name: 'x'.repeat(70_000) }, 40);
      assert.equal(huge.status, 413);
      assert.equal(huge.body.code, 'too_large');
      // A field the command does not declare: the public principal writes only what the command takes.
      const extra = await submit(f, { name: 'Ada', role: 'admin' }, 41);
      assert.equal(extra.status, 400);
      assert.equal(extra.body.code, 'invalid_input');
      assert.doesNotMatch(extra.text, /admin/);
      const member = await call(
        f.base,
        '/api/pages/lobby/commands/enrol',
        { input: { name: 'Ada' }, submission: key(42), trap: 'x' },
        { 'x-mistri-ticket': aged() },
      );
      assert.equal(member.status, 400, 'a page door reads no decoy: an extra member is refused');
      const form = await call(f.base, '/api/pages/lobby/commands/enrol', 'name=Ada', {
        'x-mistri-ticket': aged(),
        'content-type': 'application/x-www-form-urlencoded',
      });
      assert.notEqual(form.status, 200, 'a plain HTML form cannot post');
      assert.equal(rows(f), 0);
    });
  },
);

test('a cross-origin post is refused; a session cookie still runs as the public principal', { timeout: 15_000 }, async () => {
  await fixture(
    async (f) => {
      const cross = await call(
        f.base,
        '/api/pages/lobby/commands/enrol',
        { input: { name: 'Ada' }, submission: key(50) },
        {
          'x-mistri-ticket': aged(),
          origin: 'https://evil.example',
          'sec-fetch-site': 'cross-site',
        },
      );
      assert.equal(cross.status, 403);
      assert.equal(rows(f), 0);
      const signedIn = await submit(f, { name: 'Ada' }, 51);
      assert.equal(signedIn.status, 200, signedIn.text);
      assert.deepEqual(f.actors, ['public:lobby'], 'never the session’s account');
    },
    { session: true },
  );
});

test("the App's human check is asked before the body: a missing, refused or thrown token is a 403", { timeout: 15_000 }, async () => {
  await fixture(
    async (f) => {
      for (const headers of [{}, { 'x-mistri-challenge': 'robot' }, { 'x-mistri-challenge': 'throws' }] as Record<string, string>[]) {
        const refused = await submit(f, { name: 'Ada' }, 60, { 'x-mistri-ticket': aged(), ...headers });
        assert.equal(refused.status, 403);
        assert.equal(refused.body.code, 'challenge_failed');
      }
      resetPublicFormLimits(); // each refusal spent this client's budget, counted before anything is read
      const passed = await submit(f, { name: 'Ada' }, 61, { 'x-mistri-ticket': aged(), 'x-mistri-challenge': 'person' });
      assert.equal(passed.status, 200, passed.text);
      // And the stock public form: served the widget where the check has one (none here), asked the same.
      const form = await call(f.base, '/api/forms/apply', { input: { name: 'Bea' }, submission: key(62) });
      assert.equal(form.status, 403);
      assert.equal(form.body.code, 'challenge_failed');
      const formPassed = await call(
        f.base,
        '/api/forms/apply',
        { input: { name: 'Bea' }, submission: key(63) },
        { 'x-mistri-challenge': 'person' },
      );
      assert.equal(formPassed.status, 200, formPassed.text);
      assert.equal(rows(f), 2);
    },
    {
      challenge: (token) => {
        if (token === 'throws') throw new Error('provider down');
        return token === 'person';
      },
    },
  );
});

test("the stock public form's decoy: filled, it is answered as accepted and nothing is written", { timeout: 15_000 }, async () => {
  const ended: Array<Record<string, unknown>> = [];
  const stop = addSink({ onEnd: (span) => ended.push(span.attributes) });
  await fixture(async (f) => {
    const decoy = await call(f.base, '/api/forms/apply', { input: { name: 'Bot' }, submission: key(70), trap: 'http://spam.example' });
    assert.equal(decoy.status, 200);
    assert.deepEqual(Object.keys(decoy.body).sort(), ['receipt', 'reference']);
    assert.equal(rows(f), 0);
    assert.deepEqual(f.actors, []);
    const person = await call(f.base, '/api/forms/apply', { input: { name: 'Ada' }, submission: key(71), trap: '' });
    assert.equal(person.status, 200);
    assert.equal(rows(f), 1);
    // Counted as a command's outcome, `decoy`, where an operator reads them; the value it typed is not.
    const outcomes = ended.filter((span) => span['mistri.command.id'] === 'enrol').map((span) => span['mistri.command.outcome']);
    assert.deepEqual(outcomes, ['decoy', 'applied']);
    assert.doesNotMatch(JSON.stringify(ended), /spam\.example/);
  }).finally(stop);
});

test(
  'a flood with no ticket or token from many addresses spends their own budgets, never the App-wide one a person needs',
  { timeout: 60_000 },
  async () => {
    await fixture(
      async (f) => {
        // Past the App-wide ceiling of 300 an hour, one request from each address: none can prove anything.
        for (let n = 0; n < 160; n++) {
          const page = await call(
            f.base,
            '/api/pages/lobby/commands/enrol',
            { input: { name: 'Bot' }, submission: key(100 + n) },
            {
              'x-forwarded-for': `198.51.100.${n}`,
            },
          );
          assert.equal(page.status, 403, 'no ticket');
          const form = await call(
            f.base,
            '/api/forms/apply',
            { input: { name: 'Bot' }, submission: key(400 + n) },
            {
              'x-forwarded-for': `203.0.113.${n}`,
            },
          );
          assert.equal(form.status, 403, 'no token');
        }
        assert.equal(f.asked.length, 0, 'a missing token never reaches the provider');
        const page = await submit(f, { name: 'Ada' }, 900, { 'x-mistri-ticket': aged(), 'x-mistri-challenge': 'person-1' });
        assert.equal(page.status, 200, page.text);
        const form = await call(
          f.base,
          '/api/forms/apply',
          { input: { name: 'Bea' }, submission: key(901) },
          { 'x-mistri-challenge': 'person-2' },
        );
        assert.equal(form.status, 200, form.text);
        assert.equal(rows(f), 2);
      },
      { challenge: (token) => token.startsWith('person') },
    );
  },
);

test('a declared body past 64 KB is a 413 before the human check calls out', { timeout: 15_000 }, async () => {
  await fixture(
    async (f) => {
      const huge = { input: { name: 'x'.repeat(70_000) }, submission: key(950) };
      const page = await submit(f, huge.input, 950, { 'x-mistri-ticket': aged(), 'x-mistri-challenge': 'person-1' });
      assert.equal(page.status, 413);
      const form = await call(f.base, '/api/forms/apply', { ...huge, submission: key(951) }, { 'x-mistri-challenge': 'person-2' });
      assert.equal(form.status, 413);
      assert.deepEqual(f.asked, [], 'the provider was never asked');
    },
    { challenge: (token) => token.startsWith('person') },
  );
});

test("an embed host's vouched-for origin stands for no visitor at the public page door", async () => {
  await fixture(async (f) => {
    const path = '/api/pages/lobby/commands/enrol';
    const req = {
      method: 'POST',
      url: path,
      headers: {
        host: `${f.bound.host}:${f.bound.port}`,
        origin: 'https://host.example',
        'content-type': 'application/json',
        'x-mistri-ticket': aged(),
      },
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as IncomingMessage;
    // The embed door admitted its Origin on a host's bearer (embed/crossOrigin.ts).
    vouchForOrigin(req);
    let status = 0;
    let body = '';
    const res = {
      req,
      destroyed: false,
      writableEnded: false,
      setHeader() {},
      getHeader: () => undefined,
      removeHeader() {},
      writeHead(code: number) {
        status = code;
      },
      end(bytes: Buffer) {
        body = String(bytes);
      },
    } as unknown as ServerResponse;
    const ctx = {
      req,
      res,
      path,
      registry: f.registry,
      signedIn: f.host,
      bound: f.bound,
      policyUnavailable: false,
    } as unknown as RequestContext;
    assert.equal(await pageCommandRoutes(ctx), true);
    assert.equal(status, 403);
    assert.equal(JSON.parse(body).code, 'cross_origin');
    assert.equal(rows(f), 0);
  });
});

test('without MISTRI_FORM_KEY a start that knows it is one of several refuses, and a production one warns', () => {
  const key = { MISTRI_FORM_KEY: 'k'.repeat(32) };
  assert.equal(ticketKeyStart({ doors: false, shared: true, production: true, env: {} }), undefined, 'no door, no ticket');
  assert.equal(ticketKeyStart({ doors: true, shared: true, production: true, env: key }), undefined);
  assert.equal(ticketKeyStart({ doors: true, shared: false, production: false, env: {} }), undefined, 'one process at work');
  assert.match((ticketKeyStart({ doors: true, shared: true, production: false, env: {} }) as { refuse: string }).refuse, /shared cache/);
  assert.match(
    (ticketKeyStart({ doors: true, shared: false, production: false, env: { WEB_CONCURRENCY: '4' } }) as { refuse: string }).refuse,
    /WEB_CONCURRENCY/,
  );
  assert.match((ticketKeyStart({ doors: true, shared: false, production: true, env: {} }) as { warn: string }).warn, /MISTRI_FORM_KEY/);
  assert.match(
    (ticketKeyStart({ doors: true, shared: false, production: true, env: { MISTRI_FORM_KEY: 'short' } }) as { warn: string }).warn,
    /at least 32 bytes/,
  );
});
