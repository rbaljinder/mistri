import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { appKeepsInbox, appNotifyRules, notifyAdvisories } from '../packages/mistri/src/shared/appNotify.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

/**
 * `notify` as the App says it: the parse refuses a rule it cannot read, and
 * the catalog every name that does not resolve — who is told must end at an
 * email, a title's words at a column, and a tenant App or one without
 * sign-in keeps no inbox at all.
 */
const col = (name: string, type = 'TEXT', extra: Record<string, unknown> = {}) => ({
  name,
  type,
  nullable: true,
  primaryKey: false,
  ...extra,
});
const schema: DatabaseSchema = {
  dialect: 'sqlite',
  tables: [
    {
      id: 'person',
      schema: '',
      name: 'person',
      columns: [col('id', 'INTEGER', { primaryKey: true, nullable: false }), col('email'), col('age', 'INTEGER'), col('account_id')],
    },
    {
      id: 'thread',
      schema: '',
      name: 'thread',
      columns: [
        col('id', 'INTEGER', { primaryKey: true, nullable: false }),
        col('title'),
        col('author_id', 'INTEGER', { references: { table: 'person', column: 'id' } }),
        col('photo', 'BLOB'),
      ],
    },
    {
      id: 'post',
      schema: '',
      name: 'post',
      columns: [
        col('id', 'INTEGER', { primaryKey: true, nullable: false }),
        col('thread_id', 'INTEGER', { references: { table: 'thread', column: 'id' } }),
        col('body'),
        col('watcher'),
      ],
    },
  ],
} as unknown as DatabaseSchema;

const app = (notify: unknown, extra: Record<string, unknown> = {}) =>
  parseAppConfig(
    {
      id: 'forum',
      name: 'Forum',
      connection: 'db',
      resources: {
        person: {},
        thread: { access: 'write', actions: { lock: { label: 'Lock', set: { title: 'x' } } } },
        post: { access: 'write', notify },
      },
      auth: { me: { from: 'person', column: 'email' }, roles: { member: { read: true } } },
      views: { posts: { kind: 'list', from: 'post' } },
      home: 'posts',
      nav: ['posts'],
      ...extra,
    },
    'notify fixture',
  );

test('a rule compiles to the paths the writer reads, a person reference ending at the email auth.me names', () => {
  const { rules, problems } = appNotifyRules(
    app([
      { on: 'insert', to: ['thread_id.author_id', 'watcher'], title: 'Reply in {thread_id.title}', opens: 'thread_id' },
      { on: { changes: ['body'] }, when: "watcher in ('a@example.test', 'b@example.test')", to: 'watcher', title: 'Edited' },
      { on: { action: 'lock' }, to: 'watcher', title: 'Locked' },
    ]),
    schema,
  );
  assert.deepEqual(problems, []);
  const [reply, edit, lock] = rules.get('post')!;
  assert.deepEqual(reply.to, [
    {
      column: 'thread_id',
      hops: [
        { table: 'thread', key: 'id', column: 'author_id' },
        { table: 'person', key: 'id', column: 'email' },
      ],
    },
    { column: 'watcher', hops: [] },
  ]);
  assert.deepEqual(reply.title, ['Reply in ', { column: 'thread_id', hops: [{ table: 'thread', key: 'id', column: 'title' }] }]);
  assert.deepEqual(reply.open, { resource: 'thread', key: { column: 'thread_id', target: 'id' } });
  assert.deepEqual(reply.uses.sort(), ['post.thread_id', 'thread.title']);
  assert.deepEqual(edit.on, { kind: 'update', columns: ['body'] });
  assert.deepEqual(edit.when, [[{ column: 'watcher', values: ['a@example.test', 'b@example.test'] }]]);
  assert.deepEqual(lock.on, { kind: 'action', label: 'Lock' });
});

test('every name that does not resolve is a problem naming the fix', () => {
  const said = (notify: unknown) => appNotifyRules(app(notify), schema).problems.join('\n');
  assert.match(said([{ on: 'insert', to: 'nobody', title: 'x' }]), /"nobody", which is not a column of post/);
  assert.match(said([{ on: 'insert', to: 'body.author_id', title: 'x' }]), /goes through "body", which references no table/);
  assert.match(said([{ on: 'insert', to: 'thread_id', title: 'x' }]), /holds no email\. It references thread/);
  assert.match(said([{ on: 'insert', to: 'thread_id.author_id.age', title: 'x' }]), /holds no email/);
  assert.match(said([{ on: 'insert', to: 'watcher', title: '{thread_id.photo}' }]), /holds bytes, not words/);
  assert.match(said([{ on: { changes: 'missing' }, to: 'watcher', title: 'x' }]), /"on.changes" names "missing"/);
  assert.match(said([{ on: { action: 'archive' }, to: 'watcher', title: 'x' }]), /no action's id/);
  assert.match(said([{ on: 'insert', to: 'watcher', title: 'x', when: 'nope = 1' }]), /"when"/);
  assert.match(said([{ on: 'insert', to: 'watcher', title: 'x', opens: 'body' }]), /"opens" names "body", which is not a reference/);
  const unwritten = parseAppConfig(
    {
      id: 'forum',
      name: 'Forum',
      connection: 'db',
      resources: { post: { notify: [{ on: 'insert', to: 'watcher', title: 'x' }] } },
      auth: { roles: { member: { read: true } } },
      views: { posts: { kind: 'list', from: 'post' } },
      home: 'posts',
      nav: ['posts'],
    },
    'unwritten',
  );
  assert.match(appNotifyRules(unwritten, schema).problems[0], /nothing writes post/);
  assert.throws(() => app([{ on: 'insert', to: 'watcher', title: 'x', open: 'thread_id' }]), /has "open", which is now "opens"/);
});

test('a rule that sends on a channel reads its address, consent and zone off the record, and may tell no inbox', () => {
  const { rules, problems } = appNotifyRules(
    app([
      {
        on: 'insert',
        title: 'Reply in {thread_id.title}',
        send: { channel: 'sms', to: 'thread_id.title', consent: 'watcher', timezone: 'body' },
      },
    ]),
    schema,
  );
  assert.deepEqual(problems, []);
  const [rule] = rules.get('post')!;
  assert.deepEqual(rule.to, []);
  assert.deepEqual(rule.send, {
    channel: 'sms',
    to: { column: 'thread_id', hops: [{ table: 'thread', key: 'id', column: 'title' }] },
    consent: { column: 'watcher', hops: [] },
    timezone: { column: 'body', hops: [] },
  });
  const said = (send: unknown) => appNotifyRules(app([{ on: 'insert', title: 'x', send }]), schema).problems.join('\n');
  assert.match(said({ channel: 'sms', to: 'thread_id' }), /"send.to" "thread_id" ends at post.thread_id, which is not a text column/);
  assert.match(said({ channel: 'sms', to: 'nobody' }), /"send.to" "nobody" names "nobody", which is not a column of post/);
  assert.throws(
    () => app([{ on: 'insert', title: 'x', send: { channel: 'SMS!', to: 'body' } }]),
    /"send.channel" is an integration's channel/,
  );
});

test('the parse refuses what it cannot read', () => {
  for (const [notify, pattern] of [
    [{ on: 'insert' }, /must be a list/],
    [[{ on: 'delete', to: 'watcher', title: 'x' }], /"on" is 'insert', 'update'/],
    [[{ on: 'insert', title: 'x' }], /"to" must be who is told/],
    [[{ on: 'insert', to: 'a.b.c.d', title: 'x' }], /at most two references/],
    [[{ on: 'insert', to: 'watcher' }], /needs a "title"/],
    [[{ on: 'insert', to: 'watcher', title: 'x'.repeat(201) }], /at most 200/],
    [[{ on: 'insert', to: 'watcher', title: '{a b}' }], /\{a b\} is not a column/],
    [[{ on: 'insert', to: 'watcher', title: 'x', recipient: 'y' }], /recipient/],
    [[{ on: 'insert', to: 'watcher', title: 'x', when: { watcher: [] } }], /"when" is a condition in the query language/],
  ] as const)
    assert.throws(() => app(notify), pattern as RegExp, JSON.stringify(notify));
});

test("a flow's rule tells the audience a notify step names, its {message} the step's words (G95)", () => {
  const flowing = (notify: unknown, flows = true) =>
    app(notify, {
      resources: {
        person: {},
        thread: { access: 'write' },
        post: { access: 'write', notify, ...(flows ? { flows: { from: 'post_flow', steps: 'post_step' } } : {}) },
        post_flow: { access: 'write' },
        post_step: { access: 'write' },
      },
    });
  const rule = { on: { flow: 'author' }, to: 'thread_id.author_id', title: 'Reply {id}: {message}' };
  const { rules, problems } = appNotifyRules(flowing([rule]), schema);
  assert.deepEqual(problems, []);
  const [compiled] = rules.get('post')!;
  assert.deepEqual(compiled.on, { kind: 'flow', audience: 'author' });
  assert.deepEqual(compiled.title, ['Reply ', { column: 'id', hops: [] }, ': ', { message: true }]);
  assert.match(
    appNotifyRules(flowing([rule], false), schema).problems.join(''),
    /"on.flow" is told by a flow's notify step, and post has no flows/,
  );
  assert.throws(() => flowing([{ ...rule, on: { flow: 'two words' } }]), /\{ flow: 'requester' \}/);
  assert.throws(() => flowing([{ ...rule, mentions: { in: 'body', by: 'email' } }]), /"mentions" tells whom a write's words name/);
});

test('an App without sign-in keeps no inbox and says so; a tenant App keeps one', () => {
  const unsigned = parseAppConfig(
    {
      id: 'forum',
      name: 'Forum',
      connection: 'db',
      resources: { post: { notify: [{ on: 'insert', to: 'watcher', title: 'x' }] } },
      views: { posts: { kind: 'list', from: 'post' } },
      home: 'posts',
      nav: ['posts'],
    },
    'unsigned',
  );
  assert.match(appNotifyRules(unsigned, schema).problems[0], /no sign-in/);
  const signed = app([{ on: 'insert', to: 'watcher', title: 'x' }]);
  const tenant = { ...signed, auth: { ...signed.auth!, rows: 'tenant' as const } };
  // Its notices are each kept in the inbox of the tenant whose record was written (tenant/tenantInbox.ts).
  assert.deepEqual(appNotifyRules(tenant, schema).problems, []);
  assert.equal(appKeepsInbox(tenant), true);
});

test("in a tenant App a person is told by account id, and the check says when auth.me's column cannot be one", () => {
  const signed = app([{ on: 'insert', to: ['thread_id.author_id', 'watcher'], title: 'x' }]);
  const tenant = { ...signed, auth: { ...signed.auth!, rows: 'tenant' as const } };
  // The person's column is an account id, which the writer tells at its email while a member; a text column stays an email.
  const [rule] = appNotifyRules(tenant, schema).rules.get('post')!;
  assert.deepEqual(
    rule.to.map((path) => path.account === true),
    [true, false],
  );
  assert.equal(rule.to[1].account, undefined);
  // auth.me names "email" in a tenant App: every person reached would be nobody, silently. Advice, not a refusal.
  assert.match(notifyAdvisories(tenant, schema)[0], /looks like an email column\. In a tenant App it holds each person's account id/);
  // An App's people hold emails: "email" is right there, and an id-like column is named.
  assert.deepEqual(notifyAdvisories(signed, schema), []);
  const byId = { ...signed, auth: { ...signed.auth!, me: { from: 'person', column: 'account_id' } } };
  assert.match(notifyAdvisories(byId, schema)[0], /"account_id" looks like an id\. A notice is told at the email that column holds/);
  assert.deepEqual(notifyAdvisories({ ...byId, auth: { ...byId.auth, rows: 'tenant' as const } }, schema), []);
});
