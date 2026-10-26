import { ExperimentExposurePending } from '../packages/mistri/src/server/experiments/contracts.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import type { WriteTransaction } from '../packages/engine/src/adapters/adapter.js';
import { normalizeFlagCatalog, type FlagValue } from '../packages/mistri/src/shared/appFlags.js';
import { defineCommand, defineCommands, type AnyBusinessCommand } from '../packages/mistri/src/server/commands/businessCommands.js';
import {
  createCommandFlags,
  validateCommandFlagGates,
  commandFlagsReader,
  executeWithCommandFlags,
} from '../packages/mistri/src/server/commands/commandFlags.js';
import {
  executeBusinessCommand,
  lookupBusinessCommandStatus,
  type CommandDoor,
} from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { bindBusinessCommands, type BusinessCommandBinding } from '../packages/mistri/src/server/commands/businessCommandAccess.js';
import { contractDigest, appCommandCatalog } from '../packages/mistri/src/server/commands/commandContracts.js';
import { readCommandAvailability } from '../packages/mistri/src/server/commands/commandAvailability.js';
import { readPreparedRecord, readPreparedTargetAvailability } from '../packages/mistri/src/server/commands/commandPrepare.js';
import { preparesInitial } from '../packages/mistri/src/server/commands/commandPrepareNeeds.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { AppAccessDenied } from '../packages/mistri/src/server/app/appAccess.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { parseTestApp } from './support/commandCatalog.js';

const flagsCatalog = normalizeFlagCatalog({
  flags: {
    enabled: { type: 'boolean', default: false, owner: 'team' },
    copy: { type: 'string', default: 'a', variants: ['a', 'b'], owner: 'team' },
    size: { type: 'number', default: 1, variants: [1, 2], owner: 'team' },
    arbitrary: { type: 'string', default: 'any', owner: 'team' },
    config: { type: 'object', default: { nested: [true] }, owner: 'team' },
  },
  roles: [],
  audiences: {},
});
const flags = (enabled: boolean) =>
  createCommandFlags(flagsCatalog, {
    evaluate(id) {
      return { value: id === 'enabled' ? enabled : flagsCatalog.flags[id].default, reason: 'default', revision: 1, diagnostics: [] };
    },
  });
const base = { source: 'desk', target: 'item', handle() {} };
const enabledBy = { flag: 'enabled', is: true };
const actor = { id: 'account', appId: 'desk', roles: ['staff'] };
const body = (idempotencyKey = 'flag-command-request-0001') => ({
  command: 'change',
  commandVersion: 1,
  key: { id: 1 },
  expectedVersion: 0,
  input: {},
  idempotencyKey,
});

test('enabledBy is closed own scalar data, captured without evaluating; startup validates catalog references', () => {
  const gate = { ...enabledBy };
  const command = defineCommand({ ...base, enabledBy: gate });
  gate.is = false;
  assert.deepEqual(command.enabledBy, enabledBy);
  assert.ok(Object.isFrozen(command.enabledBy));
  const getter = Object.defineProperty({ is: true }, 'flag', {
    enumerable: true,
    get() {
      throw new Error('Getter ran');
    },
  });
  for (const value of [
    undefined,
    null,
    {},
    { ...enabledBy, extra: true },
    { flag: 'enabled' },
    { flag: 'enabled', is: {} },
    { flag: 'enabled', is: NaN },
    { flag: 'enabled', is: Infinity },
    Object.create(enabledBy),
    getter,
    { ...enabledBy, [Symbol('extra')]: true },
  ]) {
    assert.throws(() => defineCommand({ ...base, enabledBy: value } as never), /enabledBy/);
  }
  for (const gate of [enabledBy, { flag: 'enabled', is: false }, { flag: 'copy', is: 'b' }, { flag: 'size', is: 2 }]) {
    validateCommandFlagGates(defineCommands({ change: defineCommand({ ...base, enabledBy: gate }) }), flagsCatalog);
  }
  for (const gate of [
    { flag: 'missing', is: true },
    { flag: 'copy', is: 'c' },
    { flag: 'size', is: '2' },
    { flag: 'arbitrary', is: 'any' },
    { flag: 'config', is: true },
  ]) {
    assert.throws(() => validateCommandFlagGates(defineCommands({ change: defineCommand({ ...base, enabledBy: gate }) }), flagsCatalog));
  }
  const app = { sources: { desk: { connection: 'desk-db', default: true } } };
  assert.notEqual(contractDigest(app, command), contractDigest(app, defineCommand(base)));
  assert.deepEqual((appCommandCatalog({ change: command }, app).get('change') as unknown as { enabledBy: unknown }).enabledBy, enabledBy);
});

test('host readers detach and freeze values; absent, undeclared and structural readers never default to false', () => {
  const object = { nested: [true] };
  let current = true;
  const reader = createCommandFlags(flagsCatalog, {
    evaluate(id) {
      return {
        value: id === 'enabled' ? current : id === 'config' ? object : flagsCatalog.flags[id].default,
        reason: 'default',
        revision: 1,
        diagnostics: [],
      };
    },
  });
  current = false;
  object.nested[0] = false;
  const value: FlagValue = reader.get('enabled');
  assert.equal(value, true);
  assert.deepEqual(reader.get('config'), { nested: [true] });
  assert.ok(Object.isFrozen(reader.get('config')));
  assert.throws(() => reader.get('missing'), /Undeclared/);
  assert.throws(() => commandFlagsReader().get('enabled'), /not configured/);
  assert.throws(() => commandFlagsReader({ get: () => true }).get('enabled'), /not configured/);
});

async function fixture(
  run: (f: {
    binding: BusinessCommandBinding;
    db: DatabaseSync;
    command: AnyBusinessCommand;
    calls: { handle: number; lookup: number; availability: number; initial: number };
  }) => Promise<void>,
  track?: 'none' | 'receipts' | 'audit',
) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-flag-command-'));
  const path = join(directory, 'desk.db'),
    db = new DatabaseSync(path),
    registry = new Registry();
  try {
    db.exec('CREATE TABLE item (id INTEGER PRIMARY KEY, version INTEGER NOT NULL, note TEXT); INSERT INTO item VALUES (1, 0, NULL);');
    migrateSqliteCommandJournal(path);
    registry.add({ id: 'desk-db', name: 'Desk', url: path, writable: true, source: 'config' });
    const app = parseTestApp(
      {
        id: 'desk',
        name: 'Desk',
        sources: { desk: { connection: 'desk-db' } },
        resources: { item: { access: 'write' } },
        auth: { roles: { staff: { read: true, commands: ['change'] }, viewer: { read: true } } },
        views: { items: { kind: 'list', from: 'item' } },
        home: 'items',
      },
      'flag fixture',
    );
    const calls = { handle: 0, lookup: 0, availability: 0, initial: 0 };
    const command = defineCommand({
      ...base,
      enabledBy,
      ...(track ? { track } : {}),
      sources: { desk: ['item'] },
      initial({ flags }) {
        calls.initial++;
        assert.equal(flags.get('enabled'), true);
        return {};
      },
      availability({ flags, records }) {
        calls.availability++;
        assert.equal(flags.get('enabled'), true);
        return records.map(() => true);
      },
      lookup({ flags }) {
        calls.lookup++;
        assert.equal(flags.get('enabled'), true);
        return {};
      },
      async handle({ flags, db, record }) {
        calls.handle++;
        assert.equal(flags.get('enabled'), true);
        await db.item.update(record, { note: 'changed' });
      },
    });
    const binding = bindBusinessCommands({
      app,
      resources: await loadAppRuntimeResources(registry, app, 'desk-db'),
      registry: defineCommands({ change: command }),
      writableConnection: () => true,
    });
    await run({ binding, db, command, calls });
  } finally {
    await registry.closeAll();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const [name, track, door] of [
  ['receipt-first', undefined, undefined],
  ['none', 'none', 'ui'],
  ['receipts', 'receipts', 'ui'],
  ['audit', 'audit', 'ui'],
  ['API', 'none', 'api'],
  ['job', 'none', 'job'],
] as const)
  test(`${name}: new attempts fail closed before lookup; durable replay works while off or unconfigured`, async () => {
    await fixture(async ({ binding, db, calls }) => {
      const options = { door: door as CommandDoor | undefined };
      for (const reader of [undefined, flags(false), { get: () => true }]) {
        await assert.rejects(executeBusinessCommand(binding, actor, body(), { ...options, flags: reader }), { code: 'forbidden' });
      }
      await assert.rejects(executeBusinessCommand(binding, actor, { ...body(), flags: { enabled: true } }, options), {
        code: 'invalid_input',
      });
      const actorWithFlags = { ...actor, flags: flags(true) };
      await assert.rejects(executeBusinessCommand(binding, actorWithFlags, body(), options), { code: 'forbidden' });
      assert.deepEqual(calls, { handle: 0, lookup: 0, availability: 0, initial: 0 });
      assert.equal(db.prepare('SELECT version FROM item').get()!.version, 0);
      await assert.rejects(executeBusinessCommand(binding, { ...actor, roles: ['viewer'] }, body(), { ...options, flags: flags(true) }), {
        code: 'forbidden',
      });
      const applied = await executeBusinessCommand(binding, actor, body(), { ...options, flags: flags(true) });
      assert.equal(applied.replayed, false);
      assert.deepEqual(calls, { handle: 1, lookup: 1, availability: 1, initial: 0 });
      for (const reader of [undefined, flags(false)]) {
        if (name === 'none') {
          await assert.rejects(executeBusinessCommand(binding, actor, body(), { ...options, flags: reader }), { code: 'forbidden' });
        } else {
          assert.deepEqual(await executeBusinessCommand(binding, actor, body(), { ...options, flags: reader }), {
            ...applied,
            replayed: true,
          });
          assert.deepEqual(await lookupBusinessCommandStatus(binding, actor, body(), { flags: reader }), { ...applied, replayed: true });
        }
      }
      await assert.rejects(executeBusinessCommand(binding, actor, body('flag-command-new-request'), { ...options, flags: flags(false) }), {
        code: 'forbidden',
      });
      await assert.rejects(lookupBusinessCommandStatus(binding, { ...actor, roles: ['viewer'] }, body()), { code: 'forbidden' });
      assert.equal(calls.handle, 1);
      assert.equal(calls.lookup, 1);
      assert.equal(calls.availability, 1);
    }, track);
  });

test('receipt recovery still checks current row and result authority when the flag is off', async () => {
  await fixture(async ({ binding, calls }) => {
    let targetVisible = true,
      resultVisible = true;
    const scoped: BusinessCommandBinding = {
      scoped: true,
      authorize(id, who) {
        return {
          ...binding.authorize(id, who),
          assertTarget: async () => {
            if (!targetVisible) throw new AppAccessDenied();
          },
          assertResult: async () => {
            if (!resultVisible) throw new AppAccessDenied();
          },
        };
      },
    };
    const applied = await executeBusinessCommand(scoped, actor, body(), { flags: flags(true), door: 'api' });
    assert.deepEqual(await executeBusinessCommand(scoped, actor, body(), { flags: flags(false), door: 'api' }), {
      ...applied,
      replayed: true,
    });
    targetVisible = false;
    await assert.rejects(executeBusinessCommand(scoped, actor, body(), { flags: flags(false) }), { code: 'forbidden' });
    targetVisible = true;
    resultVisible = false;
    await assert.rejects(lookupBusinessCommandStatus(scoped, actor, body()), { code: 'forbidden' });
    assert.equal(calls.handle, 1);
    assert.equal(calls.lookup, 1);
  });
});

test('prepare and availability use the same issued reader, including commands with only a gate', async () => {
  await fixture(async ({ binding, command, calls }) => {
    const auth = binding.authorize('change', actor);
    const options = {
      command,
      commandId: 'change',
      actor,
      catalog: auth.catalog,
      key: { id: 1 },
      signal: new AbortController().signal,
      check: { command: 'change', commandVersion: 1, keys: [{ id: 1 }] },
    };
    for (const candidate of [command, defineCommand({ ...base, enabledBy })]) {
      assert.equal(preparesInitial(candidate), true);
      const selected = { ...options, command: candidate };
      for (const reader of [undefined, flags(false)]) {
        await auth.transaction(async (tx) => {
          await assert.rejects(readPreparedRecord(tx, { ...selected, flags: reader }), { code: 'forbidden' });
          assert.deepEqual(await readCommandAvailability({ ...selected, reader: tx, flags: reader }), [false]);
          const targets = [{ key: { id: 1 }, expectedVersion: 0, eligible: true }];
          assert.equal((await readPreparedTargetAvailability(tx, { ...selected, targets, flags: reader }))[0].eligible, false);
        });
      }
    }
    assert.deepEqual(calls, { handle: 0, lookup: 0, availability: 0, initial: 0 });
    await auth.transaction(async (tx) => {
      assert.deepEqual(await readPreparedRecord(tx, { ...options, flags: flags(true) }), { expectedVersion: 0, initial: {} });
      assert.deepEqual(await readCommandAvailability({ ...options, reader: tx, flags: flags(true) }), [true]);
      const targets = [{ key: { id: 1 }, expectedVersion: 0, eligible: false }];
      assert.equal((await readPreparedTargetAvailability(tx, { ...options, targets, flags: flags(true) }))[0].eligible, false);
    });
    assert.equal(calls.initial, 1);
    assert.equal(calls.availability, 2);
    const hidden = { query: async () => ({ rows: [] }) } as unknown as WriteTransaction;
    await assert.rejects(readPreparedRecord(hidden, { ...options, flags: flags(true) }), { code: 'not_found' });
    assert.deepEqual(await readCommandAvailability({ ...options, reader: hidden, flags: flags(true) }), [false]);
  });
});

test('prepare and availability capture their reader before waiting on database reads', async () => {
  await fixture(async ({ binding, command }) => {
    const auth = binding.authorize('change', actor);
    await auth.transaction(async (tx) => {
      const options = {
        command,
        commandId: 'change',
        actor,
        catalog: auth.catalog,
        key: { id: 1 },
        flags: flags(true),
        signal: new AbortController().signal,
        check: { command: 'change', commandVersion: 1, keys: [{ id: 1 }] },
        targets: [{ key: { id: 1 }, expectedVersion: 0, eligible: true }],
      };
      const reader: WriteTransaction = {
        ...tx,
        async query(request) {
          options.flags = flags(false);
          return tx.query(request);
        },
      };
      assert.deepEqual(await readPreparedRecord(reader, options), { expectedVersion: 0, initial: {} });
      options.flags = flags(true);
      // Keep the options object itself: replacement during the read cannot swap the captured reader.
      const availabilityOptions = Object.assign(options, { reader });
      assert.deepEqual(await readCommandAvailability(availabilityOptions), [true]);
      options.flags = flags(true);
      assert.equal((await readPreparedTargetAvailability(reader, options))[0].eligible, true);
    });
  });
});

test('commands with no target records, including public principals, cannot bypass the gate with an empty availability batch', async () => {
  await fixture(async ({ binding, db }) => {
    for (const publicCommand of [false, true]) {
      let calls = 0;
      const command = defineCommand({
        source: 'desk',
        target: 'item',
        targets: 'none',
        enabledBy,
        ...(publicCommand ? { public: true as const } : {}),
        async handle({ flags, db }) {
          calls++;
          assert.equal(flags.get('enabled'), true);
          await db.item.insert({ version: 0, note: 'created' });
        },
      });
      const principal = publicCommand ? { id: 'public:intake', appId: 'desk', roles: [], kind: 'public' as const, form: 'intake' } : actor;
      // Trusted binding seam: reuse the fixture's footprint transaction while
      // handing the executor the already-authorized create/public command.
      const creating: BusinessCommandBinding = {
        creates: () => true,
        authorize() {
          return { ...binding.authorize('change', actor), command, actor: principal, keyColumns: [] };
        },
      };
      const request = { ...body(`flag-create-request-${publicCommand}`), key: {} };
      for (const reader of [undefined, flags(false)]) {
        await assert.rejects(executeBusinessCommand(creating, principal, request, { flags: reader, door: 'ui' }), { code: 'forbidden' });
      }
      assert.equal(calls, 0);
      const applied = await executeBusinessCommand(creating, principal, request, { flags: flags(true), door: 'ui' });
      assert.equal(calls, 1);
      assert.deepEqual(await executeBusinessCommand(creating, principal, request, { flags: flags(false), door: 'ui' }), {
        ...applied,
        replayed: true,
      });
    }
    assert.equal(db.prepare('SELECT count(*) AS n FROM item').get()!.n, 3);
  });
});

test('actual handler consumption records once; availability and durable replay stay passive', async () => {
  await fixture(async ({ binding, calls }) => {
    const used: string[] = [];
    const reader = createCommandFlags(
      flagsCatalog,
      {
        evaluate: (id) => ({
          value: id === 'enabled' ? true : flagsCatalog.flags[id].default,
          reason: 'default',
          revision: 1,
          diagnostics: [],
        }),
      },
      () => {},
      async (id) => {
        used.push(id);
      },
    );
    reader.get('enabled');
    assert.deepEqual(used, []);
    await executeBusinessCommand(binding, actor, body(), { flags: reader });
    assert.deepEqual(used, ['enabled']);
    assert.equal(calls.availability, 1);
    await executeBusinessCommand(binding, actor, body(), { flags: reader });
    assert.deepEqual(used, ['enabled']);
    assert.equal(calls.handle, 1);
  });
});

test('telemetry failures drain without undoing handler result and retained readers retire', async () => {
  const used: string[] = [];
  const reader = createCommandFlags(
    flagsCatalog,
    { evaluate: (id) => ({ value: flagsCatalog.flags[id].default, reason: 'default', revision: 1, diagnostics: [] }) },
    () => {},
    async (id) => {
      used.push(id);
      throw new ExperimentExposurePending();
    },
  );
  let retained: typeof reader | undefined;
  const result = await executeWithCommandFlags(reader, undefined, async (flags) => {
    retained = flags;
    flags.get('copy');
    flags.get('copy');
    return 'committed';
  });
  assert.equal(result, 'committed');
  assert.deepEqual(used, ['copy']);
  assert.throws(() => retained!.get('copy'), /retired/);
  await assert.rejects(
    executeWithCommandFlags(reader, undefined, async (flags) => {
      flags.get('enabled');
      throw new Error('business failure');
    }),
    /business failure/,
  );
  assert.deepEqual(used, ['copy', 'enabled']);
});

test('experimental enrollment failure rolls back the handler transaction before receipt commit', async () => {
  await fixture(async ({ binding, db, calls }) => {
    const reader = createCommandFlags(
      flagsCatalog,
      {
        evaluate: (id) => ({
          value: id === 'enabled' ? true : flagsCatalog.flags[id].default,
          reason: 'default',
          revision: 1,
          diagnostics: [],
        }),
      },
      () => {},
      async () => {
        throw new Error('enrollment unavailable');
      },
    );
    await assert.rejects(executeBusinessCommand(binding, actor, body(), { flags: reader }));
    assert.equal(calls.handle, 1, 'sync reads may run, but the transaction cannot commit untracked use');
    assert.equal(db.prepare('SELECT note FROM item WHERE id=1').get()!.note, null);
    const result = await executeBusinessCommand(binding, actor, body(), { flags: flags(true) });
    assert.equal(result.replayed, false, 'the failed attempt wrote no replay receipt');
  });
});
