/**
 * A record's tags as a column (tagLists.ts) on the engines an App runs on:
 * the same issues, the same chips, the same answers to `tags has` — one label
 * or any of a list, beside an ordinary condition whose value binds after the
 * tags' own — counted, and under a row scope on the tag table, which must
 * narrow the chips and the question exactly as it narrows a list of the tags.
 * On PostgreSQL, the catalog's text rules too (textRules.ts): a varchar's
 * length, and the two simple CHECK shapes a form can judge as someone types.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import type { Adapter } from '../packages/engine/src/adapters/adapter.js';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import type { AppDef } from '../packages/mistri/src/shared/appModel.js';
import { withRollups } from '../packages/mistri/src/shared/appRollups.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { tagChips } from '../packages/engine/src/shared/tagLists.js';
import { withViewComputed } from '../packages/engine/src/shared/view.js';
import { textToView } from '../packages/engine/src/shared/viewtext.js';
import { liveSkip } from './live.js';

type Names = { issue: string; label: string; link: string };
const SEED = [
  `INSERT INTO {issue} VALUES (1, 'Crash'), (2, 'Docs typo'), (3, 'Idle')`,
  `INSERT INTO {label} VALUES (1, 'bug', 'bad', 'north'), (2, 'docs', 'info', 'south'), (3, 'ui', NULL, 'north')`,
  `INSERT INTO {link} VALUES (1, 1, 1), (2, 1, 3), (3, 2, 2), (4, 2, 1)`,
];
const seed = (names: Names) =>
  SEED.map((sql) => sql.replace('{issue}', names.issue).replace('{label}', names.label).replace('{link}', names.link));

async function proves(adapter: Adapter, raw: DatabaseSchema, issue: string, label: string, link: string) {
  const app = {
    resources: { [issue]: { tags: { through: link, to: label, toneOf: 'tone' } }, [label]: {}, [link]: {} },
  } as unknown as AppDef;
  const schema = withRollups(app, raw);
  assert.ok(schema.tables.find((table) => table.id === issue)!.tags, 'the catalog carries the tags');
  const run = async (text: string, reader: Pick<Adapter, 'runView' | 'countView'> = adapter) => {
    const parsed = textToView(schema, text);
    assert.deepEqual(parsed.errors, [], text);
    const view = withViewComputed(schema, parsed.view!);
    return { rows: (await reader.runView!(view)).rows, count: Number(await reader.countView!(view)) };
  };
  const chips = (rows: Array<Record<string, unknown>>) => rows.map((row) => [row.name, tagChips(row.tags).map((chip) => chip.label)]);

  const listed = await run(`${issue} show name, tags sort name`);
  assert.deepEqual(chips(listed.rows), [
    ['Crash', ['bug', 'ui']],
    ['Docs typo', ['bug', 'docs']],
    ['Idle', []],
  ]);
  assert.deepEqual(
    tagChips(listed.rows[0].tags),
    [{ label: 'bug', tone: 'bad' }, { label: 'ui' }],
    'a chip carries its tone where the tag has one',
  );

  const bugs = await run(`${issue} show name where tags has bug sort name`);
  assert.deepEqual(
    bugs.rows.map((row) => row.name),
    ['Crash', 'Docs typo'],
  );
  assert.equal(bugs.count, 2);
  const either = await run(`${issue} show name where tags has (docs, ui) sort name`);
  assert.deepEqual(
    either.rows.map((row) => row.name),
    ['Crash', 'Docs typo'],
    'any of the list',
  );
  // The tags' value binds before the name's: positional placeholders must stay in order.
  const both = await run(`${issue} show name, tags where tags has docs and name != 'Crash'`);
  assert.deepEqual(chips(both.rows), [['Docs typo', ['bug', 'docs']]]);
  assert.equal(both.count, 1);
  const none = await run(`${issue} show name where tags has nothing`);
  assert.deepEqual(none.rows, []);

  // A scope on the tags narrows the chips and the question as it narrows the tags themselves.
  if (adapter.scopeReads) {
    const north = await adapter.scopeReads({
      [issue]: true,
      [link]: true,
      [label]: { groups: [[{ column: 'tenant', op: '=', value: 'north' }]] },
    });
    const scoped = await run(`${issue} show name, tags sort name`, north);
    assert.deepEqual(chips(scoped.rows), [
      ['Crash', ['bug', 'ui']],
      ['Docs typo', ['bug']],
      ['Idle', []],
    ]);
    const docs = await run(`${issue} show name where tags has docs`, north);
    assert.deepEqual(docs.rows, []);
    assert.equal(docs.count, 0);
  }
}

describe('tags on SQLite', () => {
  let directory: string;
  let adapter: SqliteAdapter;
  before(() => {
    directory = mkdtempSync(join(tmpdir(), 'tablewalk-tags-live-'));
    const db = new DatabaseSync(join(directory, 'tags.db'));
    db.exec(`CREATE TABLE issue (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE label (id INTEGER PRIMARY KEY, name TEXT NOT NULL, tone TEXT, tenant TEXT NOT NULL);
      CREATE TABLE issue_label (id INTEGER PRIMARY KEY, issue_id INTEGER NOT NULL REFERENCES issue(id), label_id INTEGER NOT NULL REFERENCES label(id));`);
    for (const sql of seed({ issue: 'issue', label: 'label', link: 'issue_label' })) db.exec(sql);
    db.close();
    adapter = new SqliteAdapter(join(directory, 'tags.db'), 'tags');
  });
  after(async () => {
    await adapter?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  test('the same chips and answers here', async () => {
    await proves(adapter, await adapter.introspect(), 'issue', 'label', 'issue_label');
  });
});

const PG = process.env.TABLEWALK_TEST_PG;
describe('tags and text rules on PostgreSQL', { skip: liveSkip('postgres', PG) }, () => {
  const prefix = `tw_tags_${randomUUID().replaceAll('-', '').slice(0, 10)}_`;
  const names = { issue: `${prefix}issue`, label: `${prefix}label`, link: `${prefix}issue_label`, coded: `${prefix}coded` };
  let adapter: PostgresAdapter;
  type Client = { connect(): Promise<void>; query(text: string): Promise<unknown>; end(): Promise<void> };
  const client = async (): Promise<Client> => {
    const specifier = 'pg';
    const pg = (await import(specifier)) as {
      Client?: new (o: { connectionString: string }) => Client;
      default?: { Client: new (o: { connectionString: string }) => Client };
    };
    const Made = pg.Client ?? pg.default!.Client;
    const made = new Made({ connectionString: PG! });
    await made.connect();
    return made;
  };
  before(async () => {
    const db = await client();
    try {
      await db.query(`CREATE TABLE public.${names.issue} (id integer PRIMARY KEY, name text NOT NULL)`);
      await db.query(`CREATE TABLE public.${names.label} (id integer PRIMARY KEY, name text NOT NULL, tone text, tenant text NOT NULL)`);
      await db.query(`CREATE TABLE public.${names.link} (id integer PRIMARY KEY, issue_id integer NOT NULL REFERENCES public.${names.issue}(id),
        label_id integer NOT NULL REFERENCES public.${names.label}(id))`);
      for (const sql of seed({ issue: `public.${names.issue}`, label: `public.${names.label}`, link: `public.${names.link}` }))
        await db.query(sql);
      await db.query(`CREATE TABLE public.${names.coded} (id integer PRIMARY KEY,
        code varchar(3) NOT NULL CHECK (code ~ '^[A-Z]{3}$'),
        name varchar(80) NOT NULL CHECK (char_length(name) >= 2),
        note text CHECK (note ~ 'x'),
        free text CHECK (char_length(free) >= 2 AND free <> 'no'))`);
    } finally {
      await db.end();
    }
    adapter = new PostgresAdapter(PG!, 'tags');
  });
  after(async () => {
    await adapter?.close();
    const db = await client();
    try {
      await db.query(`DROP TABLE IF EXISTS public.${names.link}; DROP TABLE IF EXISTS public.${names.label};
        DROP TABLE IF EXISTS public.${names.issue}; DROP TABLE IF EXISTS public.${names.coded}`);
    } finally {
      await db.end();
    }
  });

  test('the same chips and answers here', async () => {
    const schema = await adapter.introspect();
    const id = (name: string) => schema.tables.find((table) => table.name === name)!.id;
    await proves(adapter, schema, id(names.issue), id(names.label), id(names.link));
  });

  test("a varchar's length and the simple CHECK shapes are the column's text rule; anything more is none", async () => {
    const schema = await adapter.introspect();
    const columns = schema.tables.find((table) => table.name === names.coded)!.columns;
    const text = (name: string) => columns.find((column) => column.name === name)!.text;
    assert.deepEqual(text('code'), { max: 3, pattern: '^[A-Z]{3}$' });
    assert.deepEqual(text('name'), { max: 80, min: 2 });
    assert.deepEqual(text('note'), { pattern: '[\\s\\S]*(?:x)[\\s\\S]*' }, 'an unanchored ~ matches anywhere');
    assert.equal(text('free'), undefined, 'a check that says more than a length is no rule');
  });
});
