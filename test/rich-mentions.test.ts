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
import { parseAppConfig, resolveDisplay } from '../packages/mistri/src/shared/app.js';
import { appNotifyRules } from '../packages/mistri/src/shared/appNotify.js';
import { provisionSqliteInbox } from '../packages/mistri/src/adapters/inbox/sqliteInbox.js';
import { INBOX_TABLES, noticeMentions } from '../packages/mistri/src/adapters/inbox/inbox.js';
import { richTextMentioned } from '../packages/engine/src/shared/richText.js';
import { sanitizeRichText } from '../packages/mistri/src/server/richText.js';
import { parseCommandInput } from '../packages/mistri/src/shared/commandInputParse.js';
import { mentionLabelText, mentionQuery } from '../packages/engine/src/shared/mentionLookup.js';

/**
 * @mentions in rich text, end to end. The editor keeps a mention as the
 * handle its column's display rule stores (`data-id`), a team with
 * `data-kind="group"`; a `notify` rule's `mentions` tells the people a value
 * names that way — a team as its members — never the `@Name` drawn in it. An
 * edit tells only whom it newly mentions, and a person who cannot read the
 * record is never shown the notice.
 */
const appId = 'rich-mentions';
const owner = 'rich-mentions-db';

type Reply = { status: number; body: any };
type Person = 'ann' | 'bob' | 'oz';
const people: Record<Person, { id: string; who: string; role: string; name?: string }> = {
  ann: { id: 'account-ann', who: 'ann@example.test', role: 'member', name: 'Ann Lee' },
  bob: { id: 'account-bob', who: 'bob@example.test', role: 'member', name: 'Bob Diaz' },
  // Oz reads people, never a thread or a post.
  oz: { id: 'account-oz', who: 'oz@example.test', role: 'outsider' },
};

const mention = (id: number | string, label: string, group = false) =>
  `<span data-type="mention" data-id="${id}"${group ? ' data-kind="group"' : ''}>@${label}</span>`;

function definition(post: Record<string, unknown> = {}) {
  return {
    id: appId,
    name: 'Mentions',
    connection: owner,
    resources: {
      person: {},
      member: {},
      team: {},
      team_member: {},
      thread: { access: 'write' },
      post: {
        access: 'write',
        display: {
          body: {
            format: 'richText',
            mentions: {
              from: 'person',
              by: 'id',
              labelColumn: 'name',
              groups: { from: 'team', by: 'id', labelColumn: 'name', through: 'team_member' },
            },
          },
        },
        notify: [
          { on: 'insert', mentions: { in: 'body' }, title: 'You were mentioned in {thread_id.title}', opens: 'thread_id' },
          { on: { changes: 'body' }, mentions: { in: 'body' }, title: 'You were mentioned in {thread_id.title}', opens: 'thread_id' },
        ],
        ...post,
      },
    },
    auth: {
      me: { from: 'person', column: 'email' },
      roles: { member: { read: true, write: true }, outsider: { read: ['person'] } },
    },
    views: { threads: { kind: 'list', from: 'thread' } },
    home: 'threads',
    nav: ['threads'],
  };
}

async function fixture(
  run: (f: {
    post: (path: string, body: Record<string, unknown>) => Promise<Reply>;
    as: (person: Person) => void;
    db: DatabaseSync;
  }) => Promise<void>,
  post: Record<string, unknown> = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-rich-mentions-'));
  const file = join(directory, 'fixture.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE person (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT);
    INSERT INTO person VALUES (1, 'Ann', 'ann@example.test'), (2, 'Bob', 'bob@example.test'), (3, 'Cat', 'cat@example.test'), (4, 'Oz', 'oz@example.test');
    CREATE TABLE member (id TEXT PRIMARY KEY, first_name TEXT NOT NULL, last_name TEXT NOT NULL, email TEXT NOT NULL);
    INSERT INTO member VALUES ('3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b', 'Morgan', 'Hughes', 'mhughes@example.test'),
      ('7d1e2f3a-4b5c-4d6e-8f9a-0b1c2d3e4f5a', 'Morgan', 'Tran', 'mtran@example.test'),
      ('0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e', 'Vic', 'Ramos', 'vramos@example.test'),
      ('5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d', 'Ann', 'Victor', 'avictor@example.test'),
      ('9e0f1a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b', 'Eve', 'Novick', 'enovick@example.test');
    CREATE TABLE team (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO team VALUES (1, 'Bench'), (2, 'Empty');
    CREATE TABLE team_member (id INTEGER PRIMARY KEY, team_id INTEGER NOT NULL REFERENCES team(id), person_id INTEGER NOT NULL REFERENCES person(id));
    INSERT INTO team_member VALUES (1, 1, 2), (2, 1, 3), (3, 1, 4), (4, 1, 1);
    CREATE TABLE thread (id INTEGER PRIMARY KEY, title TEXT NOT NULL);
    INSERT INTO thread VALUES (1, 'Solder fumes');
    CREATE TABLE post (id INTEGER PRIMARY KEY, thread_id INTEGER NOT NULL REFERENCES thread(id), body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open');`);
  provisionSqliteInbox(file);
  const registry = new Registry();
  registry.add({ id: owner, name: 'Mentions', url: file, source: 'config', writable: true });
  const app = parseAppConfig(definition(post), 'mentions fixture');
  let current: Person = 'ann';
  const host: AppHost = {
    app: { path: 'mentions-fixture.ts', app, pages: [], sources: {} },
    pages: [],
    auth: {
      spec: app.auth!,
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
  try {
    await run({
      db,
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
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    clearJournal(owner);
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

const told = (db: DatabaseSync) =>
  db
    .prepare(`SELECT recipient FROM "${INBOX_TABLES.notice}" ORDER BY id`)
    .all()
    .map((row) => String(row.recipient));

test('a rich text mention tells the person its stored handle names, never the words drawn in it', async () =>
  fixture(async ({ post, as, db }) => {
    const reply = await post('/api/insert', {
      table: 'post',
      // "@3" is words here, and the span's "@Cat" is how Bob's mention reads: neither is a handle.
      values: { thread_id: 1, body: `<p>${mention(2, 'Cat')} please look, and @3 too.</p>` },
    });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.deepEqual(told(db), ['bob@example.test']);
    as('bob');
    const inbox = await post('/api/inbox', {});
    assert.deepEqual(
      inbox.body.notices.map((notice: { title: string; key: unknown }) => [notice.title, notice.key]),
      [['You were mentioned in Solder fumes', { id: 1 }]],
    );
  }));

test('a person who cannot read the record is never shown a mention of them', async () =>
  fixture(async ({ post, as, db }) => {
    assert.equal((await post('/api/insert', { table: 'post', values: { thread_id: 1, body: `<p>${mention(4, 'Oz')}</p>` } })).status, 200);
    as('oz');
    const inbox = await post('/api/inbox', {});
    assert.deepEqual({ notices: inbox.body.notices, unread: inbox.body.unread }, { notices: [], unread: 0 });
    // Kept, as every notice is, and shown only while its record is theirs to read.
    assert.deepEqual(told(db), ['oz@example.test']);
  }));

test('an edit tells only whom it newly mentions; saving the same words again tells nobody', async () =>
  fixture(async ({ post, db }) => {
    const first = await post('/api/insert', { table: 'post', values: { thread_id: 1, body: `<p>${mention(2, 'Bob')}</p>` } });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const key = first.body.key ?? { id: 1 };
    assert.deepEqual(told(db), ['bob@example.test']);
    const again = await post('/api/update', { table: 'post', key, values: { body: `<p>${mention(2, 'Bob')} and more words</p>` } });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.deepEqual(told(db), ['bob@example.test'], 'Bob is mentioned already');
    assert.equal(
      (await post('/api/update', { table: 'post', key, values: { body: `<p>${mention(2, 'Bob')} ${mention(3, 'Cat')}</p>` } })).status,
      200,
    );
    assert.deepEqual(told(db), ['bob@example.test', 'cat@example.test']);
    // A change to another column tells nobody of the mentions the body already held.
    assert.equal((await post('/api/update', { table: 'post', key, values: { status: 'closed' } })).status, 200);
    assert.deepEqual(told(db), ['bob@example.test', 'cat@example.test']);
  }));

test('a record the rule comes to hold of tells everyone it mentions then, once', async () =>
  fixture(
    async ({ post, db }) => {
      const first = await post('/api/insert', {
        table: 'post',
        values: { thread_id: 1, status: 'held', body: `<p>${mention(2, 'Bob')}</p>` },
      });
      assert.equal(first.status, 200, JSON.stringify(first.body));
      const key = first.body.key ?? { id: 1 };
      // Held for review: the rule does not hold of it, so nobody is told yet.
      assert.deepEqual(told(db), []);
      assert.equal((await post('/api/update', { table: 'post', key, values: { status: 'open' } })).status, 200);
      assert.deepEqual(told(db), ['bob@example.test']);
      // Another change while it stays open tells nobody again.
      assert.equal(
        (await post('/api/update', { table: 'post', key, values: { body: `<p>${mention(2, 'Bob')}, thanks</p>` } })).status,
        200,
      );
      assert.deepEqual(told(db), ['bob@example.test']);
    },
    {
      notify: [
        {
          on: 'update',
          when: 'status = open',
          mentions: { in: 'body' },
          title: 'You were mentioned in {thread_id.title}',
          opens: 'thread_id',
        },
      ],
    },
  ));

test('a team mentioned tells its members, never the writer, and survives the sanitizer', async () =>
  fixture(async ({ post, as, db }) => {
    const reply = await post('/api/insert', {
      table: 'post',
      values: { thread_id: 1, body: `<p>${mention(1, 'Bench', true)} ${mention(2, 'Empty', true)}</p>` },
    });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.match(String(db.prepare('SELECT body FROM post').get()!.body), /data-kind="group"/);
    // Ann is in the team and wrote it; Oz is told and cannot read it.
    assert.deepEqual(told(db).sort(), ['bob@example.test', 'cat@example.test', 'oz@example.test']);
    as('oz');
    assert.deepEqual((await post('/api/inbox', {})).body.notices, []);
  }));

test('the rule and the display rule must mean one thing by a mention, and a team must say who is in it', () => {
  const problems = (post: Record<string, unknown>) => {
    const app = parseAppConfig(definition(post), 'mentions fixture');
    const col = (name: string, type: string, references?: { table: string; column: string }) => ({
      name,
      type,
      nullable: name !== 'id',
      ...(name === 'id' ? { primaryKey: true } : {}),
      ...(references ? { references } : {}),
    });
    const table = (name: string, columns: ReturnType<typeof col>[]) => ({ id: name, name, schema: '', columns });
    const schema = {
      dialect: 'sqlite',
      tables: [
        table('person', [col('id', 'INTEGER'), col('name', 'TEXT'), col('email', 'TEXT')]),
        table('team', [col('id', 'INTEGER'), col('name', 'TEXT')]),
        table('team_member', [
          col('id', 'INTEGER'),
          col('team_id', 'INTEGER', { table: 'team', column: 'id' }),
          col('person_id', 'INTEGER', { table: 'person', column: 'id' }),
        ]),
        table('thread', [col('id', 'INTEGER'), col('title', 'TEXT')]),
        table('post', [
          col('id', 'INTEGER'),
          col('thread_id', 'INTEGER', { table: 'thread', column: 'id' }),
          col('body', 'TEXT'),
          col('status', 'TEXT'),
        ]),
      ],
    };
    return appNotifyRules(app, schema as never).problems.join('\n');
  };
  assert.equal(problems({}), '');
  assert.match(
    problems({ notify: [{ on: 'insert', mentions: { in: 'body', by: 'name' }, title: 'x' }] }),
    /"mentions\.by" is "name", and post\.body's display rule stores a mention as "id"\. They must agree/,
  );
  assert.match(
    problems({
      display: { body: { format: 'richText', mentions: { from: 'team', by: 'id' } } },
      notify: [{ on: 'insert', mentions: { in: 'body' }, title: 'x' }],
    }),
    /offers mentions of "team", and a notice finds its person in person/,
  );
  assert.match(
    problems({
      display: { body: { format: 'richText', mentions: { from: 'person', by: 'id', groups: { from: 'team', by: 'id' } } } },
      notify: [{ on: 'insert', mentions: { in: 'body' }, title: 'x' }],
    }),
    /person has no reference to team, so who is in a team cannot be read\. Name the link rows with "through"/,
  );
  // A plain text column says its handle column; a rich one may take its display rule's.
  assert.match(problems({ display: {}, notify: [{ on: 'insert', mentions: { in: 'body' }, title: 'x' }] }), /"mentions" needs "by"/);
});

test('mentions are read the way the column keeps them', () => {
  const html = `<p>${mention('ada', 'Ada Lovelace')} ${mention('ops', 'Ops', true)} @bob</p>`;
  assert.deepEqual(richTextMentioned(html), { people: ['ada'], groups: ['ops'] });
  // A rich column with no teams declared tells no team; a plain column read rich when it holds a stored mention.
  assert.deepEqual(noticeMentions({ rich: true }, html), { people: ['ada'], groups: [] });
  assert.deepEqual(noticeMentions({}, html), { people: ['ada'], groups: [] });
  assert.deepEqual(noticeMentions({}, 'hi @bob and @cat'), { people: ['bob', 'cat'], groups: [] });
  // The sanitizer keeps a team's kind and nothing else in its place.
  assert.match(sanitizeRichText(`<p>${mention('ops', 'Ops', true)}</p>`), /data-kind="group"/);
  assert.doesNotMatch(sanitizeRichText('<p><span data-type="mention" data-id="ops" data-kind="admin">@Ops</span></p>'), /data-kind/);
});

/* People keyed by UUID with first and last names. A label of one column could not tell "Morgan Hughes"
   from "Morgan Tran", a template refused to load, and `by: 'email'` offered nobody — an email's "@" was not a handle,
   so every row was dropped in the browser, the mention stripped on save, and nobody told. */
const memberColumns = [
  { name: 'id', type: 'TEXT' },
  { name: 'first_name', type: 'TEXT' },
  { name: 'last_name', type: 'TEXT' },
  { name: 'email', type: 'TEXT' },
];

test("a mention's label is a column or a template of the people's own columns, and a column it lacks is named", () => {
  const rule = (label: string, by = 'id') => ({
    display: { body: { format: 'richText', mentions: { from: 'member', by, labelColumn: label } } },
    notify: [],
  });
  const col = (name: string, type: string) => ({ name, type, nullable: name !== 'id', primaryKey: name === 'id' });
  const table = (name: string, columns: ReturnType<typeof col>[]) => ({ id: name, name, schema: '', columns });
  const schema = {
    dialect: 'sqlite',
    tables: [
      table(
        'member',
        memberColumns.map((c) => col(c.name, c.type)),
      ),
      table('person', [col('id', 'INTEGER'), col('name', 'TEXT'), col('email', 'TEXT')]),
      table('team', [col('id', 'INTEGER'), col('name', 'TEXT')]),
      table('team_member', [col('id', 'INTEGER')]),
      table('thread', [col('id', 'INTEGER'), col('title', 'TEXT')]),
      table('post', [col('id', 'INTEGER'), col('thread_id', 'INTEGER'), col('body', 'TEXT'), col('status', 'TEXT')]),
    ],
  };
  const resolved = (label: string, by?: string) => resolveDisplay(parseAppConfig(definition(rule(label, by)), 'g91'), schema as never);
  const good = resolved('{first_name} {last_name}', 'email');
  assert.deepEqual(good.warnings, []);
  assert.deepEqual(good.display['post.body'].mentions, { from: 'member', by: 'email', labelColumn: '{first_name} {last_name}' });
  const bad = resolved('{first_name} {surname}');
  assert.match(
    bad.warnings.join('\n'),
    /mentions "labelColumn" "\{first_name\} \{surname\}" names "surname", which is not a column of "member"/,
  );
  assert.equal(bad.display['post.body'].mentions, undefined, 'no @ list that would fail at the first letter');
  assert.match(resolved('nickname').warnings.join('\n'), /"labelColumn" names "nickname", which is not a column of "member"/);
  // The template's grammar is a record label's: an open brace, a path through a reference, are said at load.
  assert.throws(() => parseAppConfig(definition(rule('{first_name')), 'g91'), /mentions\.labelColumn.*opens a "\{" it never closes/);
  assert.throws(() => parseAppConfig(definition(rule('{team_id.name}')), 'g91'), /\{team_id\.name\}.*the people's own columns/);
  // A command's rich text input takes the same label.
  const [field] = parseCommandInput(
    { body: { type: 'richText', mentions: { from: 'member', by: 'email', labelColumn: '{first_name} {last_name}' } } },
    'g91',
  );
  assert.deepEqual((field as { mentions?: unknown }).mentions, { from: 'member', by: 'email', labelColumn: '{first_name} {last_name}' });
  assert.throws(
    () => parseCommandInput({ body: { type: 'richText', mentions: { from: 'member', by: 'email', labelColumn: '{first_name' } } }, 'g91'),
    /never closes/,
  );
});

test('an @ finds people by any word of their label and by their handle, keyed by UUID or by email', async () =>
  fixture(async ({ post }) => {
    const offered = async (by: 'id' | 'email', typed: string) => {
      const source = { from: 'member', by, labelColumn: '{first_name} {last_name}' };
      const reply = await post('/api/run', { q: mentionQuery(source, typed, memberColumns), limit: 8, offset: 0, count: 'none' });
      assert.equal(reply.status, 200, JSON.stringify(reply.body));
      return (reply.body.rows as Array<Record<string, unknown>>).map((row) => [mentionLabelText(source, row), row[by]]);
    };
    for (const by of ['id', 'email'] as const) {
      // Any word's start, in any case: "Vic Ramos" and "Ann Victor", never "Eve Novick".
      assert.deepEqual(
        (await offered(by, 'vic')).map(([label]) => label),
        ['Ann Victor', 'Vic Ramos'],
        by,
      );
      assert.deepEqual(
        (await offered(by, 'Mor')).map(([label]) => label),
        ['Morgan Hughes', 'Morgan Tran'],
        by,
      );
      assert.deepEqual(
        (await offered(by, 'morgan t')).map(([label]) => label),
        ['Morgan Tran'],
        by,
      );
    }
    // The handle is looked for too: an email's start finds its person, and what is stored is the handle.
    assert.deepEqual(await offered('email', 'vramos'), [['Vic Ramos', 'vramos@example.test']]);
  }));

test('a person mentioned by email is kept through the sanitizer and told', () => {
  const html = `<p>${mention('vramos@example.test', 'Vic Ramos')} and ${mention('v.r+ops@example.test', 'Vic R')}</p>`;
  assert.equal(sanitizeRichText(html), html);
  assert.deepEqual(richTextMentioned(html).people, ['vramos@example.test', 'v.r+ops@example.test']);
  assert.deepEqual(noticeMentions({ rich: true }, html).people, ['vramos@example.test', 'v.r+ops@example.test']);
  // Still a handle, never markup: a quote or an angle bracket is not kept.
  assert.doesNotMatch(sanitizeRichText('<p><span data-type="mention" data-id="a&quot;b">@x</span></p>'), /data-id/);
});

test('a mention stored as an email tells that person', async () =>
  fixture(
    async ({ post, db }) => {
      const reply = await post('/api/insert', {
        table: 'post',
        values: { thread_id: 1, body: `<p>${mention('bob@example.test', 'Bob')} please look</p>` },
      });
      assert.equal(reply.status, 200, JSON.stringify(reply.body));
      assert.match(String(db.prepare('SELECT body FROM post').get()!.body), /data-id="bob@example\.test"/);
      assert.deepEqual(told(db), ['bob@example.test']);
    },
    { display: { body: { format: 'richText', mentions: { from: 'person', by: 'email', labelColumn: 'name' } } } },
  ));
