/**
 * The machine a scaffold drafts from a status vocabulary (scaffoldMachine.ts): the work ends where it is done, so a
 * word listed after `completed` that names no further step is another way the work ended, never a step out of a
 * finished record. A visit's `scheduled, completed, missed, cancelled` drafted `completed → markMissed`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { draftMachine } from '../packages/engine/src/server/scaffoldMachine.js';
import type { ColumnMeta, TableMeta } from '../packages/engine/src/shared/schema.js';

const column = (name: string, type: string, extra: Partial<ColumnMeta> = {}): ColumnMeta => ({
  name,
  type,
  nullable: true,
  primaryKey: false,
  ...extra,
});
const table = (states: string[]): { table: TableMeta; status: ColumnMeta } => {
  const status = column('status', 'TEXT', { nullable: false, allowed: states });
  return {
    status,
    table: {
      id: 'visit',
      name: 'visit',
      schema: '',
      isView: false,
      columns: [column('id', 'INTEGER', { primaryKey: true, nullable: false }), status, column('starts_at', 'TEXT')],
    },
  };
};
const draft = (states: string[]) => {
  const { table: t, status } = table(states);
  const machine = draftMachine(t, status)!;
  return { machine, moves: machine.verbs.map((verb) => `${verb.from.join('|')} → ${verb.verb} → ${verb.to}`) };
};

test('a word after the done state that names no step is a way the work ended, left from the open states', () => {
  const { machine, moves } = draft(['scheduled', 'completed', 'missed', 'cancelled']);
  assert.deepEqual(machine.path, ['scheduled', 'completed']);
  assert.deepEqual(machine.exits, ['missed', 'cancelled']);
  assert.ok(!moves.some((move) => move.startsWith('completed')), moves.join('\n'));
  assert.ok(
    moves.some((move) => /^scheduled → \w+ → missed$/.test(move)),
    moves.join('\n'),
  );
});

test('a known step past done still goes on, and a hold after it is still a hold', () => {
  const { machine } = draft(['new', 'in_progress', 'completed', 'invoiced', 'on_hold', 'cancelled']);
  assert.deepEqual(machine.path, ['new', 'in_progress', 'completed', 'invoiced']);
  assert.deepEqual(machine.exits, ['cancelled']);
  assert.deepEqual([...machine.holds.keys()], ['on_hold']);
});

test('a vocabulary with no done word reads as before', () => {
  const { machine } = draft(['draft', 'review', 'published', 'withdrawn']);
  assert.deepEqual(machine.path, ['draft', 'review', 'published']);
  assert.deepEqual(machine.exits, ['withdrawn']);
});
