import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CsvError, CsvReader, parseCsv, sniffDelimiter } from '../packages/mistri/src/shared/csvParse.js';
import {
  checkImports,
  importErrorCsv,
  importFields,
  mappingProblem,
  parseLocaleDate,
  parseLocaleNumber,
  readCell,
  suggestMapping,
  type ImportField,
} from '../packages/mistri/src/shared/appImport.js';
import type { TableMeta } from '../packages/engine/src/shared/schema.js';

const limits = { maxRows: 10, maxColumns: 5, maxField: 20 };

test('CSV is read a record at a time, however the text is cut into pieces', () => {
  const text = '﻿name,note\r\n"Smith, J","said ""hi""\r\nthen left"\rplain,\n\n"",last';
  const whole = parseCsv(text, limits);
  assert.deepEqual(whole.header, ['name', 'note']);
  assert.deepEqual(whole.rows, [
    ['Smith, J', 'said "hi"\nthen left'],
    ['plain', ''],
    ['', 'last'],
  ]);
  assert.deepEqual(whole.lines, [2, 4, 6]);
  // One character at a time, the same records: a CRLF split across pieces is one break.
  const seen: string[][] = [];
  const reader = new CsvReader((fields) => {
    seen.push(fields);
  }, limits);
  for (const ch of text) reader.push(ch);
  reader.end();
  assert.deepEqual(seen, [whole.header, ...whole.rows]);
});

test('CSV the reader cannot use is refused with its line, never guessed at', () => {
  assert.throws(
    () => parseCsv('a,b\n"open', limits),
    (error: unknown) => error instanceof CsvError && error.line === 2 && /never closed/.test(error.message),
  );
  assert.throws(() => parseCsv('a\n"x"y', limits), /followed by more text/);
  assert.throws(() => parseCsv('a\n' + 'x'.repeat(21), limits), /longer than 20 characters/);
  assert.throws(() => parseCsv('a,b,c,d,e,f', limits), /more than 5 fields/);
  assert.throws(() => parseCsv('a\n' + '1\n'.repeat(11), limits), /more than 10 rows/);
  assert.throws(() => parseCsv('', limits), /empty/);
  assert.equal(sniffDelimiter('SKU;Name;"a,b"\n1;2;3'), ';');
  assert.equal(sniffDelimiter('SKU\tName\n'), '\t');
  assert.equal(sniffDelimiter('SKU'), ',');
});

test('numbers and dates are read as the locale writes them, and a misplaced mark is refused', () => {
  assert.equal(parseLocaleNumber('$1,234.50', 'en-US'), 1234.5);
  assert.equal(parseLocaleNumber('(12)', 'en-US'), -12);
  assert.equal(parseLocaleNumber('-0.5', 'en-US'), -0.5);
  assert.equal(parseLocaleNumber('1.234,5 €', 'de-DE'), 1234.5);
  assert.equal(parseLocaleNumber('1.5', 'de-DE'), undefined);
  assert.equal(parseLocaleNumber('12,34', 'en-US'), undefined);
  assert.equal(parseLocaleNumber('1e3', 'en-US'), 1000);
  assert.equal(parseLocaleNumber('ten', 'en-US'), undefined);
  assert.equal(parseLocaleDate('3/14/2026', 'en-US'), '2026-03-14');
  assert.equal(parseLocaleDate('14/03/2026', 'en-GB'), '2026-03-14');
  assert.equal(parseLocaleDate('14.03.2026', 'de-DE'), '2026-03-14');
  assert.equal(parseLocaleDate('2026-03-14T09:30', 'en-US'), '2026-03-14 09:30:00');
  assert.equal(parseLocaleDate('3/14/26', 'en-US'), undefined, 'a two-digit year says too little');
  assert.equal(parseLocaleDate('2/30/2026', 'en-US'), undefined);
  assert.equal(parseLocaleDate('14/03/2026', 'en-US'), undefined);
});

const table: TableMeta = {
  id: 'product',
  name: 'product',
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
    { name: 'sku', type: 'TEXT', nullable: false, primaryKey: false },
    { name: 'supplier_id', type: 'INTEGER', nullable: false, primaryKey: false, references: { table: 'supplier', column: 'id' } },
    { name: 'status', type: 'TEXT', nullable: false, primaryKey: false, default: "'active'", allowed: ['active', 'on_hold'] },
    { name: 'active', type: 'BOOLEAN', nullable: true, primaryKey: false },
    { name: 'photo', type: 'BLOB', nullable: true, primaryKey: false },
    { name: 'stage', type: 'TEXT', nullable: true, primaryKey: false, changesBy: 'actions' },
    { name: 'secret', type: 'TEXT', nullable: true, primaryKey: false, writable: false },
  ],
};

test('the fields an import fills are the columns the reader may write, and a header suggests one each', () => {
  const fields = importFields(table, {}, (column) => ({ supplier_id: 'Supplier', sku: 'SKU' })[column]);
  assert.deepEqual(
    fields.map((field) => [field.name, field.kind, field.required]),
    [
      ['id', 'integer', false],
      ['sku', 'text', true],
      ['supplier_id', 'reference', true],
      ['status', 'choice', false],
      ['active', 'boolean', false],
    ],
  );
  assert.deepEqual(suggestMapping(['S.K.U.', 'supplier', 'Supplier', 'Notes', 'STATUS'], fields), [
    'sku',
    'supplier_id',
    null,
    null,
    'status',
  ]);
  assert.equal(mappingProblem(['sku', null], fields, 2), 'No column fills "Supplier", which every row needs.');
  assert.equal(mappingProblem(['sku', 'sku', 'supplier_id'], fields, 3), 'Two columns fill "SKU"; choose one.');
  assert.equal(mappingProblem(['sku', 'photo', 'supplier_id'], fields, 3), '"photo" is not a field this import fills.');
  assert.equal(mappingProblem(['sku', 'supplier_id'], fields, 3), 'The mapping names a field for each column of the file.');
});

test("a cell becomes its field's value: vocabulary by its word, yes and no, a reference left to find by name", () => {
  const field = (name: string) => importFields(table, {}).find((f) => f.name === name) as ImportField;
  assert.deepEqual(readCell(field('status'), 'On hold', 'en-US'), { value: 'on_hold' });
  assert.deepEqual(readCell(field('status'), 'ACTIVE', 'en-US'), { value: 'active' });
  assert.match((readCell(field('status'), 'retired', 'en-US') as { problem: string }).problem, /is not one of "Active", "On hold"/);
  assert.deepEqual(readCell(field('active'), 'Yes', 'en-US'), { value: true });
  assert.deepEqual(readCell(field('active'), '0', 'en-US'), { value: false });
  assert.deepEqual(readCell(field('supplier_id'), ' Summit ', 'en-US'), { lookup: 'Summit' });
  assert.deepEqual(readCell(field('id'), '  ', 'en-US'), { empty: true });
  assert.match((readCell(field('id'), '1.5', 'en-US') as { problem: string }).problem, /not a whole number/);
});

test('the error file keeps the line and the problem, and never hands a spreadsheet a formula', () => {
  const csv = importErrorCsv(
    ['SKU', 'Name'],
    [
      ['=HYPERLINK("http://x","y")', '@SUM(A1)'],
      ['-5', 'fine'],
    ],
    [
      { row: 1, line: 2, problems: [{ field: 'Name', message: '"x" is wrong.' }] },
      { row: 2, line: 3, problems: [{ message: '+cmd' }] },
    ],
  );
  assert.equal(
    csv,
    'Line,SKU,Name,Problem\r\n' + '2,"\'=HYPERLINK(""http://x"",""y"")",\'@SUM(A1),"Name: ""x"" is wrong."\r\n' + "3,-5,fine,'+cmd\r\n",
  );
});

test('a command import is refused at load on a row-policy App; a tenant App serves both kinds', () => {
  const command = { id: 'assign', version: 1, target: 'loan', input: [] };
  assert.throws(
    () => checkImports({ auth: { rows: 'policy' }, resources: { loan: { import: { command, match: ['code'] } } }, views: {} }, 'fixture'),
    /imports through the command "assign", which is not supported yet on an App with "auth.rows": "policy"/,
  );
  assert.doesNotThrow(() => checkImports({ auth: { rows: 'policy' }, resources: { loan: { import: {} } }, views: {} }, 'fixture'));
  // Every row lands in the member's own context, the tenant's ownership injected (tenant/tenantHttp.ts).
  assert.doesNotThrow(() =>
    checkImports({ auth: { rows: 'tenant' }, resources: {}, views: { list: { table: 'loan', import: {} } } }, 'fixture'),
  );
  assert.doesNotThrow(() =>
    checkImports({ auth: { rows: 'tenant' }, resources: { loan: { import: { command, match: ['code'] } } }, views: {} }, 'fixture'),
  );
});
