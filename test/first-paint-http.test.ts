/**
 * A first page with its data in it (server/http/firstPaint.ts).
 *
 * The page carries the answers to what its first paint asks — who is here,
 * the runtime, the App, its schema and pages, the saved views, then the
 * first room's reads — each the reply of the route a fetch reaches. So every
 * answer it carries is compared with the same request asked alone, as the
 * same reader: a role that reads every column, a role whose field grant
 * leaves one out, and a signed-out visitor under the App's public grant. A
 * row's text is anybody's, so hostile values ride in the rows the page
 * carries and must come back out of it as the values they were. The block
 * is bounded, never run, never kept by a shared cache, and a page for
 * someone the App would send to its sign-in screen carries who-am-I and
 * nothing of the App.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { shellPolicy } from '../packages/engine/src/server/clientHttp.js';
import { firstPaint, firstPaintBlock, setFirstPaintBudget, type LoopAnswer } from '../packages/engine/src/server/http/firstPaint.js';
import { APP_PAINT_ROOMS } from '../packages/mistri/src/server/http/firstPaintRooms.js';

/* What is carried is compared, not how fast: a loaded machine gets the time it needs. */
setFirstPaintBudget(60_000);
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { parsePagesConfig } from '../packages/engine/src/shared/page.js';
import { FIRST_PAINT_ELEMENT, readKey, type FirstPaintData } from '../packages/engine/src/shared/firstPaint.js';

const appId = 'painted';
const owner = 'painted-records';
const secret = 'PRIVATE_NOTE_SENTINEL';
const token = 'HIDDEN_TOKEN_SENTINEL';
/* What a row may say: the end of the script element, a comment's start, the
   line separators JavaScript once ended lines at, markup and entities. */
const hostile = 'Acme </script><script>alert(1)</script> <!-- \u2028\u2029 </SCRIPT > & &amp; "quoted" \'single\'';

interface Page {
  status: number;
  headers: Headers;
  html: string;
  data?: FirstPaintData;
}
type Call = (path: string, body?: object) => Promise<{ status: number; body: any; account: string | null }>;

async function fixture(
  run: (f: { page: (path: string) => Promise<Page>; call: Call; as: (role: string | null) => void }) => Promise<void>,
  { publicGrant = true }: { publicGrant?: boolean } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-first-paint-'));
  const file = join(directory, 'records.db');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE account (id INTEGER PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL, tier TEXT,
      private_note TEXT DEFAULT '${secret}', api_token TEXT DEFAULT '${token}');
    CREATE TABLE deal (id INTEGER PRIMARY KEY, account_id INTEGER REFERENCES account(id), title TEXT NOT NULL, amount REAL, stage TEXT);
    INSERT INTO account (id, name, status, tier) VALUES (2, 'Brightline', 'paused', 'silver');
  `);
  db.prepare("INSERT INTO account (id, name, status, tier) VALUES (1, ?, 'active', 'gold')").run(hostile);
  db.exec("INSERT INTO deal VALUES (1, 1, 'Renewal', 1200, 'won'), (2, 1, 'Expansion', 800, 'open'), (3, 2, 'Pilot', 50, 'open')");
  db.close();
  clearJournal(owner);
  const registry = new Registry();
  registry.add({ id: owner, name: 'Painted records', url: file, source: 'config', writable: true, hidden: { account: ['api_token'] } });
  const definition = parseAppConfig(
    {
      id: appId,
      name: 'Painted',
      connection: owner,
      resources: { account: { access: 'write', segments: { active: 'status = active', paused: 'status = paused' } }, deal: {} },
      auth: {
        roles: {
          admin: { read: true, write: true },
          rep: { read: true, write: true, fields: { account: { read: ['id', 'name', 'status', 'tier'], write: ['status'] } } },
        },
        ...(publicGrant ? { public: { read: ['account', 'deal'], fields: { account: { read: ['id', 'name', 'status', 'tier'] } } } } : {}),
      },
      views: {
        accounts: {
          kind: 'list',
          from: 'account',
          label: 'Accounts',
          // Counted on its say: this test is of the first paint asking for the menu's counts, not of the rule.
          count: true,
          show: ['name', 'status', 'tier'],
          tabs: ['active', 'paused', { label: 'All' }],
        },
        deals: { kind: 'list', from: 'deal', label: 'Deals', count: true, show: ['title', 'account_id', 'amount', 'stage'] },
        overview: {
          kind: 'dashboard',
          label: 'Overview',
          sections: [
            { kind: 'metric', title: 'Open value', from: 'deal', query: 'stage = open', measure: 'sum amount as value' },
            { kind: 'breakdown', title: 'Deals by stage', from: 'deal', by: 'stage' },
            { kind: 'rows', title: 'Biggest deals', from: 'deal', show: ['title', 'account_id', 'amount'], sort: 'amount desc', limit: 3 },
          ],
        },
      },
      home: 'accounts',
      nav: ['accounts', 'deals', 'overview'],
      ui: { shell: { counts: true } },
    },
    'first paint fixture',
  );
  const pages = parsePagesConfig(
    {
      pages: [
        {
          id: 'account',
          label: 'Account',
          base: 'account',
          sections: [
            { kind: 'fields', show: ['name', 'status'] },
            { kind: 'list', from: 'deal', whose: 'account_id' },
          ],
        },
      ],
    },
    'first paint pages',
  );
  let role: string | null = 'admin';
  const host: AppHost = {
    app: { path: 'first-paint-fixture.ts', app: definition, pages, sources: {} },
    pages,
    auth: {
      spec: definition.auth!,
      store: 'not-used',
      handler: async () => {},
      close: async () => {},
      session: async () => (role === null ? null : { id: `account-${role}`, who: `${role}@example.test`, role }),
    },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], pages });
  server.listen(0, bound.host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  bound.port = address.port;
  const origin = `http://${bound.host}:${bound.port}`;
  try {
    await run({
      as: (next) => {
        role = next;
      },
      page: async (path) => {
        const response = await fetch(`${origin}${path}`, {
          signal: AbortSignal.timeout(20_000),
          headers: { 'Accept-Encoding': 'identity' },
        });
        const html = await response.text();
        const block = new RegExp(`<script type="application/json" id="${FIRST_PAINT_ELEMENT}">([\\s\\S]*?)</script>`).exec(html);
        return {
          status: response.status,
          headers: response.headers,
          html,
          ...(block ? { data: JSON.parse(block[1]) as FirstPaintData } : {}),
        };
      },
      call: async (path, body) => {
        const response = await fetch(`${origin}${path}`, {
          signal: AbortSignal.timeout(10_000),
          headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'identity' },
          ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
        });
        return { status: response.status, body: JSON.parse(await response.text()), account: response.headers.get('x-mistri-account') };
      },
    });
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    clearJournal(owner);
    rmSync(directory, { recursive: true, force: true });
  }
}

/* A read's timing is its own; everything it says is compared. */
const timeless = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(timeless)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([key]) => key !== 'ms')
            .map(([key, item]) => [key, timeless(item)]),
        )
      : value;

/** The request a key stands for (shared/firstPaint.ts readKey). */
function request(key: string): { method: string; url: string; body?: object } {
  const [head, payload] = key.split('\u0000');
  const [method, url] = head.split(' ');
  return { method, url, ...(payload ? { body: JSON.parse(payload) } : {}) };
}

/** Every answer the page carries is the endpoint's answer to the same request, for the same reader; each item its route's alone. */
async function sameAsEndpoints(call: Call, data: FirstPaintData, label: string): Promise<string[]> {
  const asked: string[] = [];
  for (const [key, read] of Object.entries(data.reads)) {
    const { url, body } = request(key);
    const alone = await call(url, body);
    asked.push(url.split('?')[0]);
    assert.equal(alone.status, 200, `${label}: ${key}`);
    assert.deepEqual(timeless(read.body), timeless(alone.body), `${label}: ${key}`);
    assert.equal(read.account ?? null, alone.account, `${label}: who ${key} was for`);
  }
  for (const [key, answer] of Object.entries(data.items)) {
    const [kind, app, text] = key.split('\u0000');
    const item = JSON.parse(text) as Record<string, unknown>;
    const alone =
      kind === 'count'
        ? (await call('/api/counts', { app, items: [item.q], countLimit: item.countLimit })).body.results[0]
        : kind === 'run'
          ? (await call('/api/run', { app, ...(item.run as object) })).body
          : (await call('/api/breakdown', { app, ...item })).body;
    asked.push(`${kind}:${JSON.stringify(item)}`);
    assert.deepEqual(timeless(answer.body), timeless(alone), `${label}: item ${key}`);
  }
  return asked;
}

test("every answer a first page carries is the endpoint's own, for each reader and each room", async () => {
  await fixture(async ({ page, call, as }) => {
    for (const role of ['admin', 'rep', null]) {
      as(role);
      for (const path of ['/accounts', '/accounts?tab=paused', '/accounts/1', '/overview', '/']) {
        const label = `${role ?? 'signed out'} ${path}`;
        const served = await page(path);
        assert.equal(served.status, 200, label);
        assert.ok(served.data, `${label} carries its data`);
        const asked = await sameAsEndpoints(call, served.data!, label);
        for (const boot of ['/api/whoami', '/api/runtime', '/api/app', '/api/schema', '/api/pages'])
          assert.ok(asked.includes(boot), `${label} carries ${boot}`);
        // A visitor browsing signed out keeps no saved views and is never asked for them.
        assert.equal(asked.includes('/api/filters'), role !== null, `${label} and the saved views`);
        if (path.startsWith('/accounts') && path !== '/accounts/1')
          assert.ok(asked.includes('/api/run') && asked.includes('/api/counts'), `${label}: the list's rows and its tabs' counts`);
        if (path === '/accounts/1')
          assert.ok(asked.includes('/api/pages/compose') && asked.includes('/api/query'), `${label}: the record page and its crumb`);
        if (path === '/overview')
          assert.ok(
            asked.some((one) => one.startsWith('breakdown:')) && asked.some((one) => one.startsWith('run:')),
            `${label}: the dashboard's sections`,
          );
        assert.ok(
          asked.some((one) => one.startsWith('count:')),
          `${label}: the menu's counts`,
        );
        assert.ok(!served.html.includes(token), `${label}: a hidden column is never carried`);
        if (role !== 'admin') assert.ok(!served.html.includes(secret), `${label}: a column the reader's grant leaves out is never carried`);
      }
    }
  });
});

test("a row's hostile text cannot end the block or be read as markup, and comes back out as it went in", async () => {
  await fixture(async ({ page }) => {
    const served = await page('/accounts/1');
    const at = served.html.indexOf(`id="${FIRST_PAINT_ELEMENT}">`);
    assert.ok(at > 0);
    const body = served.html.slice(at, served.html.indexOf('</script>', at));
    assert.ok(!/<\/script|<!--|<script|\u2028|\u2029/i.test(body), 'nothing in the block the HTML parser acts on');
    assert.ok(served.html.slice(at).split('</script>').length >= 2);
    assert.ok(JSON.stringify(served.data).includes(JSON.stringify(hostile).slice(1, -1)), 'the value itself survives the round trip');
  });
});

test("a page with answers is one reader's: private, never stored, no cookie, and its policy is the static page's", async () => {
  await fixture(async ({ page }) => {
    const served = await page('/accounts');
    assert.match(served.headers.get('cache-control') ?? '', /private/);
    assert.match(served.headers.get('cache-control') ?? '', /no-store/);
    assert.match(served.headers.get('vary') ?? '', /Cookie/);
    assert.equal(served.headers.get('set-cookie'), null);
    /* The block is data, never run: the page's script hashes are those of the page without it. */
    const without = served.html.replace(new RegExp(`<script type="application/json" id="${FIRST_PAINT_ELEMENT}">[\\s\\S]*?</script>`), '');
    /* From source, connect-src also names the dev client's hot-reload socket (devclient.ts devSocket). */
    const policy = served.headers.get('content-security-policy')?.replace(/(connect-src 'self')[^;]*/, '$1');
    assert.equal(policy, shellPolicy(without, { fromSource: true }));
  });
});

test('a signed-out visitor to an App with no public grant is carried who-am-I, and nothing of the App', async () => {
  await fixture(
    async ({ page, as }) => {
      as(null);
      const served = await page('/accounts/1');
      assert.ok(served.data);
      assert.deepEqual(
        Object.keys(served.data!.reads).map((key) => request(key).url.split('?')[0]),
        ['/api/whoami'],
      );
      assert.deepEqual(served.data!.items, {});
      assert.ok(!served.html.includes('Brightline') && !served.html.includes('Renewal'));
    },
    { publicGrant: false },
  );
});

test('the block is bounded: what would take it past the bound is left for the client to ask, in the order the page needs it', async () => {
  const big = { rows: 'x'.repeat(5_000) };
  const small = { ok: true };
  const answers: Record<string, unknown> = {
    '/api/whoami?app=a': { signedIn: true, appId: 'a' },
    '/api/runtime': { appConfigured: true, apps: [{ id: 'a' }], active: 'a' },
    '/api/app?app=a': { appId: 'a', app: { id: 'a', views: {}, nav: [], resources: {} } },
    '/api/pages?app=a': small,
    '/api/schema?app=a': big,
    '/api/filters?app=a': small,
  };
  const loop = async (_method: string, target: string): Promise<LoopAnswer> => ({
    status: 200,
    body: answers[target] ?? small,
    carriable: true,
  });
  const whole = await firstPaint({ rooms: APP_PAINT_ROOMS, path: '/a', search: '', loop });
  assert.ok(whole.json && JSON.parse(whole.json).reads[readKey('GET', '/api/schema?app=a')]);
  const bounded = await firstPaint({ rooms: APP_PAINT_ROOMS, path: '/a', search: '', loop, most: 2_000 });
  const carried = JSON.parse(bounded.json!) as FirstPaintData;
  assert.ok(bounded.json!.length <= 2_000);
  assert.equal(carried.reads[readKey('GET', '/api/schema?app=a')], undefined, 'the schema is past the bound, and asked');
  assert.ok(
    carried.reads[readKey('GET', '/api/whoami?app=a')] && carried.reads[readKey('GET', '/api/filters?app=a')],
    'what fits is carried',
  );
  // A reply that sets a cookie is the client's to receive, and one the route refused is the client's to be told.
  const refusing = async (_method: string, target: string): Promise<LoopAnswer> =>
    target.startsWith('/api/whoami')
      ? { status: 200, body: answers[target], carriable: true }
      : target === '/api/pages?app=a'
        ? { status: 200, body: small, carriable: false }
        : target === '/api/filters?app=a'
          ? { status: 403, body: { error: 'no' }, carriable: true }
          : { status: 200, body: answers[target] ?? small, carriable: true };
  const partial = await firstPaint({ rooms: APP_PAINT_ROOMS, path: '/a', search: '', loop: refusing });
  const reads = Object.keys((JSON.parse(partial.json!) as FirstPaintData).reads).map((key) => request(key).url);
  assert.ok(!reads.includes('/api/pages?app=a') && !reads.includes('/api/filters?app=a'));
  // An answer still out at the budget is the client's to ask; the page is not held for it.
  const slow = async (_method: string, target: string): Promise<LoopAnswer> =>
    target.startsWith('/api/schema')
      ? new Promise((resolve) => setTimeout(() => resolve({ status: 200, body: big, carriable: true }), 500))
      : { status: 200, body: answers[target] ?? small, carriable: true };
  const began = Date.now();
  const budgeted = JSON.parse(
    (await firstPaint({ rooms: APP_PAINT_ROOMS, path: '/a', search: '', loop: slow, budget: 100 })).json!,
  ) as FirstPaintData;
  assert.ok(Date.now() - began < 450);
  assert.equal(budgeted.reads[readKey('GET', '/api/schema?app=a')], undefined);
  assert.ok(budgeted.reads[readKey('GET', '/api/whoami?app=a')]);
  assert.equal(firstPaintBlock('x', '"</script>\u2028"'), '<script type="application/json" id="x">"\\u003c/script\\u003e\\u2028"</script>');
});

test('the size cap counts UTF-8 bytes after HTML-safe escaping', async () => {
  for (const name of ['🙂'.repeat(100), '<'.repeat(100)]) {
    const page = await firstPaint({
      rooms: APP_PAINT_ROOMS,
      path: '/a',
      search: '',
      most: 400,
      loop: async (_method, target) => ({
        status: 200,
        carriable: true,
        body: target.startsWith('/api/whoami') ? { signedIn: true, name } : { appConfigured: false },
      }),
    });
    const data = JSON.parse(page.json!) as FirstPaintData;
    assert.equal(data.reads[readKey('GET', '/api/whoami?app=a')], undefined);
    const block = firstPaintBlock('x', page.json!);
    assert.ok(Buffer.byteLength(block.slice(block.indexOf('>') + 1, block.lastIndexOf('</script>'))) <= 400);
  }
});

test('an exhausted budget starts no reads, and expiry cancels the outstanding stage', async () => {
  const targets: string[] = [];
  const signals: AbortSignal[] = [];
  const loop = async (_method: 'GET' | 'POST', target: string, _body?: Record<string, unknown>, signal?: AbortSignal) => {
    targets.push(target);
    assert.ok(signal);
    signals.push(signal);
    return new Promise<undefined>((resolve) => signal.addEventListener('abort', () => resolve(undefined), { once: true }));
  };
  assert.equal((await firstPaint({ rooms: APP_PAINT_ROOMS, path: '/a', search: '', budget: 0, loop })).json, undefined);
  assert.deepEqual(targets, []);
  assert.equal((await firstPaint({ rooms: APP_PAINT_ROOMS, path: '/a', search: '', budget: 20, loop })).json, undefined);
  assert.deepEqual(targets, ['/api/whoami?app=a', '/api/runtime']);
  assert.ok(signals.every((signal) => signal.aborted));
});

test('batch items from another account cannot enter the first room', async () => {
  const answers: Record<string, unknown> = {
    '/api/whoami?app=a': { signedIn: true, accountId: 'alice', appId: 'a' },
    '/api/runtime': { appConfigured: true, apps: [{ id: 'a' }], active: 'a' },
    '/api/app?app=a': {
      appId: 'a',
      app: {
        id: 'a',
        resources: {},
        views: { tasks: { table: 'task', count: true } },
        nav: [{ view: 'tasks' }],
        ui: { shell: { counts: true } },
      },
    },
    '/api/pages?app=a': { pages: [] },
    '/api/schema?app=a': { tables: [{ id: 'task', name: 'task', columns: [], primaryKey: [] }] },
    '/api/filters?app=a': { filters: {} },
  };
  for (const batchAccount of ['alice', 'bob', undefined]) {
    let batches = 0;
    const page = await firstPaint({
      rooms: APP_PAINT_ROOMS,
      path: '/a',
      search: '',
      loop: async (_method, target, body) => {
        if (target === '/api/counts') {
          batches++;
          return {
            status: 200,
            carriable: true,
            account: batchAccount,
            body: { results: (body!.items as unknown[]).map(() => ({ count: 7 })) },
          };
        }
        return { status: 200, carriable: true, account: 'alice', body: answers[target] };
      },
    });
    assert.equal(batches, 1);
    const data = JSON.parse(page.json!) as FirstPaintData;
    assert.equal(Object.keys(data.items).length, batchAccount === 'alice' ? 1 : 0);
  }
});
