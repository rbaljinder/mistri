/**
 * Reading the values a column is allowed to hold.
 *
 * Every dialect writes the same constraint differently and Postgres does not
 * even store what you wrote, so this is the file where a `status` column
 * either becomes a list of states or stays an opaque `text`. The refusals
 * matter as much as the reads: a half-understood `CHECK (total > 0 AND status
 * IN (...))` reported as a vocabulary would present one clause of a rule as
 * the whole rule.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkFlag,
  checkVocabulary,
  checksIn,
  flagsFromDDL,
  typeVocabulary,
  vocabularyFromDDL,
} from '../packages/engine/src/shared/vocabulary.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from '../packages/engine/src/adapters/connect.js';
import { isFlagColumn } from '../packages/engine/src/shared/schema.js';

describe('a CHECK that pins a column', () => {
  test('reads the plain IN list every dialect writes', () => {
    assert.deepEqual(checkVocabulary("status IN ('draft','open','paid')", 'status'), ['draft', 'open', 'paid']);
  });

  test('reads what Postgres stores instead, casts and all', () => {
    const stored = "(((status)::text = ANY ((ARRAY['draft'::character varying, 'open'::character varying])::text[])))";
    assert.deepEqual(checkVocabulary(stored, 'status'), ['draft', 'open']);
  });

  test('survives quoting on either side', () => {
    assert.deepEqual(checkVocabulary(`"status" in ('a')`, 'status'), ['a']);
    assert.deepEqual(checkVocabulary("status IN ('it''s')", 'status'), ["it's"]);
  });

  test('is about one column, and knows when it is not that column', () => {
    assert.equal(checkVocabulary("status IN ('a')", 'priority'), undefined);
  });

  test('refuses everything it does not fully understand', () => {
    /* A partial read is worse than none: it would be shown as the rule. */
    assert.equal(checkVocabulary('total > 0', 'total'), undefined);
    assert.equal(checkVocabulary("total > 0 AND status IN ('a')", 'status'), undefined);
    assert.equal(checkVocabulary('status IN (SELECT code FROM status)', 'status'), undefined);
    assert.equal(checkVocabulary("status IN ('a', other_column)", 'status'), undefined);
  });
});

describe('checks inside a CREATE TABLE', () => {
  test('are matched to their own closing paren, not the first one', () => {
    const found = checksIn("CREATE TABLE t (status TEXT CHECK (status IN ('a','b')), n INT)");
    assert.deepEqual(found, ["status IN ('a','b')"]);
  });

  test('step over parens inside string literals', () => {
    const found = checksIn("CHECK (label IN ('a)b', 'c'))");
    assert.deepEqual(found, ["label IN ('a)b', 'c')"]);
  });

  test('give a table its whole vocabulary, column- and table-level alike', () => {
    const ddl = `CREATE TABLE t (
      status TEXT CHECK (status IN ('a','b')),
      total INT CHECK (total > 0),
      kind TEXT,
      CHECK (kind IN ('x','y'))
    )`;
    assert.deepEqual(
      [...vocabularyFromDDL(ddl, ['status', 'total', 'kind'])],
      [
        ['status', ['a', 'b']],
        ['kind', ['x', 'y']],
      ],
    );
  });
});

describe('a vocabulary written into the type, as MySQL does', () => {
  test('is read off the declared type', () => {
    assert.deepEqual(typeVocabulary("enum('draft','open')"), ['draft', 'open']);
    assert.deepEqual(typeVocabulary("SET('a','b')"), ['a', 'b']);
  });

  test('and every other type has none', () => {
    assert.equal(typeVocabulary('varchar(20)'), undefined);
    assert.equal(typeVocabulary('int'), undefined);
  });
});

describe('a CHECK that pins an integer to 0 and 1', () => {
  test('is a flag in each way it is written', () => {
    for (const check of [
      'billable IN (0, 1)',
      'billable IN (1,0)',
      '(billable IN (0,1))',
      'billable = 0 OR billable = 1',
      '(billable = 1) OR (billable = 0)',
      'billable BETWEEN 0 AND 1',
      '"billable" in (0, 1)',
      '(billable = ANY (ARRAY[0, 1]))',
    ]) {
      assert.equal(checkFlag(check, 'billable'), true, check);
    }
  });

  test('is no flag when it says more, less, or of another column', () => {
    for (const check of [
      'billable IN (0, 1, 2)',
      'billable IN (1)',
      'billable >= 0',
      'billable IN (0, 1) AND hours > 0',
      'billable = 0 OR other = 1',
      'billable = 1 OR billable = 1',
      "billable IN ('0', 'x')",
    ]) {
      assert.equal(checkFlag(check, 'billable'), false, check);
    }
    assert.equal(checkFlag('other IN (0, 1)', 'billable'), false);
  });

  test('is read off a CREATE TABLE beside its vocabularies', () => {
    const ddl = `CREATE TABLE t (auto_renew INTEGER NOT NULL DEFAULT 0 CHECK (auto_renew IN (0, 1)), status TEXT CHECK (status IN ('a','b')), n INT)`;
    assert.deepEqual([...flagsFromDDL(ddl, ['auto_renew', 'status', 'n'])], ['auto_renew']);
  });

  test('reaches the schema from SQLite, and only on an integer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tw-flag-'));
    try {
      const file = join(dir, 'flags.db');
      const db = new DatabaseSync(file);
      db.exec(`CREATE TABLE lease (id INTEGER PRIMARY KEY, auto_renew INTEGER NOT NULL DEFAULT 0 CHECK (auto_renew IN (0, 1)),
        grade TEXT CHECK (grade IN (0, 1)), open BOOLEAN, plain INTEGER)`);
      db.close();
      const adapter = connect(`sqlite:${file}`);
      try {
        const columns = (await adapter.introspect()).tables.find((t) => t.id === 'lease')!.columns;
        const by = (name: string) => columns.find((c) => c.name === name)!;
        assert.equal(by('auto_renew').flag, true);
        assert.equal(by('grade').flag, undefined, 'a text column is no integer flag');
        assert.deepEqual(
          ['auto_renew', 'grade', 'open', 'plain'].map((name) => isFlagColumn(by(name))),
          [true, false, true, false],
        );
      } finally {
        await adapter.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
