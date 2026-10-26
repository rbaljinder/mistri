/**
 * A command's `when` that says `me` (`when: 'owner = me'`, a "my records"
 * verb its bulk action carries) is judged for the actor everywhere it is
 * judged (commandWhen.ts whenPerson): a selection's prepare
 * (commandTargets.ts), availability, and the run — so the actor's rows are
 * eligible under `owner = me`, everyone else's under `owner != me`. Both
 * shapes of `me`: a text column holding the email, and a reference to the
 * people table (`auth.me`) the command reads.
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
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { parsePagesConfig } from '../packages/engine/src/shared/page.js';
import { catalogOf } from './support/commandCatalog.js';

const agent: Identity = { id: 'account-agent', who: 'ada@example.test', role: 'agent' };
const KEYS = [1, 2, 3, 4, 5];

interface Shape {
  name: string;
  column: string;
  /** The people table, where `me` is a row of it. */
  people: boolean;
  schema: string;
}

const shapes: Shape[] = [
  {
    name: 'a text column holding the email',
    column: 'owner',
    people: false,
    schema: `CREATE TABLE ticket (id INTEGER PRIMARY KEY, title TEXT NOT NULL, owner TEXT, status TEXT NOT NULL DEFAULT 'open');
      INSERT INTO ticket (id, title, owner) VALUES (1, 'Printer', 'ada@example.test'), (2, 'Laptop', 'grace@example.test'),
        (3, 'Badge', 'ada@example.test'), (4, 'Desk', NULL), (5, 'Chair', 'linus@example.test');`,
  },
  {
    name: 'a reference to the people table',
    column: 'owner_id',
    people: true,
    schema: `CREATE TABLE person (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE);
      INSERT INTO person (id, email) VALUES (10, 'grace@example.test'), (11, 'ada@example.test'), (12, 'linus@example.test');
      CREATE TABLE ticket (id INTEGER PRIMARY KEY, title TEXT NOT NULL, owner_id INTEGER REFERENCES person(id), status TEXT NOT NULL DEFAULT 'open');
      INSERT INTO ticket (id, title, owner_id) VALUES (1, 'Printer', 11), (2, 'Laptop', 10), (3, 'Badge', 11), (4, 'Desk', NULL), (5, 'Chair', 12);`,
  },
];

for (const shape of shapes) {
  test(`a command's when reads me as the actor in a selection's prepare, availability and the run: ${shape.name}`, async () => {
    // The command's own `when`, which its bulk action carries: a "my records" verb and its opposite.
    const when = { claim: `${shape.column} = me`, nudge: `${shape.column} != me` };
    const commands = Object.keys(when);
    const directory = mkdtempSync(join(tmpdir(), 'tablewalk-bulk-me-'));
    const file = join(directory, 'desk.db');
    const db = new DatabaseSync(file);
    db.exec(shape.schema);
    migrateSqliteCommandJournal(file);
    clearJournal('desk-db');
    const connections = new Registry();
    connections.add({ id: 'desk-db', name: 'Desk', url: file, writable: true, source: 'config' });
    const manifest = parseAppConfig(
      {
        id: 'desk',
        name: 'Desk',
        sources: { desk: { connection: 'desk-db', default: true } },
        resources: {
          ticket: {
            access: 'write',
            actions: {
              claim: { label: 'Close mine', command: 'claim', bulk: true },
              nudge: { label: 'Nudge owners', command: 'nudge', bulk: true },
            },
          },
          ...(shape.people ? { person: {} } : {}),
        },
        auth: {
          providers: ['email'],
          ...(shape.people ? { me: { from: 'person', column: 'email' } } : {}),
          roles: { agent: { read: true, commands } },
        },
        views: { tickets: { kind: 'list', from: 'ticket' } },
        home: 'tickets',
        nav: ['tickets'],
      },
      'bulk me',
      {
        commands: catalogOf(
          Object.fromEntries(Object.entries(when).map(([id, text]) => [id, { target: 'ticket', targets: 'many', when: text }])),
        ),
      },
    );
    const command = (text: string) =>
      defineCommand({
        source: 'desk',
        target: 'ticket',
        targets: 'many',
        when: text,
        // The people table is read where `me` is a row of it, as a handler's `me` needs (binding.people).
        ...(shape.people ? { read: ['person'] } : {}),
        async handle(context: unknown) {
          const { db, records } = context as {
            db: { ticket: { update(row: object, values: object): Promise<unknown> } };
            records: object[];
          };
          for (const record of records) await db.ticket.update(record, { status: 'done' });
        },
      } as Parameters<typeof defineCommand>[0]);
    const pages = parsePagesConfig({ pages: [] }, 'bulk me pages');
    const host: AppHost = {
      app: { app: manifest, path: '/private/desk/app.ts', pages, sources: {} },
      pages,
      auth: { spec: manifest.auth!, store: '/private/desk/auth.db', close() {}, handler: async () => {}, session: async () => agent },
    };
    const bound = { host: '127.0.0.1', port: 0 };
    const server = createApp({
      registry: connections,
      bound,
      apps: [host],
      pages,
      commands: { appId: 'desk', registry: defineCommands({ claim: command(when.claim), nudge: command(when.nudge) }) },
    });
    server.listen(0, bound.host);
    await once(server, 'listening');
    bound.port = (server.address() as { port: number }).port;
    const post = async (path: string, body: object) => {
      const response = await fetch(`http://${bound.host}:${bound.port}${path}`, {
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
        headers: { 'content-type': 'application/json', 'x-mistri-account': agent.id },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as Record<string, any> };
    };
    const prepare = async (name: string, ids = KEYS) => {
      const answer = await post('/api/commands/prepare', { command: name, commandVersion: 1, keys: ids.map((id) => ({ id })) });
      assert.equal(answer.status, 200, JSON.stringify(answer.body));
      return answer.body.targets as { key: { id: number }; expectedVersion: number | null; eligible: boolean }[];
    };
    const eligible = async (name: string) => (await prepare(name)).filter((target) => target.eligible).map((target) => target.key.id);
    const available = async (name: string) => {
      const answer = await post('/api/commands/availability', {
        checks: [{ command: name, commandVersion: 1, keys: KEYS.map((id) => ({ id })) }],
      });
      assert.equal(answer.status, 200, JSON.stringify(answer.body));
      return KEYS.filter((_, index) => answer.body.checks[0].available[index]);
    };
    let requests = 0;
    const run = async (name: string, ids: number[]) => {
      const targets = await prepare(name, ids);
      return post('/api/commands/execute', {
        command: name,
        commandVersion: 1,
        keys: ids.map((id) => ({ id })),
        expectedVersions: targets.map((target) => target.expectedVersion ?? 0),
        idempotencyKey: `bulk-me-request-${String(++requests).padStart(4, '0')}`,
        input: {},
      });
    };
    const status = (id: number) => (db.prepare('SELECT status FROM ticket WHERE id = ?').get(id) as { status: string }).status;
    try {
      assert.deepEqual(await eligible('claim'), [1, 3]);
      // An empty owner is nobody's, so `!=` leaves it out, as the query language always does.
      assert.deepEqual(await eligible('nudge'), [2, 5]);
      assert.deepEqual(await available('claim'), [1, 3]);
      assert.deepEqual(await available('nudge'), [2, 5]);
      // The run judges the same `me`: someone else's record is refused, the actor's own are done.
      const refused = await run('claim', [1, 2]);
      assert.equal(refused.body.code, 'ineligible_state', JSON.stringify(refused.body));
      assert.equal(status(1), 'open');
      const done = await run('claim', [1, 3]);
      assert.equal(done.status, 200, JSON.stringify(done.body));
      assert.deepEqual([status(1), status(2), status(3)], ['done', 'open', 'done']);
    } finally {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
      db.close();
      await connections.closeAll();
      clearJournal();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
