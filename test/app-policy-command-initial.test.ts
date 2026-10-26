/* A command's `initial` on the row-policy prepare path: the starting values
   are read in the principal's scoped command transaction, after the target is
   judged against the principal's rows, through the command's footprint, and
   they are served only as the declaration can hold them. A principal without
   the grant, or a target outside its rows, never reaches `initial`. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { COMMAND_JOURNAL_TABLES, migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { createAppPolicyContext, type AppPolicyContextOptions } from '../packages/mistri/src/server/policy/appPolicyContext.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { BusinessCommandExecutionError } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { defineCommand } from '../packages/mistri/src/server/commands/businessCommands.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import { parseTestApp } from './support/commandCatalog.js';

type Request = { role?: string };
type Mode = 'values' | 'outside' | 'undeclared' | 'mistyped' | 'unavailable';
const fields = {
  assignee: { label: 'Assignee', type: 'text', max: 40 },
  due_on: { label: 'Due', type: 'date', optional: true },
} as const;
const request = (id = 1) => ({ command: 'assign', commandVersion: 1, key: { id } });
const refused = (code: string) => (error: unknown) => {
  assert.ok(error instanceof BusinessCommandExecutionError);
  assert.equal(error.code, code);
  return true;
};

async function fixture(t: TestContext, mode: Mode) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-command-initial-'));
  const path = join(directory, 'initial.db');
  const db = new DatabaseSync(path);
  const registry = new Registry();
  t.after(async () => {
    try {
      await registry.closeAll();
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  db.exec(`
    CREATE TABLE loan (id INTEGER PRIMARY KEY, desk INTEGER NOT NULL, version INTEGER NOT NULL,
      assignee TEXT NOT NULL, due_on TEXT);
    CREATE TABLE secret (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
    INSERT INTO loan VALUES (1, 1, 7, '  Original  ', '2026-09-30'), (2, 2, 13, 'Hidden', NULL), (3, 1, 3, 'Sibling', NULL);
    INSERT INTO secret VALUES (1, 'Outside the footprint');
  `);
  await migrateSqliteCommandJournal(path);
  const before = JSON.stringify(db.prepare('SELECT * FROM loan ORDER BY id').all());
  const journal = () => Object.values(COMMAND_JOURNAL_TABLES).map((table) => db.prepare(`SELECT * FROM "${table}"`).all());
  const journalBefore = JSON.stringify(journal());
  const owner = 'private-initial-owner';
  registry.add({ id: owner, name: 'Initial fixture', url: path, writable: true, source: 'config' });
  const app = parseTestApp(
    {
      id: 'initial-policy',
      name: 'Initial policy',
      sources: { operations: { connection: owner, default: true } },
      resources: {
        loan: {
          access: 'write',
          actions: {
            assign: {
              label: 'Assign',
              command: {
                id: 'assign',
                version: 1,
                target: 'loan',
                input: fields,
              },
            },
          },
        },
        secret: {},
      },
      auth: { roles: { manager: { read: true, commands: ['assign'] }, viewer: { read: true } } },
      views: { loans: { kind: 'list', from: 'loan' } },
      home: 'loans',
      nav: ['loans'],
    },
    'initial fixture',
  );
  const resources = await loadAppRuntimeResources(registry, app, owner);
  const seen = { initials: 0, handles: 0, availability: 0, tx: [] as string[], frozen: false, expectedVersion: -1, hidden: -1 };
  const command = defineCommand({
    source: 'operations',
    target: 'loan',
    read: ['loan'],
    write: ['loan'],
    input: fields,
    ...(mode === 'unavailable'
      ? {
          availability: async (
            context: import('../packages/mistri/src/server/commands/businessCommands.js').BusinessCommandAvailabilityContext,
          ) => {
            seen.availability++;
            assert.equal('tx' in context, false);
            assert.equal(await context.db.loan.count({ id: 2 }), 0);
            return context.records.map(() => false);
          },
        }
      : {}),
    async initial(context) {
      seen.initials++;
      seen.tx = Reflect.ownKeys(context.tx).map(String).sort();
      seen.frozen = Object.isFrozen(context.tx);
      // The record is the one read at the revision prepare serves.
      seen.expectedVersion = Number(context.record.version);
      // The principal's rows bound what `initial` reads, as they bound execution.
      seen.hidden = (
        await context.tx.query({
          table: 'loan',
          columns: ['id'],
          limit: 5,
          offset: 0,
          filter: { groups: [[{ column: 'id', op: '=', value: 2 }]] },
        })
      ).rows.length;
      if (mode === 'outside') {
        await context.tx.query({
          table: 'secret',
          columns: ['body'],
          limit: 1,
          offset: 0,
          filter: { groups: [[{ column: 'id', op: '=', value: 1 }]] },
        });
      }
      const row = context.record;
      if (mode === 'undeclared') return { assignee: row.assignee, reviewer: 4 } as never;
      if (mode === 'mistyped') return { assignee: 42 } as never;
      return { assignee: row.assignee as string, ...(row.due_on ? { due_on: row.due_on as string } : {}) };
    },
    output: { parse: (value) => value },
    handle() {
      seen.handles++;
      return { version: 0 };
    },
  });
  const rows: RowScope = { loan: { groups: [[{ column: 'desk', op: '=', value: 1 }]] }, secret: true };
  const options: AppPolicyContextOptions<Request> = {
    app,
    resources,
    commands: { registry: { assign: command }, writableConnection: () => true, resultReferences: { assign: () => [] } },
    sourceConnections: new Map([['operations', owner]]),
    verifySession: async (req) => ({ id: 'verified', who: 'manager@example.test', role: req.role ?? 'manager' }),
    resolveRows: () => rows,
  };
  const prepare = (req: Request, id = 1) =>
    createAppPolicyContext(options).withContext(req, (context) => context.commands!.prepare(request(id)));
  const untouched = () => {
    assert.equal(seen.handles, 0);
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM loan ORDER BY id').all()), before);
    // Prepare keeps no receipt: the journal is exactly as it was.
    assert.equal(JSON.stringify(journal()), journalBefore);
  };
  const availability = (req: Request) =>
    createAppPolicyContext(options).withContext(req, (context) =>
      context.commands!.availability!({
        checks: [{ command: 'assign', commandVersion: 1, keys: [{ id: 1 }, { id: 2 }, { id: 999 }] }],
      }),
    );
  return { prepare, availability, seen, untouched };
}

test('policy availability batches only visible rows and never initial or handler', async (t) => {
  const f = await fixture(t, 'unavailable');
  assert.deepEqual(await f.availability({}), { checks: [{ command: 'assign', commandVersion: 1, available: [false, false, false] }] });
  assert.equal(f.seen.availability, 1);
  assert.equal(f.seen.initials, 0);
  assert.equal(f.seen.handles, 0);
  f.untouched();
});

test('business availability uses scoped readonly prepare and refuses before prefill or journal changes', async (t) => {
  const f = await fixture(t, 'unavailable');
  await assert.rejects(f.prepare({}), refused('forbidden'));
  assert.equal(f.seen.initials, 0);
  assert.equal(f.seen.availability, 1);
  await assert.rejects(f.prepare({}, 2), refused('not_found'));
  assert.equal(f.seen.availability, 1);
  f.untouched();
});

test("initial prefills from the revision it is read with, within the principal's rows, through a read-only transaction", async (t) => {
  const f = await fixture(t, 'values');
  assert.deepEqual(await f.prepare({}), { expectedVersion: 7, initial: { assignee: 'Original', due_on: '2026-09-30' } });
  assert.equal(f.seen.initials, 1);
  assert.equal(f.seen.expectedVersion, 7);
  assert.deepEqual(f.seen.tx, ['count', 'query']);
  assert.ok(f.seen.frozen);
  assert.equal(f.seen.hidden, 0);
  // An optional value the record does not hold is absent, not null.
  assert.deepEqual(await f.prepare({}, 3), { expectedVersion: 3, initial: { assignee: 'Sibling' } });
  f.untouched();
});

test("a target outside the principal's rows is not_found before initial runs", async (t) => {
  const f = await fixture(t, 'values');
  // Hidden and nonexistent answer alike, as prepare without `initial` does.
  const messages: string[] = [];
  for (const id of [2, 999]) {
    await assert.rejects(f.prepare({}, id), (error) => {
      refused('not_found')(error);
      messages.push((error as Error).message);
      return true;
    });
  }
  assert.equal(messages[0], messages[1]);
  assert.equal(f.seen.initials, 0);
  f.untouched();
});

test('a principal without the command grant is forbidden and initial never runs', async (t) => {
  const f = await fixture(t, 'values');
  await assert.rejects(f.prepare({ role: 'viewer' }), refused('forbidden'));
  assert.equal(f.seen.initials, 0);
  f.untouched();
});

test("initial reading beyond the command's footprint is forbidden", async (t) => {
  const f = await fixture(t, 'outside');
  await assert.rejects(f.prepare({}), refused('forbidden'));
  f.untouched();
});

for (const mode of ['undeclared', 'mistyped'] as const) {
  test(`initial values the declaration cannot hold are invalid_result: ${mode}`, async (t) => {
    const f = await fixture(t, mode);
    await assert.rejects(f.prepare({}), refused('invalid_result'));
    f.untouched();
  });
}
