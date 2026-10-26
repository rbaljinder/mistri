/** Shared ordinary recovery through a real authorized binding and native journal. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  migrateSqliteCommandJournal,
  isOrdinarySqliteCommandJournal,
  COMMAND_JOURNAL_TABLES,
} from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { isOrdinaryPostgresCommandJournal } from '../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { bindBusinessCommands, type BusinessCommandBinding } from '../packages/mistri/src/server/commands/businessCommandAccess.js';
import { defineCommand, defineCommands, type BusinessCommandActor } from '../packages/mistri/src/server/commands/businessCommands.js';
import { BusinessCommandExecutionError } from '../packages/mistri/src/server/commands/commandErrors.js';
import { recoverBusinessCommandReceipt } from '../packages/mistri/src/server/commands/businessCommandRecovery.js';
import { executeBusinessCommand } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { canonicalCommandJson } from '../packages/mistri/src/server/commands/commandPayload.js';
import { commandsOf } from '../packages/mistri/src/server/stores/commandStores.js';

const actor: BusinessCommandActor = { id: 'account', appId: 'recovery-app', roles: ['editor'] };
const request = { command: 'edit', commandVersion: 1, idempotencyKey: 'recovery_attempt_0001' };
const refusal = (code: string, field?: string) => (error: unknown) => {
  assert.ok(error instanceof BusinessCommandExecutionError);
  assert.equal(error.code, code);
  assert.equal(error.outcome, 'unknown');
  assert.equal(error.key, undefined);
  assert.equal(error.field, field);
  assert.doesNotMatch(error.message, /private|SELECT|secret/i);
  return true;
};

async function fixture(
  run: (value: {
    binding: BusinessCommandBinding;
    db: DatabaseSync;
    seed(keys: unknown[], options?: { target?: string; result?: string; actorId?: string }): Promise<void>;
    calls: { forbidden: number; output: number; project: boolean; execute: boolean; abort?: AbortController };
  }) => Promise<void>,
  many = true,
) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-shared-recovery-'));
  const path = join(directory, 'business.db');
  const db = new DatabaseSync(path),
    registry = new Registry();
  try {
    db.exec('CREATE TABLE ticket(tenant TEXT NOT NULL,id INTEGER NOT NULL,version INTEGER NOT NULL,PRIMARY KEY(tenant,id));');
    await migrateSqliteCommandJournal(path);
    registry.add({ id: 'business', name: 'Business', url: path, writable: true, source: 'config' });
    const app = parseAppConfig(
      {
        id: actor.appId,
        name: 'Recovery',
        sources: { business: { connection: 'business' } },
        resources: { ticket: { access: 'write' } },
        auth: { roles: { editor: { read: true, commands: ['edit'] }, reader: { read: true } } },
        views: { tickets: { kind: 'list', from: 'ticket' } },
        home: 'tickets',
      },
      'recovery test',
    );
    const calls = { forbidden: 0, output: 0, project: false, execute: false, abort: undefined as AbortController | undefined };
    const forbidden = (): never => {
      calls.forbidden++;
      throw new Error('private callback must not run');
    };
    const command = defineCommand({
      source: 'business',
      target: 'ticket',
      ...(many ? { targets: 'many' as const } : { initial: forbidden }),
      input: {},
      validate: (input: Record<string, never>): Record<string, never> => (calls.execute ? input : forbidden()),
      sources: { business: ['ticket'] },
      lookup: () => (calls.execute ? null : forbidden()),
      availability: (context) => (calls.execute ? context.records.map(() => true) : forbidden()),
      output: {
        parse(value: unknown) {
          calls.output++;
          calls.abort?.abort();
          return calls.project ? {} : value;
        },
      },
      handle: () => (calls.execute ? { ok: true } : forbidden()),
    });
    const resources = await loadAppRuntimeResources(registry, app, 'business');
    const binding = bindBusinessCommands({
      app,
      registry: defineCommands({ edit: command }),
      resources,
      writableConnection: (id) => registry.configOf(id)?.writable === true,
    });
    const seed = async (keys: unknown[], options: { target?: string; result?: string; actorId?: string } = {}) => {
      await commandsOf(binding.authorize('edit', actor)).commandTransaction!(async (_records, journal) => {
        assert.equal(isOrdinarySqliteCommandJournal(journal), true);
        assert.equal(isOrdinaryPostgresCommandJournal(journal), false);
        assert.equal(isOrdinarySqliteCommandJournal({ ...journal }), false);
        await journal.commit(
          {
            id: 'receipt',
            appId: actor.appId,
            actorId: options.actorId ?? actor.id,
            commandId: 'edit',
            commandVersion: 1,
            idempotencyKey: request.idempotencyKey,
            fingerprint: 'irreversible',
            resultJson: options.result ?? '{"ok":true}',
            requestId: 'original-request',
            completedAt: '2026-09-14T12:00:00.000Z',
          },
          keys.map((key) => ({
            target: options.target ?? 'ticket',
            keyJson: canonicalCommandJson(key, 8192),
            changesJson: '[{"secret":"hidden"}]',
          })),
        );
      });
    };
    await run({ binding, db, seed, calls });
    assert.equal(calls.forbidden, 0);
  } finally {
    await registry.closeAll();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test('recovery returns ordered immutable targets after deletion, without business callbacks or old input', async () => {
  await fixture(async ({ binding, db, seed, calls }) => {
    await seed([
      { tenant: 'east', id: '2' },
      { tenant: 'west', id: 1 },
    ]);
    assert.equal(db.prepare('SELECT count(*) AS n FROM ticket').get()?.n, 0);
    const answer = await recoverBusinessCommandReceipt(binding, actor, request);
    assert.equal(answer.status, 'applied');
    if (answer.status !== 'applied') assert.fail();
    assert.deepEqual(
      answer.targets.map((key) => ({ ...key })),
      [
        { tenant: 'east', id: '2' },
        { tenant: 'west', id: 1 },
      ],
    );
    assert.equal(answer.recovered, true);
    assert.equal(answer.receiptId, 'receipt');
    assert.ok(Object.isFrozen(answer));
    assert.ok(Object.isFrozen(answer.targets));
    assert.ok(answer.targets.every(Object.isFrozen));
    assert.ok(Object.isFrozen(answer.result));
    assert.doesNotMatch(JSON.stringify(answer), /secret|fingerprint|expectedVersion|input|requestId/);
    assert.equal(calls.output, 1);
    assert.deepEqual(await recoverBusinessCommandReceipt(binding, { ...actor, id: 'different-account' }, request), {
      status: 'not_found',
      outcome: 'unknown',
    });
    await assert.rejects(recoverBusinessCommandReceipt(binding, { ...actor, roles: ['reader'] }, request), refusal('forbidden'));
    await assert.rejects(
      recoverBusinessCommandReceipt(binding, actor, { ...request, commandVersion: 2 }),
      refusal('command_version_mismatch'),
    );
  });
});

test('actual execution format recovers after deletion without rerunning callbacks, and cancellation stays unknown', async () => {
  await fixture(async ({ binding, db, calls }) => {
    db.exec("INSERT INTO ticket VALUES('east',1,0)");
    calls.execute = true;
    const applied = await executeBusinessCommand(binding, actor, {
      ...request,
      key: { tenant: 'east', id: '1' },
      input: {},
      expectedVersion: 0,
    });
    calls.execute = false;
    db.exec('DELETE FROM ticket');
    const recovered = await recoverBusinessCommandReceipt(binding, actor, request);
    assert.equal(recovered.status, 'applied');
    if (recovered.status !== 'applied') assert.fail();
    assert.equal(recovered.receiptId, applied.receiptId);
    assert.deepEqual(recovered.result, applied.result);
    assert.deepEqual(
      recovered.targets.map((key) => ({ ...key })),
      [{ id: '1', tenant: 'east' }],
    );
    const before = new AbortController();
    before.abort();
    await assert.rejects(recoverBusinessCommandReceipt(binding, actor, request, { signal: before.signal }), refusal('cancelled'));
    const during = new AbortController();
    calls.abort = during;
    await assert.rejects(recoverBusinessCommandReceipt(binding, actor, request, { signal: during.signal }), refusal('cancelled'));
    calls.abort = undefined;
    const after = new AbortController();
    const late: BusinessCommandBinding = {
      ...binding,
      authorize(id, principal) {
        const authorized = binding.authorize(id, principal);
        return {
          ...authorized,
          async commandTransaction(run) {
            const result = await commandsOf(authorized).commandTransaction!(run);
            after.abort();
            return result;
          },
        };
      },
    };
    await assert.rejects(recoverBusinessCommandReceipt(late, actor, request, { signal: after.signal }), refusal('cancelled'));
  }, false);
});

test('recovery refuses unsupported authority before opening a transaction', async () => {
  await fixture(async ({ binding }) => {
    for (const candidate of [
      { ...actor, kind: 'public' as const },
      { ...actor, kind: 'service' as const },
    ]) {
      await assert.rejects(recoverBusinessCommandReceipt(binding, candidate, request), refusal('forbidden'));
    }
    for (const candidate of [
      { ...binding, scoped: true as const },
      { ...binding, creates: () => true },
      {
        ...binding,
        authorize(id: string, principal: BusinessCommandActor) {
          return { ...binding.authorize(id, principal), receiptOwner: { storeId: 'store', sourceId: 'business', tenantId: 'tenant' } };
        },
      },
    ])
      await assert.rejects(recoverBusinessCommandReceipt(candidate, actor, request), refusal('forbidden'));
    /* The refusal names the member it objected to, where the name is the
       envelope's own: a recovery body carrying `input` is refused without
       repeating that name back, since the sender chose it. */
    for (const [extra, field] of [
      [{ input: {} }, undefined],
      [{ key: {} }, undefined],
      [{ expectedVersion: 0 }, undefined],
      [{ commandVersion: 0 }, 'commandVersion'],
      [{ idempotencyKey: 'short' }, 'idempotencyKey'],
    ] as const) {
      await assert.rejects(recoverBusinessCommandReceipt(binding, actor, { ...request, ...extra }), refusal('invalid_input', field));
    }
  });
});

test('recovery refuses wrong resource, incomplete/extra/typed keys, duplicates and output projection', async () => {
  const cases = [
    { keys: [{ tenant: 'east', id: 1 }], target: 'other' },
    { keys: [{ id: 1 }] },
    { keys: [{ tenant: 'east', id: 1, extra: 2 }] },
    { keys: [{ tenant: 'east', id: '1.5' }] },
    {
      keys: [
        { tenant: 'east', id: 1 },
        { tenant: 'east', id: '1' },
      ],
    },
  ];
  for (const { keys, ...options } of cases)
    await fixture(async ({ binding, seed }) => {
      await seed(keys, options);
      await assert.rejects(recoverBusinessCommandReceipt(binding, actor, request), refusal('invalid_result'));
    });
  await fixture(async ({ binding, seed, calls }) => {
    await seed([{ tenant: 'east', id: 1 }]);
    calls.project = true;
    await assert.rejects(recoverBusinessCommandReceipt(binding, actor, request), refusal('invalid_result'));
  });
  await fixture(async ({ binding, seed }) => {
    await seed([
      { tenant: 'east', id: 1 },
      { tenant: 'east', id: 2 },
    ]);
    await assert.rejects(recoverBusinessCommandReceipt(binding, actor, request), refusal('invalid_result'));
  }, false);
  for (const result of [' {"ok":true}', '{"id":0,"id":1}', '{"id":1e0}', '{"id":9007199254740993}']) {
    await fixture(async ({ binding, seed, calls }) => {
      await seed([{ tenant: 'east', id: 1 }], { result });
      await assert.rejects(recoverBusinessCommandReceipt(binding, actor, request), refusal('invalid_result'));
      assert.equal(calls.output, 0);
    });
  }
  for (const raw of [
    ' {"id":1,"tenant":"east"}',
    '{"id":0,"id":1,"tenant":"east"}',
    '{"id":1e0,"tenant":"east"}',
    '{"id":9007199254740993,"tenant":"east"}',
  ]) {
    await fixture(async ({ binding, seed, db, calls }) => {
      await seed([{ tenant: 'east', id: 1 }]);
      db.prepare(`UPDATE "${COMMAND_JOURNAL_TABLES.receipt}" SET keys_json=json_array(?)`).run(raw);
      await assert.rejects(recoverBusinessCommandReceipt(binding, actor, request), refusal('invalid_result'));
      assert.equal(calls.output, 0);
    });
  }
});
