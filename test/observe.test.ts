/*
 * The dev observer: a command's round trip through the real HTTP server is
 * kept with everything the author needs — the SQL with its parameters, the
 * command's input and output, a refusal with its recorded cause, the App's
 * own console lines inside the span that wrote them — and credentials are
 * masked on the way in. It answers this machine only, and a server that did
 * not start it answers its address with a 404.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { refuse } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { startObserver } from '../packages/mistri/src/server/observe/observer.js';
import { boundColumns, Masker, MASKED_CREDENTIAL, MASKED_HIDDEN } from '../packages/mistri/src/server/observe/mask.js';
import { traceTree } from '../packages/mistri/src/server/observe/mcp.js';
import { parseTestApp } from './support/commandCatalog.js';

async function fixture(
  run: (f: { base: string; control: { fail?: string } }) => Promise<void>,
  observe = true,
  addresses?: { base?: string; mounts?: Record<string, string> },
) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-observe-'));
  const file = join(directory, 'app.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE loan(id INTEGER PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0, note TEXT, api_token TEXT);
    CREATE TABLE payment(id INTEGER PRIMARY KEY, loan INTEGER NOT NULL, amount INTEGER NOT NULL);
    INSERT INTO loan VALUES (1, 0, 'first', 'tok-OLD');
    INSERT INTO payment VALUES (1,1,10),(2,1,20),(3,1,30),(4,1,40),(5,1,50),(6,1,60);`);
  migrateSqliteCommandJournal(file);
  const registry = new Registry();
  registry.add({ id: 'db', name: 'db', url: file, writable: true, source: 'config' });
  const input = {
    note: { label: 'Note', type: 'text' },
    password: { label: 'Password', type: 'text' },
    tax_id: { label: 'Tax id', type: 'text', sensitive: { keep: 'last4' } },
  } as const;
  const app = parseTestApp(
    {
      id: 'loans',
      name: 'Loans',
      sources: { lending: { connection: 'db' } },
      resources: {
        loan: {
          access: 'write',
          actions: { annotate: { label: 'Annotate', command: { id: 'annotate', version: 1, target: 'loan', input } } },
        },
        payment: {},
      },
      auth: { roles: { manager: { read: true, commands: ['annotate'] }, viewer: { read: ['loan'], write: false } } },
      views: { loan: { kind: 'list', from: 'loan' } },
      home: 'loan',
      nav: ['loan'],
    },
    'observer fixture',
  );
  const control: { fail?: string } = {};
  const account: Identity = { id: 'account-a', who: 'manager@example.test', role: 'manager' };
  const commands = defineCommands({
    annotate: defineCommand({
      source: 'lending',
      target: 'loan',
      input,
      read: ['payment'],
      validate(value): { note: string; password: string } {
        return { note: String(value.note), password: String(value.password) };
      },
      output: {
        parse(value: unknown) {
          return value as { version: number; total: number };
        },
      },
      async handle({ db: tx, record }, value) {
        console.log(`annotating loan with "${value.note}"`);
        if (control.fail) refuse(control.fail);
        // One read per payment: the N+1 the observer flags.
        let total = 0;
        for (const id of [1, 2, 3, 4, 5, 6]) total += Number((await tx.payment.find({ id }))?.amount ?? 0);
        const { version } = await tx.loan.update(record, { note: value.note, api_token: `tok-${value.password}` });
        return { version: Number(version), total };
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
      session: async () => account,
    },
  };
  const observer = observe ? startObserver({ registry, apps: () => [host] }, { slowMs: 10_000 }) : undefined;
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({
    registry,
    bound,
    apps: [host],
    commands: { appId: 'loans', registry: commands },
    ...(addresses ? { addresses } : {}),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  bound.port = (server.address() as { port: number }).port;
  try {
    await run({ base: `http://127.0.0.1:${bound.port}${addresses?.base ?? ''}`, control });
  } finally {
    observer?.stop();
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

const execute = (base: string, note: string, expectedVersion = 0) =>
  fetch(`${base}/api/commands/execute`, {
    method: 'POST',
    signal: AbortSignal.timeout(5000),
    headers: { 'content-type': 'application/json', authorization: 'Bearer secret-bearer-token', cookie: 'session=secret-cookie' },
    body: JSON.stringify({
      command: 'annotate',
      commandVersion: 1,
      key: { id: 1 },
      expectedVersion,
      idempotencyKey: `annotate-${note.replace(/\W/g, '-')}-0001`,
      input: { note, password: 'hunter2-password', tax_id: '987654321' },
    }),
  });
const observe = async (base: string, path: string, init?: RequestInit) => {
  const response = await fetch(`${base}/_mistri/observe/api${path}`, init);
  return { status: response.status, body: (await response.json()) as Record<string, any> };
};

test(
  'a command round trip shows its SQL with parameters, input and output, logs in their span, N+1 — and credentials masked',
  { timeout: 20_000 },
  async () => {
    await fixture(async ({ base, control }) => {
      const applied = await execute(base, 'looks good');
      assert.equal(applied.status, 200, await applied.clone().text());
      const traceId = applied.headers.get('x-mistri-trace');
      assert.match(traceId ?? '', /^[0-9a-f]{32}$/, 'a dev response names its trace');

      const list = await observe(base, '/traces');
      assert.equal(list.status, 200);
      const summary = list.body.traces.find((each: { traceId: string }) => each.traceId === traceId);
      assert.ok(summary, 'the request is listed');
      assert.equal(summary.route, '/api/commands/execute');
      assert.equal(summary.path, '/api/commands/execute');
      assert.deepEqual(summary.commands, [{ id: 'annotate', outcome: 'applied' }]);
      /* Six reads of one shape under the command are an N+1 pattern. (So, today,
       is the SQLite adapter's own table check before each read: the observer
       shows the platform's repeats as plainly as an App's.) */
      assert.ok(summary.nPlusOne >= 1);

      const trace = (await observe(base, `/traces/${traceId}`)).body;
      const spans = trace.spans as Array<Record<string, any>>;
      const server = spans.find((span) => span.name === 'POST /api/commands/execute')!;
      assert.equal(server.detail.request.headers.authorization, MASKED_CREDENTIAL);
      assert.equal(server.detail.request.headers.cookie, MASKED_CREDENTIAL);
      assert.match(server.detail.request.body, /looks good/);
      assert.doesNotMatch(server.detail.request.body, /hunter2/, 'a password in a body is masked');
      assert.match(server.detail.response.body, /"applied"|applied/);

      const command = spans.find((span) => span.name === 'command annotate')!;
      assert.equal(command.detail.input.note, 'looks good');
      assert.equal(command.detail.input.password, MASKED_CREDENTIAL);
      assert.equal(command.detail.output.total, 210);
      assert.equal(command.logs?.[0]?.message, 'annotating loan with "looks good"', "the App's console line is inside its command");
      assert.equal(command.logs?.[0]?.source, 'app');

      const update = spans.find((span) => span.name === 'UPDATE loan')!;
      assert.match(update.detail.sql, /UPDATE/);
      assert.ok(update.detail.params.includes('looks good'), `params ${JSON.stringify(update.detail.params)}`);
      assert.ok(update.detail.params.includes(MASKED_CREDENTIAL), 'the api_token parameter is masked');
      {
        const text = JSON.stringify(trace);
        const at = text.indexOf('hunter2');
        assert.ok(at < 0, `the password appears: ${text.slice(Math.max(0, at - 300), at + 60)}`);
        /* A field the command declares sensitive is masked by its declaration, not by its name. */
        const taxAt = text.indexOf('987654321');
        assert.ok(taxAt < 0, `the sensitive value appears: ${text.slice(Math.max(0, taxAt - 300), taxAt + 60)}`);
      }
      assert.match(update.detail.transaction, /^sqlite:\d+\/tx\d+$/);
      const reads = spans.filter((span) => span.name === 'SELECT payment' && /WHERE/.test(span.detail.sql));
      assert.equal(reads.length, 6);
      assert.ok(reads.every((span) => span.flags?.nPlusOne === 6));
      assert.equal(reads[0].detail.rows, 1);

      // EXPLAIN a read it recorded, run read-only.
      const explained = await observe(base, '/explain', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ spanId: reads[0].spanId }),
      });
      assert.equal(explained.status, 200, JSON.stringify(explained.body));
      assert.ok(
        explained.body.plan.some((line: string) => /payment/.test(line)),
        JSON.stringify(explained.body),
      );

      // The agent's view of the same trace: one line per span, the SQL and its parameters beneath.
      const tree = traceTree(trace as never).tree as string[];
      assert.ok(tree.some((line) => /^\s+command annotate/.test(line)));
      assert.ok(tree.some((line) => /params: .*looks good/.test(line)));

      // A refusal names its cause in the observer, and is listed among the errors.
      control.fail = 'Nothing to annotate on a closed loan';
      const refused = await execute(base, 'again', 1);
      assert.ok(refused.status >= 400);
      const refusedBody = (await refused.json()) as { observe?: string };
      const refusedTrace = refused.headers.get('x-mistri-trace')!;
      assert.equal(refusedBody.observe, `/_mistri/observe/#trace/${refusedTrace}`, 'the refusal links to its trace');
      const errors = (await observe(base, '/errors')).body;
      const error = errors.errors.find((each: { traceId: string }) => each.traceId === refusedTrace);
      assert.ok(error, JSON.stringify(errors));
      const detail = (await observe(base, `/traces/${refusedTrace}`)).body;
      const refusedCommand = detail.spans.find((span: { name: string }) => span.name === 'command annotate');
      assert.equal(refusedCommand.detail.refusal.reason ?? refusedCommand.detail.refusal.message, 'Nothing to annotate on a closed loan');
      assert.ok(refusedCommand.attributes['mistri.refusal.code']);

      // Logs, first class: searchable, and each line carries its trace.
      const logs = (await observe(base, `/logs?text=annotating`)).body;
      assert.equal(logs.logs.length, 2);
      assert.ok(logs.logs.every((line: { traceId?: string }) => line.traceId));

      // tail: nothing new since the cursor, then the next request.
      const cursor = (await observe(base, '/tail')).body.cursor;
      assert.equal((await observe(base, `/tail?cursor=${cursor}`)).body.traces.length, 0);
      await fetch(`${base}/api/whoami`);
      assert.ok((await observe(base, `/tail?cursor=${cursor}`)).body.traces.length >= 1);

      // explain_access, from the App's own grants.
      const access = (await observe(base, '/access?role=viewer&command=annotate')).body;
      assert.equal(access.allowed, false);
      assert.match(access.because, /auth\.roles\.viewer has no "commands"/);
      const column = (await observe(base, '/access?role=viewer&table=loan&column=note')).body;
      assert.equal(column.read, true);
      assert.equal(column.write, false);
    });
  },
);

test('the observer answers this machine only, and its page is served', { timeout: 20_000 }, async () => {
  await fixture(async ({ base }) => {
    const { port } = new URL(base);
    const asked = (host: string) =>
      new Promise<number>((resolve, reject) => {
        request({ host: '127.0.0.1', port, path: '/_mistri/observe/api/traces', headers: { host } }, (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        })
          .on('error', reject)
          .end();
      });
    assert.equal(await asked(`localhost:${port}`), 200);
    // A name rebound to loopback reaches the socket, not the observer.
    assert.equal(await asked(`evil.example:${port}`), 403);
    const page = await fetch(`${base}/_mistri/observe/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Observer · mistri/);
    assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'self'/);
    // The App's own page says the observer runs, so its badge and beacon load.
    const shell = await (await fetch(`${base}/loans`)).text();
    assert.match(shell, /<meta name="mistri-observe"/);
    // The tab says the App's name from the first byte, not "tablewalk" until the client boots.
    assert.match(shell, /<title>Loans<\/title>/);
  });
});

test('a server without the observer answers its address with 404, and its pages carry no observer tag', { timeout: 20_000 }, async () => {
  await fixture(async ({ base }) => {
    for (const path of ['/_mistri/observe', '/_mistri/observe/', '/_mistri/observe/api/traces']) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 404, path);
    }
    const applied = await execute(base, 'quietly');
    assert.equal(applied.headers.get('x-mistri-trace'), null);
    const shell = await (await fetch(`${base}/loans`)).text();
    assert.doesNotMatch(shell, /tablewalk-observe/);
  }, false);
});

test('masking: credentials by name, hidden columns by rule, secrets by value, and parameters by the column they bind', () => {
  const masker = new Masker({ hidden: [{ table: 'person', columns: ['ssn', '*_private'] }], secrets: new Set(['s3cr3t-db-pass']) });
  assert.deepEqual(
    masker.params('UPDATE "person" SET "ssn" = $1, "name" = $2, "notes_private" = $3 WHERE "id" = $4', ['123-45', 'Ada', 'x', 7], 'person'),
    [MASKED_HIDDEN, 'Ada', MASKED_HIDDEN, 7],
  );
  assert.deepEqual(
    masker.params(
      'INSERT INTO account (email, password_hash, name) VALUES (?, ?, ?), (?, ?, ?)',
      ['a@b', 'h1', 'A', 'c@d', 'h2', 'C'],
      'account',
    ),
    Array(6).fill(MASKED_CREDENTIAL),
    "the auth store's tables are masked whole",
  );
  assert.deepEqual(masker.params('INSERT INTO lead (email, api_key, name) VALUES (?, ?, ?)', ['a@b', 'k', 'A'], 'lead'), [
    'a@b',
    MASKED_CREDENTIAL,
    'A',
  ]);
  assert.deepEqual(masker.params("SELECT * FROM t WHERE note = '?' AND token IN (?, ?)", ['a', 'b'], 't'), [
    MASKED_CREDENTIAL,
    MASKED_CREDENTIAL,
  ]);
  assert.equal(masker.text('postgres://u:s3cr3t-db-pass@host/db'), 'postgres://u:••••••@host/db');
  assert.deepEqual(masker.headers({ Authorization: 'Bearer x', 'x-api-key': 'y', accept: 'json' }), {
    Authorization: MASKED_CREDENTIAL,
    'x-api-key': MASKED_CREDENTIAL,
    accept: 'json',
  });
  assert.deepEqual(masker.value({ person: { ssn: '1', name: 'Ada', password: 'p' } }, 'person'), {
    person: { ssn: MASKED_HIDDEN, name: 'Ada', password: MASKED_CREDENTIAL },
  });
  assert.deepEqual(
    [...boundColumns('UPDATE t SET a = ?, b = ? WHERE c IN (?, ?)').entries()],
    [
      [0, 'a'],
      [1, 'b'],
      [2, 'c'],
      [3, 'c'],
    ],
  );
  // A sign-in's callback and its redirect to the provider carry a code, a state and a nonce; a list's ?code= is a value.
  assert.equal(
    masker.text('/api/auth/callback/workforce?code=abc&state=xyz&iss=https%3A%2F%2Fidp'),
    `/api/auth/callback/workforce?code=${MASKED_CREDENTIAL}&state=${MASKED_CREDENTIAL}&iss=https%3A%2F%2Fidp`,
  );
  assert.match(
    masker.text('https://idp.example/authorize?client_id=c&redirect_uri=x&nonce=n1&code_challenge=cc&state=s1'),
    /nonce=\[masked[^&]*&code_challenge=\[masked[^&]*&state=\[masked/,
  );
  assert.equal(masker.text('/leads?code=A-17'), '/leads?code=A-17');
});

test(
  'under --base-path and an App at the root, the observer, its links, the probes and the route names follow the mount',
  { timeout: 20_000 },
  async () => {
    await fixture(
      async ({ base }) => {
        const origin = new URL(base).origin;
        assert.equal((await fetch(`${base}/healthz`)).status, 200);
        assert.equal((await fetch(`${base}/readyz`)).status, 200);
        assert.equal((await fetch(`${origin}/_mistri/observe/api/traces`)).status, 404, 'outside the base names nothing');
        const refused = await fetch(`${base}/api/commands/execute`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            command: 'nothing',
            commandVersion: 1,
            key: { id: 1 },
            expectedVersion: 0,
            idempotencyKey: 'nothing-at-all-0001',
            input: {},
          }),
        });
        const traceId = refused.headers.get('x-mistri-trace')!;
        assert.equal(((await refused.json()) as { observe?: string }).observe, `/tools/_mistri/observe/#trace/${traceId}`);
        const trace = (await (await fetch(`${base}/_mistri/observe/api/traces/${traceId}`)).json()) as { route: string; name: string };
        assert.equal(trace.route, '/api/commands/execute');
        assert.equal(trace.name, 'POST /api/commands/execute');
        // A page of the root App: its route is the App's page, never the base-path spelling, and its tag names the observer under the base.
        const page = await fetch(`${base}/loan`);
        const shell = await page.text();
        assert.match(shell, /<meta name="mistri-observe" content="\/tools\/_mistri\/observe\/">/);
        const listed = (await (await fetch(`${base}/_mistri/observe/api/traces?route=${encodeURIComponent('/{page}')}`)).json()) as {
          traces: Array<{ route: string }>;
        };
        assert.ok(listed.traces.length >= 1);
        // Neither the probes nor the observer's own requests are traced.
        const all = (await (await fetch(`${base}/_mistri/observe/api/traces?limit=200`)).json()) as { traces: Array<{ name: string }> };
        assert.ok(
          !all.traces.some((each) => /healthz|readyz|_mistri/.test(each.name)),
          JSON.stringify(all.traces.map((each) => each.name)),
        );
        assert.equal((await fetch(`${base}/_mistri/observe/`)).status, 200);
      },
      true,
      { base: '/tools' },
    );
  },
);

test(
  'a pooled statement is counted in the request that asked for it, not the one whose release handed it the connection',
  { timeout: 20_000 },
  async () => {
    /* The pool's own checkout, over a client that answers without a server: a
     full pool queues the waiter and calls it back from inside the releasing
     request's callback. Six requests, two connections, two statements each —
     the shape a row-policy App's policy lookups had (ksobs one.mjs). */
    const { EventEmitter } = await import('node:events');
    /* pg's own Pool, untyped here: the repository reads pg through its own
     narrow types (adapters/postgresPool.ts), not @types/pg. */
    type Pool = { query(text: string): Promise<unknown>; end(): Promise<void> };
    const pg = (await import('node:module')).createRequire(import.meta.url)('pg') as {
      Pool: new (options: Record<string, unknown>) => Pool;
    };
    const { instrumentPg } = await import('../packages/engine/src/adapters/telemetry/drivers.js');
    const { addSink, inSpan } = await import('../packages/engine/src/adapters/telemetry/trace.js');
    class FakeClient extends EventEmitter {
      connect(done: (error?: Error) => void) {
        setImmediate(() => done());
      }
      query(_text: string, _values: unknown, done: (error: Error | undefined, result: unknown) => void) {
        setTimeout(() => done(undefined, { rows: [], rowCount: 0 }), 5);
      }
      end(done?: () => void) {
        done?.();
      }
    }
    // pg's own pool class, over the fake client: the checkout under test is the pool's.
    class FakePool extends pg.Pool {}
    instrumentPg({ Client: FakeClient as never, Pool: FakePool as never });
    const ended: Array<{ traceId: string; name: string; statement: boolean }> = [];
    const remove = addSink({
      onEnd(span) {
        ended.push({ traceId: span.traceId, name: span.name, statement: Boolean(span.attributes['db.system.name']) });
      },
    });
    const pool = new FakePool({ Client: FakeClient as never, max: 2 });
    try {
      const requests = await Promise.all(
        [1, 2, 3, 4, 5, 6].map((n) =>
          inSpan(`request ${n}`, { kind: 'server' }, async (span) => {
            await pool.query(`SELECT ${n} FROM policy`);
            await pool.query(`SELECT ${n} FROM policy`);
            return span.traceId;
          }),
        ),
      );
      for (const traceId of requests) {
        const statements = ended.filter((span) => span.statement && span.traceId === traceId);
        assert.equal(statements.length, 2, `each request's trace holds its own two statements: ${JSON.stringify(ended)}`);
      }
    } finally {
      remove();
      await pool.end();
    }
  },
);

test(
  "the observer lists by the App served, drops what a dropped file left behind, says aborted apart from errors, and keeps a refusal's sentence, stderr and a bounded tail",
  { timeout: 30_000 },
  async () => {
    await fixture(async ({ base, control }) => {
      // The App at the root: its page and its API are its own, and no prefix of its id is.
      await fetch(`${base}/loan`);
      await fetch(`${base}/api/whoami`);
      const mine = (await observe(base, '/traces?app=loans')).body;
      assert.ok(
        mine.traces.some((each: { path?: string }) => each.path === '/loan'),
        JSON.stringify(mine.traces.map((each: { path?: string }) => each.path)),
      );
      assert.ok(mine.traces.some((each: { path?: string }) => each.path === '/api/whoami'));
      assert.equal((await observe(base, '/traces?app=loan')).body.traces.length, 0, 'an App id is not a path prefix');
      // Vite's own module, asked at the root, is a file, not the root App's page.
      await (await fetch(`${base}/@vite/client`)).arrayBuffer();
      const all = (await observe(base, '/traces?limit=200')).body.traces as Array<{ path?: string; route?: string }>;
      assert.ok(!all.some((each) => (each.path ?? '').startsWith('/@vite/')), JSON.stringify(all.map((each) => [each.path, each.route])));

      // A refusal in the list of errors says what its reader was told.
      control.fail = 'Nothing to annotate on a closed loan';
      const refused = await execute(base, 'refused sentence', 0);
      const traceId = refused.headers.get('x-mistri-trace');
      const errors = (await observe(base, '/errors')).body.errors as Array<{ traceId?: string; refusal?: { message?: string } }>;
      assert.equal(
        errors.find((each) => each.traceId === traceId)?.refusal?.message,
        'Nothing to annotate on a closed loan',
        JSON.stringify(errors),
      );

      // A line written straight to stderr is kept, as the terminal showed it.
      process.stderr.write('a driver wrote this to stderr\n');
      const logs = (await observe(base, '/logs?source=stderr')).body.logs as Array<{ message: string }>;
      assert.ok(
        logs.some((line) => line.message === 'a driver wrote this to stderr'),
        JSON.stringify(logs),
      );

      // Asked with no cursor, tail answers the cursor, not the whole memory.
      const tail = (await observe(base, '/tail')).body;
      assert.equal(typeof tail.cursor, 'number');
      assert.equal(tail.traces, undefined);
      assert.ok(JSON.stringify(tail).length < 400, JSON.stringify(tail));
    });

    // In the store: a statement that ends after its dropped file's request starts no trace, and an aborted request is no error.
    const { ObserverStore } = await import('../packages/mistri/src/server/observe/store.js');
    const store = new ObserverStore(new Masker({ hidden: [], secrets: new Set() }));
    const span = (traceId: string, spanId: string, attributes: Record<string, unknown>, parentSpanId?: string) =>
      ({
        traceId,
        spanId,
        ...(parentSpanId ? { parentSpanId } : {}),
        remoteParent: false,
        name: String(attributes.name ?? 'span'),
        kind: parentSpanId ? 'client' : 'server',
        startTime: 1,
        endTime: 2,
        attributes,
        events: [],
        links: [],
        status: { code: 'unset' },
        sampled: true,
        detail: {},
      }) as never;
    const file = 'a'.repeat(32),
      dropped = 'b'.repeat(32);
    store.addSpan(span(file, '1'.repeat(16), { 'http.route': '/{asset}', 'http.response.status_code': 200 }));
    store.addSpan(span(file, '2'.repeat(16), { 'db.system.name': 'postgresql', name: 'SELECT session' }, '1'.repeat(16)));
    assert.equal(store.list().traces.length, 0, 'the late session read is not a trace of its own');
    store.addSpan(
      span(dropped, '3'.repeat(16), { 'http.route': '/api/query', 'http.request.method': 'GET', 'mistri.request.aborted': true }),
    );
    const [aborted] = store.list().traces;
    assert.equal(aborted.aborted, true);
    assert.equal(aborted.error, undefined);
    assert.equal(store.errors().errors.length, 0);
  },
);

/* Here for its fixture: a signed-in reader and a real command. The step check a signed-in form asks before Next. */
test(
  'a signed-in step check judges the fields asked so far, refuses a name the command lacks and a stale version',
  { timeout: 20_000 },
  async () => {
    await fixture(async ({ base }) => {
      const check = (body: object) =>
        fetch(`${base}/api/commands/check`, {
          method: 'POST',
          signal: AbortSignal.timeout(5000),
          headers: { 'content-type': 'application/json', cookie: 'session=secret-cookie' },
          body: JSON.stringify({ command: 'annotate', commandVersion: 1, ...body }),
        });
      const missing = await check({ fields: ['note'], input: {} });
      assert.equal(missing.status, 200, await missing.clone().text());
      const said = ((await missing.json()) as { problems: Record<string, string> }).problems;
      assert.deepEqual(Object.keys(said), ['note']);
      // An answer to a field not asked yet is one nobody asked for.
      const ahead = (
        (await (await check({ fields: ['note'], input: { note: 'fine', password: 'later' } })).json()) as {
          problems: Record<string, string>;
        }
      ).problems;
      assert.deepEqual(Object.keys(ahead), ['password']);
      const fine = (
        (await (await check({ fields: ['note', 'password'], input: { note: 'fine', password: 'p' } })).json()) as { problems: object }
      ).problems;
      assert.deepEqual(fine, {});
      assert.equal((await check({ fields: ['nope'], input: {} })).status, 400);
      assert.equal((await check({ commandVersion: 2, fields: ['note'], input: {} })).status, 409);
    }, false);
  },
);
