/**
 * A timeline's reactions as the platform takes them: the shape the parser keeps, the three columns the check names
 * (each inferred only where there is one candidate, and asked for by key where there are none or several), the
 * entry's key read with its stream, and the App's own command, which an action of the entry's resource must offer
 * with the kind as its input.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePagesConfig, validatePage, type PageDef } from '../packages/engine/src/shared/page.js';
import { planPageSections } from '../packages/engine/src/shared/pagePlans.js';
import { resolvePageEmbeds } from '../packages/mistri/src/shared/appPages.js';
import { appProblems } from '../packages/mistri/src/server/app/apps.js';
import { parseTestApp } from './support/commandCatalog.js';
import type { PageTimeline } from '../packages/engine/src/shared/pageModel.js';
import type { ColumnMeta, DatabaseSchema, ForeignKey, TableMeta } from '../packages/engine/src/shared/schema.js';
import type { AppDef } from '../packages/mistri/src/shared/appModel.js';

const col = (name: string, type = 'TEXT', extra: Partial<ColumnMeta> = {}): ColumnMeta => ({
  name,
  type,
  nullable: true,
  primaryKey: false,
  ...extra,
});
const key = (name = 'id'): ColumnMeta => ({ name, type: 'INTEGER', nullable: false, primaryKey: true });
const table = (id: string, columns: ColumnMeta[]): TableMeta => ({ id, name: id, schema: 'main', columns, isView: false });
const fk = (from: string, column: string, to: string): ForeignKey => ({
  name: `${from}_${column}_fk`,
  from: { table: from, columns: [column] },
  to: { table: to, columns: ['id'] },
});
const KINDS = ['like', 'thanks', 'helpful'];

/* A forum: a thread's posts, and the reactions members give them. */
function forum({ reaction = [] as ColumnMeta[], keys = [] as ForeignKey[] } = {}): DatabaseSchema {
  return {
    label: 'forum',
    dialect: 'sqlite',
    readAt: '',
    tables: [
      table('thread', [key(), col('title')]),
      table('member', [key(), col('email'), col('display_name')]),
      table('post', [key(), col('thread_id', 'INTEGER'), col('author_id', 'INTEGER'), col('body'), col('created_at', 'TIMESTAMP')]),
      table('reaction', [
        key(),
        col('post_id', 'INTEGER'),
        col('member_id', 'INTEGER'),
        col('kind', 'TEXT', { allowed: [...KINDS, 'laugh'] }),
        col('created_at', 'TIMESTAMP'),
        ...reaction,
      ]),
    ],
    foreignKeys: [
      fk('post', 'thread_id', 'thread'),
      fk('post', 'author_id', 'member'),
      fk('reaction', 'post_id', 'post'),
      fk('reaction', 'member_id', 'member'),
      ...keys,
    ],
  };
}

const STREAM = { from: 'post', whose: 'thread_id', at: 'created_at', text: 'body', author: 'author_id.display_name' };
const REACTIONS = { from: 'reaction', kinds: KINDS, command: 'reactToPost' };

function threadPage(reactions: Record<string, unknown> = REACTIONS): PageDef {
  return parsePagesConfig(
    {
      pages: [
        { id: 'thread', label: 'Thread', base: 'thread', sections: [{ kind: 'timeline', title: 'Posts', streams: [STREAM], reactions }] },
      ],
    },
    'pages',
  )[0]!;
}
/* As the App loads it: the table people are rows of stamped on, as an App with `auth.me` does (appPages.ts). */
const withPerson = (page: PageDef, person = 'member'): PageDef =>
  resolvePageEmbeds({ views: {}, auth: { me: { from: person, column: 'email' } } } as unknown as AppDef, [page], 'test')[0]!;
const reactionsOf = (page: PageDef) => (page.sections[0] as PageTimeline).reactions;

describe('the reactions a timeline section takes', () => {
  test('keeps the shape as written, the optional columns only when named', () => {
    assert.deepEqual(reactionsOf(threadPage()), REACTIONS);
    assert.deepEqual(reactionsOf(threadPage({ ...REACTIONS, whose: ' post_id ', by: 'member_id', column: 'kind' })), {
      ...REACTIONS,
      whose: 'post_id',
      by: 'member_id',
      column: 'kind',
    });
  });

  test('refuses what it cannot draw, by name', () => {
    assert.throws(() => threadPage({ from: 'reaction', command: 'reactToPost' }), /reactions needs "kinds"/);
    assert.throws(() => threadPage({ ...REACTIONS, kinds: [] }), /reactions needs "kinds"/);
    assert.throws(() => threadPage({ ...REACTIONS, kinds: ['like', 'like'] }), /names "like" twice/);
    assert.throws(() => threadPage({ ...REACTIONS, kinds: 'abcdefghi'.split('') }), /at most 8/);
    assert.throws(() => threadPage({ kinds: KINDS, command: 'reactToPost' }), /reactions needs "from"/);
    assert.throws(() => threadPage({ from: 'reaction', kinds: KINDS }), /reactions needs "command"/);
    assert.throws(() => threadPage({ ...REACTIONS, whose: '' }), /reactions.whose is not a column's name/);
    assert.throws(() => threadPage({ ...REACTIONS, emoji: true }), /emoji/);
  });
});

describe('the columns the check names', () => {
  test('each is the one candidate, and the page is served with all three named', () => {
    const checked = validatePage(forum(), withPerson(threadPage()));
    assert.equal(checked.error, undefined);
    assert.deepEqual(reactionsOf(checked), { ...REACTIONS, whose: 'post_id', by: 'member_id', column: 'kind', person: 'member' });
  });

  test('two references to an entry ask for "whose"', () => {
    const schema = forum({ reaction: [col('quoted_id', 'INTEGER')], keys: [fk('reaction', 'quoted_id', 'post')] });
    assert.match(validatePage(schema, withPerson(threadPage())).error ?? '', /names no "whose", and "post_id", "quoted_id" could each be/);
    assert.equal(validatePage(schema, withPerson(threadPage({ ...REACTIONS, whose: 'post_id' }))).error, undefined);
  });

  test('a "whose" that is not a reference to an entry is refused', () => {
    assert.match(
      validatePage(forum(), withPerson(threadPage({ ...REACTIONS, whose: 'member_id' }))).error ?? '',
      /reactions.whose names "member_id", which does not refer to an entry/,
    );
  });

  test('a "whose" that refers to an entry by a column other than its primary key is refused, named or inferred', () => {
    // The post's slug is unique, so a reference to it is a reference to a post, but not by the key a press runs on.
    const bySlug = (): DatabaseSchema => {
      const schema = forum();
      schema.tables.find((each) => each.id === 'post')!.columns.push(col('slug', 'TEXT', { nullable: false }));
      return {
        ...schema,
        foreignKeys: schema.foreignKeys.map((each) =>
          each.from.table === 'reaction' && each.from.columns[0] === 'post_id'
            ? { ...each, to: { table: 'post', columns: ['slug'] } }
            : each,
        ),
      };
    };
    for (const page of [threadPage({ ...REACTIONS, whose: 'post_id' }), threadPage()])
      assert.match(
        validatePage(bySlug(), withPerson(page)).error ?? '',
        /reactions.whose "post_id" refers to post.slug, which is not post's primary key \(id\); a reaction is pressed on its entry by that key/,
      );
  });

  test('without auth.me, "by" is asked for; with it, two references to a person ask for it too', () => {
    assert.match(validatePage(forum(), threadPage()).error ?? '', /names no "by", and the App does not say which table people are rows of/);
    assert.equal(validatePage(forum(), threadPage({ ...REACTIONS, by: 'member_id' })).error, undefined);
    const schema = forum({ reaction: [col('on_behalf_of', 'INTEGER')], keys: [fk('reaction', 'on_behalf_of', 'member')] });
    assert.match(
      validatePage(schema, withPerson(threadPage())).error ?? '',
      /names no "by", and "member_id", "on_behalf_of" could each be/,
    );
  });

  test('a second text column that could hold the kinds asks for "column"; one that cannot is passed over', () => {
    const two = forum({ reaction: [col('mood')] });
    assert.match(validatePage(two, withPerson(threadPage())).error ?? '', /names no "column", and "kind", "mood" could each be/);
    assert.equal(validatePage(two, withPerson(threadPage({ ...REACTIONS, column: 'kind' }))).error, undefined);
    // A column whose database constraint leaves a kind out is no candidate.
    const narrow = forum({ reaction: [col('mood', 'TEXT', { allowed: ['calm'] })] });
    assert.equal(validatePage(narrow, withPerson(threadPage())).error, undefined);
  });

  test("a kind the column's constraint does not allow is named", () => {
    assert.match(
      validatePage(forum(), withPerson(threadPage({ ...REACTIONS, kinds: ['like', 'wow'], column: 'kind' }))).error ?? '',
      /reactions.kinds names "wow", which reaction.kind does not allow/,
    );
  });

  test('a table that is not there is said so', () => {
    assert.match(validatePage(forum(), withPerson(threadPage({ ...REACTIONS, from: 'nope' }))).error ?? '', /"reactions" reads "nope"/);
  });
});

describe('the stream a reaction is to', () => {
  test('reads the column its reactions name it by, and says which it is', () => {
    const checked = validatePage(forum(), withPerson(threadPage()));
    const [plan] = planPageSections(forum(), checked, { id: 1 }, {}, new Date(0)) as unknown as Array<{
      streams: Array<{ reacts?: string; view?: { columns?: Array<{ path: string }> } }>;
    }>;
    assert.equal(plan!.streams[0]!.reacts, 'id');
    assert.ok(plan!.streams[0]!.view!.columns!.some((column) => column.path === 'id'));
  });
});

describe("the reactions' command", () => {
  const schema = forum();
  const app = (actions: Record<string, unknown>) =>
    parseTestApp(
      {
        name: 'Forum',
        resources: { thread: {}, member: {}, reaction: {}, post: { access: 'write', actions } },
        auth: { me: { from: 'member', column: 'email' }, roles: { member: { read: true } } },
        views: { threads: { kind: 'list', from: 'thread' } },
        home: 'threads',
      },
      'forum',
    );
  const problems = (actions: Record<string, unknown>) => {
    const loaded = app(actions);
    const pages = resolvePageEmbeds(loaded, [threadPage()], 'forum');
    return appProblems({ path: '/apps/forum/app.ts', app: loaded, pages, sources: {} } as never, schema).filter((p) =>
      p.includes('reactions'),
    );
  };
  const react = (input: Record<string, unknown>, target = 'post') => ({
    react: { label: 'React', command: { id: 'reactToPost', target, input } },
  });

  test('is offered by an action of the entry, taking the kind', () => {
    assert.deepEqual(problems(react({ kind: { type: 'text' } })), []);
  });

  test('one no action offers is named, with the action to add', () => {
    assert.match(
      problems({}).join('\n'),
      /the reactions' command "reactToPost" is offered by no action of "post", the entry a reaction is to\. Add one to resources\.post\.actions: react: action\('React', \{ command: 'reactToPost' \}\)/,
    );
  });

  test('one that takes no input of the kind column is named', () => {
    assert.match(problems(react({ emoji: { type: 'text' } })).join('\n'), /takes no "kind" input/);
  });
});
