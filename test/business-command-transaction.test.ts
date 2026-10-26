import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { WriteConflict, type WriteTransaction } from '../packages/engine/src/adapters/adapter.js';
import { AppAccessDenied, authorizeResources } from '../packages/mistri/src/server/app/appAccess.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { bindBusinessCommands, type AuthorizedBusinessCommand } from '../packages/mistri/src/server/commands/businessCommandAccess.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { parseAppConfig, resolveAppAccess } from '../packages/mistri/src/shared/app.js';

const actor = { id: 'verified-manager', appId: 'loan-operations', roles: ['manager'] };
const rowQuery = (table: string) => ({ table, limit: 10, offset: 0 });

async function fixture(run: (command: AuthorizedBusinessCommand, db: DatabaseSync) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-command-transaction-'));
  const database = join(directory, 'lending.db');
  const db = new DatabaseSync(database);
  db.exec(`
    CREATE TABLE physical_reviewer (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE physical_application (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, reviewer_id INTEGER REFERENCES physical_reviewer(id),
      version INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE physical_assignment_history (
      id INTEGER PRIMARY KEY, loan_id INTEGER NOT NULL REFERENCES physical_application(id),
      actor TEXT NOT NULL, reason TEXT NOT NULL
    );
    CREATE TABLE internal_note (
      id INTEGER PRIMARY KEY, loan_id INTEGER NOT NULL REFERENCES physical_application(id) ON DELETE CASCADE,
      name TEXT NOT NULL
    );
    INSERT INTO physical_reviewer VALUES (2, 'Reviewer');
    INSERT INTO physical_application (id, name) VALUES (1, 'Application');
    INSERT INTO internal_note VALUES (1, 1, 'Private note');
  `);
  const connection = 'private-lending-connection';
  const registry = new Registry();
  registry.add({ id: connection, name: 'Lending', url: database, writable: true, source: 'config' });
  let handlerCalls = 0;
  try {
    const app = parseAppConfig(
      {
        id: actor.appId,
        name: 'Loan Operations',
        sources: { lending: { connection } },
        resources: {
          loan: { physical: 'physical_application', access: 'write' },
          history: { physical: 'physical_assignment_history', access: 'write' },
          reviewer: { physical: 'physical_reviewer' },
        },
        auth: {
          roles: { manager: { read: true, commands: ['assign-reviewer'] }, viewer: { read: true } },
        },
        views: { loans: { kind: 'list', from: 'loan' } },
        home: 'loans',
      },
      'business command transaction fixture',
    );
    const resources = await loadAppRuntimeResources(registry, app, connection);
    const generic = authorizeResources(resources, resolveAppAccess(app, resources.schema, actor.roles));
    await assert.rejects(async () => generic.adapter.update!({ table: 'loan', key: { id: 1 }, values: { version: 99 } }), AppAccessDenied);
    const commands = defineCommands({
      'assign-reviewer': defineCommand({
        targets: 'none',
        source: 'lending',
        target: 'loan',
        read: ['loan', 'history', 'reviewer'],
        write: ['loan', 'history'],
        input: {},
        output: { parse: (value: unknown) => value },
        handle: (): unknown => {
          handlerCalls++;
          throw new Error('This test must not dispatch a handler.');
        },
      }),
    });
    const command = bindBusinessCommands({
      app,
      registry: commands,
      resources,
      writableConnection: (owner) => registry.configOf(owner)?.writable === true,
    }).authorize('assign-reviewer', actor);
    await run(command, db);
    assert.equal(handlerCalls, 0, 'binding and transaction callbacks are not command dispatch');
  } finally {
    await registry.closeAll();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

const history = (tx: WriteTransaction) =>
  tx.insert({
    table: 'history',
    values: { loan_id: 1, actor: actor.id, reason: 'Manual assignment' },
  });
const unchanged = (db: DatabaseSync) => {
  assert.deepEqual(
    { ...db.prepare('SELECT reviewer_id, version FROM physical_application WHERE id = 1').get() },
    { reviewer_id: null, version: 0 },
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM physical_assignment_history').get()?.n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM internal_note').get()?.n, 1);
};

test('authorized logical transaction commits assignment and history together without generic CRUD grants', async () => {
  await fixture(async (command, db) => {
    const result = await command.transaction(async (tx) => {
      assert.equal(await tx.count('loan'), 1);
      assert.equal((await tx.query(rowQuery('reviewer'))).rows[0].id, 2);
      await tx.update({
        table: 'loan',
        key: { id: 1 },
        values: { reviewer_id: 2, version: 1 },
        expected: { reviewer_id: null, version: 0 },
      });
      await history(tx);
      assert.equal(await tx.count('history'), 1);
      assert.equal((await tx.query(rowQuery('loan'))).rows[0].version, 1);
      return 'Assignment recorded';
    });
    assert.equal(result, 'Assignment recorded');
    assert.deepEqual(
      { ...db.prepare('SELECT reviewer_id, version FROM physical_application WHERE id = 1').get() },
      { reviewer_id: 2, version: 1 },
    );
    assert.deepEqual(
      { ...db.prepare('SELECT loan_id, actor, reason FROM physical_assignment_history').get() },
      {
        loan_id: 1,
        actor: command.actor.id,
        reason: 'Manual assignment',
      },
    );
  });
});

test('version conflict rolls back earlier history written through the logical facade', async () => {
  await fixture(async (command, db) => {
    await assert.rejects(
      command.transaction(async (tx) => {
        await history(tx);
        await tx.update({
          table: 'loan',
          key: { id: 1 },
          values: { reviewer_id: 2, version: 2 },
          expected: { reviewer_id: null, version: 1 },
        });
      }),
      WriteConflict,
    );
    unchanged(db);
  });
});

test('caught local-name, footprint and dependent-write refusals still roll back prior writes', async () => {
  await fixture(async (command, db) => {
    const attempts: Array<(tx: WriteTransaction) => Promise<unknown>> = [
      (tx) => tx.query(rowQuery('lending.loan')),
      (tx) => tx.update({ table: 'physical_application', key: { id: 1 }, values: { version: 1 } }),
      (tx) => tx.update({ table: 'reviewer', key: { id: 2 }, values: { name: 'Forbidden write' } }),
      (tx) => tx.remove({ table: 'loan', key: { id: 1 } }),
    ];
    for (const attempt of attempts) {
      let caught = false;
      await assert.rejects(
        command.transaction(async (tx) => {
          await history(tx);
          await attempt(tx).catch((error) => {
            assert.ok(error instanceof AppAccessDenied);
            caught = true;
          });
          return 'Must not commit';
        }),
        AppAccessDenied,
      );
      assert.equal(caught, true);
      unchanged(db);
    }
    assert.equal(db.prepare('SELECT name FROM physical_reviewer WHERE id = 2').get()?.name, 'Reviewer');
  });
});

test('escaped authorized transaction handles refuse reads and writes after commit or rollback', async () => {
  await fixture(async (command, db) => {
    for (const fail of [false, true]) {
      let escaped!: WriteTransaction;
      const work = command.transaction(async (tx) => {
        escaped = tx;
        if (fail) throw new Error('Rollback');
      });
      if (fail) await assert.rejects(work, /Rollback/);
      else await work;
      for (const operation of [
        () => escaped.query(rowQuery('loan')),
        () => escaped.count('loan'),
        () => history(escaped),
        () => escaped.update({ table: 'loan', key: { id: 1 }, values: { version: 1 } }),
        () => escaped.remove({ table: 'loan', key: { id: 1 } }),
      ])
        await assert.rejects(operation, /no longer active/);
      unchanged(db);
    }
  });
});
