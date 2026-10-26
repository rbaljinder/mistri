import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { appTagRules, parseAppConfig, resolveResources } from '../packages/mistri/src/shared/app.js';
import { catalogOf } from './support/commandCatalog.js';

/* Issues carry labels through a link table; the other tables are the shapes a
   link table must not have: no key, or two references to the same side. */
const SQL = `CREATE TABLE issue (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE label (id INTEGER PRIMARY KEY, name TEXT NOT NULL, tone TEXT);
  CREATE TABLE issue_label (id INTEGER PRIMARY KEY, issue_id INTEGER NOT NULL REFERENCES issue(id), label_id INTEGER NOT NULL REFERENCES label(id));
  CREATE TABLE twice (id INTEGER PRIMARY KEY, a INTEGER REFERENCES issue(id), b INTEGER REFERENCES issue(id), label_id INTEGER REFERENCES label(id));`;
const commands = catalogOf({
  tagIssue: { target: 'issue', input: { tag: { type: 'text' } } },
  untagIssue: { target: 'issue', input: { tag: { type: 'text' } } },
  closeIssues: { target: 'issue', targets: 'many', input: { tag: { type: 'text' } } },
  renameLabel: { target: 'label', input: { tag: { type: 'text' } } },
  touchIssue: { target: 'issue' },
});
const app = (tags: unknown) =>
  parseAppConfig(
    {
      id: 'tags',
      name: 'Tags',
      resources: { issue: { access: 'write', tags }, label: {}, issue_label: { access: 'write', delete: true } },
      views: { issues: { kind: 'list', from: 'issue', label: 'Issues' } },
      home: 'issues',
      nav: ['issues'],
    },
    'tags fixture',
    { commands },
  );

async function catalog(t: import('node:test').TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-tags-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(join(directory, 'tags.db'));
  db.exec(SQL);
  db.close();
  const adapter = new SqliteAdapter(join(directory, 'tags.db'), 'tags');
  t.after(() => adapter.close());
  return adapter.introspect();
}

test('a tags block is checked where it is written', () => {
  assert.throws(() => app({ through: 'issue_label' }), /"tags" "to" must name the table of tags/);
  assert.throws(() => app({ through: 'issue_label', to: 'label', colour: 'tone' }), /colour/);
  assert.throws(() => app({ through: 'issue_label', to: 'label', toneOf: 'label.tone' }), /"toneOf" must name a column/);
  assert.throws(() => app({ through: 'label', to: 'label' }), /two tables/);
});

test("tags resolve to the link table, its two references and the tag's name, and are served with the resource", async (t) => {
  const schema = await catalog(t);
  const expected = {
    through: 'issue_label',
    to: 'label',
    from: 'issue_id',
    key: 'id',
    via: 'label_id',
    tagKey: 'id',
    label: 'name',
    tone: 'tone',
  };
  const resolved = appTagRules(app({ through: 'issue_label', to: 'label', toneOf: 'tone' }), schema);
  assert.deepEqual(resolved.problems, []);
  assert.deepEqual(resolved.rules.get('issue'), expected);
  assert.deepEqual(resolveResources(app({ through: 'issue_label', to: 'label', toneOf: 'tone' }), schema).resources.issue?.tags, expected);
});

test('a link table the server could not add to and remove from is a problem, and nothing is served', async (t) => {
  const schema = await catalog(t);
  const problems = (tags: unknown) => appTagRules(app(tags), schema).problems;
  assert.match(problems({ through: 'nope', to: 'label' })[0], /tags through "nope" is not a table/);
  assert.match(problems({ through: 'twice', to: 'label' })[0], /twice to reference issue by exactly one column; it does by 2/);
  assert.match(problems({ through: 'issue_label', to: 'label', toneOf: 'colour' })[0], /tags toneOf "colour" is not a column of label/);
  assert.equal(resolveResources(app({ through: 'twice', to: 'label' }), schema).resources.issue?.tags, undefined);
});

test('the query language asks tags with has, and has asks nothing else', async (t) => {
  const { withRollups } = await import('../packages/mistri/src/shared/appRollups.js');
  const { textToView } = await import('../packages/engine/src/shared/viewtext.js');
  const { parseQuery } = await import('../packages/engine/src/shared/query.js');
  const schema = withRollups(app({ through: 'issue_label', to: 'label', toneOf: 'tone' }), await catalog(t));
  const errors = (text: string) =>
    textToView(schema, text)
      .errors.map((error) => error.message)
      .join('\n');
  assert.equal(errors('issue show name, tags where tags has (bug, docs)'), '');
  assert.deepEqual(textToView(schema, 'issue where tags has (bug, docs)').view?.filter?.groups[0][0], {
    path: 'tags',
    op: 'has',
    value: ['bug', 'docs'],
  });
  assert.match(errors('issue where tags = bug'), /"tags" is a record's tags: ask it with has, as in tags has bug/);
  assert.match(errors('issue where name has bug'), /has/);
  assert.match(
    parseQuery('label where name has bug', { schema })
      .errors.map((error) => error.message)
      .join('\n'),
    /has/,
  );
});

test('tags may be put on and taken off through two commands on the record, each told the tag', () => {
  const parsed = app({ through: 'issue_label', to: 'label', add: 'tagIssue', remove: 'untagIssue' });
  const tags = parsed.resources!.issue!.tags!;
  assert.equal(tags.add?.id, 'tagIssue');
  assert.equal(tags.remove?.id, 'untagIssue');
  assert.throws(() => app({ through: 'issue_label', to: 'label', add: 'tagIssue' }), /names add alone/);
  assert.throws(
    () => app({ through: 'issue_label', to: 'label', add: 'closeIssues', remove: 'untagIssue' }),
    /must act on one issue record/,
  );
  assert.throws(() => app({ through: 'issue_label', to: 'label', add: 'renameLabel', remove: 'untagIssue' }), /acts on label/);
  assert.throws(() => app({ through: 'issue_label', to: 'label', add: 'touchIssue', remove: 'untagIssue' }), /takes no "tag" input/);
});
