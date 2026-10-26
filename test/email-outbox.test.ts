import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { provisionSqliteInbox } from '../packages/mistri/src/adapters/inbox/sqliteInbox.js';
import { INBOX_TABLES, mentionedHandles } from '../packages/mistri/src/adapters/inbox/inbox.js';
import { createEmailOutbox, emailProblems, retryDelay, type MailAccount } from '../packages/mistri/src/server/email/outbox.js';
import { EmailFailure, type EmailMessage, type EmailTransport } from '../packages/mistri/src/server/email/email.js';
import { emailOf } from '../packages/mistri/src/server/serviceConnections.js';

/**
 * Notifications by email. A rule that says `email: true` queues its mail in
 * the write's own transaction — a rollback queues none — and the outbox sends
 * it after the commit, to accounts only, as the reader the account is: a
 * record they cannot read is never mailed, and a mention of someone who
 * cannot read the record tells them nothing. A send that fails is tried
 * again with backoff and never touches the write that queued it.
 */
const appId = 'mail-http';
const owner = 'mail-http-db';

type Reply = { status: number; body: any };
type Person = 'ann' | 'bob' | 'outsider' | 'dee';
const people: Record<Person, { id: string; who: string; role: string; name?: string }> = {
  ann: { id: 'account-ann', who: 'ann@example.test', role: 'member', name: 'Ann Lee' },
  bob: { id: 'account-bob', who: 'bob@example.test', role: 'member', name: 'Bob Diaz' },
  outsider: { id: 'account-out', who: 'oz@example.test', role: 'outsider' },
  // Reads every thread, and is served only a room of people whose word is the thread table's own.
  dee: { id: 'account-dee', who: 'dee@example.test', role: 'reader' },
};
/* The accounts the outbox finds by address: Cat has a person row and no account. */
const accounts = new Map<string, MailAccount>(Object.values(people).map((person) => [person.who, { id: person.id, roles: [person.role] }]));

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
    post: (path: string, body: Record<string, unknown>) => Promise<Reply>;
    as: (person: Person) => void;
    db: DatabaseSync;
    outbox: ReturnType<typeof createEmailOutbox>;
    mail: Recorder;
    clock: { now: number };
    registry: Registry;
    directory: string;
  }) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-mail-'));
  const file = join(directory, 'fixture.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE person (id INTEGER PRIMARY KEY, name TEXT NOT NULL, handle TEXT NOT NULL, email TEXT);
    INSERT INTO person VALUES (1, 'Ann', 'ann', 'ann@example.test'), (2, 'Bob', 'bob', 'bob@example.test'),
      (3, 'Cat', 'cat', 'cat@example.test'), (4, 'Oz', 'oz', 'oz@example.test'),
      (5, 'Dee', 'dee', 'dee@example.test');
    CREATE TABLE thread (id INTEGER PRIMARY KEY, title TEXT NOT NULL, author_id INTEGER NOT NULL REFERENCES person(id));
    INSERT INTO thread VALUES (1, 'Solder fumes', 1), (2, 'Cat''s thread', 3);
    CREATE TABLE post (id INTEGER PRIMARY KEY, thread_id INTEGER NOT NULL REFERENCES thread(id), author_id INTEGER NOT NULL REFERENCES person(id),
      body TEXT NOT NULL CHECK (length(body) > 0));`);
  provisionSqliteInbox(file);
  const registry = new Registry();
  registry.add({ id: owner, name: 'Mail', url: file, source: 'config', writable: true });
  const definition = parseAppConfig(
    {
      id: appId,
      name: 'Forum',
      connection: owner,
      resources: {
        person: {},
        thread: { access: 'write' },
        post: {
          access: 'write',
          notify: [
            { on: 'insert', to: 'thread_id.author_id', title: 'New reply in {thread_id.title}', opens: 'thread_id', email: true },
            {
              on: 'insert',
              mentions: { in: 'body', by: 'handle' },
              title: 'You were mentioned in {thread_id.title}',
              opens: 'thread_id',
              email: true,
            },
          ],
        },
      },
      auth: {
        me: { from: 'person', column: 'email' },
        // An outsider reads people, never a thread.
        roles: { member: { read: true, write: true }, outsider: { read: ['person'] }, clerk: { read: true }, reader: { read: true } },
      },
      /* The whole App's first list over threads is the clerks' desk: a member is mailed their own address, the
         threads list, and a reader — served no list over threads, and a room that takes the table's own word —
         has none, so is sent to their notifications. */
      views: {
        desk: { kind: 'list', from: 'thread', roles: ['clerk'] },
        threads: { kind: 'list', from: 'thread', roles: ['member', 'outsider'] },
        thread: { kind: 'list', from: 'person', roles: ['reader'] },
      },
      home: 'threads',
      nav: ['desk', 'threads', 'thread'],
    },
    'mail fixture',
  );
  let current: Person = 'bob';
  const host: AppHost = {
    app: { path: 'mail-fixture.ts', app: definition, pages: [], sources: {} },
    pages: [],
    auth: {
      spec: definition.auth!,
      store: 'not-used',
      handler: async () => {},
      close: async () => {},
      session: async () => ({ ...people[current] }),
    },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], pages: [] });
  server.listen(0, bound.host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  bound.port = address.port;
  const mail = new Recorder();
  /* The write queues its mail at the server's real time, so the outbox's frozen
     clock must read after it: a date pinned in the calendar held only until
     the day it named passed noon. A minute ahead is after any write here. */
  const clock = { now: Date.now() + 60_000 };
  const outbox = createEmailOutbox({
    registry,
    hosts: () => [host],
    transport: mail,
    baseURL: 'https://forum.example.test/',
    account: async (_host, email) => accounts.get(email) ?? null,
    now: () => clock.now,
    warn: () => {},
  });
  try {
    await run({
      db,
      mail,
      outbox,
      clock,
      registry,
      directory,
      as: (person) => {
        current = person;
      },
      post: async (path, body) => {
        const response = await fetch(`http://${bound.host}:${bound.port}${path}`, {
          method: 'POST',
          signal: AbortSignal.timeout(5000),
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ app: appId, ...body }),
        });
        return { status: response.status, body: await response.json() };
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

const queued = (db: DatabaseSync) =>
  db
    .prepare(`SELECT m.state, m.attempts, m.due_at, m.last_error, n.recipient FROM "${INBOX_TABLES.mail}" m
  JOIN "${INBOX_TABLES.notice}" n ON n.id = m.notice ORDER BY m.notice`)
    .all()
    .map((row) => ({ ...row }));

test('a reply queues its mail with the write, and the outbox sends it after the commit, with a link to the record', async () =>
  fixture(async ({ post, db, outbox, mail }) => {
    const reply = await post('/api/insert', { table: 'post', values: { thread_id: 1, author_id: 2, body: 'Use a fan.' } });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.deepEqual(
      queued(db).map((row) => [row.recipient, row.state, row.attempts]),
      [['ann@example.test', 'queued', 0]],
    );
    // Nothing went out with the write: it is the outbox's to send.
    assert.equal(mail.sent.length, 0);
    assert.deepEqual(await outbox.runOnce(), { sent: 1, skipped: 0, retried: 0, failed: 0 });
    assert.equal(mail.sent.length, 1);
    assert.equal(mail.sent[0].to, 'ann@example.test');
    assert.equal(mail.sent[0].subject, 'New reply in Solder fumes');
    assert.match(mail.sent[0].text, /https:\/\/forum\.example\.test\/mail-http\/threads\/1/);
    assert.match(mail.sent[0].text, /Turn them off/);
    assert.deepEqual(queued(db), []);
    // Sent once: the next pass finds nothing.
    assert.deepEqual(await outbox.runOnce(), { sent: 0, skipped: 0, retried: 0, failed: 0 });
    // The notice itself stays in the inbox.
    assert.equal((db.prepare(`SELECT count(*) AS n FROM "${INBOX_TABLES.notice}"`).get() as { n: number }).n, 1);
  }));

test('a write that rolls back queues no mail', async () =>
  fixture(async ({ post, db, registry }) => {
    // Any request binds the App's rules to its adapter; then a transaction that fails after its insert.
    assert.equal((await post('/api/inbox', {})).status, 200);
    const { adapter } = await registry.open(owner);
    const { attributeWrites } = await import('../packages/engine/src/adapters/writeAttribution.js');
    await assert.rejects(
      attributeWrites({ actor: 'bob@example.test', via: 'app' }, () =>
        adapter.transaction!(async (tx) => {
          await tx.insert({ table: 'post', values: { thread_id: 1, author_id: 2, body: 'Gone with the write.' } });
          assert.equal(queued(db).length, 0, 'uncommitted: another reader sees nothing yet');
          throw new Error('the write fails after its notice');
        }),
      ),
      /fails after/,
    );
    assert.equal((db.prepare('SELECT count(*) AS n FROM post').get() as { n: number }).n, 0);
    assert.equal((db.prepare(`SELECT count(*) AS n FROM "${INBOX_TABLES.notice}"`).get() as { n: number }).n, 0);
    assert.deepEqual(queued(db), []);
  }));

test('a failed send is tried again later with backoff, and never fails the write that queued it', async () =>
  fixture(async ({ post, db, outbox, mail, clock }) => {
    mail.failing = new EmailFailure('relay said 451');
    const reply = await post('/api/insert', { table: 'post', values: { thread_id: 1, author_id: 2, body: 'Try again.' } });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.deepEqual(await outbox.runOnce(), { sent: 0, skipped: 0, retried: 1, failed: 0 });
    const [row] = queued(db);
    assert.equal(row.state, 'queued');
    assert.equal(row.attempts, 1);
    assert.equal(row.last_error, 'relay said 451');
    assert.equal(row.due_at, new Date(clock.now + retryDelay(1)).toISOString());
    // Not due yet: nothing is claimed.
    mail.failing = undefined;
    assert.deepEqual(await outbox.runOnce(), { sent: 0, skipped: 0, retried: 0, failed: 0 });
    clock.now += retryDelay(1);
    assert.deepEqual(await outbox.runOnce(), { sent: 1, skipped: 0, retried: 0, failed: 0 });
    assert.equal(mail.sent.length, 1);
    assert.ok(retryDelay(2) > retryDelay(1) && retryDelay(40) === 3_600_000);
  }));

test('a refusal for good is kept as failed, for an operator, and not tried again', async () =>
  fixture(async ({ post, db, outbox, mail }) => {
    mail.failing = new EmailFailure('550 no such mailbox', true);
    assert.equal((await post('/api/insert', { table: 'post', values: { thread_id: 1, author_id: 2, body: 'Hello.' } })).status, 200);
    assert.deepEqual(await outbox.runOnce(), { sent: 0, skipped: 0, retried: 0, failed: 1 });
    assert.deepEqual(
      queued(db).map((row) => [row.state, row.last_error]),
      [['failed', '550 no such mailbox']],
    );
    assert.deepEqual(await outbox.runOnce(), { sent: 0, skipped: 0, retried: 0, failed: 0 });
  }));

test('only accounts are mailed, and an account that turned email off is not; its inbox is unchanged', async () =>
  fixture(async ({ post, as, db, outbox, mail }) => {
    // Cat has a person row and an address, and no account: the notice is kept, the mail is not sent.
    assert.equal((await post('/api/insert', { table: 'post', values: { thread_id: 2, author_id: 2, body: 'Nice.' } })).status, 200);
    assert.deepEqual(await outbox.runOnce(), { sent: 0, skipped: 1, retried: 0, failed: 0 });
    as('ann');
    assert.deepEqual((await post('/api/inbox/email', {})).body, { email: true });
    assert.deepEqual((await post('/api/inbox/email', { email: false })).body, { email: false });
    assert.equal((await post('/api/inbox', {})).body.email, false);
    // A body cannot name whose choice it is.
    assert.equal((await post('/api/inbox/email', { email: true, recipient: 'bob@example.test' })).status, 400);
    as('bob');
    assert.equal((await post('/api/insert', { table: 'post', values: { thread_id: 1, author_id: 2, body: 'Again.' } })).status, 200);
    assert.deepEqual(await outbox.runOnce(), { sent: 0, skipped: 1, retried: 0, failed: 0 });
    assert.equal(mail.sent.length, 0);
    as('ann');
    assert.equal((await post('/api/inbox', {})).body.notices.length, 1);
    assert.deepEqual(queued(db), []);
  }));

test('a mention tells the person it names, and never someone who cannot read the record', async () =>
  fixture(async ({ post, as, outbox, mail }) => {
    as('ann');
    const reply = await post('/api/insert', {
      table: 'post',
      values: { thread_id: 1, author_id: 1, body: '@bob and @oz, see this. Not ann@example.test, nor @nobody.' },
    });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.deepEqual(await outbox.runOnce(), { sent: 1, skipped: 1, retried: 0, failed: 0 });
    assert.deepEqual(
      mail.sent.map((message) => [message.to, message.subject]),
      [['bob@example.test', 'You were mentioned in Solder fumes']],
    );
    // Oz reads no thread: nothing in their inbox either.
    as('outsider');
    assert.deepEqual((await post('/api/inbox', {})).body.notices, []);
    as('bob');
    assert.equal((await post('/api/inbox', {})).body.notices.length, 1);
  }));

test("each recipient's link is the record at their own address, and one with none is their notifications", async () =>
  fixture(async ({ post, as, outbox, mail }) => {
    as('ann');
    assert.equal(
      (await post('/api/insert', { table: 'post', values: { thread_id: 1, author_id: 1, body: '@bob and @dee, see this.' } })).status,
      200,
    );
    assert.deepEqual(await outbox.runOnce(), { sent: 2, skipped: 0, retried: 0, failed: 0 });
    const to = Object.fromEntries(mail.sent.map((message) => [message.to, message.text]));
    // Not /desk/1, the whole App's: a member is not served the desk.
    assert.match(to['bob@example.test'], /https:\/\/forum\.example\.test\/mail-http\/threads\/1\n/);
    assert.match(to['dee@example.test'], /https:\/\/forum\.example\.test\/mail-http\/notifications\n/);
  }));

test('mentions are read at word edges, each once, and a server with email rules needs an email service', () => {
  assert.deepEqual(mentionedHandles('@bob, @ann. (@bob) mail@host.test @x @oz_2! email ann@example.test'), ['bob', 'ann', 'x', 'oz_2']);
  assert.deepEqual(mentionedHandles(42), []);
  const app = parseAppConfig(
    {
      id: 'a',
      name: 'A',
      resources: { post: { access: 'write', notify: [{ on: 'insert', to: 'email', title: 'x', email: true }] } },
      auth: { roles: { member: { read: true } } },
      views: { posts: { kind: 'list', from: 'post' } },
      home: 'posts',
      nav: ['posts'],
    },
    'a',
  );
  assert.match(emailProblems(app, false)!, /no email service/);
  assert.equal(emailProblems(app, true), undefined);
  assert.throws(
    () =>
      parseAppConfig(
        {
          id: 'a',
          name: 'A',
          resources: { post: { notify: [{ on: 'insert', title: 'x', email: 'yes' }] } },
          views: { posts: { kind: 'list', from: 'post' } },
          home: 'posts',
          nav: ['posts'],
        },
        'a',
      ),
    /"email" is true/,
  );
});

test('the log transport writes each message as a line and sends nothing', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-mail-log-'));
  try {
    const registry = new Registry();
    const { emailConnectionOf } = await import('../packages/mistri/src/server/email/email.js');
    registry.addService(
      emailConnectionOf({ name: 'mail', kind: 'email', url: 'log:out/mail.log', from: 'Forum <no-reply@example.test>' }, 'test', directory),
    );
    await emailOf(registry)!.send({ to: 'ann@example.test', subject: 'Hello', text: 'Line one\nLine two' });
    const file = join(directory, 'out', 'mail.log');
    assert.ok(existsSync(file));
    const line = JSON.parse(readFileSync(file, 'utf8').trim());
    assert.deepEqual(
      { to: line.to, subject: line.subject, text: line.text, from: line.from },
      { to: 'ann@example.test', subject: 'Hello', text: 'Line one\nLine two', from: 'Forum <no-reply@example.test>' },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
