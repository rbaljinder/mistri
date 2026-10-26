/**
 * `me` where people's emails are kept from each other: a role whose field
 * grant leaves the email column out still reads "mine" — the server finds
 * the reader's own row by their verified email, and the reader only learns
 * the key of a row it can see — while no request of theirs may filter or
 * read by anyone's email, and a role that reads no people has no row.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';

const connection = 'me-private-connection';
const appId = 'me-private';

test(
  "a reader who may not read people's emails still reads what is theirs, and nothing by anyone's email",
  { timeout: 20_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tablewalk-app-me-private-'));
    const path = join(directory, 'forum.db');
    const db = new DatabaseSync(path);
    db.exec(`
    CREATE TABLE member (id INTEGER PRIMARY KEY, handle TEXT NOT NULL, email TEXT);
    CREATE TABLE post (id INTEGER PRIMARY KEY, body TEXT NOT NULL, author_id INTEGER NOT NULL REFERENCES member(id));
    INSERT INTO member VALUES (1, 'bo', 'bo@example.test'), (2, 'ada', 'ada@example.test');
    INSERT INTO post VALUES (1, 'First', 2), (2, 'Second', 1), (3, 'Third', 2);
  `);
    db.close();
    const registry = new Registry();
    registry.add({ id: connection, name: 'Forum', url: path, source: 'config', writable: true });
    const manifest = parseAppConfig(
      {
        id: appId,
        name: 'Forum',
        connection,
        resources: { member: {}, post: { segments: { mine: 'author_id = me' } } },
        auth: {
          providers: ['email'],
          defaultRole: 'member',
          me: { from: 'member', column: 'email' },
          roles: {
            member: { read: true, fields: { member: { read: ['id', 'handle'] } } },
            stranger: { read: ['post'] },
          },
        },
        views: { posts: { kind: 'list', from: 'post', tabs: ['mine', { label: 'All' }] } },
        home: 'posts',
        nav: ['posts'],
      },
      'private me fixture',
    );
    let who: Identity = { id: 'account-ada', who: 'ada@example.test', role: 'member' };
    const host: AppHost = {
      app: { path: '/forum/app.ts', app: manifest, pages: [], sources: {} },
      pages: [],
      auth: {
        spec: manifest.auth!,
        store: join(directory, 'sessions.db'),
        handler: async () => {},
        close: async () => {},
        session: async () => who,
      },
    };
    const bound = { host: '127.0.0.1', port: 0 };
    const server = createApp({ registry, bound, apps: [host], pages: [] });
    try {
      server.listen(0, bound.host);
      await once(server, 'listening');
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      const run = async (q: string) => {
        const response = await fetch(`http://${bound.host}:${address.port}/api/run`, {
          signal: AbortSignal.timeout(5_000),
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ app: appId, q, exactCount: true }),
        });
        return { status: response.status, body: await response.json() };
      };
      const ids = async (q: string) => {
        const { body } = await run(q);
        assert.deepEqual(body.errors ?? [], [], q);
        return (body.rows as Array<{ id: number }>).map((row) => row.id).sort();
      };
      assert.deepEqual(await ids('post author_id = me'), [1, 3], 'Ada is member 2, found by her own verified email');
      // Her "Mine" tab is served, not a view broken for want of an email column she may not read.
      const served = await (
        await fetch(`http://${bound.host}:${address.port}/api/app?app=${appId}`, { signal: AbortSignal.timeout(5_000) })
      ).json();
      assert.equal(served.app.views.posts.error, undefined, JSON.stringify(served.app.views.posts));
      assert.deepEqual(
        served.app.views.posts.tabs.map((tab: { label: string }) => tab.label),
        ['Mine', 'All'],
      );
      // Her grant still reads no one's email: not through a path, not as a filter, not as a column.
      for (const q of ['post author_id.email = "bo@example.test"', 'member email = "bo@example.test"', 'post author_id.email = me']) {
        const refused = await run(q);
        assert.ok(refused.status >= 400 || refused.body.errors?.length, `${q}: ${JSON.stringify(refused.body)}`);
        assert.doesNotMatch(JSON.stringify(refused.body), /bo@example\.test.*"rows":\[\{/);
      }
      const members = await run('member');
      assert.doesNotMatch(JSON.stringify(members.body), /@example\.test/, 'no email in what she reads');
      // Signed in as nobody the forum knows: nothing is theirs.
      who = { id: 'account-new', who: 'new@example.test', role: 'member' };
      assert.deepEqual(await ids('post author_id = me'), []);
      // A role that reads no members at all has no row, whoever it is.
      who = { id: 'account-ada', who: 'ada@example.test', role: 'stranger' };
      const stranger = await run('post author_id = me');
      assert.deepEqual(
        (stranger.body.rows ?? []).map((row: { id: number }) => row.id),
        [],
      );
    } finally {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
      await registry.closeAll();
      clearJournal(connection);
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
