import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defineCommand,
  defineCommands,
  type BusinessCommandAvailabilityContext,
} from '../packages/mistri/src/server/commands/businessCommands.js';
import {
  collectCommandAvailability,
  readCommandAvailability,
  evaluateCommandAvailability,
} from '../packages/mistri/src/server/commands/commandAvailability.js';
import { parseCommandAvailability } from '../packages/mistri/src/server/commands/commandPayload.js';
import { BusinessCommandExecutionError } from '../packages/mistri/src/server/commands/commandErrors.js';
import { defineSource, type CommandCatalog } from '../packages/mistri/src/server/commands/commandDb.js';
import { bool } from '../packages/mistri/src/server/commands/commandShapes.js';
import { field } from '../packages/mistri/src/server/commands/commandFields.js';
import { BULK_LIMIT } from '../packages/mistri/src/shared/command.js';
import { readPreparedRecord, readPreparedTargetAvailability } from '../packages/mistri/src/server/commands/commandPrepare.js';
import { preparesInitial } from '../packages/mistri/src/server/commands/commandPrepareNeeds.js';
import type { WriteTransaction } from '../packages/engine/src/adapters/adapter.js';

const source = defineSource<{ item: { id: number; version: number; team_id: number } }>('data');
const base = () => ({
  source,
  target: 'item' as const,
  input: {},
  output: bool(),
  handle() {
    throw new Error('Handler must never execute.');
  },
});
const catalog: CommandCatalog = {
  item: {
    name: 'item',
    key: ['id'],
    kinds: { id: 'number', version: 'number', team_id: 'number' },
    meta: {
      id: 'item',
      name: 'item',
      schema: '',
      isView: false,
      columns: ['id', 'version', 'team_id'].map((name) => ({ name, type: 'INTEGER', nullable: false, primaryKey: name === 'id' })),
    },
  },
};
const options = () => ({
  commandId: 'change',
  actor: { id: 'account', appId: 'app', roles: ['manager'] },
  records: [
    { id: 1, version: 0, team_id: 2 },
    { id: 2, version: 1, team_id: 3 },
  ],
  catalog,
  reader: {
    query: async () => {
      throw new Error('No reads expected.');
    },
    count: async () => 0,
  },
  signal: new AbortController().signal,
  requestId: 'availability-test',
  now: () => new Date('2026-01-01'),
});

test('availability protocol strictly bounds commands and total distinct keys without actor input', () => {
  const check = { command: 'change', commandVersion: 1, keys: [{ id: 1 }] };
  assert.equal(JSON.stringify(parseCommandAvailability({ checks: [check] })), JSON.stringify([check]));
  for (const value of [
    { checks: [] },
    { checks: [check], actor: {} },
    { checks: [{ ...check, actor: {} }] },
    { checks: [check, check] },
    { checks: [{ ...check, keys: [{ id: 1 }, { id: 1 }] }] },
    { checks: [{ ...check, keys: [] }] },
    { checks: [{ ...check, commandVersion: 0 }] },
    { checks: [{ ...check, keys: Array.from({ length: 201 }, (_, id) => ({ id })) }] },
    { checks: Array.from({ length: 17 }, (_, id) => ({ ...check, command: `change${id}` })) },
    {
      checks: [
        { ...check, keys: Array.from({ length: 101 }, (_, id) => ({ id })) },
        { ...check, command: 'other', keys: Array.from({ length: 100 }, (_, id) => ({ id })) },
      ],
    },
  ]) {
    assert.throws(() => parseCommandAvailability(value));
  }
});

test('visibility reads targets once, batches predicate and aligns missing keys without initial/handler', async () => {
  let reads = 0,
    calls = 0;
  const check = parseCommandAvailability({
    checks: [{ command: 'change', commandVersion: 1, keys: [{ id: 1 }, { id: 2 }, { id: 9 }] }],
  })[0];
  const command = defineCommand({
    ...base(),
    initial() {
      throw new Error('No initial');
    },
    availability({ records }) {
      calls++;
      assert.equal(records.length, 2);
      return records.map((row) => row.team_id === 2);
    },
  });
  const reader = {
    query: async () => {
      reads++;
      return { rows: options().records, columns: ['id', 'version', 'team_id'], ms: 0, sql: { text: '', params: [] } };
    },
    count: async () => 0,
  };
  const values = await readCommandAvailability({ ...options(), check, command, reader });
  assert.deepEqual(values, [true, false, false]);
  assert.equal(reads, 1);
  assert.equal(calls, 1);
  assert.deepEqual(await readCommandAvailability({ ...options(), check: { ...check, commandVersion: 2 }, command, reader }), [
    false,
    false,
    false,
  ]);
  assert.equal(reads, 1);
});

test('visibility collector returns no private refusal details and preserves cancellation', async () => {
  const checks = parseCommandAvailability({ checks: [{ command: 'change', commandVersion: 1, keys: [{ id: 1 }] }] });
  assert.deepEqual(
    await collectCommandAvailability(checks, async () => {
      throw new BusinessCommandExecutionError('forbidden');
    }),
    { checks: [{ command: 'change', commandVersion: 1, available: [false] }] },
  );
  await assert.rejects(
    collectCommandAvailability(checks, async () => {
      throw new BusinessCommandExecutionError('stale_record', 'not_applied', 'secret', { secret: 'private' });
    }),
    (error) => error instanceof BusinessCommandExecutionError && error.code === 'temporarily_unavailable' && !error.key && !error.field,
  );
  await assert.rejects(
    collectCommandAvailability(checks, async () => {
      throw new Error('private hook reason');
    }),
    { code: 'temporarily_unavailable' },
  );
  await assert.rejects(
    collectCommandAvailability(checks, async () => [true], AbortSignal.abort()),
    { code: 'cancelled' },
  );
});

test('availability registration captures without executing and evaluates a detached readonly batch', async () => {
  let calls = 0;
  const definition = {
    ...base(),
    availability(context: BusinessCommandAvailabilityContext) {
      calls++;
      assert.ok(Object.isFrozen(context) && Object.isFrozen(context.records) && Object.isFrozen(context.records[0]));
      assert.ok(Object.isFrozen(context.actor) && Object.isFrozen(context.actor.roles));
      assert.equal('tx' in context, false);
      assert.equal('input' in context, false);
      assert.equal('update' in context.db.item, false);
      return context.records.map((row) => row.team_id === 2);
    },
  };
  const registry = defineCommands({ change: defineCommand(definition) });
  assert.equal(calls, 0);
  definition.availability = () => {
    throw new Error('Replacement must not run.');
  };
  const result = await evaluateCommandAvailability({ ...options(), command: registry.change });
  assert.deepEqual(result, [true, false]);
  assert.ok(Object.isFrozen(result));
  assert.equal(calls, 1);
});

test('availability typed context has only readonly footprint and records', () => {
  defineCommand({
    ...base(),
    availability({ db, records }) {
      if (records.length < 0) {
        // @ts-expect-error Availability cannot write even its command target.
        db.item.update(records[0], {});
        // @ts-expect-error Batch records are readonly.
        records[0].team_id = 7;
        // @ts-expect-error Undeclared resources are not part of the context.
        db.secret.count();
      }
      return records.map((row) => row.team_id === 2);
    },
  });
});

test('existing commands default to unchanged eligibility and invalid hooks refuse at definition', async () => {
  assert.deepEqual(await evaluateCommandAvailability({ ...options(), command: defineCommand(base()) }), [true, true]);
  assert.throws(() => defineCommand({ ...base(), availability: true } as never), /availability must be a function/);
  const creating = base();
  assert.throws(
    () => defineCommand({ ...creating, targets: 'none', availability: () => [] }),
    /availability judges existing target records/,
  );
  const rows = [{ id: 1, json: { nested: [true] }, bytes: Buffer.from([1, 2]), undefinedValue: undefined }];
  assert.deepEqual(await evaluateCommandAvailability({ ...options(), records: rows, command: defineCommand(base()) }), [true]);
  const hooked = defineCommand({
    ...base(),
    availability({ records }) {
      const row = records[0] as unknown as (typeof rows)[number];
      assert.ok(Object.isFrozen(row.json) && Object.isFrozen(row.json.nested));
      row.bytes[0] = 9;
      return [true];
    },
  });
  assert.deepEqual(await evaluateCommandAvailability({ ...options(), records: rows, command: hooked }), [true]);
  assert.equal(rows[0].bytes[0], 1);
});

test('availability refuses malformed return shapes, oversized batches and cancellation without handler execution', async () => {
  const sparse = [true, false];
  delete sparse[0];
  for (const result of [[true], [true, 1], [true, false, true], sparse, { allowed: true }]) {
    const command = defineCommand({ ...base(), availability: () => result } as never);
    await assert.rejects(evaluateCommandAvailability({ ...options(), command }), { code: 'invalid_result' });
  }
  let called = false;
  const command = defineCommand({
    ...base(),
    availability: ({ records }) => {
      called = true;
      return records.map(() => true);
    },
  });
  await assert.rejects(
    evaluateCommandAvailability({ ...options(), command, records: Array.from({ length: BULK_LIMIT + 1 }, () => ({ id: 1 })) }),
    { code: 'invalid_input' },
  );
  await assert.rejects(evaluateCommandAvailability({ ...options(), command, signal: AbortSignal.abort() }), { code: 'cancelled' });
  assert.equal(called, false);
});

test('an initial says values: undefined, as the whole prefill or as a field, is a compile error', () => {
  const input = { name: field.text({ label: 'Name', optional: true }) };
  // prettier-ignore
  // @ts-expect-error A prefill is an object of values, never undefined.
  defineCommand({ ...base(), input, initial() { return undefined; } });
  // prettier-ignore
  // @ts-expect-error A field with no value is left out, not set to undefined.
  defineCommand({ ...base(), input, initial() { return { name: undefined }; } });
  // prettier-ignore
  // @ts-expect-error A path that returns nothing returns undefined.
  defineCommand({ ...base(), input, initial({ record }) { if (record.id) return { name: 'x' }; } });
  const left = (name?: string) => ({ ...(name === undefined ? {} : { name }) });
  assert.ok(defineCommand({ ...base(), input, initial: () => left('x') }));
});

test('prepare refuses unavailable records before prefill, including commands without initial', async () => {
  let initials = 0,
    checks = 0;
  const reader = {
    query: async () => ({ rows: [{ id: 1, version: 0, team_id: 2 }] }),
    count: async () => 0,
  } as unknown as WriteTransaction;
  for (const prefill of [false, true]) {
    const command = defineCommand({
      ...base(),
      availability: () => {
        checks++;
        return [false];
      },
      ...(prefill
        ? {
            initial: () => {
              initials++;
              return {};
            },
          }
        : {}),
    });
    assert.equal(preparesInitial(command), true);
    await assert.rejects(readPreparedRecord(reader, { ...options(), command, key: { id: 1 } }), { code: 'forbidden' });
  }
  assert.equal(initials, 0);
  assert.equal(checks, 2);
  const command = defineCommand({
    ...base(),
    when: 'team_id = 3',
    availability: () => {
      checks++;
      return [true];
    },
  });
  await assert.rejects(readPreparedRecord(reader, { ...options(), command, key: { id: 1 } }), { code: 'ineligible_state' });
  assert.equal(checks, 2);
});

test('bulk prepare checks business eligibility once for the visible state-matching batch', async () => {
  let reads = 0,
    hooks = 0;
  const command = defineCommand({
    ...base(),
    targets: 'many',
    availability: ({ records }) => {
      hooks++;
      return records.map((record) => record.team_id === 2);
    },
  });
  const reader = {
    query: async () => {
      reads++;
      return { rows: options().records };
    },
    count: async () => 0,
  } as unknown as WriteTransaction;
  const targets = [
    { key: { id: 1 }, expectedVersion: 0, eligible: true },
    { key: { id: 2 }, expectedVersion: 1, eligible: true },
    { key: { id: 3 }, expectedVersion: null, eligible: false },
  ];
  const result = await readPreparedTargetAvailability(reader, { ...options(), command, targets });
  assert.deepEqual(
    result.map((target) => target.eligible),
    [true, false, false],
  );
  assert.equal(reads, 1);
  assert.equal(hooks, 1);
  assert.equal(targets[1].eligible, true);
});
