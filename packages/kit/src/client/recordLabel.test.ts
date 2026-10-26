import { afterEach, expect, test } from 'vitest';
import type { DatabaseSchema, TableMeta } from '../../../engine/src/shared/schema.js';
import { rowLabel, state } from './core.js';
import { installShell, resetShell } from './shellMode.js';

const vehicle: TableMeta = {
  id: 'vehicle',
  name: 'vehicle',
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'TEXT', nullable: false, primaryKey: true },
    { name: 'title', type: 'TEXT', nullable: false, primaryKey: false },
  ],
};
const savedVehicle: TableMeta = {
  id: 'saved_vehicle',
  name: 'saved_vehicle',
  schema: '',
  isView: false,
  columns: [
    { name: 'account_id', type: 'TEXT', nullable: false, primaryKey: false },
    { name: 'vehicle_id', type: 'TEXT', nullable: false, primaryKey: true, references: { table: 'vehicle', column: 'id' } },
    { name: 'saved_at', type: 'TEXT', nullable: false, primaryKey: true },
  ],
};
const schema: DatabaseSchema = {
  label: 'Forecourt',
  dialect: 'sqlite',
  readAt: '',
  tables: [savedVehicle, vehicle],
  foreignKeys: [
    { name: 'saved_vehicle_vehicle', from: { table: 'saved_vehicle', columns: ['vehicle_id'] }, to: { table: 'vehicle', columns: ['id'] } },
  ],
};

function useLabel(value: string | false | undefined): void {
  installShell({ recordLabel: (id: string) => (id === savedVehicle.id ? value : undefined) });
}

afterEach(() => {
  resetShell();
  state.schema = null;
});

test('an explicit joined record label wins over an ownership-shaped local field', () => {
  state.schema = schema;
  useLabel('vehicle_id.title');
  expect(
    rowLabel(savedVehicle, {
      account_id: 'account-private',
      vehicle_id: 'vehicle-7',
      saved_at: '2026-09-20T12:00:00Z',
      'vehicle_id.title': 'Azure Touring',
    }),
  ).toBe('Azure Touring');
});

test('null or unavailable explicit labels use the complete exact primary key, never account_id', () => {
  state.schema = schema;
  const row = { account_id: 'account-private', vehicle_id: '9007199254740993', saved_at: 'north' };
  useLabel('vehicle_id.title');
  expect(rowLabel(savedVehicle, { ...row, 'vehicle_id.title': null })).toBe('9007199254740993/north');
  useLabel(false);
  expect(rowLabel(savedVehicle, row)).toBe('9007199254740993/north');
  expect(rowLabel(savedVehicle, { account_id: 'account-private', vehicle_id: '9007199254740993' })).toBe('(row)');
});

test('an unset record-label source retains the legacy inferred label only when no declaration was served', () => {
  state.schema = schema;
  resetShell();
  expect(rowLabel(savedVehicle, { account_id: 'legacy-account-name', vehicle_id: 'vehicle-7', saved_at: 'north' })).toBe(
    'legacy-account-name',
  );
});
