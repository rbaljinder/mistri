/**
 * What a machine says without being told: `status is open` (not in a final
 * state), its groups as names the query language reads (`status is onBench`),
 * a state's tones by where it stands, and the column a state stamps on entry
 * by its name (app-machine-doors.test.ts holds the stamp on every door).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAppConfig, resolveDisplay, resolveViews } from '../packages/mistri/src/shared/app.js';
import { machineStates, parseMachine } from '../packages/mistri/src/shared/appMachine.js';
import { stateStampColumn } from '../packages/engine/src/shared/schema.js';
import { withMachineStates } from '../packages/mistri/src/shared/appRollups.js';
import { machineTones } from '../packages/engine/src/shared/displayDefaults.js';
import { parseViewQuery } from '../packages/engine/src/shared/view.js';
import { menuCount } from '../packages/engine/src/shared/menuCounts.js';
import type { ColumnMeta, DatabaseSchema } from '../packages/engine/src/shared/schema.js';

const col = (name: string, type: string, more: Partial<ColumnMeta> = {}): ColumnMeta =>
  ({ name, type, primaryKey: false, nullable: true, ...more }) as ColumnMeta;
const schema: DatabaseSchema = {
  tables: [
    {
      id: 'work_order',
      name: 'work_order',
      schema: '',
      isView: false,
      columns: [
        col('id', 'INTEGER', { primaryKey: true, nullable: false }),
        col('summary', 'TEXT', { nullable: false }),
        col('status', 'TEXT', { nullable: false }),
        col('ready_at', 'TEXT'),
        col('collected_on', 'DATE'),
        col('in_repair_at', 'INTEGER'),
      ],
    },
  ],
  foreignKeys: [],
} as unknown as DatabaseSchema;

const none = () => false;
const states = {
  booked: { on: { checkIn: 'checked_in', cancel: 'cancelled' } },
  checked_in: { on: { repair: 'in_repair', cancel: 'cancelled' } },
  in_repair: { on: { wait: 'waiting_parts', finish: 'ready' } },
  waiting_parts: { on: { resume: 'in_repair' } },
  ready: { on: { collect: 'collected' } },
  collected: { final: true },
  cancelled: { final: true },
} as const;
const APP = {
  id: 'shop',
  name: 'Shop',
  connection: 'shop',
  resources: {
    work_order: {
      access: 'write',
      machine: { column: 'status', groups: { onBench: ['in_repair', 'checked_in'] }, states },
      segments: { bench: 'status is onBench' },
    },
  },
  views: {
    open: { kind: 'list', from: 'work_order', query: 'status is open', tabs: ['bench'] },
    bench: { kind: 'list', from: 'work_order', query: 'status is onBench', board: { by: 'status', primary: 'summary' } },
  },
  home: 'open',
};

test('a group is its states in machine order, and a bad group is refused by name', () => {
  const machine = parseMachine({ column: 'status', groups: { onBench: ['in_repair', 'checked_in'] }, states }, 'shop', none);
  assert.deepEqual(machine.groups, { onBench: ['checked_in', 'in_repair'] });
  assert.deepEqual(machineStates(machine), {
    open: ['booked', 'checked_in', 'in_repair', 'waiting_parts', 'ready'],
    final: ['collected', 'cancelled'],
    groups: { onBench: ['checked_in', 'in_repair'] },
  });
  assert.throws(() => parseMachine({ column: 'status', groups: { onBench: ['lost'] }, states }, 'shop', none), /lost/);
  assert.throws(() => parseMachine({ column: 'status', groups: { ready: ['in_repair'] }, states }, 'shop', none), /ready/);
  assert.throws(() => parseMachine({ column: 'status', groups: { open: ['in_repair'] }, states }, 'shop', none), /open/);
  assert.throws(() => parseMachine({ column: 'status', groups: { onBench: ['ready', 'ready'] }, states }, 'shop', none), /twice/);
});

test('`is open` and a group read the machine on its column', () => {
  const app = parseAppConfig(APP, 'shop');
  const stated = withMachineStates(app, schema);
  const asked = (text: string) => {
    const parsed = parseViewQuery(stated, 'work_order', text);
    assert.deepEqual(parsed.errors, [], text);
    return parsed.filter.groups[0][0];
  };
  assert.deepEqual(asked('status is open'), {
    path: 'status',
    op: 'in',
    value: ['booked', 'checked_in', 'in_repair', 'waiting_parts', 'ready'],
  });
  assert.deepEqual(asked('status is not open'), { path: 'status', op: 'in', value: ['collected', 'cancelled'] });
  assert.deepEqual(asked('status is onBench'), { path: 'status', op: 'in', value: ['checked_in', 'in_repair'] });
  assert.deepEqual(asked('status is not onBench'), { path: 'status', op: '!=', value: 'checked_in' });
  // A group is asked one way, with `is`; inside `in` its name is refused with that fix, never read as a state.
  assert.match(parseViewQuery(stated, 'work_order', 'status in (onBench, ready)').errors[0].message, /status is onBench/);
  assert.match(parseViewQuery(stated, 'work_order', 'status is onbench').errors[0].message, /no group "onbench".*onBench/);
  // A column with no machine has no open states to ask about.
  assert.match(parseViewQuery(stated, 'work_order', 'summary is open').errors[0].message, /machine/);
  // The served list and its tab say the same words, judged against the stated catalog.
  const views = resolveViews(app, stated) as Record<string, { error?: string }>;
  assert.equal(views.open.error, undefined);
  assert.equal(views.bench.error, undefined);
});

test('a group trims a board to its lanes and counts in the menu, as `is open` does', () => {
  const app = parseAppConfig(APP, 'shop');
  const board = app.views.bench as { presentation?: { lanes?: string[] } };
  assert.deepEqual(board.presentation?.lanes, ['checked_in', 'in_repair']);
  const machine = {
    column: 'status',
    states: machineStates(app.resources!.work_order.machine!).open.map((value) => ({ value })),
    groups: app.resources!.work_order.machine!.groups,
  };
  assert.equal(menuCount('status is onBench', machine).counted, true);
  assert.equal(menuCount('bench', machine, undefined, { bench: 'status is onBench' }).counted, true);
  assert.equal(menuCount('status is elsewhere', machine).counted, false);
});

test('a machine wears tones by where its states stand, unless the App says them', () => {
  const machine = parseMachine({ column: 'status', states }, 'shop', none);
  assert.deepEqual(machineTones(machine), {
    booked: 'neutral',
    checked_in: 'neutral',
    in_repair: 'neutral',
    waiting_parts: 'warn',
    ready: 'good',
    collected: 'neutral',
    cancelled: 'neutral',
  });
  const app = parseAppConfig(APP, 'shop');
  assert.deepEqual(resolveDisplay(app, schema).display['work_order.status'].tone, machineTones(machine));
  const toned = parseAppConfig(
    { ...APP, resources: { work_order: { ...APP.resources.work_order, display: { status: { tone: { booked: 'info' } } } } } },
    'shop',
  );
  assert.deepEqual(resolveDisplay(toned, schema).display['work_order.status'].tone, { booked: 'info' });
});

test("a state's stamp is its name and _at or _on, never a number", () => {
  const columns = schema.tables[0].columns;
  assert.equal(stateStampColumn('ready', columns, { column: 'status' })?.name, 'ready_at');
  assert.equal(stateStampColumn('collected', columns, { column: 'status' })?.name, 'collected_on');
  assert.equal(stateStampColumn('in_repair', columns, { column: 'status' }), undefined);
  assert.equal(stateStampColumn('ready', columns, { column: 'status', since: 'ready_at' }), undefined);
});
