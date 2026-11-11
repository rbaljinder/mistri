/**
 * A write's words for its notices (`{words.code}` in a notify title, given as
 * `db.t.insert(row, { words: { code } })`): said by mail or on a channel and
 * nowhere else. The inbox keeps the title masked; the queued mail keeps the
 * said title sealed under a key derived from MISTRI_SECRETS_KEY and bound to
 * its row, cleared once it is sent or fails; a word the title names and the
 * write does not give refuses the write; and an App whose notices say words
 * does not start without the key. The inbox and integration stores take the
 * sealed column in their version 2 layouts.
 *
 * SQLite always; PostgreSQL upgrades when TABLEWALK_TEST_PG names a server where the role may create databases.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { liveSkip } from './live.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { refusalCause } from '../packages/engine/src/server/evidence.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { attributeWrites } from '../packages/engine/src/adapters/writeAttribution.js';
import { openMigrationDb, type MigrationDb } from '../packages/engine/src/server/migrate/database.js';
import { createApp } from './support/createApp.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { provisionSqliteInbox } from '../packages/mistri/src/adapters/inbox/sqliteInbox.js';
import { INBOX_TABLES } from '../packages/mistri/src/adapters/inbox/inbox.js';
import { ensureAppInbox } from '../packages/mistri/src/server/inbox.js';
import { createEmailOutbox } from '../packages/mistri/src/server/email/outbox.js';
import { EmailFailure, type EmailMessage, type EmailTransport } from '../packages/mistri/src/server/email/email.js';
import { assertNoticeWordsKey, noticeWordsSeal, openNoticeWords } from '../packages/mistri/src/server/app/noticeWordsSeal.js';
import { STORES, storeStatuses, upgradeStores } from '../packages/mistri/src/server/storeLayouts.js';
import { ENGINES, LIVE, PROVISION, applyFixture, describeUrl, fixtureFiles, scratch, type Engine } from './support/storeLayouts.js';

/* A test's own secret, at least 32 bytes; never a deployment's. */
process.env.MISTRI_SECRETS_KEY = 'notice-words-test-secret-0123456789abcdef';

const withoutKey = async <T>(work: () => T | Promise<T>): Promise<T> => {
  const kept = process.env.MISTRI_SECRETS_KEY;
  delete process.env.MISTRI_SECRETS_KEY;
  try {
    return await work();
  } finally {
    process.env.MISTRI_SECRETS_KEY = kept;
  }
};

test('the said title is sealed to its place and opens only there', async () => {
  const sealed = noticeWordsSeal('desk')('Your code is 482913', ['desk', '7']);
  assert.doesNotMatch(sealed, /482913/);
  assert.equal(openNoticeWords('desk', ['desk', '7'], sealed), 'Your code is 482913');
  assert.equal(openNoticeWords('desk', ['desk', '8'], sealed), undefined, 'another row');
  assert.equal(openNoticeWords('desk', ['desk', '7'], `${sealed.slice(0, -2)}AA`), undefined, 'damaged');
  await withoutKey(() => assert.throws(() => assertNoticeWordsKey('desk'), /MISTRI_SECRETS_KEY/));
});

const appId = 'words-http';
const owner = 'words-http-db';

class Recorder implements EmailTransport {
  readonly name = 'test';
  sent: EmailMessage[] = [];
  failing?: EmailFailure;
  async send(message: EmailMessage) {
    if (this.failing) throw this.failing;
    this.sent.push(message);
  }
}

async function fixture(
  run: (f: {
    db: DatabaseSync;
    host: AppHost;
    registry: Registry;
    outbox: ReturnType<typeof createEmailOutbox>;
    mail: Recorder;
    warned: string[];
    write: (body: string, words?: Record<string, string>) => Promise<unknown>;
  }) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-words-'));
  const file = join(directory, 'fixture.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE person (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT);
    INSERT INTO person VALUES (1, 'Ann', 'ann@example.test'), (2, 'Bob', 'bob@example.test');
    CREATE TABLE thread (id INTEGER PRIMARY KEY, title TEXT NOT NULL, author_id INTEGER NOT NULL REFERENCES person(id));
    INSERT INTO thread VALUES (1, 'Sign-in', 1);
    CREATE TABLE post (id INTEGER PRIMARY KEY, thread_id INTEGER NOT NULL REFERENCES thread(id), body TEXT NOT NULL);`);
  provisionSqliteInbox(file);
  const registry = new Registry();
  registry.add({ id: owner, name: 'Words', url: file, source: 'config', writable: true });
  const definition = parseAppConfig(
    {
      id: appId,
      name: 'Words',
      connection: owner,
      resources: {
        person: {},
        thread: { access: 'write' },
        post: {
          access: 'write',
          notify: [{ on: 'insert', to: 'thread_id.author_id', title: 'Your code is {words.code}', opens: 'thread_id', email: true }],
        },
      },
      auth: { me: { from: 'person', column: 'email' }, roles: { member: { read: true, write: true } } },
      views: { threads: { kind: 'list', from: 'thread' } },
      home: 'threads',
      nav: ['threads'],
    },
    'words fixture',
  );
  const host: AppHost = {
    app: { path: 'words-fixture.ts', app: definition, pages: [], sources: {} },
    pages: [],
    auth: {
      spec: definition.auth!,
      store: 'not-used',
      handler: async () => {},
      close: async () => {},
      session: async () => ({ id: 'account-bob', who: 'bob@example.test', role: 'member' }),
    },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], pages: [] });
  server.listen(0, bound.host);
  await once(server, 'listening');
  const mail = new Recorder();
  const clock = { now: Date.now() + 60_000 };
  const warned: string[] = [];
  const outbox = createEmailOutbox({
    registry,
    hosts: () => [host],
    transport: mail,
    baseURL: 'https://words.example.test/',
    account: async (_host, email) => (email === 'ann@example.test' ? { id: 'account-ann', roles: ['member'] } : null),
    now: () => clock.now,
    warn: (message) => warned.push(message),
  });
  try {
    await run({
      db,
      host,
      registry,
      outbox,
      mail,
      warned,
      write: async (body, words) => {
        await ensureAppInbox(registry, host);
        const { adapter } = await registry.open(owner);
        return attributeWrites({ actor: 'bob@example.test', via: 'app' }, () =>
          adapter.transaction!((tx) => tx.insert({ table: 'post', values: { thread_id: 1, body }, ...(words ? { words } : {}) })),
        );
      },
    });
  } finally {
    await outbox.stop();
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    clearJournal(owner);
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

const notices = (db: DatabaseSync) =>
  db
    .prepare(`SELECT title FROM "${INBOX_TABLES.notice}" ORDER BY id`)
    .all()
    .map((row) => (row as { title: string }).title);
const queued = (db: DatabaseSync) =>
  db
    .prepare(`SELECT state, words FROM "${INBOX_TABLES.mail}" ORDER BY notice`)
    .all()
    .map((row) => ({ ...(row as { state: string; words: string | null }) }));

test('the inbox keeps the title masked, the mail waits sealed, and the code is said only in the mail sent', async () =>
  fixture(async ({ db, outbox, mail, write }) => {
    await write('Sign me in.', { code: '482913' });
    assert.deepEqual(notices(db), ['Your code is …']);
    const [row] = queued(db);
    assert.equal(row.state, 'queued');
    assert.ok(row.words, 'the said title waits sealed');
    assert.doesNotMatch(row.words!, /482913/);
    assert.deepEqual(await outbox.runOnce(), { sent: 1, skipped: 0, retried: 0, failed: 0 });
    assert.equal(mail.sent.length, 1);
    assert.equal(mail.sent[0].to, 'ann@example.test');
    assert.equal(mail.sent[0].subject, 'Your code is 482913');
    // Sent: the row and its sealed words are gone; the inbox still says nothing.
    assert.deepEqual(queued(db), []);
    assert.deepEqual(notices(db), ['Your code is …']);
  }));

test('a title too long is cut in its own text, never through the word it says', async () =>
  fixture(async ({ db, outbox, mail, write }) => {
    // A link, say: long enough that the title runs past what a notice says, with the word at its end.
    const link = `https://words.example.test/sign-in/${'k'.repeat(155)}`;
    await write('Sign me in.', { code: link });
    assert.deepEqual(notices(db), ['Your code is …']);
    assert.deepEqual(await outbox.runOnce(), { sent: 1, skipped: 0, retried: 0, failed: 0 });
    // 203 characters whole: the title's own text gives way, to 200 with the ellipsis and its space.
    assert.equal(mail.sent[0].subject, `Your cod… ${link}`);
  }));

test('a write that does not give the word a title names stands, and that notice is not sent for it', async () =>
  fixture(async ({ db, write }) => {
    await write('No code.');
    await write('Wrong code.', { other: '1' });
    assert.equal((db.prepare('SELECT count(*) AS n FROM post').get() as { n: number }).n, 2);
    assert.deepEqual(notices(db), []);
    assert.deepEqual(queued(db), []);
  }));

test('a send refused for good keeps the row for an operator and clears its words', async () =>
  fixture(async ({ db, outbox, mail, write }) => {
    mail.failing = new EmailFailure('550 no such mailbox', true);
    await write('Sign me in.', { code: '482913' });
    assert.deepEqual(await outbox.runOnce(), { sent: 0, skipped: 0, retried: 0, failed: 1 });
    assert.deepEqual(queued(db), [{ state: 'failed', words: null }]);
  }));

test("a provider's reason that quotes the message is neither kept nor logged where the message said a write's words", async () =>
  fixture(async ({ db, outbox, mail, warned, write }) => {
    mail.failing = new EmailFailure('451 try later: "Your code is 482913"');
    await write('Sign me in.', { code: '482913' });
    assert.deepEqual(await outbox.runOnce(), { sent: 0, skipped: 0, retried: 1, failed: 0 });
    mail.failing = new EmailFailure('550 rejected: "Your code is 731905"', true);
    await write('Sign me in again.', { code: '731905' });
    assert.deepEqual(await outbox.runOnce(), { sent: 0, skipped: 0, retried: 0, failed: 1 });
    const kept = db
      .prepare(`SELECT state, last_error FROM "${INBOX_TABLES.mail}" ORDER BY notice`)
      .all()
      .map((row) => ({ ...(row as { state: string; last_error: string }) }));
    assert.deepEqual(
      kept.map((row) => row.state),
      ['queued', 'failed'],
    );
    for (const said of [...kept.map((row) => row.last_error), ...warned]) assert.doesNotMatch(said, /482913|731905|Your code/);
    assert.equal(warned.length, 2);
  }));

test('an App whose notices say words does not start without MISTRI_SECRETS_KEY', async () =>
  fixture(async ({ registry, host }) => {
    await withoutKey(() => assert.rejects(ensureAppInbox(registry, host), /MISTRI_SECRETS_KEY/));
  }));

/* The version 2 layouts: the outbox's and the channel queue's sealed `words`, taken in place by `migrate stores up`. */
async function withDb<T>(url: string, work: (db: MigrationDb) => Promise<T>): Promise<T> {
  const db = await openMigrationDb(url, [], false);
  try {
    return await work(db);
  } finally {
    await db.close();
  }
}

const UPGRADES = {
  inbox: {
    attest: async (engine: Engine, url: string) =>
      engine === 'sqlite'
        ? (await import('../packages/mistri/src/adapters/inbox/sqliteInbox.js')).provisionSqliteInbox(url)
        : (await import('../packages/mistri/src/adapters/inbox/postgresInbox.js')).provisionPostgresInbox(url),
    seed: async (engine: Engine, db: MigrationDb) => {
      const [notice, mail] =
        engine === 'sqlite' ? ['"__mistri_inbox_notice"', '"__mistri_inbox_mail"'] : ['mistri.inbox_notice', 'mistri.inbox_mail'];
      // The notice id is an identity Postgres generates; the mail row names it, so the seed gives it.
      const given = engine === 'sqlite' ? '' : 'OVERRIDING SYSTEM VALUE';
      await db.run(
        `INSERT INTO ${notice} (id, app, recipient, at, resource, key_json, title, uses_json, actor, actor_name, action) ${given}
         VALUES (1, 'desk', 'ann@example.test', '2026-01-01T00:00:00.000Z', 'post', '{"id":1}', 'New reply', '[]', 'bob', 'Bob', 'insert')`,
      );
      await db.run(
        `INSERT INTO ${mail} (notice, state, attempts, due_at, last_error) VALUES (1, 'queued', 2, '2026-01-01T00:00:00.000Z', 'relay said 451')`,
      );
    },
    kept: [[1, 'queued', 2, 'relay said 451', null]] as unknown[][],
  },
  integrations: {
    attest: async (engine: Engine, url: string) => {
      const store = await import('../packages/mistri/src/adapters/integrations/integrationStore.js');
      return engine === 'sqlite' ? store.provisionSqliteIntegrations(url) : store.provisionPostgresIntegrations(url);
    },
    seed: async (engine: Engine, db: MigrationDb) => {
      const message = engine === 'sqlite' ? '"__mistri_integration_message"' : 'mistri.integration_message';
      await db.run(
        `INSERT INTO ${message} (app, key, tenant, channel, recipient, text, state, attempts, at) VALUES ('desk', 'k1', 't1', 'sms', '+15550100', 'Hello', 'held', 0, 1)`,
      );
    },
    kept: [['k1', 'Hello', 'held', null]] as unknown[][],
  },
} as const;

for (const id of ['inbox', 'integrations'] as const)
  for (const engine of ENGINES)
    test(
      `${engine}: a version 1 ${id} store with rows upgrades in place to version 2, every row kept, and a start accepts it`,
      { skip: engine === 'postgres' ? liveSkip('postgres', LIVE) : false },
      async () => {
        const layouts = STORES.filter((store) => store.id === id);
        const { attest, seed, kept } = UPGRADES[id];
        const where = await scratch(engine, `${id}_words_up`),
          fresh = await scratch(engine, `${id}_words_fresh`);
        try {
          const v1 = fixtureFiles(id, engine).find((file) => file.version === 1)!;
          await applyFixture(engine, where.url, readFileSync(v1.path, 'utf8'));
          await withDb(where.url, async (db) => {
            await seed(engine, db);
            const [status] = await storeStatuses(db, layouts);
            assert.equal(status.found, 1);
            assert.deepEqual(status.pending, [1]);
          });
          await assert.rejects(attest(engine, where.url), /migrate stores up/);
          const done = await withDb(where.url, (db) => upgradeStores(db, where.url, layouts));
          assert.deepEqual(done.failed, []);
          assert.deepEqual(
            done.applied.map((each) => [each.id, each.from, each.to]),
            [[id, 1, 2]],
          );
          assert.deepEqual(await attest(engine, where.url), { version: 2, provisioned: false });
          await PROVISION[id][engine]!(fresh.url);
          assert.deepEqual(await describeUrl(where.url), await describeUrl(fresh.url));
          await withDb(where.url, async (db) => {
            assert.deepEqual(await keptRows(engine, db, id), kept, 'every row kept, with no words');
          });
          assert.deepEqual((await withDb(where.url, (db) => upgradeStores(db, where.url, layouts))).applied, []);
        } finally {
          await where.drop();
          await fresh.drop();
        }
      },
    );

/* The seeded rows as the upgraded store holds them. */
async function keptRows(engine: Engine, db: MigrationDb, id: 'inbox' | 'integrations'): Promise<unknown[][]> {
  if (id === 'inbox') {
    const mail = engine === 'sqlite' ? '"__mistri_inbox_mail"' : 'mistri.inbox_mail';
    return (await db.all<Record<string, unknown>>(`SELECT notice, state, attempts, last_error, words FROM ${mail}`)).map((row) => [
      Number(row.notice),
      row.state,
      Number(row.attempts),
      row.last_error,
      row.words,
    ]);
  }
  const message = engine === 'sqlite' ? '"__mistri_integration_message"' : 'mistri.integration_message';
  return (await db.all<Record<string, unknown>>(`SELECT key, text, state, words FROM ${message}`)).map((row) => [
    row.key,
    row.text,
    row.state,
    row.words,
  ]);
}

test("a command's write gives its words as { words }, and its notice waits sealed like any other", { timeout: 10_000 }, async () => {
  const { migrateSqliteCommandJournal } = await import('../packages/mistri/src/adapters/commands/commandJournal.js');
  const { loadAppRuntimeResources } = await import('../packages/mistri/src/server/app/appRuntimeResources.js');
  const { bindBusinessCommands } = await import('../packages/mistri/src/server/commands/businessCommandAccess.js');
  const { executeBusinessCommand } = await import('../packages/mistri/src/server/commands/businessCommandExecution.js');
  const { defineCommand, defineCommands } = await import('../packages/mistri/src/server/commands/businessCommands.js');
  const { parseTestApp } = await import('./support/commandCatalog.js');
  const directory = mkdtempSync(join(tmpdir(), 'mistri-words-command-'));
  const path = join(directory, 'desk.db');
  const db = new DatabaseSync(path);
  const registry = new Registry();
  try {
    db.exec(`CREATE TABLE person (id INTEGER PRIMARY KEY, email TEXT NOT NULL);
      INSERT INTO person VALUES (1, 'ann@example.test'), (2, 'bob@example.test');
      CREATE TABLE thread (id INTEGER PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0, author_id INTEGER NOT NULL REFERENCES person(id));
      INSERT INTO thread (id, author_id) VALUES (1, 1);
      CREATE TABLE post (id INTEGER PRIMARY KEY, thread_id INTEGER NOT NULL REFERENCES thread(id), body TEXT NOT NULL);`);
    migrateSqliteCommandJournal(path);
    provisionSqliteInbox(path);
    registry.add({ id: 'desk-db', name: 'desk', url: path, writable: true, source: 'config' });
    const app = parseTestApp(
      {
        id: 'desk',
        name: 'Desk',
        sources: { desk: { connection: 'desk-db' } },
        resources: {
          person: {},
          thread: { access: 'write' },
          post: { access: 'write', notify: [{ on: 'insert', to: 'thread_id.author_id', title: 'Your code is {words.code}', email: true }] },
        },
        auth: { me: { from: 'person', column: 'email' }, roles: { member: { read: true, commands: ['ask', 'sloppy'] } } },
        views: { threads: { kind: 'list', from: 'thread' } },
        home: 'threads',
      },
      'words command fixture',
    );
    const host: AppHost = {
      app: { path: 'desk.ts', app, pages: [], sources: {} },
      pages: [],
      auth: {
        spec: app.auth!,
        store: 'not-used',
        handler: async () => {},
        close: async () => {},
        session: async () => ({ id: 'b', who: 'bob@example.test', role: 'member' }),
      },
    };
    await ensureAppInbox(registry, host);
    const commands = defineCommands({
      ask: defineCommand({
        source: 'desk',
        target: 'thread',
        write: ['post'],
        input: {},
        output: { parse: (value: unknown) => value as { ok: true } },
        async handle({ db, record }) {
          await db.post.insert({ thread_id: record!.id, body: 'Sign me in.' }, { words: { code: '482913' } });
          return { ok: true as const };
        },
      }),
      sloppy: defineCommand({
        source: 'desk',
        target: 'thread',
        write: ['post'],
        input: {},
        output: { parse: (value: unknown) => value as { ok: true } },
        async handle({ db, record }) {
          await db.post.insert({ thread_id: record!.id, body: 'Sloppy.' }, { words: { code: 482913 as unknown as string } });
          return { ok: true as const };
        },
      }),
    });
    const resources = await loadAppRuntimeResources(registry, app, 'desk-db');
    const binding = bindBusinessCommands({ app, resources, registry: commands, writableConnection: () => true });
    const run = (command: string) =>
      executeBusinessCommand(
        binding,
        { id: 'b', appId: 'desk', roles: ['member'], email: 'bob@example.test' },
        { command, commandVersion: 1, key: { id: 1 }, expectedVersion: 0, input: {}, idempotencyKey: `${command}-request-words-1` },
        { door: 'ui' },
      );
    await assert.rejects(run('sloppy'), (error: unknown) => {
      let reason: unknown = error;
      while (refusalCause(reason) !== undefined) reason = refusalCause(reason);
      assert.equal((error as { code?: string }).code, 'invalid_result');
      assert.match(String((reason as Error).message), /words\.code is a name and a text of at most 2,000 characters/);
      return true;
    });
    await run('ask');
    assert.deepEqual(notices(db), ['Your code is …']);
    const [row] = queued(db);
    assert.ok(row.words);
    assert.doesNotMatch(row.words!, /482913/);
  } finally {
    await registry.closeAll();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
