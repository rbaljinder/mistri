import test from 'node:test';
import assert from 'node:assert/strict';
import { labelColumn, labelPath, primaryKey, type DatabaseSchema, type TableMeta } from '../packages/engine/src/shared/schema.js';

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
    { name: 'saved_at', type: 'TIMESTAMP', nullable: false, primaryKey: true },
  ],
};
const schema: DatabaseSchema = {
  label: 'Forecourt',
  dialect: 'sqlite',
  readAt: '',
  tables: [vehicle, savedVehicle],
  foreignKeys: [
    { name: 'saved_vehicle_vehicle', from: { table: 'saved_vehicle', columns: ['vehicle_id'] }, to: { table: 'vehicle', columns: ['id'] } },
  ],
};

test('record-label paths distinguish explicit joins, unavailable labels, and legacy inference', () => {
  // The old heuristic is intentionally preserved only for an omitted declaration.
  assert.equal(labelPath(schema, savedVehicle), 'account_id');
  assert.equal(labelPath(schema, savedVehicle, 'vehicle_id.title'), 'vehicle_id.title');
  // A projected false neither reveals the denied path nor re-infers account_id.
  assert.equal(labelPath(schema, savedVehicle, false), undefined);
  assert.deepEqual(primaryKey(savedVehicle), ['vehicle_id', 'saved_at']);
});

test("a tenant table's ownership column, a required text reference, never names its rows", () => {
  const tally: TableMeta = {
    id: 'tally',
    name: 'tally',
    schema: '',
    isView: false,
    columns: [
      { name: 'id', type: 'TEXT', nullable: false, primaryKey: true },
      { name: 'tenant_id', type: 'TEXT', nullable: false, primaryKey: false, references: { table: 'clinic', column: 'id' } },
      { name: 'n', type: 'INTEGER', nullable: true, primaryKey: false },
    ],
  };
  // With no name of its own, a record is named by its key (a list then searches that), not by who owns it.
  assert.equal(labelColumn(tally), 'id');
  // A table that does carry a name keeps it.
  const patient: TableMeta = {
    ...tally,
    id: 'patient',
    columns: [...tally.columns, { name: 'name', type: 'TEXT', nullable: true, primaryKey: false }],
  };
  assert.equal(labelColumn(patient), 'name');
});
