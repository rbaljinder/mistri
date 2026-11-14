import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Refusal, WriteConflict } from '../packages/engine/src/adapters/adapter.js';
import { appError, appWriteError } from '../packages/mistri/src/server/app/appErrors.js';
import { AppValidationDenied } from '../packages/mistri/src/server/app/appValidationDenied.js';
import {
  IN_USE,
  ReferencedRefusal,
  uniqueColumns,
  uniqueConflictSeen,
  uniqueRefusal,
} from '../packages/engine/src/adapters/scoped/scopedTransaction.js';
import { recordRefusalCause } from '../packages/engine/src/shared/refusal.js';
import { refusedWrite } from '../packages/mistri/src/server/tenant/tenantWriteFault.js';

const privateMessage = 'SELECT secret FROM private.account WHERE token = password; postgres://user:password@private-host/database';

test('App errors classify structured engine codes without including driver text or detail', () => {
  const cases = [
    ['required_value', { code: '23502' }, { errcode: 1299 }],
    ['duplicate_value', { code: '23505' }, { errcode: 1555 }, { errcode: 2067 }],
    ['reference_conflict', { code: '23503' }, { errcode: 787 }],
    ['constraint_failed', { code: '23514' }, { code: '23P01' }, { errcode: 275 }],
  ] as const;
  for (const [code, ...drivers] of cases)
    for (const driver of drivers) {
      const error = Object.assign(new Error(privateMessage), driver, { detail: privateMessage, query: privateMessage });
      const result = appError(error, 'write');
      assert.equal(result.code, code);
      assert.doesNotMatch(JSON.stringify(result), /SELECT|password|private/);
      assert.deepEqual(Object.keys(result).sort(), ['code', 'message']);
      assert.equal(appError(error, 'write', true).code, 'write_unconfirmed');
    }
});

test('unknown errors and code-like messages never count as proof of rejection', () => {
  for (const error of [
    new Error(privateMessage),
    new Error('23505 duplicate key'),
    { name: 'Refusal', message: privateMessage },
    { message: privateMessage, code: 'ECONNRESET' },
    null,
    privateMessage,
  ]) {
    assert.equal(appError(error).code, 'data_unavailable');
    assert.equal(appError(error, 'write').code, 'write_unconfirmed');
    assert.doesNotMatch(JSON.stringify(appError(error)), /SELECT|password|private/);
  }
});

test('known validation and conflict exceptions retain actionable safe feedback', () => {
  const validation = new Refusal('"name" is NOT NULL and cannot be emptied.');
  assert.deepEqual(appError(validation, 'write'), { code: 'validation_failed', message: validation.message });
  const conflict = new WriteConflict();
  assert.deepEqual(appError(conflict, 'write'), { code: 'record_conflict', message: conflict.message });
});

test('authoritative App validation projects only safe field references', () => {
  const validation = new AppValidationDenied(['name', 'name', 'status']);
  assert.deepEqual(appError(validation, 'write'), {
    code: 'validation_failed',
    message: validation.message,
    fields: [
      { field: 'name', message: 'This value does not meet the application rules.' },
      { field: 'status', message: 'This value does not meet the application rules.' },
    ],
  });
  assert.doesNotMatch(JSON.stringify(appError(validation, 'write')), /secret|Ada|SELECT/);
  assert.deepEqual(appError(validation), { code: 'validation_failed', message: validation.message });
});

/* UX-5: the column a rule names, from the part of each engine's error that holds names alone, said by its caption
   and placed on the field; a value in the same error never crosses. */
test('a broken constraint names its field, on both engines, and never a value', () => {
  const caption = (column: string) => ({ email: 'Email', customer_id: 'Customer', total: 'Total' })[column] ?? column;
  const pg = (code: string, extra: object) => Object.assign(new Error(privateMessage), { code, ...extra });
  const cases: Array<[unknown, string, string, string]> = [
    [pg('23502', { column: 'total', table: 'invoice' }), 'required_value', 'total', 'Total is required. Fill it in and try again.'],
    [
      pg('23505', { detail: 'Key (email)=(ada@private.example) already exists.' }),
      'duplicate_value',
      'email',
      'Another record already has this email. Use a different value and try again.',
    ],
    [
      pg('23503', { detail: 'Key (customer_id)=(9) is not present in table "customer".' }),
      'reference_conflict',
      'customer_id',
      'The customer chosen is not a record that exists. Choose another and try again.',
    ],
    [
      pg('23514', { table: 'invoice', constraint: 'invoice_total_check' }),
      'constraint_failed',
      'total',
      'Total is not an allowed value. Change it and try again.',
    ],
    [
      Object.assign(new Error('NOT NULL constraint failed: invoice.total'), { errcode: 1299 }),
      'required_value',
      'total',
      'Total is required. Fill it in and try again.',
    ],
    [
      Object.assign(new Error('UNIQUE constraint failed: customer.email'), { errcode: 2067 }),
      'duplicate_value',
      'email',
      'Another record already has this email. Use a different value and try again.',
    ],
    [
      Object.assign(new Error('CHECK constraint failed: total > 0'), { errcode: 275 }),
      'constraint_failed',
      'total',
      'Total is not an allowed value. Change it and try again.',
    ],
  ];
  for (const [error, code, field, message] of cases) {
    const result = appError(error, 'write', false, caption);
    assert.deepEqual(result, { code, message, fields: [{ field, message: result.fields![0].message }] }, message);
    assert.doesNotMatch(JSON.stringify(result), /private|SELECT|password/);
  }
  // Without captions the column is said as it is named, capitalized to start the sentence.
  assert.equal(appError(cases[2][0], 'write').message, 'The customer_id chosen is not a record that exists. Choose another and try again.');
  // A row others point at is no field of this form; a read says nothing of fields.
  const parent = pg('23503', { detail: 'Key (id)=(1) is still referenced from table "invoice".' });
  assert.deepEqual(appError(parent, 'write'), {
    code: 'reference_conflict',
    message: 'Other records still point at this one. Change or remove them first, then try again.',
  });
  assert.equal(appError(cases[0][0]).fields, undefined);
  // SQLite's foreign key failure names no column: the sentence stays general.
  assert.equal(appError(Object.assign(new Error('FOREIGN KEY constraint failed'), { errcode: 787 }), 'write').fields, undefined);
});

test("a refused App write puts the engine's own words on the operator's stderr, and only there", (t) => {
  const said: string[] = [];
  t.mock.method(console, 'error', (line: string) => said.push(line));
  const error = Object.assign(new Error('UNIQUE constraint failed: customer.email'), { errcode: 2067 });
  const result = appWriteError(error, false);
  assert.equal(result.code, 'duplicate_value');
  assert.match(said.join('\n'), /refused \(duplicate_value\)\n {2}because: UNIQUE constraint failed: customer\.email/);
});

test('a delete still referenced is reference_conflict, naming only the rows its principal reads', () => {
  const total = 'A scoped command may not delete the "lead" row id=n3: "note" still references it (3 rows in all).';
  const seen = recordRefusalCause(new ReferencedRefusal({ table: 'note', count: 2 }), total);
  const unseen = recordRefusalCause(new ReferencedRefusal(), total);
  assert.deepEqual(appError(seen, 'write'), {
    code: 'reference_conflict',
    message: '2 records in "note" still point at this one. Change or remove them first, then try again.',
  });
  assert.deepEqual(appError(unseen, 'write'), { code: 'reference_conflict', message: IN_USE });
  // Under a value-free wrapper, as a tenant writer throws it: 409, the same sentence, the total never said.
  const wrapped = recordRefusalCause(new Error('The tenant write was not applied.'), unseen);
  const answer = refusedWrite('/api/delete', wrapped);
  assert.equal(answer?.status, 409);
  assert.equal(answer?.code, 'reference_conflict');
  assert.equal(answer?.body.error, IN_USE);
  assert.equal(answer?.body.deleted, false);
  assert.doesNotMatch(JSON.stringify(answer), /3 rows|in all/);
});

/* A unique rule's refusal names a row that may be outside the principal's rows: it is said as the scope refuses unless
   the scope itself fixes every column of the rule to the value written, compared no more loosely than the index does. */
test('a unique refusal names its row only where the scope pins every column of the rule', () => {
  const item = { id: 'item', name: 'db_item', schema: 'public' };
  const pg = (detail: string, table = 'db_item') => ({ code: '23505', table, schema: 'public', detail });
  const lite = (message: string) => ({ errcode: 2067, message });
  assert.deepEqual(uniqueColumns(pg('Key (tenant_id, business_id)=(north, same) already exists.'), item), ['tenant_id', 'business_id']);
  assert.deepEqual(uniqueColumns(lite('UNIQUE constraint failed: db_item.tenant_id, db_item.business_id'), item), [
    'tenant_id',
    'business_id',
  ]);
  // Another table (a trigger's, a cascade's), an expression, an exclusion: nothing is read.
  assert.equal(uniqueColumns(pg('Key (id)=(x) already exists.', 'db_audit'), item), undefined);
  assert.equal(uniqueColumns(pg('Key (lower(email::text))=(x) already exists.'), item), undefined);
  assert.equal(uniqueColumns({ code: '23P01', table: 'db_item' }, item), undefined);
  assert.equal(uniqueColumns(lite('UNIQUE constraint failed: db_audit.id'), item), undefined);
  assert.equal(uniqueColumns(lite("UNIQUE constraint failed: index 'by_lower'"), item), undefined);

  const tenant = { groups: [[{ column: 'tenant_id', op: '=' as const, value: 'north' }]], binary: ['tenant_id'] };
  const row = { id: 'fresh', tenant_id: 'north', business_id: 'same' };
  assert.equal(uniqueConflictSeen(tenant, ['tenant_id', 'business_id'], row, true), true);
  assert.equal(uniqueConflictSeen(tenant, ['tenant_id', 'business_id'], row, false), true);
  // An id unique across tenants: the row it meets may be another tenant's.
  assert.equal(uniqueConflictSeen(tenant, ['id'], row, true), false);
  // On SQLite a condition compared under the column's collation is not attested: the index may compare it more loosely.
  assert.equal(uniqueConflictSeen({ groups: tenant.groups }, ['tenant_id', 'business_id'], row, true), false);
  assert.equal(uniqueConflictSeen({ groups: tenant.groups }, ['tenant_id', 'business_id'], row, false), true);
  // The row written holds another value, a wider operator, a second condition the rule does not fix: not shown.
  assert.equal(uniqueConflictSeen(tenant, ['tenant_id'], { tenant_id: 'south' }, true), false);
  assert.equal(uniqueConflictSeen({ groups: [[{ column: 'tenant_id', op: 'in', value: ['north'] }]] }, ['tenant_id'], row, false), false);
  const two = { groups: [[...tenant.groups[0], { column: 'active', op: '=' as const, value: 1 }]], binary: ['tenant_id'] };
  assert.equal(uniqueConflictSeen(two, ['tenant_id', 'business_id'], { ...row, active: 1 }, true), false);
  assert.equal(uniqueConflictSeen(true, ['id'], row, true), true);
  assert.equal(uniqueConflictSeen(false, ['id'], row, true), false);

  // Said as the scope refuses; the operator reads the table and the columns, never the value.
  const refused = uniqueRefusal(item, ['id']);
  assert.deepEqual(appError(refused, 'write'), {
    code: 'validation_failed',
    message: 'This operation is not available in the current row scope.',
  });
  assert.doesNotMatch(JSON.stringify(appError(refused, 'write')), /unique|"id"/);
});
