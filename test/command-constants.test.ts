/**
 * The constants `now`, `today` and `me` in a command handler's writes
 * (`db.ticket.update(row, { closed_at: now, owner_id: me })`): each written in
 * its column's own format by the rule an action's `set` follows
 * (appStamps.ts) — the App's day, the moment as a zone-less column holds it,
 * text named for a moment on SQLite, the actor's email on text and their row
 * on a reference to the people table.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { me, now, today } from '@mistriwork/mistri/app';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { bindBusinessCommands } from '../packages/mistri/src/server/commands/businessCommandAccess.js';
import { executeBusinessCommand } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { defineCommand, defineCommands, type BusinessCommandActor } from '../packages/mistri/src/server/commands/businessCommands.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { refusalCause } from '../packages/engine/src/server/evidence.js';
import { parseTestApp } from './support/commandCatalog.js';

const NOW = new Date('2026-09-08T02:30:00Z');

test('a handler writes now, today and me in each column’s own format', { timeout: 10_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-command-constants-'));
  const path = join(directory, 'desk.db');
  const db = new DatabaseSync(path);
  const registry = new Registry();
  try {
    db.exec(`CREATE TABLE staff (id INTEGER PRIMARY KEY, email TEXT NOT NULL);
      CREATE TABLE ticket (id INTEGER PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0, closed_at TEXT, closed_on DATE,
        closed_by TEXT, owner_id INTEGER REFERENCES staff(id), note TEXT, stamped TIMESTAMP, day_said TEXT);
      INSERT INTO staff VALUES (7, 'ada@example.test');
      INSERT INTO ticket (id) VALUES (1);`);
    migrateSqliteCommandJournal(path);
    registry.add({ id: 'desk-db', name: 'desk', url: path, writable: true, source: 'config' });
    const app = parseTestApp(
      {
        id: 'desk',
        name: 'Desk',
        ui: { timezone: 'America/Los_Angeles' },
        sources: { desk: { connection: 'desk-db' } },
        resources: { ticket: { access: 'write' }, staff: {} },
        auth: { me: { from: 'staff', column: 'email' }, roles: { agent: { read: true, commands: ['close', 'scribble', 'stray'] } } },
        views: { tickets: { kind: 'list', from: 'ticket' } },
        home: 'tickets',
      },
      'constants fixture',
    );
    const commands = defineCommands({
      close: defineCommand({
        source: 'desk',
        target: 'ticket',
        read: ['staff'],
        input: {},
        output: { parse: (value: unknown) => value as { ok: true } },
        async handle(context) {
          const { db, record } = context;
          await db.ticket.update(record!, {
            closed_at: now,
            stamped: now,
            closed_on: today,
            closed_by: me,
            owner_id: me,
            // The handler's own day, in the App's zone as the stamp's is.
            day_said: context.today(),
          });
          return { ok: true as const };
        },
      }),
      // Returns a value and declares no output: refused at run time, and the owner is told what to declare.
      stray: defineCommand({
        source: 'desk',
        target: 'ticket',
        input: {},
        async handle() {
          return { ok: true } as never;
        },
      }),
      scribble: defineCommand({
        source: 'desk',
        target: 'ticket',
        input: {},
        output: { parse: (value: unknown) => value as { ok: true } },
        async handle({ db, record }) {
          await db.ticket.update(record!, { note: now });
          return { ok: true as const };
        },
      }),
    });
    const resources = await loadAppRuntimeResources(registry, app, 'desk-db');
    const binding = bindBusinessCommands({ app, resources, registry: commands, writableConnection: () => true });
    const run = (command: string, actor: BusinessCommandActor, version: number) =>
      executeBusinessCommand(
        binding,
        actor,
        {
          command,
          commandVersion: 1,
          key: { id: 1 },
          expectedVersion: version,
          input: {},
          idempotencyKey: `${command}-request-${actor.id}-${version}`,
        },
        { door: 'ui', now: () => NOW },
      );
    // An account that is nobody's row of staff has no row to write, and nothing is written.
    const said = (pattern: RegExp, code: string) => (error: unknown) => {
      assert.equal((error as { code?: string }).code, code);
      // The reason is kept for the owner, under each refusal that carried it.
      let reason: unknown = error;
      while (refusalCause(reason) !== undefined) reason = refusalCause(reason);
      assert.match(String((reason as Error).message), pattern);
      return true;
    };
    await assert.rejects(
      run('close', { id: 'm', appId: 'desk', roles: ['agent'], email: 'mallory@example.test' }, 0),
      said(/nobody's row/, 'forbidden'),
    );
    // A note is no moment: the constant is refused there, as an action's would be when the App loads.
    await assert.rejects(
      run('scribble', { id: 'a', appId: 'desk', roles: ['agent'], email: 'ada@example.test' }, 0),
      said(/"note" is TEXT, and the constant now/, 'temporarily_unavailable'),
    );
    await assert.rejects(
      run('stray', { id: 'a', appId: 'desk', roles: ['agent'], email: 'ada@example.test' }, 0),
      said(/returned a value but declares no output\. Declare `output: shape/, 'invalid_result'),
    );
    await run('close', { id: 'a', appId: 'desk', roles: ['agent'], email: 'ada@example.test' }, 0);
    assert.deepEqual(
      { ...db.prepare('SELECT closed_at, stamped, closed_on, day_said, closed_by, owner_id FROM ticket WHERE id = 1').get() },
      {
        // The App's wall clock and day: 7:30 pm on the 7th in Los Angeles, though it is the 8th in UTC.
        closed_at: '2026-09-07 19:30:00',
        // A TIMESTAMP holds no zone, so it holds the App's wall clock too, not the UTC instant.
        stamped: '2026-09-07 19:30:00',
        closed_on: '2026-09-07',
        day_said: '2026-09-07',
        closed_by: 'ada@example.test',
        owner_id: 7,
      },
    );
  } finally {
    await registry.closeAll();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
