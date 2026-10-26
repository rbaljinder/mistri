import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Refusal, WriteConflict } from '../packages/engine/src/adapters/adapter.js';
import { appError, appWriteError } from '../packages/mistri/src/server/app/appErrors.js';
import { AppValidationDenied } from '../packages/mistri/src/server/app/appValidationDenied.js';

const privateMessage = 'SELECT secret FROM private.account WHERE token = password; postgres://user:password@private-host/database';

test('App errors classify structured engine codes without including driver text or detail', () => {
  const cases = [
    ['required_value', { code: '23502' }, { errno: 1048 }, { errcode: 1299 }],
    ['duplicate_value', { code: '23505' }, { errno: 1062 }, { errcode: 1555 }, { errcode: 2067 }],
    ['reference_conflict', { code: '23503' }, { errno: 1451 }, { errno: 1452 }, { errcode: 787 }],
    ['constraint_failed', { code: '23514' }, { code: '23P01' }, { errno: 3819 }, { errno: 4025 }, { errcode: 275 }],
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
test('a broken constraint names its field, on every engine, and never a value', () => {
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
    [
      Object.assign(new Error("Column 'total' cannot be null"), { errno: 1048 }),
      'required_value',
      'total',
      'Total is required. Fill it in and try again.',
    ],
    [
      Object.assign(new Error("Duplicate entry 'ada@private.example' for key 'customer.email'"), { errno: 1062 }),
      'duplicate_value',
      'email',
      'Another record already has this email. Use a different value and try again.',
    ],
    [
      Object.assign(
        new Error(
          'Cannot add or update a child row: a foreign key constraint fails (`db`.`invoice`, CONSTRAINT `f` FOREIGN KEY (`customer_id`) REFERENCES `customer` (`id`))',
        ),
        { errno: 1452 },
      ),
      'reference_conflict',
      'customer_id',
      'The customer chosen is not a record that exists. Choose another and try again.',
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
  // A value that mimics a key name cannot become a field: the key is the last quoted word.
  const sly = Object.assign(new Error("Duplicate entry 'x' for key 'evil' for key 'customer.email'"), { errno: 1062 });
  assert.equal(appError(sly, 'write').fields?.[0].field, 'email');
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
