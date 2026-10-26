/**
 * Command field authorization: a role whose field grant leaves members'
 * emails out (Commons) may still be granted a command that reads the member
 * table. The command's handler reads the row whole — it is the App's own
 * server code — while every generic read of that role, the reply included,
 * stays narrowed: no column, no filter, no path by anyone's email.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { parseTestApp } from './support/commandCatalog.js';

const appId = 'forum';

test("a member runs a command that reads members whole, and reads no other member's email", { timeout: 20_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-command-fields-'));
  const file = join(directory, 'forum.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE member (id INTEGER PRIMARY KEY, handle TEXT NOT NULL, account_id TEXT, email TEXT, version INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE post (id INTEGER PRIMARY KEY, author_id INTEGER NOT NULL REFERENCES member(id), body TEXT NOT NULL);
    INSERT INTO member VALUES (1, 'bo', 'account-bo', 'bo@example.test', 0), (2, 'ada', 'account-ada', 'ada@example.test', 0);`);
  migrateSqliteCommandJournal(file);
  const registry = new Registry();
  registry.add({ id: 'forum-db', name: 'Forum', url: file, writable: true, source: 'config' });
  const app = parseTestApp(
    {
      id: appId,
      name: 'Forum',
      sources: { forum: { connection: 'forum-db', default: true } },
      resources: {
        member: { access: 'write', actions: { wave: { label: 'Wave', command: { id: 'wave', version: 1, target: 'member', input: {} } } } },
        post: { access: 'write' },
      },
      auth: {
        roles: {
          member: { read: true, commands: ['wave'], fields: { member: { read: ['id', 'handle', 'account_id', 'version'] } } },
        },
      },
      views: { members: { kind: 'list', from: 'member' } },
      home: 'members',
      nav: ['members'],
    },
    'command fields fixture',
  );
  const seen: unknown[] = [];
  const commands = defineCommands({
    wave: defineCommand({
      source: 'forum',
      target: 'member',
      read: ['member'],
      write: ['post'],
      input: {},
      output: { parse: (value: unknown) => value as { message: string } },
      async handle({ db: tables, record, actor }) {
        // The handler is trusted code: it reads the row whole, email included.
        seen.push(record.email);
        const me = await tables.member.find({ account_id: actor.id });
        await tables.post.insert({ author_id: me!.id, body: `Waved at ${String(record.handle)}` });
        return { message: 'Waved.' };
      },
    }),
  });
  const who: Identity = { id: 'account-ada', who: 'ada@example.test', role: 'member' };
  const host: AppHost = {
    app: { app, path: join(directory, 'app.ts'), pages: [], sources: {} },
    pages: [],
    auth: {
      spec: app.auth!,
      store: join(directory, 'auth.db'),
      close() {},
      handler: async () => {},
      session: async () => who,
    },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], commands: { appId, registry: commands } });
  try {
    server.listen(0, bound.host);
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://${bound.host}:${address.port}`;
    const post = async (path: string, body: Record<string, unknown>) => {
      const response = await fetch(`${base}${path}`, {
        method: 'POST',
        signal: AbortSignal.timeout(5_000),
        headers: { 'content-type': 'application/json', 'x-mistri-account': who.id },
        body: JSON.stringify(path.startsWith('/api/commands/') ? body : { app: appId, ...body }),
      });
      return { status: response.status, body: await response.json() };
    };

    const waved = await post('/api/commands/execute', {
      command: 'wave',
      commandVersion: 1,
      key: { id: 1 },
      expectedVersion: 0,
      idempotencyKey: 'wave-request-0001',
      input: {},
    });
    assert.equal(waved.status, 200, JSON.stringify(waved.body));
    assert.deepEqual(seen, ['bo@example.test']);
    assert.equal(JSON.stringify(waved.body).includes('@example.test'), false, 'the reply carries the declared output only');

    // Her generic reads are narrowed: the column is not served, and nothing reads by it.
    const listed = await post('/api/run', { q: 'member', exactCount: true });
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.equal(listed.body.rows.length, 2);
    assert.equal(JSON.stringify(listed.body).includes('@example.test'), false, JSON.stringify(listed.body));
    for (const q of ['member email = "bo@example.test"', 'member show email', 'post author_id.email = "bo@example.test"']) {
      const refused = await post('/api/run', { q });
      assert.ok(refused.status >= 400 || refused.body.errors?.length, `${q}: ${JSON.stringify(refused.body)}`);
      assert.equal(JSON.stringify(refused.body).includes('bo@example.test') && !refused.body.errors?.length, false, q);
    }
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
