import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  admitScopedInserts,
  apiScopeAdvisories,
  checkApiScopes,
  narrowRowsToApiScope,
} from '../packages/mistri/src/server/api/apiRowScope.js';
import { parseAppApi, type ApiScopeDef } from '../packages/mistri/src/shared/appApi.js';
import type { ColumnMeta, DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { Refusal, type WriteTransaction } from '../packages/engine/src/adapters/adapter.js';
import { BusinessCommandExecutionError } from '../packages/mistri/src/server/commands/commandErrors.js';

const column = (name: string, type = name === 'id' || name.endsWith('_id') ? 'INTEGER' : 'TEXT'): ColumnMeta => ({
  name,
  type,
  primaryKey: name === 'id',
  nullable: name !== 'id',
});
const table = (id: string, columns: string[]) => ({
  id,
  name: id,
  schema: '',
  isView: false,
  columns: columns.map((name) => column(name)),
});
const schema: DatabaseSchema = {
  label: 'Logical',
  dialect: 'sqlite',
  readAt: '2000-01-01',
  tables: [
    table('patient', ['id', 'name']),
    table('appointment', ['id', 'patient_id', 'at']),
    table('note', ['id', 'appointment_id', 'body']),
    table('clinic', ['id', 'name']),
    table('label', ['id', 'patient_ref']),
  ],
  foreignKeys: [
    { name: 'appointment_patient', from: { table: 'appointment', columns: ['patient_id'] }, to: { table: 'patient', columns: ['id'] } },
    { name: 'note_appointment', from: { table: 'note', columns: ['appointment_id'] }, to: { table: 'appointment', columns: ['id'] } },
  ],
};
const resources = { patient: {}, appointment: {}, note: {}, clinic: {}, label: {} };
const patient: ApiScopeDef = {
  key: 'patient',
  rows: { patient: 'id', appointment: 'patient_id', note: 'appointment_id.patient_id', clinic: true },
};
const checks = (scope: unknown) => () => checkApiScopes({ resources, scopes: { patient: scope as ApiScopeDef } } as never, schema);

test('api.scopes parses names, a key resource and a column or one-hop path per resource', () => {
  const parse = (scopes: unknown) =>
    parseAppApi({ version: 1, roles: ['reader'], resources: { patient: { fields: ['id'] } }, scopes }, ['reader'], 'fixture.api');
  assert.deepEqual(parse({ patient: { key: 'patient', rows: { patient: 'id', clinic: true } } })?.scopes, {
    patient: { key: 'patient', rows: { patient: 'id', clinic: true } },
  });
  assert.throws(() => parse({ patient: { key: 'patient', rows: { patient: 'id' }, extra: 1 } }), /extra/);
  assert.throws(() => parse({ patient: { key: 'patient', rows: { note: 'a.b.c', patient: 'id' } } }), /a column or one hop/);
  assert.throws(() => parse({ patient: { key: 'patient', rows: { clinic: true } } }), /must name its key column/);
  assert.throws(() => parse({ patient: { key: 'patient', rows: { patient: true } } }), /must name its key column/);
});

test('mistri check refuses an unknown resource, column or path and a mismatched kind', () => {
  checks(patient)();
  assert.throws(checks({ key: 'visit', rows: { visit: 'id' } }), /"visit" must be a resource/);
  assert.throws(checks({ key: 'patient', rows: { patient: 'id', ghost: 'patient_id' } }), /"ghost" must be a resource/);
  assert.throws(checks({ key: 'patient', rows: { patient: 'id', appointment: 'owner_id' } }), /has no column "owner_id"/);
  assert.throws(checks({ key: 'patient', rows: { patient: 'name' } }), /single-column primary key/);
  assert.throws(checks({ key: 'patient', rows: { patient: 'id', note: 'body.patient_id' } }), /not a path|one reference/);
  assert.throws(checks({ key: 'patient', rows: { patient: 'id', label: 'patient_ref' } }), /must be the same kind/);
  assert.throws(checks({ key: 'patient', rows: { patient: 'id', note: 'appointment_id.patient_id' } }), /walks to "appointment"/);
});

test('an api.resource the scope leaves out is advice, not a refusal', () => {
  const advice = apiScopeAdvisories({ resources, scopes: { patient } } as never);
  assert.equal(advice.length, 1);
  assert.match(advice[0]!, /^api\.scopes\.patient \[api-scope-unreached\]: api\.resources "label" is not in the scope/);
});

test('a scope narrows each resource rule and closes what it does not reach', () => {
  const rows = narrowRowsToApiScope(
    { patient: true, appointment: { groups: [[{ column: 'at', op: '>', value: '2026' }]] }, note: true, clinic: true, label: true },
    patient,
    '7',
    schema,
  );
  assert.deepEqual(rows.patient, { groups: [[{ column: 'id', op: '=', value: 7 }]] });
  assert.deepEqual(rows.appointment, {
    groups: [
      [
        { column: 'at', op: '>', value: '2026' },
        { column: 'patient_id', op: '=', value: 7 },
      ],
    ],
  });
  const note = rows.note as { groups: unknown[][] };
  assert.equal(note.groups.length, 1);
  assert.equal((note.groups[0]![0] as { via?: unknown }).via !== undefined || 'resource' in (note.groups[0]![0] as object), true);
  assert.equal(rows.clinic, true);
  assert.equal(rows.label, false);
});

test('an insert lands in scope: filled from the key, refused for another key or an unreached table', async () => {
  const inserted: unknown[] = [];
  let parents = 1;
  const records = {
    insert: async (request: unknown) => (inserted.push(request), { id: 1 }),
    count: async () => parents,
  } as unknown as WriteTransaction;
  const scoped = admitScopedInserts(records, patient, '7', schema);
  await scoped.insert({ table: 'appointment', values: { at: 'today' } });
  assert.deepEqual(inserted.pop(), { table: 'appointment', values: { at: 'today', patient_id: 7 } });
  await scoped.insert({ table: 'appointment', values: { patient_id: '7' } });
  const refused = async (promise: Promise<unknown>) =>
    assert.rejects(promise, (error: unknown) => error instanceof BusinessCommandExecutionError && error.code === 'out_of_scope');
  await refused(scoped.insert({ table: 'appointment', values: { patient_id: 8 } }));
  await refused(scoped.insert({ table: 'label', values: { patient_ref: '7' } }));
  await scoped.insert({ table: 'note', values: { appointment_id: 3 } });
  parents = 0;
  await refused(scoped.insert({ table: 'note', values: { appointment_id: 4 } }));
  await refused(scoped.insert({ table: 'note', values: {} }));
  await scoped.insert({ table: 'clinic', values: { name: 'North' } });
});

test('a parent the grants or row policy hide is out of scope; any other store error is not an answer about the row', async () => {
  const note = { table: 'note', values: { appointment_id: 4 } };
  const records = (count: () => Promise<number>) =>
    admitScopedInserts({ insert: async () => ({ id: 1 }), count } as unknown as WriteTransaction, patient, '7', schema);
  await assert.rejects(
    records(async () => {
      throw new Refusal('This operation is not available in the current row scope.');
    }).insert(note),
    (error: unknown) => error instanceof BusinessCommandExecutionError && error.code === 'out_of_scope',
  );
  const lost = new Error('connection terminated');
  await assert.rejects(
    records(async () => {
      throw lost;
    }).insert(note),
    (error: unknown) => error === lost,
  );
});
