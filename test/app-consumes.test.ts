/**
 * `consumes` (shared/appConsumes.ts, server/app/appConsumes.ts): a line that
 * uses stock moves the balance on every door. A new line takes, a removed one
 * gives back, an edit moves the difference or switches parents, and a take
 * past zero refuses the whole write with the rule's sentence, filled only
 * with what the reader may read of the parent. SQLite here; the move is the
 * write layer's, not the engine's.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { consumesCommandWarnings } from '../packages/mistri/src/server/app/appMachineChecks.js';
import { moveConsumed } from '../packages/mistri/src/server/app/appConsumes.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { loadHttpAppPolicy } from '../packages/mistri/src/server/policy/appPolicyHttp.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { appConsumesRules, parseAppConfig } from '../packages/mistri/src/shared/app.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { catalogOf } from './support/commandCatalog.js';

const SCHEMA = `CREATE TABLE part (id INTEGER PRIMARY KEY, name TEXT NOT NULL, on_hand INTEGER NOT NULL, weight NUMERIC, note TEXT);
  CREATE TABLE work_order (id INTEGER PRIMARY KEY, title TEXT);
  CREATE TABLE work_order_part (id INTEGER PRIMARY KEY, work_order_id INTEGER REFERENCES work_order(id), part_id INTEGER REFERENCES part(id), quantity INTEGER NOT NULL DEFAULT 1, kg NUMERIC, note TEXT);
  CREATE TABLE stock_receipt (id INTEGER PRIMARY KEY, part_id INTEGER REFERENCES part(id), quantity INTEGER NOT NULL);
  INSERT INTO part VALUES (1, 'Pump seal', 5, 10.5, NULL), (2, 'Gasket', 2, 3, NULL);`;

const CONSUMES = { column: 'part_id.on_hand', by: 'quantity', message: 'Only {part_id.on_hand} of {part_id.name} left' };

/* Where a command writes the lines too, a role says which columns it edits in place [command-and-edit];
   removing a line needs them all, so the removal runs where no command is declared. */
const LINE = { read: ['id', 'part_id', 'quantity', 'kg', 'note'], write: ['part_id', 'quantity', 'note'] };

const APP = {
  id: 'shop',
  name: 'Shop',
  sources: { shop: { connection: 'shop-db', default: true } },
  resources: {
    part: {},
    work_order_part: { access: 'write', delete: true, consumes: CONSUMES },
    // Stock brought in: a receipt's line adds what a work order's line takes.
    stock_receipt: {
      access: 'write',
      delete: true,
      restocks: { column: 'part_id.on_hand', by: 'quantity', message: 'Only {part_id.on_hand} of {part_id.name} are still here' },
    },
  },
  auth: {
    providers: ['email'],
    roles: {
      // The clerk writes lines, reads a part's balance and never its name, and may not touch the balance itself.
      clerk: {
        read: ['part', 'work_order_part', 'stock_receipt'],
        write: ['work_order_part', 'stock_receipt'],
        fields: { part: { read: ['id', 'on_hand'] } },
      },
      manager: { read: true, write: ['work_order_part', 'stock_receipt'] },
    },
  },
  views: { lines: { kind: 'list', from: 'work_order_part' } },
  home: 'lines',
  nav: ['lines'],
};

const catalog = (db: string): DatabaseSchema => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(db);
  const tables = ['part', 'work_order_part', 'stock_receipt'].map((name) => {
    const columns = sqlite.prepare(`PRAGMA table_info(${name})`).all() as Array<{
      name: string;
      type: string;
      pk: number;
      notnull: number;
    }>;
    const keys = sqlite.prepare(`PRAGMA foreign_key_list(${name})`).all() as Array<{ from: string; table: string; to: string }>;
    return {
      id: name,
      name,
      columns: columns.map((column) => {
        const key = keys.find((item) => item.from === column.name);
        return {
          name: column.name,
          type: column.type,
          nullable: !column.notnull,
          primaryKey: column.pk > 0,
          ...(key ? { references: { table: key.table, column: key.to } } : {}),
        };
      }),
    };
  });
  sqlite.close();
  return { dialect: 'sqlite', tables } as unknown as DatabaseSchema;
};

test('a rule that does not read against the catalog keeps the App from loading, naming the fix', () => {
  const schema = catalog(SCHEMA);
  const problems = (consumes: unknown) =>
    appConsumesRules(
      parseAppConfig({ ...APP, resources: { ...APP.resources, work_order_part: { access: 'write', consumes } } }, 'consumes'),
      schema,
    ).problems;
  assert.deepEqual(problems(CONSUMES), []);
  assert.match(
    problems({ column: 'note.on_hand' })[0],
    /"note", which is not a reference of "work_order_part" \[consumes-path\].*"part_id"/,
  );
  assert.match(problems({ column: 'part_id.name' })[0], /"part_id\.name" is not a number column of "part" \[consumes-balance\]/);
  assert.match(problems({ column: 'part_id.on_hand', by: 'note' })[0], /"by" names "note".*\[consumes-by\]/);
  assert.match(
    problems({ column: 'part_id.on_hand', by: 'kg' })[0],
    /"on_hand" holds whole numbers and "kg" may be a fraction \[consumes-decimal\]/,
  );
  // A decimal balance may be moved by a decimal, and a whole one by a whole one.
  assert.deepEqual(problems({ column: 'part_id.weight', by: 'kg' }), []);
  // `restocks` is read by the same rules, and says which key it is.
  const restocks = appConsumesRules(
    parseAppConfig(
      { ...APP, resources: { ...APP.resources, stock_receipt: { access: 'write', restocks: { column: 'id.on_hand' } } } },
      'r',
    ),
    schema,
  ).problems;
  assert.match(restocks[0], /resources "stock_receipt", restocks: "id\.on_hand" starts with "id".*\[consumes-path\]/);
  assert.throws(
    () =>
      parseAppConfig(
        {
          ...APP,
          resources: { ...APP.resources, work_order_part: { access: 'write', consumes: { column: 'part_id.supplier_id.on_hand' } } },
        },
        'consumes',
      ),
    /one reference of this resource and a number column of the record it names/,
  );
  assert.throws(
    () =>
      parseAppConfig(
        {
          ...APP,
          resources: { ...APP.resources, work_order_part: { access: 'write', consumes: { column: 'part_id.on_hand', floor: true } } },
        },
        'consumes',
      ),
    /"floor" of true: it is false/,
  );
  assert.throws(
    () =>
      parseAppConfig(
        {
          ...APP,
          resources: {
            ...APP.resources,
            work_order_part: { access: 'write', consumes: { column: 'part_id.on_hand', refuse: 'None left' } },
          },
        },
        'consumes',
      ),
    /has "refuse", which is now "message"/,
  );
});

test('check names a command that writes a balance and a line the rule moves it for, and not a restock', () => {
  const app = parseAppConfig(APP, 'consumes', {
    commands: catalogOf({ restock: { target: 'part' }, rename: { target: 'part' }, usePart: { target: 'part' } }),
  });
  const commands = defineCommands({
    // A delivery with no receipt line: the command keeps the balance, which is its to do.
    restock: defineCommand({
      source: 'shop',
      target: 'part',
      async handle({ db, record }) {
        await db.part.update(record, { on_hand: 10 });
      },
    }),
    rename: defineCommand({
      source: 'shop',
      target: 'part',
      async handle({ db, record }) {
        await db.part.update(record, { name: 'Renamed' });
      },
    }),
    // A line and the balance by hand: the rule moves the balance for the line too, so it counts twice.
    usePart: defineCommand({
      source: 'shop',
      target: 'part',
      async handle({ tx, record }) {
        await tx.insert({ table: 'work_order_part', values: { part_id: Number(record.id), quantity: 1 } });
        await tx.update({ table: 'part', key: { id: Number(record.id) }, values: { on_hand: 0 } });
      },
    }),
  });
  const warnings = consumesCommandWarnings(app, catalog(SCHEMA), commands);
  assert.equal(warnings.length, 1, warnings.join('\n'));
  assert.match(
    warnings[0],
    /^command "usePart" writes "on_hand" of "part" and a "work_order_part" line, whose consumes already moves it \[consumes-written\]/,
  );
});

/* The App whose work order is saved with its lines in one write, as its New form sends it (DM9). */
const WITH_ORDER = {
  ...APP,
  resources: {
    ...APP.resources,
    work_order: {
      access: 'write',
      form: {
        show: ['title'],
        lines: [{ label: 'Parts', from: 'work_order_part', whose: 'work_order_id', show: ['part_id', 'quantity'] }],
      },
    },
  },
  auth: {
    ...APP.auth,
    roles: { ...APP.auth.roles, manager: { read: true, write: ['work_order', 'work_order_part', 'stock_receipt'] } },
  },
};

/* The App with the command `grow` granted to the manager, and each role's in-place edits named. */
const WITH_COMMAND = {
  ...APP,
  resources: {
    ...APP.resources,
    work_order_part: {
      ...APP.resources.work_order_part,
      actions: { grow: { label: 'Grow', command: 'grow' }, add: { label: 'Add a line', command: 'add' } },
    },
  },
  auth: {
    ...APP.auth,
    roles: {
      clerk: { ...APP.auth.roles.clerk, fields: { ...APP.auth.roles.clerk.fields, work_order_part: LINE }, commands: ['add'] },
      manager: { ...APP.auth.roles.manager, fields: { work_order_part: LINE }, commands: ['grow', 'add'] },
    },
  },
};

async function fixture(
  run: (f: {
    post: (who: string, path: string, body: object) => Promise<{ status: number; body: any }>;
    stock: () => Record<number, number>;
    lines: () => number;
    command: (input: { id: number; quantity: number; name?: 'grow' | 'add'; as?: string }) => Promise<{ status: number; body: any }>;
  }) => Promise<void>,
  variant: 'plain' | 'command' | 'order' = 'plain',
) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-consumes-'));
  const file = join(directory, 'shop.db');
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA foreign_keys = ON; ${SCHEMA}`);
  db.close();
  migrateSqliteCommandJournal(file);
  const registry = new Registry();
  registry.add({ id: 'shop-db', name: 'Shop', url: file, writable: true, source: 'config' });
  const control = { quantity: 0 };
  const commands = defineCommands({
    // A handler's own write of the line: the rule holds there too.
    grow: defineCommand({
      source: 'shop',
      target: 'work_order_part',
      async handle({ tx, record }) {
        await tx.update({ table: 'work_order_part', key: { id: Number(record.id) }, values: { quantity: control.quantity } });
      },
    }),
    // A new line of the second part, written with no read of the part at all: its footprint is the line alone.
    add: defineCommand({
      source: 'shop',
      target: 'work_order_part',
      async handle({ tx }) {
        await tx.insert({ table: 'work_order_part', values: { part_id: 2, quantity: control.quantity } });
      },
    }),
  });
  const app = parseAppConfig(variant === 'command' ? WITH_COMMAND : variant === 'order' ? WITH_ORDER : APP, 'consumes', {
    commands: catalogOf({ grow: { target: 'work_order_part' }, add: { target: 'work_order_part' } }),
  });
  const people: Record<string, Identity> = {
    clerk: { id: 'account-clerk', who: 'clerk@example.test', role: 'clerk' },
    manager: { id: 'account-manager', who: 'manager@example.test', role: 'manager' },
  };
  let who = 'clerk';
  const host: AppHost = {
    app: { app, path: '/private/shop/app.ts', pages: [], sources: {} },
    pages: [],
    auth: { spec: app.auth!, store: '/private/shop/auth.db', close() {}, handler: async () => {}, session: async () => people[who] },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], pages: [], commands: { appId: 'shop', registry: commands } });
  server.listen(0, bound.host);
  await once(server, 'listening');
  bound.port = (server.address() as { port: number }).port;
  const check = new DatabaseSync(file, { readOnly: true });
  try {
    await run({
      post: async (as, path, body) => {
        who = as;
        const response = await fetch(`http://${bound.host}:${bound.port}${path}`, {
          method: 'POST',
          signal: AbortSignal.timeout(10_000),
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ app: 'shop', ...body }),
        });
        return { status: response.status, body: await response.json() };
      },
      stock: () =>
        Object.fromEntries(
          (check.prepare('SELECT id, on_hand FROM part ORDER BY id').all() as Array<{ id: number; on_hand: number }>).map((row) => [
            row.id,
            row.on_hand,
          ]),
        ),
      lines: () => (check.prepare('SELECT count(*) AS n FROM work_order_part').get() as { n: number }).n,
      command: async (input) => {
        const name = input.name ?? 'grow';
        control.quantity = input.quantity;
        who = input.as ?? 'manager';
        const call = async (path: string, body: object) => {
          const response = await fetch(`http://${bound.host}:${bound.port}${path}`, {
            method: 'POST',
            signal: AbortSignal.timeout(10_000),
            headers: { 'content-type': 'application/json', 'x-mistri-account': people[who].id },
            body: JSON.stringify(body),
          });
          return { status: response.status, body: await response.json() };
        };
        const prepared = await call('/api/commands/prepare', { command: name, commandVersion: 1, key: { id: input.id } });
        assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
        return call('/api/commands/execute', {
          command: name,
          commandVersion: 1,
          key: { id: input.id },
          expectedVersion: prepared.body.expectedVersion,
          idempotencyKey: `consumes-${name}-${who}-${input.id}-${input.quantity}`,
          input: {},
        });
      },
    });
  } finally {
    check.close();
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    clearJournal('shop-db');
    rmSync(directory, { recursive: true, force: true });
  }
}

test('a line takes from its part, gives back when removed, and moves the difference or switches parts when edited', () =>
  fixture(async ({ post, stock, lines }) => {
    // The clerk may not write the balance, and still adds a line that moves it.
    const added = await post('clerk', '/api/insert', { table: 'work_order_part', values: { part_id: 1, quantity: 3 } });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    const id = added.body.key.id;
    assert.deepEqual(stock(), { 1: 2, 2: 2 });

    const more = await post('clerk', '/api/update', { table: 'work_order_part', key: { id }, values: { quantity: 4 } });
    assert.equal(more.status, 200, JSON.stringify(more.body));
    assert.deepEqual(stock(), { 1: 1, 2: 2 });
    const fewer = await post('clerk', '/api/update', { table: 'work_order_part', key: { id }, values: { quantity: 1 } });
    assert.equal(fewer.status, 200, JSON.stringify(fewer.body));
    assert.deepEqual(stock(), { 1: 4, 2: 2 });

    // Another part: the first gets its unit back, the second gives one.
    const moved = await post('clerk', '/api/update', { table: 'work_order_part', key: { id }, values: { part_id: 2, quantity: 2 } });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.deepEqual(stock(), { 1: 5, 2: 0 });

    // A line that names no part any more gives back what it took.
    const cleared = await post('clerk', '/api/update', { table: 'work_order_part', key: { id }, values: { part_id: null } });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    assert.deepEqual(stock(), { 1: 5, 2: 2 });

    const again = await post('clerk', '/api/update', { table: 'work_order_part', key: { id }, values: { part_id: 1 } });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.deepEqual(stock(), { 1: 3, 2: 2 });
    // A write that leaves the reference and amount alone moves nothing.
    await post('clerk', '/api/update', { table: 'work_order_part', key: { id }, values: { note: 'rush' } });
    assert.deepEqual(stock(), { 1: 3, 2: 2 });

    const removed = await post('clerk', '/api/delete', { table: 'work_order_part', key: { id }, confirm: true });
    assert.equal(removed.body.deleted, true, JSON.stringify(removed.body));
    assert.deepEqual(stock(), { 1: 5, 2: 2 });
    assert.equal(lines(), 0);
  }));

test('a receipt line restocks its part, and taking it back is held to what is still there', () =>
  fixture(async ({ post, stock }) => {
    // Received: a New on the receipt, with no command, adds to the balance.
    const received = await post('clerk', '/api/insert', { table: 'stock_receipt', values: { part_id: 2, quantity: 3 } });
    assert.equal(received.status, 200, JSON.stringify(received.body));
    const receipt = received.body.key.id;
    assert.deepEqual(stock(), { 1: 5, 2: 5 });
    // A miscount corrected moves the difference.
    const corrected = await post('clerk', '/api/update', { table: 'stock_receipt', key: { id: receipt }, values: { quantity: 4 } });
    assert.equal(corrected.status, 200, JSON.stringify(corrected.body));
    assert.deepEqual(stock(), { 1: 5, 2: 6 });

    // Four are used on a work order; the receipt can no longer be taken back whole.
    const used = await post('clerk', '/api/insert', { table: 'work_order_part', values: { part_id: 2, quantity: 4 } });
    assert.equal(used.status, 200, JSON.stringify(used.body));
    assert.deepEqual(stock(), { 1: 5, 2: 2 });
    const undone = await post('manager', '/api/delete', { table: 'stock_receipt', key: { id: receipt }, confirm: true });
    assert.equal(undone.body.deleted, false, JSON.stringify(undone.body));
    assert.equal(undone.body.errors[0].code, 'consumes_refused', JSON.stringify(undone.body));
    assert.deepEqual(undone.body.errors[0].fields, [{ field: 'quantity', message: 'Only 2 of Gasket are still here' }]);
    assert.deepEqual(stock(), { 1: 5, 2: 2 });

    // Once the line is removed its parts are back, and the receipt is undone whole.
    await post('clerk', '/api/delete', { table: 'work_order_part', key: { id: used.body.key.id }, confirm: true });
    const removed = await post('clerk', '/api/delete', { table: 'stock_receipt', key: { id: receipt }, confirm: true });
    assert.equal(removed.body.deleted, true, JSON.stringify(removed.body));
    assert.deepEqual(stock(), { 1: 5, 2: 2 });
  }));

test('a take past zero refuses the whole write with the rule’s sentence, filled with what the reader may read', () =>
  fixture(async ({ post, stock, lines }) => {
    const refused = await post('manager', '/api/insert', { table: 'work_order_part', values: { part_id: 2, quantity: 3 } });
    // 422, as a command and the App API answer it, in the envelope a refused Save always had.
    assert.equal(refused.status, 422, JSON.stringify(refused.body));
    assert.equal(refused.body.outcome, 'rejected', JSON.stringify(refused.body));
    assert.deepEqual(refused.body.errors[0].code, 'consumes_refused');
    assert.deepEqual(refused.body.errors[0].fields, [{ field: 'quantity', message: 'Only 2 of Gasket left' }]);
    assert.equal(lines(), 0);
    assert.deepEqual(stock(), { 1: 5, 2: 2 });

    // The clerk does not read a part's name: that placeholder is dropped, the balance stays.
    const clerk = await post('clerk', '/api/insert', { table: 'work_order_part', values: { part_id: 2, quantity: 3 } });
    assert.deepEqual(clerk.body.errors[0].fields, [{ field: 'quantity', message: 'Only 2 of left' }]);

    // The last units can be taken; an edit past them is refused and the line keeps what it had.
    const all = await post('clerk', '/api/insert', { table: 'work_order_part', values: { part_id: 2, quantity: 2 } });
    assert.equal(all.status, 200, JSON.stringify(all.body));
    assert.deepEqual(stock(), { 1: 5, 2: 0 });
    const over = await post('clerk', '/api/update', { table: 'work_order_part', key: { id: all.body.key.id }, values: { quantity: 3 } });
    assert.equal(over.status, 422, JSON.stringify(over.body));
    assert.equal(over.body.errors[0].code, 'consumes_refused', JSON.stringify(over.body));
    assert.deepEqual(stock(), { 1: 5, 2: 0 });
  }));

test('a line written with its work order is refused as consumes_refused too, at its own field (DM9)', () =>
  fixture(async ({ post, stock, lines }) => {
    const refused = await post('manager', '/api/insert', {
      table: 'work_order',
      values: { title: 'Pump rebuild' },
      lines: { work_order_part: [{ values: { part_id: 1, quantity: 1 } }, { values: { part_id: 2, quantity: 3 } }] },
    });
    // The status the docs promise (stock.md), where a refused line once answered 200 as a plain validation failure.
    assert.equal(refused.status, 422, JSON.stringify(refused.body));
    assert.equal(refused.body.outcome, 'rejected', JSON.stringify(refused.body));
    assert.equal(refused.body.errors[0].code, 'consumes_refused', JSON.stringify(refused.body));
    assert.deepEqual(refused.body.errors[0].fields, [{ field: 'work_order_part[1].quantity', message: 'Only 2 of Gasket left' }]);
    // The whole write is undone: the first line's take with it.
    assert.equal(lines(), 0);
    assert.deepEqual(stock(), { 1: 5, 2: 2 });

    const saved = await post('manager', '/api/insert', {
      table: 'work_order',
      values: { title: 'Pump rebuild' },
      lines: { work_order_part: [{ values: { part_id: 1, quantity: 1 } }, { values: { part_id: 2, quantity: 2 } }] },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(lines(), 2);
    assert.deepEqual(stock(), { 1: 4, 2: 0 });
  }, 'order'));

test('a command’s own write of the line is held to the rule and refused as consumes_refused', () =>
  fixture(async ({ post, stock, command }) => {
    const added = await post('clerk', '/api/insert', { table: 'work_order_part', values: { part_id: 1, quantity: 1 } });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    const grown = await command({ id: added.body.key.id, quantity: 4 });
    assert.equal(grown.status, 200, JSON.stringify(grown.body));
    assert.deepEqual(stock(), { 1: 1, 2: 2 });
    const refused = await command({ id: added.body.key.id, quantity: 9 });
    assert.equal(refused.status, 422, JSON.stringify(refused.body));
    assert.equal(refused.body.code, 'consumes_refused');
    // The handler's footprint is the line alone; the sentence is said to the person, by what they may read of the part.
    assert.equal(refused.body.message, 'Only 1 of Pump seal left');
    assert.deepEqual(stock(), { 1: 1, 2: 2 });
  }, 'command'));

test('a command that inserts a line with no read of the part is refused with the whole sentence', () =>
  fixture(async ({ post, stock, lines, command }) => {
    const first = await post('clerk', '/api/insert', { table: 'work_order_part', values: { part_id: 1, quantity: 1 } });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const refused = await command({ id: first.body.key.id, quantity: 3, name: 'add' });
    assert.equal(refused.status, 422, JSON.stringify(refused.body));
    assert.equal(refused.body.code, 'consumes_refused');
    assert.equal(refused.body.message, 'Only 2 of Gasket left');
    // Run for the clerk, who reads a part's balance and never its name, the name is still left out.
    const clerk = await command({ id: first.body.key.id, quantity: 3, name: 'add', as: 'clerk' });
    assert.equal(clerk.status, 422, JSON.stringify(clerk.body));
    assert.equal(clerk.body.message, 'Only 2 of left');
    assert.equal(lines(), 1);
    assert.deepEqual(stock(), { 1: 4, 2: 2 });
    const added = await command({ id: first.body.key.id, quantity: 2, name: 'add' });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    assert.deepEqual(stock(), { 1: 4, 2: 0 });
  }, 'command'));

test('a decimal balance read as text moves without rounding, and floor: false lets it go below zero', async () => {
  const parent: Record<string, unknown> = { id: 1, weight: '10.10' };
  const written: unknown[] = [];
  const writer = {
    query: async () => ({ rows: [{ ...parent }] }),
    update: async (request: { values: Record<string, unknown>; expected?: Record<string, unknown> }) => {
      written.push(request.values.weight);
      assert.equal(request.expected?.weight, parent.weight);
      parent.weight = request.values.weight;
      return { affected: 1, applied: request.values };
    },
  } as never;
  const rule = {
    table: 'line',
    reference: 'part_id',
    parent: 'part',
    parentKey: 'id',
    balance: 'weight',
    by: 'kg',
    mentions: ['weight'],
    floor: true,
  };
  await moveConsumed(writer, [rule], undefined, { part_id: 1, kg: '0.20' }, () => true);
  await moveConsumed(writer, [rule], { part_id: 1, kg: '0.20' }, { part_id: 1, kg: 0.3 }, () => true);
  assert.deepEqual(written, ['9.9', '9.8']);
  await assert.rejects(
    moveConsumed(writer, [rule], undefined, { part_id: 1, kg: '9.81' }, () => true),
    /Only 9\.8 left\./,
  );
  await moveConsumed(writer, [{ ...rule, floor: false }], undefined, { part_id: 1, kg: '9.81' }, () => true);
  assert.equal(parent.weight, '-0.01');
});

test('under a row policy a take past zero answers 422 as well (DM9)', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-consumes-policy-'));
  const file = join(directory, 'shop.db');
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA foreign_keys = ON; ${SCHEMA}`);
  db.close();
  const registry = new Registry();
  registry.add({ id: 'shop-db', name: 'Shop', url: file, writable: true, source: 'config' });
  const app = parseAppConfig({ ...APP, auth: { ...APP.auth, rows: 'policy' } }, 'consumes');
  const manager: Identity = { id: 'account-manager', who: 'manager@example.test', role: 'manager' };
  const host: AppHost = {
    app: { app, path: join(directory, 'app.ts'), pages: [], sources: {} },
    pages: [],
    auth: { spec: app.auth!, store: join(directory, 'auth.db'), close() {}, handler: async () => {}, session: async () => manager },
  };
  // Every row is the manager's: the policy is here for the path a policy App's write takes, not to narrow it.
  const everyRow = { groups: [[{ column: 'id', op: '>', value: 0 }]] };
  writeFileSync(
    join(directory, 'policy.mjs'),
    `export default { appId: 'shop', resolveRows: () => (${JSON.stringify({ part: everyRow, work_order: everyRow, work_order_part: everyRow, stock_receipt: everyRow })}), authorizeDeletedRecord: () => true };`,
  );
  const policy = await loadHttpAppPolicy({ app, registry, file: join(directory, 'policy.mjs'), verifySession: async () => manager });
  const server = createApp({ registry, bound: { host: '127.0.0.1', port: 0 }, apps: [host], policy });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/insert?app=shop`, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/json', 'x-mistri-account': manager.id },
      body: JSON.stringify({ table: 'work_order_part', values: { part_id: 2, quantity: 3 } }),
    });
    const body = (await response.json()) as { outcome: string; errors: Array<{ code: string; fields: unknown }> };
    assert.equal(response.status, 422, JSON.stringify(body));
    assert.equal(body.outcome, 'rejected');
    assert.equal(body.errors[0].code, 'consumes_refused');
    assert.deepEqual(body.errors[0].fields, [{ field: 'quantity', message: 'Only 2 of Gasket left' }]);
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await policy.retire();
    await registry.closeAll();
    rmSync(directory, { recursive: true, force: true });
  }
});
