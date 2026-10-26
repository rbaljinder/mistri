/**
 * A record's tags in a served App (tagLists.ts): a list shows them and asks
 * `tags has`, under the reader's grants — a reader who may not read the link
 * rows is served no tags and cannot forge a view that reads them — and a New
 * form's record arrives with its tags in one transaction: a tag that cannot
 * be linked leaves no record behind, and a reader who may not add link rows
 * cannot send any.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { tagChips } from '../packages/engine/src/shared/tagLists.js';

type Reply = { status: number; body: any };

test("served: tags are listed, asked and written under the reader's grants", async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-tags-served-'));
  const file = join(directory, 'issues.db');
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE issue (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE label (id INTEGER PRIMARY KEY, name TEXT NOT NULL, tone TEXT);
    CREATE TABLE issue_label (id INTEGER PRIMARY KEY, issue_id INTEGER NOT NULL REFERENCES issue(id), label_id INTEGER NOT NULL REFERENCES label(id));
    INSERT INTO issue VALUES (1, 'Crash'), (2, 'Docs typo');
    INSERT INTO label VALUES (1, 'bug', 'bad'), (2, 'docs', 'info');
    INSERT INTO issue_label VALUES (1, 1, 1), (2, 2, 2);`);
  const registry = new Registry();
  registry.add({ id: 'issues', name: 'Issues', url: file, source: 'config', writable: true });
  const manifest = parseAppConfig(
    {
      id: 'issues-app',
      name: 'Issues',
      connection: 'issues',
      resources: {
        issue: { access: 'write', tags: { through: 'issue_label', to: 'label', toneOf: 'tone' } },
        label: {},
        issue_label: { access: 'write', delete: true },
      },
      // A triager tags; a reporter files issues and reads them, never the link rows.
      auth: {
        roles: {
          triager: { read: true, write: ['issue', 'issue_label'] },
          reporter: { read: ['issue', 'label'], write: ['issue'] },
          filer: { read: true, write: ['issue'] },
        },
      },
      views: { issues: { kind: 'list', from: 'issue', show: ['name', 'tags'], filters: ['tags'] } },
      home: 'issues',
      nav: ['issues'],
    },
    'tags served',
  );
  let role = 'triager';
  const host: AppHost = {
    app: { path: 'issues.ts', app: manifest, pages: [], sources: {} },
    pages: [],
    auth: {
      spec: manifest.auth!,
      store: 'not-used',
      handler: async () => {},
      close: async () => {},
      session: async () => ({ id: `account-${role}`, who: `${role}@example.test`, role }),
    },
  } as AppHost;
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], pages: [] });
  try {
    server.listen(0, bound.host);
    await once(server, 'listening');
    bound.port = (server.address() as { port: number }).port;
    const post = async (path: string, body: Record<string, unknown>): Promise<Reply> => {
      const res = await fetch(`http://${bound.host}:${bound.port}${path}`, {
        method: 'POST',
        signal: AbortSignal.timeout(5000),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app: 'issues-app', ...body }),
      });
      return { status: res.status, body: await res.json() };
    };
    const catalog = async () => {
      const res = await fetch(`http://${bound.host}:${bound.port}/api/schema?app=issues-app`);
      return ((await res.json()) as DatabaseSchema).tables.find((table) => table.id === 'issue')?.tags;
    };
    const chips = (reply: Reply) =>
      (reply.body.rows as Array<Record<string, unknown>> | undefined)?.map((row) => [
        row.name,
        tagChips(row.tags).map((chip) => chip.label),
      ]);

    // The triager: chips in a list, `has` as a condition.
    assert.equal((await catalog())?.through, 'issue_label');
    const listed = await post('/api/run', { q: 'issue show name, tags sort name', limit: 10 });
    assert.deepEqual(
      chips(listed),
      [
        ['Crash', ['bug']],
        ['Docs typo', ['docs']],
      ],
      JSON.stringify(listed.body),
    );
    const bugs = await post('/api/run', { q: 'issue show name, tags where tags has bug', limit: 10 });
    assert.deepEqual(chips(bugs), [['Crash', ['bug']]], JSON.stringify(bugs.body));
    const compared = await post('/api/run', { q: 'issue show name where tags = bug', limit: 10 });
    assert.equal(compared.body.rows, undefined, 'tags are asked with has, never compared');

    // A New form's record and its tags, in one transaction.
    const made = await post('/api/insert', { table: 'issue', values: { name: 'Slow start' }, tags: [1, 2] });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const id = made.body.key.id;
    assert.deepEqual(
      db
        .prepare('SELECT label_id FROM issue_label WHERE issue_id = ? ORDER BY label_id')
        .all(id)
        .map((row) => row.label_id),
      [1, 2],
    );
    const issues = () => (db.prepare('SELECT count(*) AS n FROM issue').get() as { n: number }).n;
    const before = issues();
    const broken = await post('/api/insert', { table: 'issue', values: { name: 'Orphan' }, tags: [1, 99] });
    assert.ok(broken.body.errors?.length, JSON.stringify(broken.body));
    assert.equal(issues(), before, 'a tag that cannot be linked leaves no record behind');
    assert.equal((await post('/api/insert', { table: 'issue', values: { name: 'Bad' }, tags: 'bug' })).status, 400);
    assert.equal(
      (await post('/api/insert', { table: 'issue_label', values: { issue_id: 1, label_id: 2 }, tags: [1] })).status,
      400,
      'a resource without tags takes none',
    );

    // The filer reads the tags but may not add link rows: none sent with a record.
    role = 'filer';
    assert.equal((await post('/api/insert', { table: 'issue', values: { name: 'Untagged' }, tags: [1] })).status, 403);

    // The reporter: no tags served, none read through a forged view, none written.
    role = 'reporter';
    assert.equal(await catalog(), undefined);
    const hidden = await post('/api/run', { q: 'issue show name, tags', limit: 10 });
    assert.equal(hidden.body.rows, undefined, JSON.stringify(hidden.body));
    const forged = await post('/api/view/run', {
      count: 'none',
      view: {
        id: 'x',
        name: 'x',
        base: 'issue',
        columns: [{ path: 'name' }, { path: 'tags' }],
        tagged: {
          tags: { through: 'issue_label', from: 'issue_id', key: 'id', to: 'label', via: 'label_id', tagKey: 'id', label: 'name', on: '' },
        },
      },
    });
    assert.equal(forged.body.rows, undefined, JSON.stringify(forged.body));
    const refused = await post('/api/insert', { table: 'issue', values: { name: 'Untagged' }, tags: [1] });
    // Its catalog has no link table, so the resource carries no tags for it at all.
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    assert.equal(db.prepare("SELECT count(*) AS n FROM issue WHERE name = 'Untagged'").get()!.n, 0);
    assert.equal(
      (await post('/api/insert', { table: 'issue', values: { name: 'Untagged' } })).status,
      200,
      "the record alone is the reporter's to add",
    );
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
