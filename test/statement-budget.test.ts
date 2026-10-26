/*
 * The statement budgets (scripts/statement-budgets.mjs), held: a warm
 * command sends no more statements than its ceiling, none of them a catalog
 * read, and no statement shape twice — on SQLite always, and on PostgreSQL
 * when TABLEWALK_TEST_PG names a server (with the epoch store provisioned).
 * A regression here is a regression in what every command costs at 20 ms a
 * round trip.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { migratePostgresCommandJournal } from '../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import { provisionPostgresSchemaEpoch } from '../packages/engine/src/adapters/postgresSchemaEpoch.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { bindBusinessCommands } from '../packages/mistri/src/server/commands/businessCommandAccess.js';
import { executeBusinessCommand, type CommandDoor } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { defineCommand, defineCommands, type BusinessCommandActor } from '../packages/mistri/src/server/commands/businessCommands.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { COMMAND_BUDGETS } from '../scripts/statement-budgets.mjs';
import { statementsOf, type Counted } from './support/statements.js';
import { pgClient, uuidPostgresDatabase } from './support/tenantDialects.js';
import { commandsOf } from '../packages/mistri/src/server/stores/commandStores.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
const actor: BusinessCommandActor = { id: 'account-a', appId: 'desk', roles: ['clerk'] };

function within(name: keyof typeof COMMAND_BUDGETS, measured: Counted) {
  const budget = COMMAND_BUDGETS[name];
  const said = `${name}:\n${measured.statements.map((sql) => `  ${sql.replace(/\s+/g, ' ').slice(0, 160)}`).join('\n')}`;
  assert.deepEqual(measured.catalog, [], `no catalog read on a warm ${said}`);
  assert.ok(
    measured.repeated.length <= budget.repeated,
    `${measured.repeated.length} statements repeat a shape, over the ${budget.repeated} budgeted, in a warm ${said}`,
  );
  if (process.env.TABLEWALK_BUDGET_PRINT) console.log(`${name}: ${measured.total} statements, ${measured.repeated.length} repeated`);
  assert.ok(measured.total <= budget.statements, `${measured.total} statements, over the ${budget.statements} budgeted, in a warm ${said}`);
}

/** A desk of tickets and one command that closes one, bound as the HTTP route binds it. */
async function desk(
  url: string,
  dialect: 'sqlite' | 'postgres',
  run: (execute: (door: CommandDoor, id: number, track?: 'audit') => Promise<unknown>) => Promise<void>,
) {
  const registry = new Registry();
  registry.add({ id: 'desk-db', name: 'desk', url, writable: true, source: 'config' });
  try {
    const app = parseAppConfig(
      {
        id: 'desk',
        name: 'Desk',
        sources: { desk: { connection: 'desk-db' } },
        resources: { ticket: { access: 'write' } },
        auth: { roles: { clerk: { read: true, commands: ['close', 'closeAudited'] } } },
        views: { tickets: { kind: 'list', from: 'ticket' } },
        home: 'tickets',
      },
      `${dialect} budget fixture`,
    );
    const definition = {
      source: 'desk',
      target: 'ticket',
      when: 'status = open',
      input: {},
      output: { parse: (value: unknown) => value as { closed: number } },
      async handle({
        db,
        record,
      }: {
        db: Record<string, { update(record: unknown, values: unknown): Promise<unknown> }>;
        record?: Record<string, unknown>;
      }) {
        await db.ticket.update(record!, { status: 'closed' });
        return { closed: Number(record!.id) };
      },
    } as const;
    const commands = defineCommands({
      close: defineCommand(definition as never),
      closeAudited: defineCommand({ ...(definition as object), track: 'audit' } as never),
    });
    const resources = await loadAppRuntimeResources(registry, app, 'desk-db');
    const binding = bindBusinessCommands({ app, resources, registry: commands, writableConnection: () => true });
    let n = 0;
    await run((door, id, track) =>
      executeBusinessCommand(
        binding,
        actor,
        {
          command: track ? 'closeAudited' : 'close',
          commandVersion: 1,
          key: { id },
          expectedVersion: 0,
          input: {},
          idempotencyKey: `budget-request-${String(++n).padStart(6, '0')}`,
        },
        { door },
      ),
    );
  } finally {
    await registry.closeAll();
  }
}

const TICKETS = Array.from({ length: 12 }, (_, i) => `(${i + 1}, 0, 'open')`).join(', ');

test('SQLite: a warm command, per track, within its statement budget', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-statement-budget-'));
  const path = join(directory, 'desk.db');
  const db = new DatabaseSync(path);
  try {
    db.exec(
      `CREATE TABLE ticket (id INTEGER PRIMARY KEY, version INTEGER NOT NULL, status TEXT NOT NULL); INSERT INTO ticket VALUES ${TICKETS};`,
    );
    migrateSqliteCommandJournal(path);
    await desk(path, 'sqlite', async (execute) => {
      await execute('ui', 1);
      within('sqlite command, none', await statementsOf(() => execute('ui', 2)));
      await execute('api', 3);
      within('sqlite command, receipts', await statementsOf(() => execute('api', 4)));
      await execute('api', 5, 'audit');
      within('sqlite command, audit', await statementsOf(() => execute('api', 6, 'audit')));
    });
    const adapter = new SqliteAdapter(path);
    try {
      const write = (id: number) =>
        adapter.scopeTransaction({ ticket: true }, (tx) => tx.update({ table: 'ticket', key: { id }, values: { status: 'held' } }));
      await write(7);
      within('sqlite scoped write', await statementsOf(() => write(8)));
    } finally {
      await adapter.close();
    }
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  'PostgreSQL: a warm command, and a warm row-scoped command, within their statement budgets',
  { skip: !LIVE, timeout: 120_000 },
  async () => {
    const database = await uuidPostgresDatabase('speed_budget');
    const control = await pgClient(database.url);
    try {
      await control.query(`CREATE TABLE ticket (id integer PRIMARY KEY, version integer NOT NULL, status text NOT NULL);
      CREATE TABLE note (id integer PRIMARY KEY, ticket_id integer NOT NULL REFERENCES ticket(id), version integer NOT NULL DEFAULT 0, body text NOT NULL);
      INSERT INTO ticket VALUES ${TICKETS};
      INSERT INTO note (id, ticket_id, body) VALUES (1, 1, 'a'), (2, 1, 'b')`);
      await migratePostgresCommandJournal(database.url);
      await provisionPostgresSchemaEpoch(database.url);
      await desk(database.url, 'postgres', async (execute) => {
        await execute('ui', 1);
        within('postgres command, none', await statementsOf(() => execute('ui', 2)));
        await execute('api', 3);
        within('postgres command, receipts', await statementsOf(() => execute('api', 4)));
      });
      const adapter = new PostgresAdapter(database.url);
      try {
        await adapter.introspect();
        /* The row-policy command's writes: the note in scope, its ticket (a
         parent) in scope too, under the scope's locks. */
        const write = (id: number, body: string) =>
          commandsOf(adapter).scopeCommandTransaction(
            { 'public.note': { groups: [[{ column: 'ticket_id', op: '=', value: 1 }]] }, 'public.ticket': true },
            async (records) => {
              const found = await records.query({
                table: 'public.note',
                filter: { groups: [[{ column: 'id', op: '=', value: id }]] },
                limit: 2,
                offset: 0,
              });
              assert.equal(found.rows.length, 1);
              return records.update({ table: 'public.note', key: { id }, values: { body } });
            },
          );
        await write(1, 'warm-up');
        within('postgres scoped command, none', await statementsOf(() => write(2, 'measured')));
      } finally {
        await adapter.close();
      }
    } finally {
      await control.end();
      await database.drop();
    }
  },
);
