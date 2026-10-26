/**
 * Reading a shape for what it will cost.
 *
 * The rules are the load-bearing part: a lint that fires on things people
 * meant is one they turn off, and a lint that stays quiet about a foreign key
 * with nothing behind it is not worth running. So each rule gets a schema
 * that should trip it and one that should not, and the "should not" half is
 * the half that keeps this usable.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { lintCounts, lintReport, lintSchema } from '../packages/tablewalk/src/shared/lint.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

const base = (over: Partial<DatabaseSchema> = {}): DatabaseSchema => ({
  label: 'test',
  dialect: 'postgres',
  readAt: '2026-08-23T00:00:00.000Z',
  tables: [],
  foreignKeys: [],
  ...over,
});

const table = (name: string, columns: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) =>
  ({
    name,
    schema: '',
    id: name,
    isView: false,
    columns: columns.map((c) => ({ nullable: true, primaryKey: false, type: 'text', ...c })) as never,
    ...over,
  }) as never;

const rulesOf = (schema: DatabaseSchema) => lintSchema(schema).map((f) => f.rule);

describe('a table with no key', () => {
  test('is a table whose rows cannot be reached', () => {
    const schema = base({ tables: [table('eventlog', [{ name: 'note' }])] });
    const [finding] = lintSchema(schema);
    assert.equal(finding.rule, 'no-primary-key');
    assert.equal(finding.severity, 'high');
    /* The statement is about *this* table; the consequence belongs to the
       rule, because it is identical for every finding of that rule and
       repeating it makes a list nobody reads past the third line. */
    assert.match(finding.message, /eventlog has no primary key/);
    assert.match(finding.why, /linked to, edited or deleted/);
  });

  test('but a view has no key by definition and is not a finding', () => {
    const schema = base({ tables: [table('totals', [{ name: 'n' }], { isView: true })] });
    assert.deepEqual(lintSchema(schema), []);
  });
});

describe('a foreign key with nothing behind it', () => {
  const withIndex = (indexed: string[]) =>
    base({
      tables: [
        table(
          'invoice',
          [
            { name: 'id', primaryKey: true, type: 'integer' },
            { name: 'customer_id', type: 'integer' },
          ],
          { indexed },
        ),
        table('customer', [{ name: 'id', primaryKey: true, type: 'integer' }], { indexed: ['id'] }),
      ],
      foreignKeys: [
        {
          name: 'invoice_customer',
          from: { table: 'invoice', columns: ['customer_id'] },
          to: { table: 'customer', columns: ['id'] },
          onDelete: 'cascade',
        },
      ],
    });

  test('is the reverse walk run as a full scan, every time', () => {
    const findings = lintSchema(withIndex(['id']));
    assert.deepEqual(
      findings.map((f) => f.rule),
      ['unindexed-foreign-key'],
    );
    assert.match(findings[0].message, /customer_id → customer, with no index leading on customer_id/);
    assert.match(findings[0].why, /Every walk back from the referenced table scans this whole table/);
  });

  test('and an index leading on the column clears it', () => {
    assert.deepEqual(rulesOf(withIndex(['id', 'customer_id'])), []);
  });

  test('an adapter that does not report indexes is "we did not look", not "there are none"', () => {
    const schema = withIndex([]);
    delete (schema.tables[0] as { indexed?: string[] }).indexed;
    /* Absent and empty mean different things, and inventing a finding out of
       the absent one would make the lint useless on that engine. */
    assert.deepEqual(rulesOf(schema), []);
  });
});

describe('the rules that are about intent being written down', () => {
  test('a reference with no delete rule says what happens the day someone deletes', () => {
    const schema = base({
      tables: [
        table('invoice', [{ name: 'id', primaryKey: true }, { name: 'customer_id' }], { indexed: ['id', 'customer_id'] }),
        table('customer', [{ name: 'id', primaryKey: true }], { indexed: ['id'] }),
      ],
      foreignKeys: [
        {
          name: 'fk',
          from: { table: 'invoice', columns: ['customer_id'] },
          to: { table: 'customer', columns: ['id'] },
        },
      ],
    });
    assert.deepEqual(rulesOf(schema), ['no-delete-rule']);
  });

  test('a naive timestamp is a different instant to every reader', () => {
    const schema = base({
      tables: [
        table(
          'note',
          [
            { name: 'id', primaryKey: true, type: 'integer' },
            { name: 'written_at', type: 'timestamp without time zone' },
            { name: 'settled_at', type: 'timestamp with time zone' },
          ],
          { indexed: ['id'] },
        ),
      ],
    });
    /* The island rule fires here too — one table pointing nowhere — so this
       asks about the rule under test rather than about the whole answer. */
    const findings = lintSchema(schema).filter((f) => f.rule === 'timestamp-without-zone');
    assert.deepEqual(
      findings.map((f) => f.columns?.[0]),
      ['written_at'],
      'the zoned column is not a finding',
    );
  });
});

describe('the report', () => {
  const schema = base({
    tables: [
      table('eventlog', [{ name: 'note' }]),
      table(
        'note',
        [
          { name: 'id', primaryKey: true },
          { name: 'at', type: 'timestamp' },
        ],
        { indexed: ['id'] },
      ),
    ],
  });

  test('counts what it found and groups it by table', () => {
    const findings = lintSchema(schema);
    const counts = lintCounts(findings);
    assert.equal(counts.high + counts.medium + counts.low, findings.length);

    const text = lintReport(findings);
    assert.match(text, /^\d+ findings: \d+ high/);
    /* Each cost said once, at the end, rather than on every line. */
    assert.match(text, /## Why these matter/);
    assert.equal(text.split('no row here can be linked').length, 1, 'the consequence is not repeated inline');
    /* A table appears once, with its findings under it: sorting by severity
       first splits every table across three places in the document. */
    assert.equal(text.split('## eventlog').length, 2);
  });

  test('says so plainly when there is nothing to say', () => {
    assert.match(lintReport([]), /Nothing to report/);
  });

  test('leaves out a rule the caller does not want to hear about', () => {
    const findings = lintSchema(schema, { skip: ['unreferenced-table'] });
    assert.ok(!findings.some((f) => f.rule === 'unreferenced-table'));
  });
});
