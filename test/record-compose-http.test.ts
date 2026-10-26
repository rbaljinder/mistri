/**
 * A record page in one request (shared/recordReads.ts, server/http/recordCompose.ts).
 *
 * The composed answer is the parts: every read it carries is answered
 * exactly as the same request sent alone is answered, for each reader —
 * a role that reads every column, a role whose field grant leaves one out,
 * and a signed-out visitor under the App's public grant — so composing a
 * page moves no read past the grants, row scope and hidden columns its own
 * request meets. What a reader may not read is not in the composed answer
 * at all, and what a reader may not ask (a signed-out visitor's record
 * history) is not asked.
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
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { parsePagesConfig } from '../packages/engine/src/shared/page.js';
import { parseAppPages } from '../packages/mistri/src/shared/appPages.js';

const appId = 'composed';
const owner = 'composed-records';
const secret = 'PRIVATE_NOTE_SENTINEL';
const token = 'HIDDEN_TOKEN_SENTINEL';

type Call = (path: string, body?: object) => Promise<{ status: number; body: any; text: string }>;

async function fixture(run: (f: { call: Call; as: (role: string | null) => void }) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-compose-'));
  const file = join(directory, 'records.db');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE account (id INTEGER PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL, tier TEXT,
      private_note TEXT DEFAULT '${secret}', api_token TEXT DEFAULT '${token}');
    CREATE TABLE contact (id INTEGER PRIMARY KEY, account_id INTEGER REFERENCES account(id), name TEXT NOT NULL, email TEXT);
    CREATE TABLE deal (id INTEGER PRIMARY KEY, account_id INTEGER REFERENCES account(id), title TEXT NOT NULL, amount REAL, stage TEXT);
    INSERT INTO account (id, name, status, tier) VALUES (1, 'Acme', 'active', 'gold'), (2, 'Brightline', 'paused', 'silver');
    INSERT INTO contact VALUES (1, 1, 'Ada', 'ada@example.test'), (2, 1, 'Grace', 'grace@example.test'), (3, 2, 'Linus', NULL);
    INSERT INTO deal VALUES (1, 1, 'Renewal', 1200, 'won'), (2, 1, 'Expansion', 800, 'open'), (3, 2, 'Pilot', 50, 'open');
  `);
  db.close();
  clearJournal(owner);
  const registry = new Registry();
  registry.add({ id: owner, name: 'Composed records', url: file, source: 'config', writable: true, hidden: { account: ['api_token'] } });
  const definition = parseAppConfig(
    {
      id: appId,
      name: 'Composed',
      connection: owner,
      resources: {
        account: {
          access: 'write',
          actions: {
            pause: { label: 'Pause', set: { status: 'paused' }, when: 'status = active' },
            resume: { label: 'Resume', set: { status: 'active' }, when: 'status = paused' },
          },
        },
        contact: {},
        deal: {},
      },
      auth: {
        roles: {
          admin: { read: true, write: true },
          rep: { read: true, write: true, fields: { account: { read: ['id', 'name', 'status', 'tier'], write: ['status'] } } },
          // Reads the deals and nothing of an account: a document of an account is not theirs to read.
          outsider: { read: ['deal'] },
        },
        public: { read: ['account', 'deal'], fields: { account: { read: ['id', 'name', 'status'] } } },
      },
      views: { accounts: { kind: 'list', from: 'account', label: 'Accounts' } },
      home: 'accounts',
      nav: ['accounts'],
    },
    'compose fixture',
  );
  const pages = parsePagesConfig(
    {
      pages: [
        {
          id: 'account',
          label: 'Account',
          base: 'account',
          sections: [
            { kind: 'header', facts: ['tier'] },
            { kind: 'fields', show: ['name', 'status'] },
            { kind: 'metric', title: 'Open deals', from: 'deal', whose: 'account_id', query: 'stage = open' },
            { kind: 'list', from: 'deal', whose: 'account_id' },
            { kind: 'list', from: 'contact', whose: 'account_id', when: 'status = active' },
          ],
        },
        {
          id: 'storefront',
          label: 'Storefront',
          base: 'account',
          sections: [
            { kind: 'fields', show: ['name', 'status'] },
            { kind: 'list', from: 'deal', whose: 'account_id' },
          ],
        },
        {
          id: 'notes',
          label: 'Account notes',
          base: 'account',
          sections: [
            { kind: 'fields', show: ['name'] },
            { kind: 'fields', show: ['private_note'] },
          ],
        },
      ],
    },
    'compose pages',
  );
  /* An account's statement on paper (appDocuments.ts): a page like any other to the routes that read it. */
  pages.push(
    ...parseAppPages(
      {
        pages: {
          statement: {
            base: 'account',
            sections: [
              { kind: 'fields', show: ['name', 'status'], presentation: 'facts' },
              { kind: 'list', from: 'deal', whose: 'account_id', show: ['title', 'amount'] },
            ],
            document: { label: 'Statement', number: 'name' },
          },
        },
      },
      'compose documents',
    ),
  );
  let role: string | null = 'admin';
  const host: AppHost = {
    app: { path: 'compose-fixture.ts', app: definition, pages, sources: {} },
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
  try {
    await run({
      as: (next) => {
        role = next;
      },
      call: async (path, body) => {
        const response = await fetch(`http://${bound.host}:${bound.port}${path}`, {
          signal: AbortSignal.timeout(10_000),
          headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'identity' },
          ...(body ? { method: 'POST', body: JSON.stringify({ app: appId, ...body }) } : {}),
        });
        const text = await response.text();
        return { status: response.status, text, body: JSON.parse(text) };
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

/** Every composed read, asked alone as the same reader, is answered the same. */
async function sameAsAlone(call: Call, reads: Array<{ path: string; body: Record<string, unknown>; status: number; reply: unknown }>) {
  assert.ok(reads.length > 0);
  for (const read of reads) {
    const alone = await call(read.path, read.body);
    assert.equal(alone.status, read.status, `${read.path} ${JSON.stringify(read.body)}`);
    assert.deepEqual(timeless(read.reply), timeless(alone.body), `${read.path} ${JSON.stringify(read.body)}`);
  }
}

test('a composed record page is its parts, for each reader, and the plan it brings is the plan', async () => {
  await fixture(async ({ call, as }) => {
    for (const role of ['admin', 'rep']) {
      as(role);
      const composed = await call('/api/pages/compose', { page: 'account', key: { id: 1 }, rows: 10 });
      assert.equal(composed.status, 200);
      assert.equal(composed.body.planned, true);
      const plan = await call('/api/pages/plan', { page: 'account', key: { id: 1 } });
      assert.deepEqual(composed.body.page, plan.body.page);
      assert.deepEqual(composed.body.plans, plan.body.plans);
      const paths = composed.body.reads.map((read: { path: string }) => read.path);
      // The row once, each list with its first page, the figure, and each `when`: the section's and the two actions'.
      assert.equal(paths.filter((path: string) => path === '/api/view/run').length, 3, role);
      assert.ok(paths.includes('/api/breakdown'), role);
      assert.equal(paths.filter((path: string) => path === '/api/run').length, 3, role);
      await sameAsAlone(call, composed.body.reads);
      assert.ok(!composed.text.includes(token), `${role} never reads a hidden column`);
      if (role === 'rep') assert.ok(!composed.text.includes(secret), 'a field grant keeps its column out of the composed answer');
    }
  });
});

test('a signed-out visitor composes only what the public grant reads, and asks no history', async () => {
  await fixture(async ({ call, as }) => {
    as(null);
    // A section the public grant does not read is left out of the page, never the page: the header's tier and the
    // contacts go, the fields, the open deals and their list stay.
    const account = await call('/api/pages/compose', { page: 'account', key: { id: 1 } });
    assert.equal(account.body.planned, true);
    assert.deepEqual(
      account.body.page.sections.map((section: { kind: string }) => section.kind),
      ['fields', 'metric', 'list'],
    );
    assert.ok(!account.text.includes('gold') && !account.text.includes(secret), 'nothing of a section left out is read');
    const composed = await call('/api/pages/compose', { page: 'storefront', key: { id: 1 } });
    assert.equal(composed.status, 200);
    assert.equal(composed.body.planned, true);
    const paths = composed.body.reads.map((read: { path: string }) => read.path);
    assert.ok(!paths.includes('/api/record-history'), 'record history is behind sign-in, composed or not');
    assert.ok(
      !composed.text.includes(secret) && !composed.text.includes(token) && !composed.text.includes('ada@example.test'),
      'nothing the public grant does not read',
    );
    await sameAsAlone(call, composed.body.reads);
  });
});

test('a section its reader may not read is left out of the page, and nothing of it is read', async () => {
  await fixture(async ({ call, as }) => {
    as('rep');
    const composed = await call('/api/pages/compose', { page: 'notes', key: { id: 1 } });
    // The rep may not read the page's second section: the page is composed without it, as its own plan is.
    assert.equal(composed.body.planned, true);
    assert.deepEqual(
      composed.body.page.sections.map((section: { show?: string[]; paths?: string[] }) => section.paths ?? section.show),
      [['name']],
    );
    assert.ok(!composed.text.includes(secret));
    await sameAsAlone(call, composed.body.reads);
  });
});

test('a page, a key or a page size it cannot use is refused before anything is read', async () => {
  await fixture(async ({ call }) => {
    assert.equal((await call('/api/pages/compose', { page: 'account' })).status, 400);
    assert.equal((await call('/api/pages/compose', { page: 'account', key: { id: 1 }, rows: 5000 })).status, 400);
    assert.equal((await call('/api/pages/compose', { page: 'account', key: { id: 1 }, tab: 7 })).status, 400);
    assert.deepEqual((await call('/api/pages/compose', { page: 'no-such-page', key: { id: 1 } })).body, { planned: false });
  });
});

test('a document is read with the grants of its record: every line for a reader of the record, nothing for anyone else', async () => {
  await fixture(async ({ call, as }) => {
    as('admin');
    const composed = await call('/api/pages/compose', { page: 'statement', key: { id: 1 }, rows: 10 });
    assert.equal(composed.status, 200, composed.text);
    assert.equal(composed.body.planned, true);
    assert.deepEqual(composed.body.page.document, { label: 'Statement', number: 'name' });
    // Its lines are every line, past the page a screen reads at once.
    const lines = composed.body.plans.find((plan: { view?: { base: string } }) => plan.view?.base === 'deal');
    assert.equal(lines.view.limit, 500);
    assert.ok(composed.text.includes('Renewal') && composed.text.includes('Expansion'));
    assert.ok(!composed.text.includes('Pilot'), "another account's line is not on this one's statement");
    await sameAsAlone(call, composed.body.reads);
    // A field grant holds on paper as on the page: the rep's statement has no column the rep cannot read.
    as('rep');
    const rep = await call('/api/pages/compose', { page: 'statement', key: { id: 1 } });
    assert.equal(rep.status, 200, rep.text);
    assert.ok(!rep.text.includes(secret) && !rep.text.includes(token));
    // A reader without the record's table gets no plan, no reads and no name of the record.
    as('outsider');
    const unplanned = await call('/api/pages/compose', { page: 'statement', key: { id: 1 } });
    assert.deepEqual(unplanned.body, { planned: false }, 'compose answers nothing, and the plan says why');
    const refused = await call('/api/pages/plan', { page: 'statement', key: { id: 1 } });
    assert.notEqual(refused.status, 200, refused.text);
    assert.ok(!refused.text.includes('Acme') && !refused.text.includes('Renewal'), refused.text);
  });
});
