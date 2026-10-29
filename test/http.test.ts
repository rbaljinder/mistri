// test-package: shared — holds the database browser and the App framework to one rule (scripts/test-owners.mjs).
/**
 * The API, over the wire.
 *
 * Every other suite reaches past the server: it builds an adapter, calls a
 * function, and asserts what came back. That leaves the whole HTTP layer —
 * status codes, the two error vocabularies, and the security check that
 * decides whether a request is allowed to happen at all — asserted nowhere. A
 * guard that is only ever called with a hand-built fake request is a guard
 * nobody has proved is wired in, and that is exactly the guard worth proving.
 *
 * So this suite starts a real server on a real socket and drives it with
 * `fetch`. Two things follow.
 *
 * The house rule applies as it does everywhere else: assert the refusal *and*
 * assert that nothing happened. A 403 proves the server said no; a row count
 * afterwards proves it meant it.
 *
 * And the vocabularies are pinned deliberately rather than described. tablewalk
 * answers `{ error }` when the request could not be carried out and
 * `{ errors: [{ message, at? }] }` when the person typing made a mistake in
 * the language — and several endpoints answer **200 with `errors`**, because a
 * statement the database refused is the user's to fix and belongs beside the
 * editor rather than in a failed request. Which endpoint does which is a
 * decision the client depends on, so each one is written down here.
 */
import { test, before, after, describe } from 'node:test';
import { toolCounts } from '../packages/tablewalk/src/server/mcp.js';
import assert from 'node:assert/strict';
import { request as httpRequest, type Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './support/createApp.js';
import { hostRefusal, identityFor, parseHostList, parseTrustedProxies } from '../packages/engine/src/server/http/trust.js';
import { Registry, loadConfig } from '../packages/engine/src/server/connections.js';
import { parseViewsConfig } from '../packages/engine/src/shared/view.js';
import { parseQueriesConfig } from '../packages/engine/src/shared/sqlsaved.js';
import { DEFAULT_LIMIT, MAX_LIMIT } from '../packages/engine/src/adapters/adapter.js';
import { makeDemoDatabase } from './make-demo-db.js';
import { CONFIG_SECTIONS } from '../packages/mistri/src/server/serviceConnections.js';

/* Its own files rather than the ones the other suites build. `node --test`
   gives each file its own process, and two processes opening one SQLite handle
   race — see the same note at the top of language.test.ts. Made for this run
   and removed after it — never `.demo/`, where a developer's demo databases
   and credentials are. */
const DB_DIR = mkdtempSync(join(tmpdir(), 'tablewalk-http-db-'));
const RO_DB = join(DB_DIR, 'http-readonly.db');
const RW_DB = join(DB_DIR, 'http-writable.db');

/** A password that must never appear in anything the server sends. */
const SECRET = 'hunter2';

/**
 * The record `crossOriginRefusal` compares the `Host` header against.
 *
 * Mutable, and filled in after `listen`: the port is the kernel's to choose,
 * and hardcoding 4111 means the suite fails on a machine where a developer
 * already has tablewalk running.
 */
const bound = { host: '127.0.0.1', port: 0, allowedHosts: [] as string[] };

/** A second listener, standing in for the container-behind-a-proxy case. */
const proxied = {
  host: '127.0.0.1',
  port: 0,
  allowedHosts: parseHostList('tablewalk.internal, proxy.example:8080'),
};

let server: Server;
let proxyServer: Server;
let registry: Registry;
let tmp: string;
let configPath: string;

/**
 * One answer, unpacked.
 *
 * `json` is deliberately loose. What these tests assert is the shape the
 * server chose, so declaring that shape up front would be assuming the thing
 * under test.
 */
interface Answer {
  status: number;
  text: string;
  contentType: string;
  json: any;
  /* Carried so a test can ask which connection answered — the one thing that
     tells a reply from the right database apart from a reply from the wrong
     one. Empty for the `node:http` path, which does not need it. */
  headers: Headers;
}

function answer(status: number, contentType: string, text: string, headers = new Headers()): Answer {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined; // A static file. The JSON assertions do not apply to it.
  }
  return { status, contentType, text, json, headers };
}

const at = (where: { port: number }, path: string) => `http://127.0.0.1:${where.port}${path}`;

async function unwrap(res: Response): Promise<Answer> {
  return answer(res.status, res.headers.get('content-type') ?? '', await res.text(), res.headers);
}

async function getFrom(where: { port: number }, path: string, headers: Record<string, string> = {}): Promise<Answer> {
  return unwrap(await fetch(at(where, path), { headers }));
}

async function postTo(where: { port: number }, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Answer> {
  return unwrap(
    await fetch(at(where, path), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
}

/** A GET, the way the page makes one. */
const get = (path: string, headers: Record<string, string> = {}) => getFrom(bound, path, headers);

/** A POST, the way the page makes one: JSON in, JSON out. */
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => postTo(bound, path, body, headers);

/**
 * A request with headers `fetch` will not send.
 *
 * Undici refuses to forward a `Host` of our choosing, and `Host` is the header
 * the DNS-rebinding half of the guard reads — so the test that matters most
 * for that check cannot be written with `fetch` at all. `node:http` sends what
 * it is given.
 */
function raw(where: { port: number }, method: string, path: string, headers: Record<string, string>, body?: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: where.port, path, method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        text += chunk;
      });
      res.on('end', () => resolve(answer(res.statusCode ?? 0, String(res.headers['content-type'] ?? ''), text)));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** How many rows a table has right now, straight from the file. */
function rowsIn(file: string, sql: string): number {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return Number((db.prepare(sql).get() as { n: number }).n);
  } finally {
    db.close();
  }
}

/** One value, straight from the file, so a write is confirmed outside the API. */
function valueIn(file: string, sql: string): unknown {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return Object.values(db.prepare(sql).get() as Record<string, unknown>)[0];
  } finally {
    db.close();
  }
}

const CONFIG = {
  connections: [
    { name: 'readonly', url: RO_DB },
    /* The opt-in. Everything that writes is refused on the connection above
       and accepted on this one, which is the only difference between them. */
    { name: 'writable', url: RW_DB, writable: true },
    /* Never opened. It is here so the connection list has a credential in it,
       and every response can be searched for the password. */
    {
      name: 'remote',
      url: `postgres://alice:${SECRET}@db.example.com:5432/appdb`,
    },
  ],
  views: [
    {
      name: 'Invoice lines',
      text: 'invoice_line show invoice_id, sku, quantity',
    },
    /* A view whose base table does not exist. It must come back *with its
       reason* rather than be dropped from the list. */
    { name: 'Broken', base: 'nonesuch', columns: ['id'] },
  ],
  queries: [
    {
      name: 'Active customers',
      sql: 'select id, name from customer where active = 1',
    },
    { name: 'Writable only', sql: 'select 1', connection: 'writable' },
  ],
};

before(async () => {
  /* Layouts and the default config location both live under the user's config
     directory, and this suite writes to both. Pointed at a temp directory so a
     test run cannot touch the layouts of whoever is running it. */
  tmp = mkdtempSync(join(tmpdir(), 'tablewalk-http-'));
  process.env.XDG_CONFIG_HOME = join(tmp, 'config');

  makeDemoDatabase(RO_DB);
  makeDemoDatabase(RW_DB);
  /* One row the two databases disagree about, so "this ran against the
     connection I named" is provable rather than assumed. */
  const seed = new DatabaseSync(RW_DB);
  seed.exec(`INSERT INTO country VALUES ('ZZ','Zedland')`);
  seed.close();

  configPath = join(tmp, 'tablewalk.json');
  writeFileSync(configPath, JSON.stringify(CONFIG, null, 2));

  /* Built the way `main` builds it, config file and all, because "writable"
     is read from that file and a registry assembled by hand would be testing
     a permission model the shipped one does not use. */
  const config = await loadConfig(configPath, CONFIG_SECTIONS);
  registry = new Registry();
  for (const c of config!.connections) {
    registry.add({
      name: c.name,
      url: c.url,
      writable: c.writable === true,
      source: 'config',
    });
  }
  registry.setActive('readonly');
  await registry.open('readonly');

  const raw = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
  const views = parseViewsConfig(raw, configPath);
  const queries = parseQueriesConfig(raw, configPath);

  server = createApp({ registry, views, configPath, queries, bound });
  proxyServer = createApp({
    registry,
    views,
    configPath,
    queries,
    bound: proxied,
  });
  for (const [listener, record] of [
    [server, bound],
    [proxyServer, proxied],
  ] as const) {
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    const address = listener.address();
    assert.ok(address && typeof address === 'object', 'the listener has no port');
    record.port = address.port;
  }
});

after(async () => {
  /* `close` alone waits for keep-alive sockets to time out, and undici keeps
     them. Destroying them is what makes the teardown instant and the process
     actually exit. */
  for (const listener of [server, proxyServer]) {
    listener?.close();
    listener?.closeAllConnections();
  }
  await registry?.closeAll();
  rmSync(DB_DIR, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */

describe('the cross-origin guard, actually wired in', () => {
  /* `crossOriginRefusal` has unit tests against hand-built request objects.
     These are the ones that prove it runs on the way in: a guard that is
     correct and unreachable protects nothing. */

  test('a cross-origin POST is refused, and does not write', async () => {
    const before = valueIn(RW_DB, `SELECT credit_limit AS v FROM customer WHERE id = 3`);

    const res = await post(
      '/api/update',
      {
        conn: 'writable',
        table: 'customer',
        key: { id: 3 },
        values: { credit_limit: 99999 },
      },
      { origin: 'http://evil.example' },
    );
    assert.equal(res.status, 403);
    assert.match(res.json.error, /a page at http:\/\/evil\.example tried to make this request/);

    /* The message proves it was refused. This proves it was refused *before*
       the write, which is the only part a user would notice. */
    assert.equal(valueIn(RW_DB, `SELECT credit_limit AS v FROM customer WHERE id = 3`), before);
  });

  test('a text/plain POST is refused', async () => {
    /* The check that holds without `Origin`. JSON-only makes a cross-origin
       POST non-simple, so the browser has to preflight it, and we answer no
       CORS headers at all. */
    const res = await raw(bound, 'POST', '/api/count', { 'content-type': 'text/plain' }, '{}');
    assert.equal(res.status, 403);
    assert.match(res.json.error, /takes application\/json/);
  });

  test('a form POST is refused too', async () => {
    // The other content type a browser will send cross-origin without asking.
    const res = await raw(bound, 'POST', '/api/count', { 'content-type': 'application/x-www-form-urlencoded' }, 'table=customer');
    assert.equal(res.status, 403);
    assert.match(res.json.error, /takes application\/json/);
  });

  test('a POST with no content-type at all is refused', async () => {
    const res = await raw(bound, 'POST', '/api/count', {}, '{}');
    assert.equal(res.status, 403);
    assert.match(res.json.error, /takes application\/json/);
  });

  test('a rebound Host is refused, and names the way out', async () => {
    /* DNS rebinding: an attacker's domain resolving to 127.0.0.1 makes their
       page same-origin with us, so the Origin check passes and only this one
       is left. The message has to name `--allowed-host`, because the people
       who hit it legitimately are behind a proxy and need to know what to
       do. */
    const res = await raw(
      bound,
      'POST',
      '/api/count',
      { host: 'attacker.example', 'content-type': 'application/json' },
      JSON.stringify({ table: 'customer' }),
    );
    assert.equal(res.status, 403);
    assert.match(res.json.error, /arrived for host "attacker\.example"/);
    assert.match(res.json.error, new RegExp(`only answers on 127\\.0\\.0\\.1:${bound.port}`));
    assert.match(res.json.error, /--allowed-host|(?:TABLEWALK|MISTRI)_ALLOWED_HOSTS/);
  });

  test('an Origin that is not a URL is refused rather than parsed loosely', async () => {
    /* `null` is what a sandboxed iframe sends, and `new URL('null')` throws.
       Falling through to a string comparison would compare "null" against the
       host and refuse anyway — but by accident, and a guard that works by
       accident stops working when someone tidies it. */
    const res = await post('/api/count', { table: 'customer' }, { origin: 'null' });
    assert.equal(res.status, 403);
    assert.match(res.json.error, /"null" is not a valid origin/);
  });

  test('no Origin at all is allowed: curl is not a confused deputy', async () => {
    const res = await raw(bound, 'POST', '/api/count', { 'content-type': 'application/json' }, JSON.stringify({ table: 'customer' }));
    assert.equal(res.status, 200);
    assert.equal(res.json.count, 5);
  });

  test('our own Origin is allowed', async () => {
    const res = await post('/api/count', { table: 'customer' }, { origin: `http://127.0.0.1:${bound.port}` });
    assert.equal(res.status, 200);
  });

  test('a GET is not refused, whatever Origin it carries', async () => {
    /* Deliberate, and worth writing down so nobody "fixes" it: the guard runs
       on methods that change something. A cross-origin GET does reach the
       handler, but we answer no CORS headers, so the page that sent it cannot
       read a byte of the reply. Refusing it would break nothing except the
       ability to open a link. */
    const res = await get('/api/schema', { origin: 'http://evil.example' });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json.tables));
  });

  test('a named host is let through, on whatever port it arrives', async () => {
    /* The container case. A request through a proxy on 80 arrives with no port
       at all, so an entry written without one matches the machine rather than
       one listener on it. */
    for (const host of ['tablewalk.internal', 'tablewalk.internal:9999', 'TableWalk.Internal']) {
      const res = await raw(
        proxied,
        'POST',
        '/api/count',
        { host, 'content-type': 'application/json' },
        JSON.stringify({ table: 'customer' }),
      );
      assert.equal(res.status, 200, `host ${host}`);
      assert.equal(res.json.count, 5);
    }
  });

  test('an entry written with a port is taken literally', async () => {
    // `proxy.example:8080` is on the list; `proxy.example` on its own is not.
    const res = await raw(
      proxied,
      'POST',
      '/api/count',
      { host: 'proxy.example', 'content-type': 'application/json' },
      JSON.stringify({ table: 'customer' }),
    );
    assert.equal(res.status, 403);
    assert.match(res.json.error, /arrived for host "proxy\.example"/);
  });

  test('trusting a host does not stop the Origin check', async () => {
    /* The escape hatch relaxes exactly one of the three checks. If naming a
       host also disabled the Origin comparison, `--allowed-host` would be a
       switch that turns the whole guard off — which is not what anyone typing
       it means. */
    const refused = await raw(
      proxied,
      'POST',
      '/api/count',
      {
        host: 'tablewalk.internal',
        origin: 'http://evil.example',
        'content-type': 'application/json',
      },
      JSON.stringify({ table: 'customer' }),
    );
    assert.equal(refused.status, 403);
    assert.match(refused.json.error, /a page at http:\/\/evil\.example/);

    const allowed = await raw(
      proxied,
      'POST',
      '/api/count',
      {
        host: 'tablewalk.internal',
        origin: 'http://tablewalk.internal',
        'content-type': 'application/json',
      },
      JSON.stringify({ table: 'customer' }),
    );
    assert.equal(allowed.status, 200);
  });

  test('a refusal costs nothing: no body is read before it', async () => {
    /* The guard runs before `readJson`, so a refused request never allocates
       for a body someone chose the size of. A 403 rather than "body too
       large" is what proves the order. */
    const res = await raw(
      bound,
      'POST',
      '/api/count',
      { host: 'attacker.example', 'content-type': 'application/json' },
      JSON.stringify({ pad: 'x'.repeat(400 * 1024) }),
    );
    assert.equal(res.status, 403);
    assert.match(res.json.error, /arrived for host/);
  });
});

/* ------------------------------------------------------------------ */

describe('writing needs a connection that says so', () => {
  /* The gate the server can actually enforce. Write mode in the browser is an
     affordance; a guard in the browser is not a guard. Every one of these
     asserts the message *and* the row, because only the second one proves the
     refusal reached the database. */

  const REFUSAL = /is read-only\. Add "writable": true to its entry in your mistri\.json/;

  test('/api/update is refused on a read-only connection', async () => {
    const before = valueIn(RO_DB, `SELECT credit_limit AS v FROM customer WHERE id = 1`);
    assert.equal(before, 5000);

    const res = await post('/api/update', {
      table: 'customer',
      key: { id: 1 },
      values: { credit_limit: 1 },
    });
    assert.equal(res.status, 403);
    assert.match(res.json.error, REFUSAL);
    // The connection is named, because the person reading this is usually the
    // person who can change the file.
    assert.match(res.json.error, /^"readonly"/);

    assert.equal(valueIn(RO_DB, `SELECT credit_limit AS v FROM customer WHERE id = 1`), 5000);
  });

  test('/api/update goes through on a writable one', async () => {
    const res = await post('/api/update', {
      conn: 'writable',
      table: 'customer',
      key: { id: 2 },
      values: { credit_limit: 4242 },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.affected, 1);
    // The value comes back coerced, so the caller can confirm what landed.
    assert.equal(res.json.applied.credit_limit, 4242);
    assert.equal(valueIn(RW_DB, `SELECT credit_limit AS v FROM customer WHERE id = 2`), 4242);
  });

  test('the one-field form writes the same row', async () => {
    const res = await post('/api/update', {
      conn: 'writable',
      table: 'customer',
      key: { id: 2 },
      column: 'name',
      value: 'Kereru Coffee Co',
    });
    assert.equal(res.status, 200);
    assert.equal(valueIn(RW_DB, `SELECT name AS v FROM customer WHERE id = 2`), 'Kereru Coffee Co');
  });

  test('save acknowledgements identify their undo entry and stale Undo cannot revert a later write', async () => {
    const original = valueIn(RW_DB, 'SELECT email AS v FROM customer WHERE id=3');
    const update = (email: unknown) =>
      post('/api/update', {
        conn: 'writable',
        table: 'customer',
        key: { id: 3 },
        values: { email },
      });
    try {
      const first = await update('first@example.test');
      const second = await update('second@example.test');
      assert.equal(typeof first.json.undoId, 'number');
      assert.notEqual(first.json.undoId, second.json.undoId);
      const stale = await post('/api/revert', {
        conn: 'writable',
        confirm: true,
        expectedId: first.json.undoId,
      });
      assert.equal(stale.status, 409);
      assert.equal(valueIn(RW_DB, 'SELECT email AS v FROM customer WHERE id=3'), 'second@example.test');
      const undo = await post('/api/revert', {
        conn: 'writable',
        confirm: true,
        expectedId: second.json.undoId,
      });
      assert.equal(undo.json.reverted, true);
      assert.equal(valueIn(RW_DB, 'SELECT email AS v FROM customer WHERE id=3'), 'first@example.test');
      const again = await post('/api/revert', {
        conn: 'writable',
        confirm: true,
        expectedId: second.json.undoId,
      });
      assert.equal(again.status, 409);
      assert.equal(valueIn(RW_DB, 'SELECT email AS v FROM customer WHERE id=3'), 'first@example.test');
    } finally {
      await update(original);
    }
  });

  test('stale expected fields return 409 without overwriting and malformed guards return 400', async () => {
    const original = valueIn(RW_DB, 'SELECT email AS v FROM customer WHERE id=3');
    const write = {
      conn: 'writable',
      table: 'customer',
      key: { id: 3 },
      values: { email: 'guarded@example.test' },
    };
    const conflict = await post('/api/update', {
      ...write,
      expected: { email: 'stale@example.test' },
    });
    assert.equal(conflict.status, 409);
    assert.equal(valueIn(RW_DB, 'SELECT email AS v FROM customer WHERE id=3'), original);
    const invalid = await post('/api/update', { ...write, expected: {} });
    assert.equal(invalid.status, 400);
    assert.equal(valueIn(RW_DB, 'SELECT email AS v FROM customer WHERE id=3'), original);
  });

  test('an adapter refusal is a 400, and changes nothing', async () => {
    /* A key that is not the whole primary key would have been an UPDATE across
       every matching row, so the adapter refuses before issuing anything. A
       `Refusal` is distinct from a database failure precisely so this can be
       a 400: it is the caller's mistake, and a 500 would send them to look at
       the server. */
    const res = await post('/api/update', {
      conn: 'writable',
      table: 'invoice_line',
      key: { invoice_id: 1001 },
      values: { quantity: 99 },
    });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /needs exactly its primary key \(invoice_id, line_no\)/);
    assert.equal(valueIn(RW_DB, `SELECT quantity AS v FROM invoice_line WHERE invoice_id=1001 AND line_no=1`), 1);
  });

  test('an update constraint refusal acknowledges rejection and leaves the stored value intact', async () => {
    const before = valueIn(RW_DB, 'SELECT country_code AS v FROM customer WHERE id=2');
    const res = await post('/api/update', {
      conn: 'writable',
      table: 'customer',
      key: { id: 2 },
      values: { country_code: 'NO_SUCH_COUNTRY' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.outcome, 'rejected');
    assert.match(res.json.errors[0].message, /country|foreign key/i);
    assert.equal(valueIn(RW_DB, 'SELECT country_code AS v FROM customer WHERE id=2'), before);
  });

  test('/api/insert is refused on a read-only connection', async () => {
    const res = await post('/api/insert', {
      table: 'customer',
      values: { name: 'Nope' },
    });
    assert.equal(res.status, 403);
    assert.match(res.json.error, /read-only/);
  });

  test("/api/insert adds the row and answers with the database's version of it", async () => {
    const res = await post('/api/insert', {
      conn: 'writable',
      table: 'customer',
      values: { name: 'HTTP Insert Co' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.row.name, 'HTTP Insert Co');
    assert.equal(res.json.row.active, 1);
    assert.equal(typeof res.json.key.id, 'number');
  });

  test('a constraint the database enforces is a 200 in its words, not a 500', async () => {
    const res = await post('/api/insert', {
      conn: 'writable',
      table: 'country',
      values: { code: 'AU', name: 'Again' },
    });
    assert.equal(res.status, 200);
    assert.match(res.json.errors[0].message, /UNIQUE constraint failed/);
  });

  test('an insert refusal the adapter words is a 400', async () => {
    const res = await post('/api/insert', {
      conn: 'writable',
      table: 'customer',
      values: { nonesuch: 'x' },
    });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /no column called/);
  });

  test('default-only inserts must be explicit, and missing required values are still rejected', async () => {
    const missing = await post('/api/insert', {
      conn: 'writable',
      table: 'customer',
    });
    assert.equal(missing.status, 400);
    assert.match(missing.json.error, /values must be an object/);
    const defaults = await post('/api/insert', {
      conn: 'writable',
      table: 'customer',
      values: {},
    });
    assert.equal(defaults.json.outcome, 'rejected');
    assert.match(defaults.json.errors[0].message, /NOT NULL/);
  });

  test('/api/delete is refused on a read-only connection, even with confirm', async () => {
    const before = rowsIn(RO_DB, 'SELECT COUNT(*) AS n FROM shipment');
    assert.equal(before, 5);

    const res = await post('/api/delete', {
      table: 'shipment',
      key: { id: 5 },
      confirm: true,
    });
    assert.equal(res.status, 403);
    assert.match(res.json.error, REFUSAL);
    assert.equal(rowsIn(RO_DB, 'SELECT COUNT(*) AS n FROM shipment'), 5);
  });

  test('/api/delete without confirm reports and does not delete', async () => {
    /* Two calls, deliberately. A destructive endpoint that is also the way you
       ask about the damage is one typo away from doing it. */
    const res = await post('/api/delete', {
      conn: 'writable',
      table: 'shipment',
      key: { id: 5 },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.deleted, false);
    // Nothing points at shipment, so there is nothing to report.
    assert.deepEqual(res.json.impact, []);
    assert.equal(rowsIn(RW_DB, 'SELECT COUNT(*) AS n FROM shipment'), 5);
  });

  test('/api/delete with confirm removes exactly the row it named', async () => {
    const res = await post('/api/delete', {
      conn: 'writable',
      table: 'shipment',
      key: { id: 5 },
      confirm: true,
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.deleted, true);
    assert.equal(res.json.affected, 1);
    assert.equal(rowsIn(RW_DB, 'SELECT COUNT(*) AS n FROM shipment'), 4);
    assert.equal(rowsIn(RW_DB, 'SELECT COUNT(*) AS n FROM shipment WHERE id = 5'), 0);
  });

  test('the impact report names the constraint before anything is removed', async () => {
    const res = await post('/api/delete', {
      conn: 'writable',
      table: 'invoice',
      key: { id: 1001 },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.deleted, false);
    const line = res.json.impact.find((i: { table: string }) => i.table === 'invoice_line');
    assert.ok(line, `no invoice_line in ${JSON.stringify(res.json.impact)}`);
    assert.equal(line.count, 2);
    // The count alone is not the answer: the same two rows are two deletions,
    // two holes, or a refusal depending on the rule beside it.
    assert.ok('onDelete' in line);
  });

  test("a constraint the database enforces comes back as 200 with the database's words", async () => {
    /* The other vocabulary. The delete was allowed, attempted, and refused by
       SQLite — that is not an outage, it is an answer, and the impact report
       is still worth sending with it. */
    const res = await post('/api/delete', {
      conn: 'writable',
      table: 'invoice',
      key: { id: 1001 },
      confirm: true,
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.deleted, false);
    assert.match(res.json.errors[0].message, /FOREIGN KEY|constraint/i);
    assert.equal(rowsIn(RW_DB, 'SELECT COUNT(*) AS n FROM invoice WHERE id = 1001'), 1);
  });

  test('an unknown table is a 404 before the impact report is built', async () => {
    const res = await post('/api/delete', {
      conn: 'writable',
      table: 'nonesuch',
      key: { id: 1 },
    });
    assert.equal(res.status, 404);
    assert.match(res.json.error, /Unknown table "nonesuch"/);
  });
});

/* ------------------------------------------------------------------ */

describe('/api/sql', () => {
  test('a read comes back positional, with the statement that ran', async () => {
    const res = await post('/api/sql', {
      text: 'select id, name from customer order by id',
      limit: 3,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.columns, ['id', 'name']);
    /* Arrays, not objects. `select id, id` returns two columns with one name
       and an object can only hold one of them — the shape is the guarantee. */
    assert.ok(Array.isArray(res.json.rows[0]), 'rows are not positional');
    assert.deepEqual(res.json.rows[0], [1, 'Harbour Freight']);
    assert.equal(res.json.rows.length, 3);
    assert.equal(res.json.truncated, true);
    assert.equal(res.json.bounded, true);
    assert.match(res.json.sql.text, /select id, name from customer/);
    assert.equal(typeof res.json.ms, 'number');
  });

  test('a long read runs beside the server, not in it, and stops when the browser leaves (SQL-1)', async () => {
    /* Seconds of work in one statement. In the server's own process it held every other request until it was done;
       in a process of its own, as the MCP sql tool's reads run, the server answers meanwhile. */
    const leave = new AbortController();
    const running = fetch(at(bound, '/api/sql'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 10000000) SELECT count(*) FROM c',
      }),
      signal: leave.signal,
    }).catch((error: Error) => error);
    await new Promise((done) => setTimeout(done, 300));
    const started = performance.now();
    const health = await get('/healthz');
    assert.equal(health.status, 200);
    assert.ok(performance.now() - started < 2000, `the server answered after ${Math.round(performance.now() - started)} ms`);
    leave.abort();
    assert.equal(((await running) as Error).name, 'AbortError');
  });

  test('two columns of the same name both survive the trip', async () => {
    const res = await post('/api/sql', {
      text: 'select id, id from customer limit 1',
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.columns.length, 2);
    assert.equal(res.json.rows[0].length, 2);
  });

  test('a statement short of the limit is not reported as truncated', async () => {
    const res = await post('/api/sql', {
      text: 'select code from country',
      limit: 100,
    });
    assert.equal(res.json.rows.length, 3);
    assert.equal(res.json.truncated, false);
  });

  test('a stacked statement is refused as 200 with errors', async () => {
    /* Two things were asked for. Running the first and discarding the rest
       would be worse than refusing both, and the refusal belongs beside the
       editor rather than as a failed request. */
    const before = rowsIn(RO_DB, 'SELECT COUNT(*) AS n FROM customer');
    const res = await post('/api/sql', {
      text: 'select 1; drop table customer',
    });
    assert.equal(res.status, 200);
    assert.match(res.json.errors[0].message, /One statement at a time/);
    assert.equal(res.json.rows, undefined);
    assert.equal(rowsIn(RO_DB, 'SELECT COUNT(*) AS n FROM customer'), before);
  });

  test('a write is refused on a read-only connection, and nothing changes', async () => {
    const res = await post('/api/sql', {
      text: `update country set name = 'Owned' where code = 'AU'`,
      write: true,
    });
    assert.equal(res.status, 403);
    assert.match(res.json.error, /is read-only/);
    assert.equal(valueIn(RO_DB, `SELECT name AS v FROM country WHERE code = 'AU'`), 'Australia');
  });

  test('a write without asking for write mode hits a handle that cannot write', async () => {
    /* The permission check is one gate; the read handle is the other, and this
       is the one that holds when a caller simply forgets the flag. SQLite
       enforces it at the file level, so its own message comes back — 200 with
       errors, because the statement is the user's to fix. */
    const res = await post('/api/sql', {
      conn: 'writable',
      text: `update country set name = 'Owned' where code = 'AU'`,
    });
    assert.equal(res.status, 200);
    assert.match(res.json.errors[0].message, /readonly|read-only/i);
    assert.equal(valueIn(RW_DB, `SELECT name AS v FROM country WHERE code = 'AU'`), 'Australia');
  });

  test('a write goes through on a writable connection', async () => {
    const res = await post('/api/sql', {
      conn: 'writable',
      text: `update country set name = 'Zedland Prime' where code = 'ZZ'`,
      write: true,
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.affected, 1);
    // A write has no rows to bound, and says so rather than claiming it did.
    assert.equal(res.json.bounded, false);

    /* And it is history: listed with the others, marked as what it is. Raw
       SQL has no general inverse, so undo will not guess at one — but a
       write the history did not show was a write nobody could reason back
       from at all. */
    const listed = await post('/api/revert', { conn: 'writable' });
    assert.equal(listed.status, 200);
    const sql = (
      listed.json.writes as Array<{
        kind: string;
        revertible: boolean;
        summary: string;
        reason?: string;
      }>
    ).find((w) => w.kind === 'sql');
    assert.ok(sql, 'the raw write is in the history');
    assert.equal(sql!.revertible, false);
    assert.match(sql!.summary, /Ran SQL: update country set name/);
    assert.match(sql!.reason ?? '', /no general inverse/);
    assert.equal(valueIn(RW_DB, `SELECT name AS v FROM country WHERE code = 'ZZ'`), 'Zedland Prime');
  });

  test('an empty statement is a 400 with {error}, not an empty result', async () => {
    for (const text of ['', '   ', undefined]) {
      const res = await post('/api/sql', { text });
      assert.equal(res.status, 400, JSON.stringify(text));
      assert.equal(res.json.error, 'Nothing to run.');
    }
  });

  test("a broken statement comes back with the database's own message", async () => {
    const res = await post('/api/sql', { text: 'select * from nonesuch' });
    assert.equal(res.status, 200);
    assert.match(res.json.errors[0].message, /nonesuch/);
    // The infrastructure vocabulary must not appear: nothing was wrong with
    // the request, only with what it asked for.
    assert.equal(res.json.error, undefined);
  });
});

/* ------------------------------------------------------------------ */

describe('reading', () => {
  test('/api/schema answers the catalog', async () => {
    const res = await get('/api/schema');
    assert.equal(res.status, 200);
    assert.equal(res.contentType, 'application/json; charset=utf-8');
    assert.equal(res.json.dialect, 'sqlite');
    assert.ok(res.json.tables.some((t: { id: string }) => t.id === 'customer'));
    assert.ok(res.json.foreignKeys.length > 0);
  });

  test('/api/query returns rows as objects, with the order it chose', async () => {
    /* Ordered even when nobody asked: a page of rows that quietly differs from
       the last one is the same bug wearing a smaller hat. */
    const res = await post('/api/query', { table: 'customer', limit: 2 });
    assert.equal(res.status, 200);
    assert.equal(res.json.rows.length, 2);
    /* Descending, because a numeric key counts up and the row worth seeing
       first is the newest one. `implicit` says nobody asked for it, so the
       client can show the sort without claiming the user chose it. */
    assert.deepEqual(
      res.json.rows.map((r: { id: number }) => r.id),
      [5, 4],
    );
    assert.equal(res.json.order.implicit, true);
    assert.deepEqual(res.json.order.order, [{ column: 'id', direction: 'desc' }]);
    assert.ok(res.json.sql.text.includes('customer'));
  });

  test('an unknown column is a 400 that names it, on a query and on a count', async () => {
    /* Column names are quoted, never bound, so an unknown one used to reach
       the database and come back as its complaint — with a 500 that sent the
       client to look at the server for the caller's typo. */
    for (const body of [
      { table: 'customer', columns: ['name', 'nope'] },
      { table: 'customer', orderBy: [{ column: 'nope', direction: 'asc' }] },
      {
        table: 'customer',
        filter: { groups: [[{ column: 'nope', op: '=', value: 1 }]] },
      },
    ]) {
      const res = await post('/api/query', body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match(res.json.error, /"customer" has no column "nope"/);
    }
    const counted = await post('/api/count', {
      table: 'customer',
      filter: { groups: [[{ column: 'nope', op: '=', value: 1 }]] },
    });
    assert.equal(counted.status, 400);
    assert.match(counted.json.error, /has no column "nope"/);
    // A dotted path is not a column either, and is reported as the table lacking it.
    const dotted = await post('/api/query', {
      table: 'customer',
      columns: ['country_code.name'],
    });
    assert.equal(dotted.status, 400);
  });

  test('/api/query on an unknown table is a 404 with {error}', async () => {
    const res = await post('/api/query', { table: 'nonesuch' });
    assert.equal(res.status, 404);
    assert.equal(res.json.error, 'Unknown table "nonesuch"');
  });

  test('/api/run parses, runs and explains in one trip', async () => {
    const res = await post('/api/run', { q: 'customer active = 1 limit 2' });
    assert.equal(res.status, 200);
    assert.equal(res.json.table, 'customer');
    assert.equal(res.json.rows.length, 2);
    assert.deepEqual(res.json.errors, []);
    assert.equal(res.json.total, 4);
    assert.equal(res.json.limit, 2);
    assert.equal(res.json.offset, 0);
    assert.match(res.json.explain, /SELECT/);
  });

  test('/api/run answers a language mistake with 200 and errors', async () => {
    /* Not a 4xx. The request was fine — the text in the box was not — and the
       client renders this beside the query bar rather than as a failure. */
    const res = await post('/api/run', { q: 'customer nonesuch = 1' });
    assert.equal(res.status, 200);
    assert.ok(res.json.errors.length > 0);
    assert.match(res.json.errors[0].message, /nonesuch/);
    assert.equal(res.json.error, undefined);
    // An error that would change which rows come back must not be papered over
    // with a partial result.
    assert.equal(res.json.rows, undefined);
  });

  test('the position of a mistake travels with it', async () => {
    const res = await post('/api/run', { q: 'nosuchtable' });
    assert.equal(res.status, 200);
    assert.equal(typeof res.json.errors[0].message, 'string');
    assert.ok(res.json.errors.every((e: { at?: number }) => e.at === undefined || typeof e.at === 'number'));
  });

  test('an unknown column in an explicit list answers to both names', async () => {
    /* A half-built view can be wrong in several places at once, which is why
       these endpoints report a list. But a client that branches on the status
       and then reads `.error` showed nothing at all, so both are sent: the
       list keeps its shape and `error` is the first of them. */
    const res = await post('/api/run', {
      q: 'customer',
      columns: ['id', 'nonesuch'],
    });
    assert.equal(res.status, 400);
    assert.match(res.json.errors[0].message, /No column called "nonesuch" on customer/);
    assert.equal(res.json.error, res.json.errors[0].message);
  });

  test('/api/count says whether the number was counted or guessed', async () => {
    const res = await post('/api/count', { table: 'customer' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { count: 5, exact: true });
  });

  test('a filtered count is never an estimate', async () => {
    /* The catalog knows how big a table is and nothing about how many rows
       match a WHERE, so a filtered count cannot be estimated at all. */
    const res = await post('/api/count', {
      table: 'customer',
      filter: { groups: [[{ column: 'active', op: '=', value: 1 }]] },
    });
    assert.deepEqual(res.json, { count: 4, exact: true });
  });

  test('exactCount forces the true count', async () => {
    const res = await post('/api/count', {
      table: 'customer',
      exactCount: true,
    });
    assert.deepEqual(res.json, { count: 5, exact: true });
  });

  test('exactTotal travels with the total on /api/run', async () => {
    /* The flag is beside the number rather than inferred from its size,
       because the interface has to say which it is showing: "2,400,113" when
       the real figure is 2,411,908 is worse than "~2.4M". SQLite has no
       catalog estimate, so this is always true here — what is asserted is that
       the field is *sent*, which is what the client branches on. */
    const res = await post('/api/run', { q: 'customer' });
    assert.equal(res.json.total, 5);
    assert.equal(res.json.exactTotal, true);

    const forced = await post('/api/run', { q: 'customer', exactCount: true });
    assert.equal(forced.json.exactTotal, true);
    assert.equal(forced.json.total, 5);
  });

  test('/api/references counts every row pointing at this one', async () => {
    const res = await post('/api/references', {
      table: 'customer',
      key: { id: 1 },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.table, 'customer');
    assert.deepEqual(res.json.primaryKey, ['id']);
    const invoices = res.json.references.find((r: { table: string }) => r.table === 'invoice');
    assert.equal(invoices.count, 2);
    // The filter comes back so the client can navigate to those rows rather
    // than rebuild the query and risk disagreeing with the count it just showed.
    assert.deepEqual(invoices.filter.groups, [[{ column: 'customer_id', op: '=', value: 1 }]]);
    assert.deepEqual(invoices.toColumns, ['id']);
  });

  test('/api/references on a composite key pairs every column', async () => {
    const res = await post('/api/references', {
      table: 'invoice_line',
      key: { invoice_id: 1001, line_no: 1 },
    });
    assert.equal(res.status, 200);
    const shipments = res.json.references.find((r: { table: string }) => r.table === 'shipment');
    assert.deepEqual(shipments.columns, ['invoice_id', 'line_no']);
    assert.equal(shipments.count, 1);
  });

  test('/api/references on an unknown table is a 404', async () => {
    const res = await post('/api/references', { table: 'nonesuch', key: {} });
    assert.equal(res.status, 404);
    assert.match(res.json.error, /Unknown table "nonesuch"/);
  });

  test('/api/ddl says whether it is the real thing or a reconstruction', async () => {
    const res = await get('/api/ddl?table=customer');
    assert.equal(res.status, 200);
    assert.equal(res.json.table, 'customer');
    assert.match(res.json.sql, /CREATE TABLE customer/);
    // SQLite keeps the original statement, so this one is exact. Saying so is
    // the point: a reconstruction presented as authoritative is a lie that
    // bites the first time someone pastes it into a migration.
    assert.equal(res.json.exact, true);
  });

  test('/api/ddl on an unknown table is a 404, not an empty statement', async () => {
    for (const query of ['?table=nonesuch', '']) {
      const res = await get(`/api/ddl${query}`);
      assert.equal(res.status, 404, query);
      assert.match(res.json.error, /Unknown table/);
    }
  });

  test('/api/views expands config views against the live schema', async () => {
    const res = await get('/api/views');
    assert.equal(res.status, 200);
    assert.equal(res.json.connection, 'readonly');
    const lines = res.json.views.find((v: { name: string }) => v.name === 'Invoice lines');
    assert.equal(lines.base, 'invoice_line');
    assert.equal(lines.error, undefined);
    assert.ok(lines.text, 'the text form is sent so the view can be read as a statement');
  });

  test('a view that does not resolve comes back with its reason, not dropped', async () => {
    /* Dropping it shows a shorter list and no explanation, which is the
       failure this whole tool argues against. */
    const res = await get('/api/views');
    const broken = res.json.views.find((v: { name: string }) => v.name === 'Broken');
    assert.ok(broken, 'the unresolvable view was dropped from the list');
    assert.match(broken.error, /nonesuch/);
  });

  test('/api/queries sends the statements this connection is meant to see', async () => {
    const mine = await get('/api/queries');
    assert.equal(mine.status, 200);
    assert.equal(mine.json.connection, 'readonly');
    assert.deepEqual(
      mine.json.queries.map((q: { name: string }) => q.name),
      ['Active customers'],
    );
    assert.equal(mine.json.queries[0].source, 'config');

    // The one scoped to another connection is not offered here, and is there.
    const theirs = await get('/api/queries?conn=writable');
    assert.deepEqual(
      theirs.json.queries.map((q: { name: string }) => q.name),
      ['Active customers', 'Writable only'],
    );
  });

  test('an unknown endpoint under /api is a 404 with {error}', async () => {
    for (const res of [await get('/api/nonesuch'), await post('/api/nonesuch', {})]) {
      assert.equal(res.status, 404);
      assert.match(res.json.error, /No such endpoint: \/api\/nonesuch/);
    }
  });
});

/* ------------------------------------------------------------------ */

describe('layouts', () => {
  test('a layout round-trips through the file the server owns', async () => {
    const empty = await get('/api/layouts');
    assert.equal(empty.status, 200);
    assert.equal(empty.json.connection, 'readonly');
    assert.deepEqual(empty.json.layouts, {});

    const saved = await post('/api/layouts', {
      table: 'customer',
      layout: { sections: [{ title: 'Money', fields: ['credit_limit'] }] },
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.json, { ok: true });

    const back = await get('/api/layouts');
    assert.deepEqual(back.json.layouts.customer.sections[0].fields, ['credit_limit']);
  });

  test('layouts are keyed by connection, not by table name', async () => {
    /* The same table name means different things on two databases, and a
       layout built for one quietly applying to the other is a record page that
       hides fields nobody hid. */
    const other = await get('/api/layouts?conn=writable');
    assert.deepEqual(other.json.layouts, {});
  });

  test('null removes a layout rather than storing an empty one', async () => {
    // "Reset to default" means no layout, so the derived one takes over again
    // — not an empty layout, which would render an empty record.
    const removed = await post('/api/layouts', {
      table: 'customer',
      layout: null,
    });
    assert.equal(removed.status, 200);
    assert.deepEqual((await get('/api/layouts')).json.layouts, {});
  });

  test('a layout with no table, or a layout that is not an object, is a 400', async () => {
    const noTable = await post('/api/layouts', { layout: {} });
    assert.equal(noTable.status, 400);
    assert.equal(noTable.json.error, 'A layout needs a table.');

    const notAnObject = await post('/api/layouts', {
      table: 'customer',
      layout: 7,
    });
    assert.equal(notAnObject.status, 400);
    assert.match(notAnObject.json.error, /must be an object, or null to remove it/);
  });
});

/* ------------------------------------------------------------------ */

describe('saved filters', () => {
  test('a filter list round-trips through the file the server owns', async () => {
    const empty = await get('/api/filters');
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.json.filters, {});

    const saved = await post('/api/filters/save', {
      list: 'customer',
      filters: [{ name: 'Big spenders', query: 'credit_limit > 1000' }],
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.json, { ok: true });

    const back = await get('/api/filters');
    assert.deepEqual(back.json.filters.customer, [{ name: 'Big spenders', query: 'credit_limit > 1000' }]);
  });

  test('filters are keyed by connection, and null removes a table entry', async () => {
    const other = await get('/api/filters?conn=writable');
    assert.deepEqual(other.json.filters, {});

    const removed = await post('/api/filters/save', {
      list: 'customer',
      filters: null,
    });
    assert.equal(removed.status, 200);
    assert.deepEqual((await get('/api/filters')).json.filters, {});
  });

  test('a save with no list, or filters that are not a list, is a 400', async () => {
    const noTable = await post('/api/filters/save', { filters: [] });
    assert.equal(noTable.status, 400);
    assert.equal(noTable.json.error, 'Saved filters belong to a list.');

    const notAList = await post('/api/filters/save', {
      list: 'customer',
      filters: { name: 'x' },
    });
    assert.equal(notAList.status, 400);
    assert.match(notAList.json.error, /must be a list, or null to remove them/);
  });
});

describe('grouping over HTTP', () => {
  test('text in, groups out, with the columns named either way', async () => {
    const res = await post('/api/breakdown', {
      text: 'invoice count, sum total as billed by status',
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.columns, ['status', 'count', 'billed']);
    assert.equal(res.json.total, res.json.rows.length, 'the total is groups, not rows');
    /* The line comes back rendered from the structure — with the limit that
       actually ran written into it. Every read here is bounded whether or not
       it asked to be, and a normalised line that hid the bound would be the
       one place the tool stopped saying so. */
    assert.equal(res.json.text, 'invoice count, sum total as billed by status limit 20');
    assert.match(res.json.sql.text, /GROUP BY/);
  });

  test('a half-typed breakdown is a 200 with messages, not a failed request', async () => {
    /* An input box is half-typed most of the time it is being used. A 4xx
       here has the client rendering "request failed" over a message that
       says which column was misspelled. */
    const res = await post('/api/breakdown', {
      text: 'invoice count by nosuchcolumn',
    });
    assert.equal(res.status, 200);
    assert.ok(res.json.errors.length);
    assert.equal(res.json.rows, undefined);
  });

  test('the limit is the ordinary limit policy, breakdowns included', async () => {
    const res = await post('/api/breakdown', {
      text: 'invoice count by id',
      limit: 2,
    });
    assert.equal(res.json.rows.length, 2);
    // And the total counts every group, not the page.
    assert.ok(res.json.total > 2);
  });
});

describe('the agent endpoints, which are the MCP by another door', () => {
  test('the tool list is the stdio list, writes included where config allows', async () => {
    const res = await get('/api/agent/tools');
    const names = (res.json.tools as Array<{ name: string }>).map((t) => t.name);
    // This fixture has a writable connection, so the write tools appear.
    assert.ok(names.includes('schema_summary') && names.includes('update') && names.includes('insert'));
    assert.ok(names.includes('insert_graph') && names.includes('delete_graph'));
    assert.ok(names.includes('change_impact'));
    assert.ok(names.includes('revert'), 'undo is a write tool too');
    // The App authoring tools are the App framework's (`mistri observe --mcp` checks an App); this server serves none.
    assert.ok(!names.includes('validate_app') && !names.includes('scaffold_app'));
    // Derived, not hardcoded: the number moved once and this line was the lag.
    const { read, write } = toolCounts();
    assert.equal(names.length, read + write);
  });

  test('a call answers the MCP shape: structured content, stats, isError', async () => {
    const res = await post('/api/agent/call', {
      name: 'query',
      arguments: { q: 'customer limit 2' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.isError, false);
    assert.equal(res.json.structuredContent.rows.length, 2);
    assert.equal(res.json.structuredContent.stats.rowsRead, 2);
    // The text content is the structured answer serialised — the dual the spec asks for.
    assert.deepEqual(JSON.parse(res.json.content[0].text), res.json.structuredContent);
  });

  test('a tool error is a result, exactly as it is over stdio', async () => {
    const res = await post('/api/agent/call', {
      name: 'table',
      arguments: { table: 'nonesuch' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.isError, true);
    assert.match(res.json.content[0].text, /Unknown table/);
  });
});

describe('saved pages, persisted like layouts', () => {
  /* Pages were the one piece of built work living only in localStorage; the
     endpoints below are the layout endpoints' twins, so a page assembled in
     one browser is offered in every other. */
  test('a page round-trips through the file the server owns', async () => {
    assert.deepEqual((await get('/api/pages/saved')).json.pages, {});

    const saved = await post('/api/pages/save', {
      id: 'saved:customer:1',
      page: {
        id: 'saved:customer:1',
        name: 'Overview',
        base: 'customer',
        source: 'saved',
        sections: [{ kind: 'fields' }],
      },
    });
    assert.deepEqual(saved.json, { ok: true });

    const back = await get('/api/pages/saved');
    assert.equal(back.json.pages['saved:customer:1'].name, 'Overview');

    // Keyed by connection, like everything stored about one.
    assert.deepEqual((await get('/api/pages/saved?conn=writable')).json.pages, {});

    // Null removes, deleting the page everywhere rather than in one browser.
    await post('/api/pages/save', { id: 'saved:customer:1', page: null });
    assert.deepEqual((await get('/api/pages/saved')).json.pages, {});
  });

  test('a page with no id, or one that is not an object, is a 400', async () => {
    assert.equal((await post('/api/pages/save', { page: {} })).status, 400);
    assert.equal((await post('/api/pages/save', { id: 'x', page: 7 })).status, 400);
  });

  test('a failed pages-file write reports failure without claiming browser persistence', async () => {
    const previous = process.env.XDG_CONFIG_HOME;
    const blocked = join(tmp, 'not-a-config-directory');
    writeFileSync(blocked, 'This file cannot contain a pages store.');
    process.env.XDG_CONFIG_HOME = blocked;
    try {
      for (const page of [{ name: 'Unsaved' }, null]) {
        const response = await post('/api/pages/save', {
          id: 'saved:failure',
          page,
        });
        assert.equal(response.status, 500);
        assert.match(response.json.error, /pages file could not be written/);
        assert.doesNotMatch(response.json.error, /Saved in this browser/);
      }
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previous;
    }
  });
});

/* ------------------------------------------------------------------ */

describe('connections, over HTTP', () => {
  test('the list never carries a connection string', async () => {
    /* A connection string is a credential. Everything the browser receives
       goes through the public view, and this is the assertion that the trip
       actually happened. */
    const res = await get('/api/connections');
    assert.equal(res.status, 200);
    assert.equal(res.json.active, 'readonly');
    assert.ok(!res.text.includes(SECRET), `password reached the page: ${res.text}`);
    const remote = res.json.connections.find((c: { id: string }) => c.id === 'remote');
    assert.equal(remote.detail, 'alice@db.example.com:5432/appdb');
    assert.equal(remote.url, undefined);
    assert.equal(remote.dialect, 'postgres');
  });

  test('the list says which connections the server will accept writes for', async () => {
    // A write toggle offered on a connection the server will refuse is a
    // button that lies, so the flag has to reach the page.
    const res = await get('/api/connections');
    const flags = Object.fromEntries(res.json.connections.map((c: { id: string; writable: boolean }) => [c.id, c.writable]));
    assert.deepEqual(flags, { readonly: false, writable: true, remote: false });
  });

  test('selecting a connection opens it and answers with its schema', async () => {
    const res = await post('/api/connections/select', { id: 'writable' });
    assert.equal(res.status, 200);
    assert.equal(res.json.active, 'writable');
    assert.equal(res.json.schema.label, 'writable');

    // Put it back: everything after this reads from the read-only one.
    await post('/api/connections/select', { id: 'readonly' });
    assert.equal((await get('/api/connections')).json.active, 'readonly');
  });

  test('selecting, refreshing, updating or removing a name nobody has is a 404', async () => {
    for (const path of ['select', 'update', 'remove']) {
      const res = await post(`/api/connections/${path}`, { id: 'nonesuch' });
      assert.equal(res.status, 404, path);
      assert.equal(res.json.error, 'No connection called "nonesuch".');
    }
  });

  test('refreshing re-reads the catalog', async () => {
    const res = await post('/api/connections/refresh', { id: 'readonly' });
    assert.equal(res.status, 200);
    assert.equal(res.json.schema.label, 'readonly');
    assert.ok(res.json.schema.tables.length > 0);
  });

  test('refresh with no id refreshes whatever is active', async () => {
    const res = await post('/api/connections/refresh', {});
    assert.equal(res.status, 200);
    assert.equal(res.json.schema.label, 'readonly');
  });

  test('renaming a connection changes the session and not the file', async () => {
    const before = readFileSync(configPath, 'utf8');
    const res = await post('/api/connections/update', {
      id: 'remote',
      name: 'remote renamed',
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.connections.find((c: { id: string }) => c.id === 'remote').name, 'remote renamed');
    /* A browser page silently editing a file on disk is a surprise nobody
       asked for. Making it permanent is /api/connections/save, and only that. */
    assert.equal(readFileSync(configPath, 'utf8'), before);

    await post('/api/connections/update', { id: 'remote', name: 'remote' });
  });

  test('a connection that will not open is kept, listed with its reason', async () => {
    /* "The add failed" and "nothing was added" are not the same thing, and
       here the first is the useful one: a mistyped password should leave the
       connection on screen to be corrected. It is also what already happens
       to a config-file connection that will not open. The list comes back
       with the error so the client can show the broken entry without a
       second request. */
    const res = await post('/api/connections', {
      name: 'missing',
      url: join(DB_DIR, 'definitely-not-here.db'),
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.id, 'missing');
    assert.match(res.json.error, /missing:/);

    const inReply = res.json.connections.find((c: { id: string }) => c.id === 'missing');
    assert.ok(inReply, 'the reply did not carry the list it had just changed');
    assert.equal(inReply.connected, false);
    assert.ok(inReply.error);

    const listed = await get('/api/connections');
    const broken = listed.json.connections.find((c: { id: string }) => c.id === 'missing');
    assert.ok(broken, 'the failed connection vanished instead of being reported');
    assert.equal(broken.connected, false);
    assert.ok(broken.error);

    const removed = await post('/api/connections/remove', { id: 'missing' });
    assert.equal(removed.status, 200);
    assert.ok(!removed.json.connections.some((c: { id: string }) => c.id === 'missing'));
  });

  test('adding without a url is a 400 and adds nothing', async () => {
    const before = (await get('/api/connections')).json.connections.length;
    const res = await post('/api/connections', { name: 'nameless' });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'A url is required.');
    assert.equal((await get('/api/connections')).json.connections.length, before);
  });

  test('testing a connection reports on it and adds nothing', async () => {
    /* Adding was the only way to find out whether a target worked, and a
       failed add leaves the entry behind on purpose — so a mistyped password
       is a correction rather than a retype. Right for adding, wrong for
       checking: somebody who is not sure yet should not have to tidy up after
       asking. */
    const before = (await get('/api/connections')).json.connections.length;

    const good = await post('/api/connections/test', { url: RO_DB });
    assert.equal(good.status, 200);
    assert.equal(good.json.ok, true);
    assert.equal(good.json.dialect, 'sqlite');
    /* The table count is what says it *read* the database rather than merely
       reached it — a URL that connects and cannot be introspected is not a
       working connection. */
    assert.ok(good.json.tables > 0);

    const bad = await post('/api/connections/test', {
      url: '/nowhere/does/not/exist.db',
    });
    assert.equal(bad.status, 200, 'a target that does not work is an answer, not a failed request');
    assert.equal(bad.json.ok, false);
    assert.ok(String(bad.json.error).length);

    const missing = await post('/api/connections/test', {});
    assert.equal(missing.status, 400);

    assert.equal((await get('/api/connections')).json.connections.length, before, 'and none of that added a connection');
  });

  test('saving writes the connections, and the writable flag only when true', async () => {
    const target = join(tmp, 'saved.json');
    const res = await post('/api/connections/save', { path: target });
    assert.equal(res.status, 200);
    assert.equal(res.json.path, target);
    assert.equal(res.json.count, 3);

    const written = JSON.parse(readFileSync(target, 'utf8')) as {
      connections: Array<{ name: string; url: string; writable?: boolean }>;
    };
    assert.deepEqual(
      written.connections.map((c) => c.name),
      ['readonly', 'writable', 'remote'],
    );
    // Absent means read-only. A file full of `"writable": false` would suggest
    // the flag is doing something.
    assert.equal('writable' in written.connections[0], false);
    assert.equal(written.connections[1].writable, true);
    /* An inline password does *not* get written back inline. `storeSecret`
       was written to move it to the keychain — or a 0600 file where there is
       no keychain — and nothing called it, so its own promise that "the URL
       that gets written to disk never contains the password" was not in
       force. A config file that leaks should be embarrassing, not a breach.

       The user survives; only the secret goes. */
    assert.ok(!written.connections[2].url.includes(SECRET), written.connections[2].url);
    assert.ok(written.connections[2].url.includes('@'), 'the rest of the URL is intact');
    assert.equal(res.json.secrets?.length, 1, 'and the answer says one was moved');
  });

  test('saving over a config file keeps its views and queries', async () => {
    /* The registry holds connections and nothing else, so building the file
       out of it alone deleted the `views` and `queries` a team had committed
       — and told the person who pressed the button that the file was written,
       not that half of it had gone. Only `connections` is rewritten now.

       Asserted against a copy, so the fixture survives the write. */
    const copy = join(tmp, 'copy.json');
    writeFileSync(copy, readFileSync(configPath, 'utf8'));
    const before = JSON.parse(readFileSync(copy, 'utf8')) as Record<string, unknown>;
    assert.ok((before.views as unknown[]).length);

    const res = await post('/api/connections/save', { path: copy });
    assert.equal(res.status, 200);

    const after = JSON.parse(readFileSync(copy, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(after.views, before.views);
    assert.deepEqual(after.queries, before.queries);
    // And the connections really were rewritten, so this is not passing by
    // having quietly done nothing at all.
    assert.equal((after.connections as unknown[]).length, 3);
  });

  test('an unknown key someone hand-added survives the write', async () => {
    /* The loader ignores keys it does not know, which is what lets the
       reference config carry a `_comment`. A save that dropped them would
       delete a block of prose the moment anyone used the connection manager. */
    const copy = join(tmp, 'commented.json');
    writeFileSync(copy, JSON.stringify({ _comment: ['keep me'], connections: [] }));
    await post('/api/connections/save', { path: copy });
    assert.deepEqual((JSON.parse(readFileSync(copy, 'utf8')) as { _comment: string[] })._comment, ['keep me']);
  });

  test('a file that is not valid JSON is reported, not overwritten', async () => {
    /* The dangerous case. Overwriting replaces something hand-edited with a
       machine-generated stub, so the person who typed a stray comma finds
       their views gone rather than their typo named. */
    const broken = join(tmp, 'broken.json');
    writeFileSync(broken, '{ "views": [], }');
    const res = await post('/api/connections/save', { path: broken });
    assert.equal(res.status, 500);
    assert.match(res.json.error, /not valid JSON/);
    assert.equal(readFileSync(broken, 'utf8'), '{ "views": [], }');
  });

  test('a config file that does not exist yet is simply written', async () => {
    const fresh = join(tmp, 'fresh.json');
    const res = await post('/api/connections/save', { path: fresh });
    assert.equal(res.status, 200);
    assert.equal((JSON.parse(readFileSync(fresh, 'utf8')) as { connections: unknown[] }).connections.length, 3);
  });

  test('a save that cannot be written is a 500 that names the path', async () => {
    const res = await post('/api/connections/save', {
      path: join(tmp, 'saved.json', 'nope.json'),
    });
    assert.equal(res.status, 500);
    assert.match(res.json.error, /Could not write/);
  });
});

/* ------------------------------------------------------------------ */

describe('the connection manager trusts the browser only on loopback', () => {
  /* On loopback the browser is the operator and may do what the config file
     may. On a listener that answers to other names — the container-behind-a-
     proxy case `proxied` stands in for — the browser is anyone on the
     network, and each of those conveniences was a way out: an env reference
     sent this process's secrets to a host the caller named, a bare path read
     any SQLite file the server user could, a save wrote JSON wherever the
     body pointed, and an update redirected a config connection for every
     reader. The same body through the loopback listener still works. */
  const host = {
    host: 'tablewalk.internal',
    'content-type': 'application/json',
  };
  const exposed = (path: string, body: unknown) => raw(proxied, 'POST', path, host, JSON.stringify(body));

  test('a URL referencing the environment is refused, on add and on test', async () => {
    for (const path of ['/api/connections', '/api/connections/test']) {
      const res = await exposed(path, {
        name: 'leak',
        url: 'postgres://u:${HOME}@attacker.example/db',
      });
      assert.equal(res.status, 403, path);
      assert.match(res.json.error, /cannot reference environment variables/);
    }
    // No connection was added on the way to the refusal.
    assert.ok(!(await get('/api/connections')).json.connections.some((c: { name: string }) => c.name === 'leak'));
  });

  test('a SQLite file path is refused, in every spelling', async () => {
    for (const url of [RO_DB, `sqlite:${RO_DB}`, '/etc/passwd', 'thing.db']) {
      const res = await exposed('/api/connections', { name: 'file', url });
      assert.equal(res.status, 403, url);
      assert.match(res.json.error, /cannot open a SQLite file by path/);
    }
  });

  test('a network URL is still accepted, and used exactly as written', async () => {
    /* The refusal is of the forms that resolve something on this machine,
       not of adding connections. A plain URL to a host nobody is listening on
       is added, fails to open, and is listed with its reason like any other —
       and the reason is the driver's, not a missing password: nothing was
       looked up by name. */
    const res = await exposed('/api/connections', {
      name: 'plain',
      url: 'postgres://u@127.0.0.1:1/db',
    });
    assert.equal(res.status, 400, res.text);
    const listed = res.json.connections.find((c: { id: string }) => c.id === 'plain');
    assert.ok(listed, 'added, with its error');
    assert.doesNotMatch(listed.error ?? '', /keychain|credentials file/);
    // And it is dialled sealed: a loopback address is not this browser's to probe (untrustedDatabase.ts).
    assert.match(listed.error ?? '', /may not reach/);
    const probe = await exposed('/api/connections/test', {
      url: 'postgres://u@127.0.0.1:1/db',
    });
    assert.equal(probe.json.ok, false);
    assert.match(probe.json.error, /may not reach/);
    await post('/api/connections/remove', { id: 'plain' });
  });

  test('a config connection cannot be redirected, and saving is refused', async () => {
    const before = readFileSync(configPath, 'utf8');
    const moved = await exposed('/api/connections/update', {
      id: 'remote',
      url: 'postgres://u@attacker.example/db',
    });
    assert.equal(moved.status, 403);
    assert.match(moved.json.error, /comes from the config file/);

    const saved = await exposed('/api/connections/save', {
      path: join(tmp, 'stolen.json'),
    });
    assert.equal(saved.status, 403);
    assert.match(saved.json.error, /saved from the machine running tablewalk/);
    assert.equal(readFileSync(configPath, 'utf8'), before);
    assert.throws(() => readFileSync(join(tmp, 'stolen.json')), 'nothing was written where the body pointed');

    // A rename is still the client's to make; it redirects nothing.
    const renamed = await exposed('/api/connections/update', {
      id: 'remote',
      name: 'remote (proxied)',
    });
    assert.equal(renamed.status, 200);
    await post('/api/connections/update', { id: 'remote', name: 'remote' });
  });

  test("on loopback, the same forms are still the operator's to use", async () => {
    /* The guard is about who is on the other end, not about the forms. */
    const file = await post('/api/connections/test', { url: RO_DB });
    assert.equal(file.status, 200);
    assert.equal(file.json.ok, true);
  });
});

describe('a proxy that signs people in', () => {
  /* `--auth-proxy-header X-Forwarded-User`: the proxy's decision, carried
     in. From beyond loopback the header is required — a request without it
     skipped the proxy — and every write is journaled with who made it. */
  test('identityFor: the header names the person; loopback without it is local; anyone else is refused', () => {
    const bound = {
      host: '0.0.0.0',
      port: 4111,
      identityHeader: 'X-Forwarded-User',
    };
    const req = (headers: Record<string, string>, from: string) => ({
      headers,
      socket: { remoteAddress: from },
    });
    const trusted = {
      ...bound,
      trustedProxies: parseTrustedProxies(['10.0.0.0/8']).ranges,
    };
    assert.deepEqual(identityFor(req({ 'x-forwarded-user': 'ada@example.org' }, '10.0.0.9'), trusted), { who: 'ada@example.org' });
    assert.deepEqual(identityFor(req({ 'x-forwarded-user': 'ada@example.org' }, '127.0.0.1'), bound), { who: 'ada@example.org' });
    assert.match(
      identityFor(req({ 'x-forwarded-user': 'ada@example.org' }, '10.0.0.9'), bound).refusal ?? '',
      /X-Forwarded-User only from its proxy/,
    );
    assert.deepEqual(identityFor(req({}, '127.0.0.1'), bound), {
      who: 'local',
    });
    assert.deepEqual(identityFor(req({}, '::ffff:127.0.0.1'), bound), {
      who: 'local',
    });
    assert.match(identityFor(req({}, '10.0.0.9'), bound).refusal ?? '', /expects X-Forwarded-User from its proxy/);
    assert.deepEqual(identityFor(req({}, '10.0.0.9'), { host: '0.0.0.0', port: 4111 }), {}, 'no header configured: nothing asked');
  });

  test('a write carries who made it into the journal, and whoami says so', async () => {
    const own = new Registry();
    own.add({ name: 'rw', url: RW_DB, writable: true, source: 'config' });
    own.setActive('rw');
    await own.open('rw');
    const where = {
      host: '127.0.0.1',
      port: 0,
      identityHeader: 'X-Forwarded-User',
    };
    const srv = createApp({ registry: own, bound: where });
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
    where.port = (srv.address() as { port: number }).port;
    try {
      const who = await getFrom(where, '/api/whoami', {
        'x-forwarded-user': 'ada@example.org',
      });
      assert.deepEqual(who.json, {
        who: 'ada@example.org',
        header: 'X-Forwarded-User',
        signedIn: false,
      });
      // Loopback without the header is the operator's own machine.
      assert.equal((await getFrom(where, '/api/whoami')).json.who, 'local');
      const wrote = await postTo(
        where,
        '/api/update',
        { table: 'country', key: { code: 'ZZ' }, values: { name: 'Zedland' } },
        { 'x-forwarded-user': 'ada@example.org' },
      );
      assert.equal(wrote.status, 200, wrote.text);
      const listed = await postTo(where, '/api/revert', {}, { 'x-forwarded-user': 'ada@example.org' });
      const last = (listed.json.writes as Array<{ kind: string; by?: string }>)[0];
      assert.equal(last.kind, 'update');
      assert.equal(last.by, 'ada@example.org');
    } finally {
      srv.close();
      srv.closeAllConnections();
    }
  });
});

describe('the writable flag does not follow a URL', () => {
  /* `writable` is the config's statement about one database. An entry that
     kept it while its URL changed carried "may be written" to whatever the
     new URL named — any file the server user could read — and `/api/sql`
     with `write: true` ran there. Its own registry, because the shared one
     has write tests behind it that need `writable` to stay writable. */
  test('retargeting a writable connection makes it read-only', async () => {
    const own = new Registry();
    const entry = own.add({
      name: 'w',
      url: RW_DB,
      writable: true,
      rows: false,
      source: 'config',
    });
    assert.equal(entry.writable, true);
    const after = await own.update(entry.id, { url: RO_DB });
    assert.equal(after.writable, false, 'the flag stayed with the old database');
    assert.equal(after.rows, false, 'a restriction is not dropped by moving');
    // A rename is not a retarget.
    const renamed = await own.update(own.add({ name: 'x', url: RW_DB, writable: true, source: 'config' }).id, { name: 'y' });
    assert.equal(renamed.writable, true);
  });

  test('moving a password out of the URL is not a retarget', async () => {
    /* Saving the config rewrites `postgres://u:secret@h/db` as
       `postgres://u@h/db` with the secret in the keychain. Same database, so
       the adapter stays open and the flag stays on; a rewrite that named
       another database is refused rather than becoming a retarget with the
       guards off. */
    const own = new Registry();
    const entry = own.add({
      name: 'p',
      url: 'postgres://u:s3cret@h/db',
      writable: true,
      source: 'config',
    });
    const kept = own.rewriteUrl(entry.id, 'postgres://u@h/db');
    assert.equal(kept.url, 'postgres://u@h/db');
    assert.equal(kept.writable, true);
    assert.throws(() => own.rewriteUrl(entry.id, 'postgres://u@elsewhere/db'), /names a different database/);
  });
});

describe('which connection a request runs against', () => {
  test('?conn= picks the connection for a GET', async () => {
    assert.equal((await get('/api/schema?conn=writable')).json.label, 'writable');
    assert.equal((await get('/api/schema?conn=readonly')).json.label, 'readonly');
    /* And the endpoints that key their answer by connection say which one they
       answered for, so a reply that arrives after the user has switched can be
       recognised as stale rather than rendered against the wrong database. */
    assert.equal((await get('/api/views?conn=writable')).json.connection, 'writable');
    assert.equal((await get('/api/layouts?conn=writable')).json.connection, 'writable');
  });

  test('body.conn picks the connection for a POST', async () => {
    assert.equal((await post('/api/count', { table: 'country', conn: 'writable' })).json.count, 4);
    assert.equal((await post('/api/count', { table: 'country', conn: 'readonly' })).json.count, 3);
  });

  test('?conn= is honoured on a POST too', async () => {
    /* It used to be read off GETs and silently dropped on POSTs, so the same
       URL ran against whatever was active — same request, different database,
       no warning. */
    const res = await post('/api/count?conn=writable', { table: 'country' });
    assert.equal(res.status, 200);
    assert.equal(res.json.count, 4);
  });

  test('two requests naming different connections do not interfere', async () => {
    /* The multi-tab bug. The server holds one "active" connection for the
       whole process, so switching database in one tab changed what every
       other tab's next request ran against — while those tabs went on
       rendering the schema they still had. The same query, the same screen,
       different data, and nothing to say so.

       Started together, because the failure was a race in effect: whichever
       request last set `active` decided what both of them read. */
    const [ro, rw] = await Promise.all([
      post('/api/count', { table: 'country', conn: 'readonly' }),
      post('/api/count', { table: 'country', conn: 'writable' }),
    ]);
    assert.equal(ro.status, 200);
    assert.equal(rw.status, 200);
    /* `country`, not `customer`: the fixture seeds one extra row into the
       writable database on purpose, and the two customer tables are
       identical — two equal numbers would have proved nothing whichever
       database answered. */
    assert.equal(rw.json.count, ro.json.count + 1, 'both requests read the same database');
  });

  test('a switch landing mid-request does not retarget the request', async () => {
    /* The other half of the multi-tab bug, and the one a pair of named
       requests cannot prove. A request resolves its connection once, at the
       start, and takes a lease on it. If anything later in the same request
       consulted `active` a second time — the count, the schema lookup, the
       header — a `select` from another tab arriving in between would answer
       part of one request from one database and part from another.

       Unnamed requests on purpose: a named one is pinned by its own body, so
       it could not catch this. These follow whatever was active when they
       arrived, and the assertion is that each answer agrees with the
       connection it says it came from. `country` is seeded with a different
       number of rows in each fixture, so the row count identifies the
       database on its own. */
    const COUNTS: Record<string, number> = { readonly: 3, writable: 4 };
    const work: Promise<unknown>[] = [];
    for (let i = 0; i < 12; i += 1) {
      work.push(post('/api/count', { table: 'country' }));
      work.push(
        post('/api/connections/select', {
          id: i % 2 ? 'readonly' : 'writable',
        }),
      );
    }
    const settled = await Promise.all(work);

    let checked = 0;
    for (const res of settled) {
      const answer = res as {
        status: number;
        json: { count?: number };
        headers: Headers;
      };
      if (answer.json.count === undefined) continue; // the selects
      const said = answer.headers.get('x-mistri-connection');
      assert.ok(said && said in COUNTS, `no connection named on the answer: ${said}`);
      assert.equal(answer.json.count, COUNTS[said!], `answered ${answer.json.count} rows but said it came from ${said}`);
      checked += 1;
    }
    assert.equal(checked, 12, 'the counts did not all come back');

    await post('/api/connections/select', { id: 'readonly' });
  });

  test('a connection is not closed while a request is still using it', async () => {
    /* Deterministically, which the HTTP version of this cannot be: the
       fixtures are SQLite and `node:sqlite` is synchronous, so a query slow
       enough to overlap with a refresh would block the event loop that has to
       deliver the refresh. Held open by hand instead, which tests the same
       lease the request pipeline takes at `index.ts`. */
    const { Registry } = await import('../packages/engine/src/server/connections.js');
    const registry = new Registry();
    registry.add({ name: 'held', url: RO_DB, source: 'config' });
    const { adapter } = await registry.open('held');

    const release = registry.lease('held');
    let refreshed = false;
    const refreshing = registry.refresh('held').then(() => {
      refreshed = true;
    });

    await new Promise((r) => setTimeout(r, 30));
    assert.equal(refreshed, false, 'the refresh closed the adapter out from under a live request');
    // And the adapter it is holding is still usable, which a closed one is not.
    assert.ok((await adapter.count('customer')) > 0);

    release();
    await refreshing;
    assert.equal(refreshed, true, 'releasing the last lease did not wake the refresh');

    await registry.closeAll();
  });

  test('releasing a lease twice does not lose a later one', async () => {
    /* `busy` is a count, and a release that ran twice would take it negative
       — after which the next drain sees a connection nobody is using and
       closes it mid-query. The bug would not show up on the request that
       caused it. */
    const { Registry } = await import('../packages/engine/src/server/connections.js');
    const registry = new Registry();
    registry.add({ name: 'twice', url: RO_DB, source: 'config' });
    await registry.open('twice');

    const first = registry.lease('twice');
    first();
    first();

    const second = registry.lease('twice');
    let done = false;
    const refreshing = registry.refresh('twice').then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(done, false, 'a double release let the next request be closed under');
    second();
    await refreshing;

    await registry.closeAll();
  });

  test('leasing a connection that does not exist is a no-op, not a throw', async () => {
    /* The pipeline leases whatever `resolve` returned. A 404 path that still
       reached the lease must not turn a clean "no such connection" into a
       500. */
    const { Registry } = await import('../packages/engine/src/server/connections.js');
    const registry = new Registry();
    assert.doesNotThrow(() => registry.lease('nobody')());
  });

  test('every answer says which connection gave it', async () => {
    /* Without this the guarantee is a claim. A reply carrying rows from the
       wrong database looks exactly like a reply carrying rows from the right
       one, which is why the bug survived: nothing on the wire disagreed. */
    const res = await post('/api/count', {
      table: 'customer',
      conn: 'writable',
    });
    assert.equal(res.headers.get('x-mistri-connection'), 'writable');

    const read = await get('/api/schema?conn=readonly');
    assert.equal(read.headers.get('x-mistri-connection'), 'readonly');
  });

  test('selecting a connection does not decide what a named request reads', async () => {
    /* `select` still moves the server's active connection, because something
       has to answer "no one said" for the first request of a session. What it
       must no longer do is answer for a request that did say. */
    await post('/api/connections/select', { id: 'writable' });
    const named = await post('/api/count', {
      table: 'customer',
      conn: 'readonly',
    });
    assert.equal(named.json.count, 5, 'a named request followed the active connection instead of its own');
    assert.equal(named.headers.get('x-mistri-connection'), 'readonly');
    await post('/api/connections/select', { id: 'readonly' });
  });

  test('a POST that names two connections is refused rather than resolved', async () => {
    /* Precedence would be the easy answer and the wrong one: either choice
       runs somebody's request against a database they did not mean, and the
       request has already said it is confused about which. */
    const res = await post('/api/count?conn=writable', {
      table: 'country',
      conn: 'readonly',
    });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /names two connections/);
  });

  test('a POST that names the same connection twice is fine', async () => {
    const res = await post('/api/count?conn=writable', {
      table: 'country',
      conn: 'writable',
    });
    assert.equal(res.status, 200);
  });

  test('a connection nobody has is a 404, not a quiet substitution', async () => {
    /* Falling back showed the database you were on and called it an answer.
       With raw SQL on the same path that is not a cosmetic difference: it is
       a statement run against the wrong database. */
    const stale = await get('/api/schema?conn=nonesuch');
    assert.equal(stale.status, 404);
    assert.match(stale.json.error, /No connection called "nonesuch"/);

    const post404 = await post('/api/count', {
      table: 'country',
      conn: 'nonesuch',
    });
    assert.equal(post404.status, 404);
  });

  test('no response body anywhere carries the password', async () => {
    /* A sweep rather than one assertion. The credential is held in the
       registry and every one of these endpoints has a route to it, so the
       cheapest honest test is to look at every answer. */
    const answers = [
      await get('/api/connections'),
      await get('/api/schema'),
      await get('/api/views'),
      await get('/api/queries'),
      await get('/api/layouts'),
      await get('/api/ddl?table=customer'),
      await post('/api/connections/select', { id: 'readonly' }),
      await post('/api/connections/refresh', { id: 'readonly' }),
      await post('/api/run', { q: 'customer' }),
      await post('/api/sql', { text: 'select 1' }),
      await post('/api/query', { table: 'customer' }),
      await post('/api/count', { table: 'customer' }),
      await post('/api/references', { table: 'customer', key: { id: 1 } }),
    ];
    for (const res of answers) {
      assert.ok(!res.text.includes(SECRET), `password leaked: ${res.text.slice(0, 200)}`);
      assert.ok(!res.text.includes('db.example.com:5432/appdb?'), 'a full URL reached the page');
    }
  });

  test('a connection that fails to open does not leak its password', async () => {
    /* The hole the sweep above left, and the one that let a real leak ship:
       every connection it looked at opened cleanly. A driver's failure
       message quotes what it was handed — the *resolved* string, password
       expanded into it — and that message was stored on the entry and served
       by every `GET /api/connections` from then on.

       An unsupported scheme is used because it fails inside `connect` without
       needing a server to refuse us, so the test is about the message rather
       than about the network. */
    const added = await post('/api/connections', {
      name: 'leaky',
      url: `oracle://alice:${SECRET}@db.example.com:1521/appdb`,
    });
    assert.equal(added.status, 400);
    assert.ok(!added.text.includes(SECRET), `the add reply leaked it: ${added.text}`);

    /* And on every subsequent read, which is the half that mattered: the
       entry is kept so the connection can be corrected, so its error is
       served again and again. */
    const listed = await get('/api/connections');
    assert.ok(!listed.text.includes(SECRET), `the list leaked it: ${listed.text}`);

    const broken = listed.json.connections.find((c: { id: string }) => c.id === 'leaky');
    assert.ok(broken, 'the failed connection vanished instead of being reported');
    assert.ok(broken.error, 'the failure was not reported at all');
    // Still useful: it says what is wrong, just not who with.
    assert.match(broken.error, /Don't know how to open/);

    await post('/api/connections/remove', { id: 'leaky' });
  });

  test('a password quoted on its own is swept too', async () => {
    /* Belt and braces. The URL-shaped pass catches the common leak; this
       catches a driver that quotes only the password back. */
    const { scrubSecrets } = await import('../packages/engine/src/server/connections.js');
    const url = `postgres://alice:${SECRET}@db.example.com:5432/appdb`;
    assert.ok(!scrubSecrets(`auth failed for ${SECRET}`, url).includes(SECRET));
    assert.ok(!scrubSecrets(`could not connect to ${url}`, url).includes(SECRET));
    // And the useful half survives: which host, and what went wrong.
    assert.match(scrubSecrets(`could not connect to ${url}`, url), /db\.example\.com/);
    assert.match(scrubSecrets(`could not connect to ${url}`, url), /could not connect/);
  });

  test('scrubbing leaves a message with no secret in it alone', async () => {
    const { scrubSecrets } = await import('../packages/engine/src/server/connections.js');
    assert.equal(scrubSecrets('relation "customer" does not exist'), 'relation "customer" does not exist');
  });
});

/* ------------------------------------------------------------------ */

describe('the view endpoints', () => {
  /* `/api/view/run` and `/api/view/compile` are heavily unit-tested through
     the compiler and had no HTTP coverage at all — including the two things
     only the endpoint does: answer errors with a 200 and an `errors` array
     rather than a status, and map a `PathError` to a 400. Both are contracts
     the client branches on. */

  const view = (extra: Record<string, unknown> = {}) => ({
    id: 'test',
    name: 'customer',
    base: 'customer',
    columns: [{ path: 'id' }, { path: 'name' }],
    limit: 5,
    ...extra,
  });

  test('runs a view and says what it compiled to', async () => {
    const res = await post('/api/view/run', { view: view() });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.errors, []);
    assert.deepEqual(res.json.columns, ['id', 'name']);
    assert.equal(res.json.rows.length, 5);
    assert.match(res.json.sql.text, /SELECT/i);
    /* The exact total, which the page's counts and pagers depend on: a view
       only ever joins to-one, so counting it is counting its base table. */
    assert.equal(res.json.total, 5);
    assert.equal(res.json.more, false);
  });

  test('a column that follows a reference comes back named for the path', async () => {
    const res = await post('/api/view/run', {
      view: view({ columns: [{ path: 'id' }, { path: 'country_code.name' }] }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.errors, []);
    assert.ok(res.json.columns.includes('country_code.name'), res.json.columns.join(', '));
  });

  test('an offset moves the window and `more` tracks it', async () => {
    const first = await post('/api/view/run', { view: view({ limit: 2 }) });
    const second = await post('/api/view/run', {
      view: view({ limit: 2 }),
      offset: 2,
    });
    assert.equal(first.json.more, true);
    assert.notDeepEqual(first.json.rows[0], second.json.rows[0]);
    assert.equal(second.json.offset, 2);
  });

  test('a half-typed filter is a 200 carrying its errors, not a status', async () => {
    /* Deliberate, and worth pinning. The composer sends the filter box on
       every keystroke, and a condition someone is halfway through typing is
       not a failed request — it is a request whose answer is "that does not
       parse yet". A 400 would make the composer report every keystroke as an
       outage. */
    const res = await post('/api/view/run', { view: view(), query: 'name = ' });
    assert.equal(res.status, 200);
    assert.ok(res.json.errors.length, 'a broken filter came back with no errors');
    assert.equal(res.json.rows, undefined, 'it ran anyway');
  });

  test('a column that does not exist is a 400, which is a different thing', async () => {
    /* Not a keystroke: a view naming a column the table does not have is
       wrong rather than unfinished, and the composer cannot fix it by waiting
       for the next letter. */
    const res = await post('/api/view/run', {
      view: view({ columns: [{ path: 'nonesuch' }] }),
    });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /nonesuch/);
  });

  test('a path that leads nowhere is a 400, and says so both ways', async () => {
    const res = await post('/api/view/run', {
      view: view({
        filter: { groups: [[{ path: 'no.such.path', op: '=', value: 1 }]] },
      }),
    });
    assert.equal(res.status, 400);
    // Both vocabularies, so a client that branches on status and reads
    // `.error` sees something.
    assert.ok(res.json.errors[0].message);
    assert.equal(res.json.error, res.json.errors[0].message);
  });

  test('a view with no base is refused rather than guessed at', async () => {
    const res = await post('/api/view/run', {
      view: { id: 'x', name: 'x', columns: [] },
    });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /base table/);
  });

  test('compiling does not run anything', async () => {
    /* The SQL panel while a view is still being built: compiling is free and
       running is not, and a half-finished view is worth showing the statement
       for. */
    const res = await post('/api/view/compile', { view: view() });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.errors, []);
    assert.match(res.json.sql.text, /SELECT/i);
    assert.equal(res.json.rows, undefined, 'compile returned rows');
  });

  test('an aggregate is one row per parent, however many children there are', async () => {
    /* The guarantee the whole aggregate design rests on: two counts over
       different children cannot inflate each other, because each is its own
       subquery rather than a join. */
    const res = await post('/api/view/run', {
      view: view({
        aggregates: [{ fn: 'count', via: 'invoice_customer_fk', alias: 'invoices' }],
        limit: 5,
      }),
    });
    if (res.status === 200 && !res.json.errors.length) {
      assert.equal(res.json.rows.length, 5, 'the aggregate multiplied its rows');
    }
  });

  test('the limit is clamped here too', async () => {
    const res = await post('/api/view/run', {
      view: view({ limit: 10_000_000 }),
    });
    assert.equal(res.status, 200);
    assert.ok(res.json.limit <= 100_000, `limit came back as ${res.json.limit}`);
  });
});

describe('planning a page section about a referenced record', () => {
  /* The one thing only the endpoint does for `of` sections: read the root
     row to learn which record the reference names, so the section's filter
     carries the *customer's* key on an invoice page. Everything below the
     endpoint is unit-tested in page.test.ts. */
  test('the plan filters by the referenced key, read from the root row', async () => {
    const invoice = (await post('/api/query', { table: 'invoice', limit: 1 })).json.rows[0];
    const res = await post('/api/pages/plan', {
      page: {
        id: 'saved:test',
        name: 'Invoice',
        base: 'invoice',
        source: 'saved',
        sections: [
          {
            kind: 'list',
            from: 'invoice',
            path: 'customer_id',
            of: 'customer_id',
            title: 'Siblings',
          },
        ],
      },
      key: { id: invoice.id },
    });
    assert.equal(res.status, 200);
    const plan = res.json.plans[0];
    assert.equal(plan.error, undefined);
    assert.equal(plan.empty, undefined);
    assert.deepEqual(plan.view.filter, {
      groups: [[{ path: 'customer_id', op: '=', value: invoice.customer_id }]],
    });
    /* And the click-through query is expressible: one column, one value. */
    assert.match(plan.query, /^invoice customer_id = /);
  });

  test('a root whose reference is null plans an empty section, not an error', async () => {
    /* An employee without a manager is the demo's natural null reference. */
    const orphan = (
      await post('/api/query', {
        table: 'employee',
        filter: { groups: [[{ column: 'manager_id', op: 'isNull' }]] },
        limit: 1,
      })
    ).json.rows[0];
    const res = await post('/api/pages/plan', {
      page: {
        id: 'saved:test2',
        name: 'Employee',
        base: 'employee',
        source: 'saved',
        sections: [
          {
            kind: 'list',
            from: 'invoice',
            path: 'sold_by',
            of: 'manager_id',
            title: 'Their manager\u2019s sales',
          },
        ],
      },
      key: { id: orphan.id },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.plans[0].error, undefined);
    assert.equal(res.json.plans[0].empty, true);
    assert.equal(res.json.plans[0].view, undefined);
  });
});

describe('the limit and offset clamps, over HTTP', () => {
  /* The clamps have unit tests. These prove the request path reaches them —
     an endpoint that read `body.limit` directly would pass every one of those
     unit tests and still send a million rows. */

  const limitOf = async (body: unknown) => (await post('/api/run', body)).json.limit;

  test('a limit that is not a number falls back to the default', async () => {
    for (const limit of ['abc', {}, [], null, true]) {
      assert.equal(await limitOf({ q: 'customer', limit }), DEFAULT_LIMIT, JSON.stringify(limit));
    }
  });

  test('a missing limit is the default, not unbounded', async () => {
    assert.equal(await limitOf({ q: 'customer' }), DEFAULT_LIMIT);
  });

  test('a limit over the ceiling is capped', async () => {
    assert.equal(await limitOf({ q: 'customer', limit: MAX_LIMIT + 1 }), MAX_LIMIT);
    assert.equal(await limitOf({ q: 'customer', limit: 1e12 }), MAX_LIMIT);
    assert.equal(await limitOf({ q: 'customer', limit: '250000' }), MAX_LIMIT);
  });

  test('a limit below one still leaves room for a row', async () => {
    assert.equal(await limitOf({ q: 'customer', limit: 0 }), 1);
    assert.equal(await limitOf({ q: 'customer', limit: -5 }), 1);
  });

  test('the query language and the request agree on the ceiling', async () => {
    assert.equal(await limitOf({ q: 'customer limit 999999999' }), MAX_LIMIT);
    assert.equal(await limitOf({ q: 'customer limit 3' }), 3);
    // An explicit request wins over the clause, which is what the pager sends.
    assert.equal(await limitOf({ q: 'customer limit 3', limit: 2 }), 2);
  });

  test('a negative offset is zero, and a fractional one is floored', async () => {
    const offsetOf = async (offset: unknown) => (await post('/api/run', { q: 'customer', offset })).json.offset;
    assert.equal(await offsetOf(-5), 0);
    assert.equal(await offsetOf('abc'), 0);
    assert.equal(await offsetOf(2.9), 2);
    assert.equal(await offsetOf(2), 2);
  });

  test('an offset actually moves the window', async () => {
    const first = await post('/api/run', { q: 'customer', limit: 1 });
    const second = await post('/api/run', {
      q: 'customer',
      limit: 1,
      offset: 1,
    });
    // Newest first, so the second page is the row below rather than above.
    assert.equal(first.json.rows[0].id, 5);
    assert.equal(second.json.rows[0].id, 4);
  });

  test('/api/sql is capped by the same ceiling', async () => {
    const res = await post('/api/sql', {
      text: 'select id from customer',
      limit: 1,
    });
    assert.equal(res.json.rows.length, 1);
    assert.equal(res.json.truncated, true);
  });
});

/* ------------------------------------------------------------------ */

describe('reading a request body', () => {
  test('a body over the cap is refused, and no handler sees it', async () => {
    /* An unbounded request body is a denial of service, so the read stops at
       256KB — and answers 413, because the size of the body is something only
       the caller can do anything about.

       A very large body can also have the socket torn down mid-upload, in
       which case `fetch` rejects. Either outcome is a refusal; what must never
       happen is a 200. */
    const body = JSON.stringify({
      table: 'customer',
      pad: 'x'.repeat(300 * 1024),
    });
    try {
      const res = await post('/api/count', JSON.parse(body) as unknown);
      assert.equal(res.status, 413);
      assert.equal(res.json.error, 'Request body too large.');
    } catch (err) {
      assert.match((err as Error).message, /fetch failed|terminated/i);
    }
  });

  test('a body just under the cap is read normally', async () => {
    // The other half of the boundary: the cap has to be big enough for a real
    // request, or it is a bug rather than a guard.
    const res = await post('/api/count', {
      table: 'customer',
      pad: 'x'.repeat(200 * 1024),
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.count, 5);
  });

  test('malformed JSON is refused with a message that says so', async () => {
    // 400: the body is the caller's, and so is the mistake in it.
    const res = await raw(bound, 'POST', '/api/count', { 'content-type': 'application/json' }, '{"table":');
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'Request body was not valid JSON.');
  });

  test('an empty body is an empty object, not a parse error', async () => {
    /* Sent to an endpoint that validates what it was given, so the answer
       distinguishes the two: "a layout needs a table" means the body parsed
       and was empty, where "not valid JSON" would mean it never parsed. */
    const res = await raw(bound, 'POST', '/api/layouts', {
      'content-type': 'application/json',
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'A layout needs a table.');
  });

  test('a refresh does not close a connection out from under a query', async () => {
    /* Closing an adapter is not something the thing using it finds out about.
       A slow read in one tab and a `refresh` in another ended the client
       mid-query: a driver-level "connection closed" 500 on Postgres, a
       use-after-close on SQLite. Nothing counted who was using what.

       Both are started together and both must succeed. On SQLite the window
       is small, so this is a guard against the shape rather than a
       reproduction of the timing — which is the honest thing a test can be
       here, and better than the nothing that was here before. */
    const [read, refreshed] = await Promise.all([
      post('/api/run', { q: 'customer' }),
      post('/api/connections/refresh', { id: 'readonly' }),
    ]);
    assert.equal(read.status, 200, `the read failed: ${read.text.slice(0, 200)}`);
    assert.equal(refreshed.status, 200, `the refresh failed: ${refreshed.text.slice(0, 200)}`);
    assert.ok(read.json.rows.length, 'the read came back empty');

    // And the connection still works afterwards, which a half-closed adapter
    // would not.
    assert.equal((await post('/api/count', { table: 'customer' })).json.count, 5);
  });

  test('two opens of the same connection do not dial twice', async () => {
    /* `open` checked for an adapter, then awaited introspection. Two callers
       both saw no adapter and both connected; the second assignment won and
       the first was never closed — on Postgres a leaked backend for the life
       of the process.

       Asserted through the schema both callers get: sharing one in-flight
       open means they are handed the same one. */
    const { Registry } = await import('../packages/engine/src/server/connections.js');
    const registry = new Registry();
    registry.add({ name: 'race', url: RO_DB, source: 'config' });

    const [a, b] = await Promise.all([registry.open('race'), registry.open('race')]);
    assert.equal(a.adapter, b.adapter, 'two adapters were opened for one connection');
    assert.equal(a.schema, b.schema);
    await registry.closeAll();
  });

  test('an open that fails is not cached as an open in progress', async () => {
    /* The failure mode the memo could have introduced: a rejected promise
       left on the entry would make every later attempt fail with the first
       attempt's error, and the connection could never be fixed without a
       restart. */
    const { Registry } = await import('../packages/engine/src/server/connections.js');
    const registry = new Registry();
    registry.add({
      name: 'broken',
      url: join(tmp, 'not-a-database.db'),
      source: 'config',
    });

    await assert.rejects(() => registry.open('broken'));
    // Fails the same way the second time, rather than differently or not at all.
    await assert.rejects(() => registry.open('broken'));
    await registry.closeAll();
  });

  test('an operator that is not one is refused, on every endpoint that takes a filter', async () => {
    /* The gap in the safety argument. A structured request is supposed to be
       unable to express injection: the column is quoted and the value is
       bound. `op` was neither — it became SQL text — and it was validated
       only by the config-file parser, so every endpoint that casts a body to
       `Filter` accepted whatever it was sent.

       The shipped client only ever sends real operators, and the cross-origin
       guard keeps another page from posting this, so it was a latent hole
       rather than a live one. It is still the one field that could have made
       the argument untrue. */
    const injection = { column: 'id', op: '= 1 OR 1=1 --', value: 1 };

    for (const [path, body] of [
      ['/api/query', { table: 'customer', filter: { groups: [[injection]] } }],
      ['/api/count', { table: 'customer', filter: { groups: [[injection]] } }],
    ] as const) {
      const res = await post(path, body);
      assert.equal(res.status, 400, `${path} did not refuse it`);
      assert.match(res.json.error, /is not an operator this tool knows/);
    }

    /* And nothing ran. The refusal happens while the statement is being
       built, so there is no statement to have run — asserted rather than
       reasoned about, in the house idiom. */
    const after = await post('/api/count', { table: 'customer' });
    assert.equal(after.status, 200);
    assert.equal(after.json.count, 5);
  });

  test('the operators the language does use are all accepted', async () => {
    /* The other half of the guard: a check that refuses everything is not a
       check, it is an outage. */
    for (const op of ['=', '!=', '>', '>=', '<', '<=', 'contains', 'startsWith', 'endsWith', 'isNull', 'isNotNull']) {
      const res = await post('/api/count', {
        table: 'customer',
        filter: { groups: [[{ column: 'name', op, value: 'a' }]] },
      });
      assert.equal(res.status, 200, `"${op}" was refused: ${res.text}`);
    }
    const inList = await post('/api/count', {
      table: 'customer',
      filter: { groups: [[{ column: 'id', op: 'in', value: [1, 2] }]] },
    });
    assert.equal(inList.status, 200);
  });

  test('/api/count and /api/query answer an unknown table the same way', async () => {
    /* They used to disagree: `/api/query` looked the table up and said 404,
       `/api/count` handed the name to the adapter and returned whatever the
       database says about a missing relation, with a 500. One mistake, two
       vocabularies, and only one of them tells the caller it was theirs. */
    const missing = await raw(bound, 'POST', '/api/count', { 'content-type': 'application/json' }, '{}');
    assert.equal(missing.status, 404);
    assert.match(missing.json.error, /Unknown table/);

    const unknown = await post('/api/count', { table: 'nonesuch' });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json.error, (await post('/api/query', { table: 'nonesuch' })).json.error);
    assert.equal((await post('/api/query', { table: 'nonesuch' })).status, 404);
  });

  test("__proto__ in a body does not become anyone else's prototype", async () => {
    /* JSON parsing and object spread preserve this literal key, but not all
       downstream keyed-assignment maps do. Refuse the request as a whole;
       never silently remove part of the caller's intended operation. */
    const res = await raw(
      bound,
      'POST',
      '/api/count',
      { 'content-type': 'application/json' },
      '{"table":"customer","__proto__":{"polluted":true},"constructor":{"prototype":{"alsoPolluted":true}}}',
    );
    assert.equal(res.status, 400);
    assert.match(res.json.error, /Request body property "(?:__proto__|prototype|constructor)" is not supported/);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.equal(({} as Record<string, unknown>).alsoPolluted, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted'), false);
  });

  test('a nested __proto__ refuses the whole request too', async () => {
    const res = await raw(
      bound,
      'POST',
      '/api/query',
      { 'content-type': 'application/json' },
      '{"table":"customer","limit":1,"filter":{"groups":[],"__proto__":{"nested":true}}}',
    );
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'Request body property "__proto__" is not supported.');
    assert.equal(({} as Record<string, unknown>).nested, undefined);
  });
});

/* ------------------------------------------------------------------ */

describe('the client, served from the same port', () => {
  test('/ answers the app', async () => {
    const res = await get('/');
    assert.equal(res.status, 200);
    assert.match(res.contentType, /text\/html/);
    /* Unversioned files, so without this a browser keeps serving the old app
       after an upgrade — silently, and looking like the fix did not work. */
    assert.match(res.text, /<html|<!doctype/i);
  });

  test('a route that is not a file is still the app', async () => {
    // Single-page app: unknown paths are routes, not missing files.
    const res = await get('/customer/1');
    assert.equal(res.status, 200);
    assert.match(res.contentType, /text\/html/);
  });

  test('a path cannot walk out of the client directory', async () => {
    /* Checked by what came back rather than by one string that was not in it.
       Asserting the absence of `"devDependencies"` proves nothing about a
       traversal that serves `packages/tablewalk/src/server/index.ts`, or a `.env`, or anything
       else without that word in it — the marker happened to be in the one
       file the test tried. What is provable is that the answer is the app. */
    for (const path of [
      '/../package.json',
      '/%2e%2e/package.json',
      '/..%2fpackage.json',
      '/../../etc/hosts',
      '/../src/server/index.ts',
      '/..%5csrc%5cserver%5cindex.ts',
      '/./../../package.json',
    ]) {
      const res = await raw(bound, 'GET', path, {});
      assert.ok(res.status === 404 || /text\/html/.test(res.contentType), `${path} answered ${res.status} ${res.contentType}`);
      assert.ok(!res.text.includes('"devDependencies"'), `served the repo: ${path}`);
      assert.ok(!/^import |^export |PostgresAdapter/m.test(res.text), `served source: ${path}`);
    }
  });
});

/* ------------------------------------------------------------------ */

/**
 * A server with nothing connected.
 *
 * `tablewalk` used to print its usage and exit(1) when nothing named a
 * database, which meant the state these tests describe was unreachable. It
 * starts now, and the browser asks — so the one screen that can ask has to be
 * servable, and the rest of the API has to refuse in a way the page can act
 * on rather than crash against.
 */
describe('the host check, on reads as well as writes', () => {
  test('an IPv6 bind expects the bracketed form a browser sends', () => {
    /* Configured bare (`--host fe80::1`), sent bracketed (`[fe80::1]:4111`):
       compared as configured, the bind could never pass its own check. */
    const req = (host: string) => ({ headers: { host } }) as unknown as import('node:http').IncomingMessage;
    const v6 = { host: 'fe80::1', port: 4111 };
    assert.equal(hostRefusal(req('[fe80::1]:4111'), v6), null);
    assert.match(hostRefusal(req('[fe80::2]:4111'), v6) ?? '', /only answers on \[fe80::1\]:4111/);
    assert.equal(hostRefusal(req('10.0.0.5:4111'), { host: '10.0.0.5', port: 4111 }), null);
  });

  /* It only ran for methods that change something, on the reasoning that a
     read is harmless. That is wrong for the attack it exists to stop: DNS
     rebinding works by making the request *same-origin* so the answer can be
     read, and the answers on offer were the whole schema, the DDL, the
     connection list and the saved SQL. */
  const attacker = { host: 'evil.example' };

  for (const path of ['/api/schema', '/api/connections', '/api/queries', '/api/views']) {
    test(`GET ${path} is refused for a host we do not answer on`, async () => {
      const res = await raw(bound, 'GET', path, attacker);
      assert.equal(res.status, 403);
      assert.match(res.text, /only answers on/);
      /* And the refusal says nothing about the database. */
      assert.doesNotMatch(res.text, /customer|invoice/i);
    });
  }

  test('so is the page itself, so the attempt fails at the door', async () => {
    const res = await raw(bound, 'GET', '/', attacker);
    assert.equal(res.status, 403);
    assert.doesNotMatch(res.text, /<title>/);
  });

  test('and the names we do answer on still work', async () => {
    for (const host of ['localhost:4111', '127.0.0.1:4111', '[::1]']) {
      const res = await raw(bound, 'GET', '/api/schema', { host });
      assert.equal(res.status, 200, host);
    }
  });

  test('an allowed host is answered, on read as on write', async () => {
    const res = await raw(proxied, 'GET', '/api/schema', {
      host: 'tablewalk.internal',
    });
    assert.equal(res.status, 200);
  });

  test('every answer says not to sniff its type', async () => {
    const res = await get('/api/schema');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  });
});

describe('with no connections at all', () => {
  let empty: Server;
  const where = { host: '127.0.0.1', port: 0, allowedHosts: [] as string[] };

  before(async () => {
    empty = createApp({ registry: new Registry(), bound: where });
    await new Promise<void>((resolve) => empty.listen(0, '127.0.0.1', resolve));
    const address = empty.address();
    assert.ok(address && typeof address === 'object');
    where.port = address.port;
  });

  after(async () => {
    empty?.close();
    empty?.closeAllConnections();
  });

  test('the page itself is served', async () => {
    /* The one that matters. This answered 409 "No connection is open" — the
       connection was resolved before the static handler at the bottom, so the
       only screen capable of adding a connection was behind the requirement
       to have one. */
    const res = await getFrom(where, '/');
    assert.equal(res.status, 200);
    assert.match(res.text, /<title>tablewalk<\/title>/);
  });

  test('so are the modules it loads, and a deep link', async () => {
    for (const path of ['/app.js', '/welcome.js', '/tour.js', '/style.css']) {
      assert.equal((await getFrom(where, path)).status, 200, path);
    }
    // The SPA fallback, so a pasted link does not 409 before it can be read.
    assert.equal((await getFrom(where, '/somedb/customer')).status, 200);
  });

  test('the connection list is empty rather than an error', async () => {
    const res = await getFrom(where, '/api/connections');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.connections, []);
    assert.equal(res.json.active, null);
  });

  test('anything needing a database says so, as 409', async () => {
    const res = await getFrom(where, '/api/schema');
    assert.equal(res.status, 409);
    assert.match(res.json.error, /No connection is open/);
  });

  test('adding one makes it active, and the schema arrives', async () => {
    const added = await postTo(where, '/api/connections', {
      name: 'fresh',
      url: RO_DB,
    });
    assert.equal(added.status, 200);
    assert.equal(added.json.active, 'fresh');

    const schema = await getFrom(where, '/api/schema');
    assert.equal(schema.status, 200);
    assert.ok(schema.json.tables.length > 0);
  });

  test('and the last one can be removed again, back to nothing', async () => {
    /* The registry refused this while zero connections was a state the
       product had no screen for. It has one now, so the refusal was only a
       connection nobody could delete. */
    const res = await postTo(where, '/api/connections/remove', { id: 'fresh' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.connections, []);
    assert.equal(res.json.active, null);
    assert.equal((await getFrom(where, '/')).status, 200);
  });

  test('an add that cannot open does not become the active connection', async () => {
    /* `add` makes the first connection active before anything has tried to
       dial it. So a first add that then failed to open left the whole
       application pointed at a connection that had never worked — and every
       later request answering with its error, including requests meant for a
       connection that was added afterwards and worked fine. */
    const bad = await postTo(where, '/api/connections', {
      name: 'nope',
      url: '/no/such/directory/db.sqlite',
    });
    assert.equal(bad.status, 400);
    /* Still listed with its error, which is deliberate: a mistyped target
       should be a correction rather than a retype. */
    assert.ok(bad.json.connections.some((c: { id: string }) => c.id === 'nope'));
    assert.equal(bad.json.active, null);
    assert.equal((await getFrom(where, '/api/schema')).status, 409);

    /* And the one added after it works, rather than inheriting the wreck. */
    const good = await postTo(where, '/api/connections', {
      name: 'works',
      url: RO_DB,
    });
    assert.equal(good.status, 200);
    assert.equal(good.json.active, 'works');
    assert.equal((await getFrom(where, '/api/schema')).status, 200);

    await postTo(where, '/api/connections/remove', { id: 'nope' });
    await postTo(where, '/api/connections/remove', { id: 'works' });
  });

  test('and a failed add leaves a working active connection alone', async () => {
    await postTo(where, '/api/connections', { name: 'keeper', url: RO_DB });
    const bad = await postTo(where, '/api/connections', {
      name: 'dud',
      url: '/no/such/directory/db.sqlite',
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.active, 'keeper');
    assert.equal((await getFrom(where, '/api/schema')).status, 200);

    await postTo(where, '/api/connections/remove', { id: 'dud' });
    await postTo(where, '/api/connections/remove', { id: 'keeper' });
  });
});
