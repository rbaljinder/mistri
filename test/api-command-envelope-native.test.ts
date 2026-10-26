/** Genuine executor/recovery envelopes; isolated SQLite fixture, serial gate. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { bindBusinessCommands } from '../packages/mistri/src/server/commands/businessCommandAccess.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { shape, bool } from '../packages/mistri/src/server/commands/commandShapes.js';
import { executeBusinessCommand } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { recoverBusinessCommandReceipt } from '../packages/mistri/src/server/commands/businessCommandRecovery.js';
import { createApiCommandEnvelopeBundle } from '../packages/mistri/src/server/api/apiCommandEnvelope.js';
import { parseTestApi, parseTestApp } from './support/commandCatalog.js';

for (const many of [false, true])
  test(`genuine SQLite ${many ? 'many-target' : 'one-target'} execution, replay and deleted-target recovery conform to internal envelope bundle`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tablewalk-envelope-native-')),
      path = join(directory, 'business.db');
    const db = new DatabaseSync(path),
      connections = new Registry();
    try {
      db.exec(
        "CREATE TABLE item(part TEXT NOT NULL,id INTEGER NOT NULL,version INTEGER NOT NULL,PRIMARY KEY(part,id)); INSERT INTO item VALUES('a',1,0)",
      );
      await migrateSqliteCommandJournal(path);
      connections.add({ id: 'business', name: 'Business', url: path, source: 'config', writable: true });
      const app = parseTestApp(
        {
          id: 'app',
          name: 'App',
          sources: { business: { connection: 'business' } },
          resources: { item: { access: 'write' } },
          auth: { roles: { editor: { read: true, commands: ['edit'] } } },
          views: { items: { kind: 'list', from: 'item' } },
          home: 'items',
        },
        'fixture',
      );
      let calls = 0;
      const registry = defineCommands({
        edit: defineCommand({
          source: 'business',
          target: 'item',
          ...(many ? { targets: 'many' as const } : {}),
          input: {},
          output: shape({ ok: bool() }),
          handle() {
            calls++;
            return { ok: true };
          },
        }),
      });
      const resources = await loadAppRuntimeResources(connections, app, 'business');
      const binding = bindBusinessCommands({ app, registry, resources, writableConnection: () => true });
      // Private future exposure does not relax active runtime loading refusals.
      const exposed = {
        ...app,
        api: parseTestApi(
          {
            version: 1,
            roles: ['editor'],
            commands: [{ id: 'edit', version: 1, target: 'item', ...(many ? { targets: 'many' } : {}), input: {} }],
          },
          ['editor'],
        )!,
      };
      const op = createApiCommandEnvelopeBundle(exposed, resources.schema, registry, {
        connectionFor: (resource) => resources.connectionFor(resource),
        writableConnection: () => true,
        transactionalConnection: () => true,
      }).operations[0];
      const request = {
        command: 'edit',
        commandVersion: 1,
        key: { part: 'a', id: '1' },
        expectedVersion: 0,
        input: {},
        idempotencyKey: 'envelope_native_0001',
      };
      const actor = { id: 'account', appId: 'app', roles: ['editor'] };
      const ajv = new Ajv2020({ strict: true }),
        execute = ajv.compile(op.schemas.executeResult),
        recover = ajv.compile(op.schemas.recoveryResult);
      op.validateExecuteRequest(request);
      for (const replayed of [false, true]) {
        const result = await executeBusinessCommand(binding, actor, request);
        assert.equal(result.replayed, replayed);
        assert.equal(execute(result), true);
        op.validateExecuteResult(request, result);
      }
      assert.equal(calls, 1);
      if (many) {
        const { key, expectedVersion, ...common } = request;
        const singleton = { ...common, keys: [key], expectedVersions: [expectedVersion] };
        const replay = await executeBusinessCommand(binding, actor, singleton);
        assert.equal(replay.replayed, true);
        assert.equal(execute(replay), true);
        op.validateExecuteResult(singleton, replay);
        assert.equal(calls, 1);
        db.exec("INSERT INTO item VALUES('b',2,0),('c',3,0)");
        const bulk = {
          ...common,
          idempotencyKey: 'envelope_bulk_0001',
          keys: [
            { part: 'b', id: 2 },
            { part: 'c', id: '3' },
          ],
          expectedVersions: [0, 0],
        };
        for (const replayed of [false, true]) {
          const result = await executeBusinessCommand(binding, actor, bulk);
          assert.equal(result.replayed, replayed);
          assert.equal(execute(result), true);
          op.validateExecuteResult(bulk, result);
        }
        db.exec("DELETE FROM item WHERE part IN ('b','c')");
        const recovered = await recoverBusinessCommandReceipt(binding, actor, {
          command: 'edit',
          commandVersion: 1,
          idempotencyKey: bulk.idempotencyKey,
        });
        assert.equal(recovered.status, 'applied');
        assert.equal(recover(recovered), true);
        op.validateRecoveryResult(recovered);
        assert.equal(calls, 2, 'each of two distinct receipts invokes the handler once');
      }
      db.exec('DELETE FROM item');
      const scope = { command: 'edit', commandVersion: 1, idempotencyKey: request.idempotencyKey };
      op.validateRecoveryRequest(scope);
      const result = await recoverBusinessCommandReceipt(binding, actor, scope);
      assert.equal(recover(result), true);
      op.validateRecoveryResult(result);
      const missing = await recoverBusinessCommandReceipt(binding, actor, { ...scope, idempotencyKey: 'envelope_missing_0001' });
      assert.equal(recover(missing), true);
      op.validateRecoveryResult(missing);
      assert.equal(calls, many ? 2 : 1);
    } finally {
      await connections.closeAll();
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
