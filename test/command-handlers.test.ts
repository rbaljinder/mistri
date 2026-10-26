/**
 * The handler's everyday API over a real transaction: the target read and
 * checked before the handler runs (present, at the revision the form saw —
 * except for a service principal — and in the state `when` requires, with
 * the key named when several were sent), and the `db` a handler reads and
 * writes through (get, find, where in its three spellings, count, insert,
 * the guarded update and its stale refusal, remove), booleans read the same
 * on every engine and keys spelled exactly.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { bindBusinessCommands } from '../packages/mistri/src/server/commands/businessCommandAccess.js';
import {
  BusinessCommandExecutionError,
  executeBusinessCommand,
  refuse,
} from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import {
  defineCommand,
  defineCommands,
  type BusinessCommandActor,
  type BusinessCommandContext,
} from '../packages/mistri/src/server/commands/businessCommands.js';
import type { UntypedRow, WriteTable } from '../packages/mistri/src/server/commands/commandDb.js';
import { Registry } from '../packages/engine/src/server/connections.js';

const actor: BusinessCommandActor = { id: 'account-a', appId: 'handlers', roles: ['staff'] };
const service: BusinessCommandActor = { id: 'service:clock', appId: 'handlers', roles: ['staff'], kind: 'service' };
type Handler = (context: BusinessCommandContext, input: Record<string, unknown>) => unknown;
/* The untyped context names every table read-only; these handlers write the tables their commands write. */
const writes = (table: unknown) => table as WriteTable<UntypedRow>;

async function fixture(
  run: (f: {
    db: DatabaseSync;
    execute: (command: string, request: Record<string, unknown>, who?: BusinessCommandActor) => Promise<unknown>;
  }) => Promise<void>,
  handlers: Partial<Record<'one' | 'many' | 'reads' | 'append', Handler>>,
) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-command-handlers-'));
  const path = join(directory, 'shop.db');
  const db = new DatabaseSync(path);
  const registry = new Registry();
  try {
    db.exec(`CREATE TABLE vehicle (id INTEGER PRIMARY KEY, stock TEXT NOT NULL UNIQUE, make TEXT NOT NULL, year INTEGER NOT NULL,
        status TEXT NOT NULL, featured BOOLEAN NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE note (id INTEGER PRIMARY KEY AUTOINCREMENT, vehicle_id INTEGER NOT NULL, body TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0);
      INSERT INTO vehicle VALUES (1, 'FC-1', 'Honda', 2019, 'available', 1, 0), (2, 'FC-2', 'Toyota', 2016, 'available', 0, 3),
        (3, 'FC-3', 'Honda', 2021, 'sold', 0, 0), (4, 'FC-4', 'or', 2020, 'available', 0, 0);`);
    migrateSqliteCommandJournal(path);
    registry.add({ id: 'private-db', name: 'Shop', url: path, writable: true, source: 'config' });
    const app = parseAppConfig(
      {
        id: 'handlers',
        name: 'Handlers',
        sources: { shop: { connection: 'private-db' } },
        resources: { vehicle: { access: 'write' }, note: { access: 'write' } },
        auth: { roles: { staff: { read: true, commands: ['one', 'many', 'reads', 'append'] } } },
        views: { vehicles: { kind: 'list', from: 'vehicle' } },
        home: 'vehicles',
      },
      'handlers fixture',
    );
    const output = { parse: (value: unknown) => value };
    const commands = defineCommands({
      one: defineCommand({
        source: 'shop',
        target: 'vehicle',
        write: ['note'],
        when: 'status = available and year >= 2018',
        input: {},
        output,
        handle: (context, input) => handlers.one!(context, input),
      }),
      append: defineCommand({
        source: 'shop',
        target: 'vehicle',
        write: ['note'],
        appendOnly: true,
        input: {},
        output,
        handle: (context, input) => handlers.append!(context, input),
      }),
      many: defineCommand({
        source: 'shop',
        target: 'vehicle',
        targets: 'many',
        when: 'status = available',
        input: {},
        output,
        handle: (context, input) => handlers.many!(context, input),
      }),
      reads: defineCommand({
        source: 'shop',
        target: 'vehicle',
        read: ['note'],
        input: { make: { type: 'text', optional: true } },
        output,
        handle: (context, input) => handlers.reads!(context, input),
      }),
    });
    const resources = await loadAppRuntimeResources(registry, app, 'private-db');
    const binding = bindBusinessCommands({ app, registry: commands, resources, writableConnection: () => true });
    let n = 0;
    const execute = async (command: string, request: Record<string, unknown>, who = actor) => {
      const envelope = {
        command,
        commandVersion: 1,
        idempotencyKey: `handlers-request-${String(++n).padStart(4, '0')}`,
        input: {},
        ...('keys' in request ? {} : { key: { id: 1 }, expectedVersion: 0 }),
        ...request,
      };
      return (await executeBusinessCommand(binding, who, envelope)).result;
    };
    await run({ db, execute });
  } finally {
    await registry.closeAll();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

const refusal = (code: string, key?: Record<string, unknown>) => (error: unknown) => {
  assert.ok(error instanceof BusinessCommandExecutionError, String(error));
  assert.equal(error.code, code);
  assert.deepEqual(error.key, key);
  return true;
};
const row = (db: DatabaseSync, id: number) => ({ ...db.prepare('SELECT status, featured, version FROM vehicle WHERE id = ?').get(id) });

test("the target is read before the handler: missing, stale and ineligible are the platform's refusals", async () => {
  let calls = 0;
  await fixture(
    async (f) => {
      assert.deepEqual(await f.execute('one', {}), { id: 1, featured: true });
      await assert.rejects(f.execute('one', { key: { id: 99 } }), refusal('not_found'));
      await assert.rejects(f.execute('one', { key: { id: 2 }, expectedVersion: 0 }), refusal('stale_record'));
      // `year >= 2018` does not hold for vehicle 2, at its own revision; vehicle 3 is sold.
      await assert.rejects(f.execute('one', { key: { id: 2 }, expectedVersion: 3 }), refusal('ineligible_state'));
      await assert.rejects(f.execute('one', { key: { id: 3 } }), refusal('ineligible_state'));
      // A key is its canonical spelling: '1' is vehicle 1; '01', '1e0', ' 1' and a rounded large id name none.
      assert.deepEqual(await f.execute('one', { key: { id: '1' } }), { id: 1, featured: true });
      for (const id of ['01', '1e0', ' 1', '9007199254740993'])
        await assert.rejects(f.execute('one', { key: { id } }), refusal('not_found'));
      // A service principal names no revision: a job acts on the row as it is now.
      assert.deepEqual(await f.execute('one', { expectedVersion: 7 }, service), { id: 1, featured: true });
      await assert.rejects(f.execute('one', { expectedVersion: 7 }), refusal('stale_record'));
      assert.equal(calls, 3, 'no refusal above reached the handler');
    },
    {
      one: async ({ record }) => {
        calls++;
        return { id: record!.id, featured: record!.featured };
      },
    },
  );
});

test('many targets are checked in order, all or nothing, and a refusal names the key', async () => {
  await fixture(
    async (f) => {
      const many = (keys: number[], versions: number[]) =>
        f.execute('many', { keys: keys.map((id) => ({ id })), expectedVersions: versions });
      await assert.rejects(many([1, 3], [0, 0]), refusal('ineligible_state', { id: 3 }));
      await assert.rejects(many([1, 2], [0, 0]), refusal('stale_record', { id: 2 }));
      // The handler's own refusal names the record it is about, and the first record's write is undone with it.
      await assert.rejects(many([1, 4], [0, 0]), refusal('forbidden', { id: 4 }));
      assert.deepEqual(row(f.db, 1), { status: 'available', featured: 1, version: 0 });
      assert.deepEqual(await many([1, 2], [0, 3]), { versions: [1, 4] });
      assert.deepEqual(row(f.db, 2), { status: 'available', featured: 1, version: 4 });
    },
    {
      many: async ({ db, records }) => {
        const versions = [];
        for (const vehicle of records!) {
          if (vehicle.make === 'or') refuse('forbidden', { key: { id: vehicle.id as number } });
          versions.push((await writes(db.vehicle).update(vehicle, { featured: true })).version);
        }
        return { versions };
      },
    },
  );
});

test('db reads: get, find, where as an object, the query language or a template, count, and booleans as booleans', async () => {
  await fixture(
    async (f) => {
      assert.deepEqual(await f.execute('reads', { input: { make: 'or' } }), {
        get: { stock: 'FC-2', featured: false },
        found: 'FC-3',
        none: null,
        object: ['FC-1', 'FC-3'],
        list: ['FC-1', 'FC-2', 'FC-4'],
        language: ['FC-3', 'FC-1'],
        limited: ['FC-3'],
        sorted: ['FC-2', 'FC-4'],
        template: [],
        templateMake: ['FC-4'],
        empty: [],
        count: 2,
        nothing: 0,
        missing: 'not_found',
        several: true,
      });
    },
    {
      reads: async ({ db }, input) => {
        const vehicle = db.vehicle;
        const stocks = (rows: readonly UntypedRow[]) => rows.map((item) => item.stock);
        const got = await vehicle.get(2);
        const missing = await vehicle.get(99).then(
          () => '',
          (error: BusinessCommandExecutionError) => error.code,
        );
        const several = await vehicle.find({ make: 'Honda' }).then(
          () => false,
          (error: Error) => /several/.test(error.message),
        );
        return {
          get: { stock: got.stock, featured: got.featured },
          found: (await vehicle.find({ stock: 'FC-3' }))?.stock,
          none: (await vehicle.find({ stock: 'FC-9' })) ?? null,
          object: stocks(await vehicle.where({ make: 'Honda' }).orderBy('stock')),
          list: stocks(await vehicle.where({ status: 'available', featured: [true, false] }).orderBy('stock')),
          language: stocks(await vehicle.where('make = Honda sort year desc')),
          limited: stocks(await vehicle.where('make = Honda').orderBy('year', 'desc').limit(1)),
          sorted: stocks(await vehicle.where('featured = false and status = available').orderBy('stock')),
          // A template's values are always quoted: typed words stay a value, never the language's `or`.
          template: stocks(await vehicle.where`make = ${'Honda or year > 0'}`),
          templateMake: stocks(await vehicle.where`make = ${String(input.make)}`),
          empty: stocks(await vehicle.where({ status: [] })),
          count: await vehicle.count({ make: 'Honda' }),
          nothing: await vehicle.count({ make: [] }),
          missing,
          several,
        };
      },
    },
  );
});

test('db is exactly the footprint: the target and what it reads, writable only where it writes; past the types, the runtime refuses the rest', async () => {
  await fixture(
    async (f) => {
      // `reads` names vehicle (its target, always written) and reads note.
      assert.deepEqual(await f.execute('reads', {}), { tables: ['vehicle', 'note'], other: false, noteWrites: false, vehicleWrites: true });
      // A raw write to a table the command only reads is refused, and nothing is kept.
      await assert.rejects(
        f.execute('reads', { input: { make: 'write' } }),
        (error: unknown) => error instanceof BusinessCommandExecutionError,
      );
      assert.equal(f.db.prepare('SELECT count(*) AS n FROM note').get()!.n, 0);
    },
    {
      reads: async ({ db, tx }, input) => {
        if (input.make === 'write') {
          await tx.insert({ table: 'note', values: { vehicle_id: 1, body: "Not this command's to write" } });
          return {};
        }
        return { tables: Object.keys(db), other: 'other' in db, noteWrites: 'insert' in db.note, vehicleWrites: 'insert' in db.vehicle };
      },
    },
  );
});

test('db writes: insert returns the stored row, update guards and bumps the revision, remove; a stale guard undoes all of it', async () => {
  let stale = false;
  const seen: Record<string, unknown> = {};
  await fixture(
    async (f) => {
      assert.deepEqual(await f.execute('one', {}), { version: 1 });
      assert.deepEqual(seen, { note: { vehicle_id: 1, body: 'Checked', version: 0 }, unchanged: true });
      assert.deepEqual(row(f.db, 1), { status: 'reserved', featured: 1, version: 1 });
      assert.equal(f.db.prepare('SELECT count(*) AS n FROM note').get()!.n, 0, 'the note was removed again');
      stale = true;
      await assert.rejects(f.execute('one', { key: { id: 4 } }), refusal('stale_record'));
      assert.deepEqual(row(f.db, 4), { status: 'available', featured: 0, version: 0 }, 'the stale refusal rolled the whole command back');
      assert.equal(f.db.prepare('SELECT count(*) AS n FROM note').get()!.n, 0);
    },
    {
      one: async ({ db, record }) => {
        const note = await writes(db.note).insert({ vehicle_id: record!.id, body: 'Checked' });
        const updated = await writes(db.vehicle).update(record!, { status: 'reserved' });
        // The row as first read is behind now: its guard no longer holds.
        if (stale) await writes(db.vehicle).update(record!, { status: 'sold' });
        seen.note = { vehicle_id: note.vehicle_id, body: note.body, version: note.version };
        seen.unchanged = (await writes(db.vehicle).update(updated, {})) === updated;
        await writes(db.note).remove(note);
        return { version: updated.version };
      },
    },
  );
});

test('a command that declares appendOnly is refused at its write to the target when the record moved, and only then', async () => {
  await fixture(
    async (f) => {
      assert.deepEqual(await f.execute('append', {}), { id: 1 });
      assert.equal(row(f.db, 1).version, 1, 'written once');
      // A record that moved before the request still refuses the write to it, and the note beside it is undone.
      await assert.rejects(f.execute('append', { expectedVersion: 0 }), refusal('stale_record'));
      assert.equal(row(f.db, 1).version, 1);
      assert.equal(Number((f.db.prepare('SELECT COUNT(*) AS n FROM note').get() as { n: number }).n), 1);
      // The same footprint without the declaration is refused up front, before its handler (the `one` command above).
    },
    {
      append: async ({ record, db }) => {
        await writes(db.note).insert({ vehicle_id: record!.id, body: 'noted' });
        await writes(db.vehicle).update(record!, { featured: true });
        return { id: record!.id };
      },
    },
  );
});
