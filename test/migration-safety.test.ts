/**
 * `mistri check --deploy` flags a migration that breaks the code still running
 * (build/migrationSafety.ts): each statement kind, the acknowledging marker,
 * and that comments and strings are not read as statements.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { migrationFindings } from '../packages/mistri/src/server/build/migrationSafety.js';

const kinds = (sql: string, strict = false) =>
  migrationFindings('V2__x.sql', sql, { strict }).map((f) => `${f.severity} ${f.line} ${f.kind}`);

test('each hazardous statement is named with its file, line and kind', () => {
  const cases: Array<[string, string]> = [
    ['DROP TABLE old_things;', 'DROP TABLE'],
    ['drop table if exists old_things cascade;', 'DROP TABLE'],
    ['ALTER TABLE t DROP COLUMN c;', 'DROP COLUMN'],
    ['alter table t drop c;', 'DROP COLUMN'],
    ['ALTER TABLE t RENAME TO u;', 'RENAME TABLE'],
    ['ALTER TABLE t RENAME COLUMN a TO b;', 'RENAME COLUMN'],
    ['ALTER TABLE t RENAME a TO b;', 'RENAME COLUMN'],
    ['ALTER TABLE t ALTER COLUMN a TYPE bigint;', 'ALTER COLUMN TYPE'],
    ['ALTER TABLE t ALTER a SET DATA TYPE text USING a::text;', 'ALTER COLUMN TYPE'],
    ['ALTER TABLE t ALTER COLUMN a SET NOT NULL;', 'SET NOT NULL'],
    ['ALTER TABLE t ADD COLUMN a int NOT NULL;', 'ADD COLUMN NOT NULL without DEFAULT'],
    ['DROP VIEW v;', 'DROP VIEW'],
    ['DROP MATERIALIZED VIEW v;', 'DROP VIEW'],
    ['DROP FUNCTION f(int);', 'DROP FUNCTION'],
  ];
  for (const [sql, kind] of cases) assert.deepEqual(kinds(sql), [`warning 1 ${kind}`], sql);
  const [found] = migrationFindings('V2__x.sql', 'SELECT 1;\n\nALTER TABLE t DROP COLUMN c;');
  assert.equal(found.file, 'V2__x.sql');
  assert.equal(found.line, 3);
  assert.match(found.message, /V2__x\.sql:3 DROP COLUMN/);
  assert.match(found.message, /still running/);
  assert.match(found.fix, /expand|Expand/);
  assert.match(found.fix, /-- mistri: contract/);
});

test('safe statements are not flagged', () => {
  const safe = [
    'CREATE TABLE t (id int NOT NULL, name text NOT NULL);',
    'ALTER TABLE t ADD COLUMN a int;',
    'ALTER TABLE t ADD COLUMN a int NOT NULL DEFAULT 0;',
    'ALTER TABLE t ADD COLUMN id bigserial NOT NULL;',
    'ALTER TABLE t ADD CONSTRAINT c CHECK (a IS NOT NULL);',
    'ALTER TABLE t DROP CONSTRAINT c;',
    'ALTER TABLE t ALTER COLUMN a DROP NOT NULL;',
    'ALTER TABLE t ALTER COLUMN a SET DEFAULT 1;',
    'ALTER TABLE t RENAME CONSTRAINT a TO b;',
    'DROP INDEX i;',
    'CREATE OR REPLACE VIEW v AS SELECT 1;',
    'INSERT INTO t (a) VALUES (1);',
  ];
  for (const sql of safe) assert.deepEqual(kinds(sql), [], sql);
});

test('several actions in one ALTER TABLE are each judged, and a comma inside parentheses is not a split', () => {
  assert.deepEqual(kinds('ALTER TABLE t DROP COLUMN a, ADD COLUMN b numeric(10, 2) NOT NULL, ALTER COLUMN c SET NOT NULL;'), [
    'warning 1 DROP COLUMN',
    'warning 1 ADD COLUMN NOT NULL without DEFAULT',
    'warning 1 SET NOT NULL',
  ]);
});

test('comments, strings, quoted identifiers and function bodies are not statements', () => {
  const sql = `-- DROP TABLE a;
/* ALTER TABLE t DROP COLUMN c; /* nested */ DROP TABLE b; */
INSERT INTO notes (body) VALUES ('DROP TABLE users; -- ''ALTER TABLE t DROP COLUMN c''');
CREATE FUNCTION f() RETURNS void AS $body$ BEGIN DROP TABLE tmp; END $body$ LANGUAGE plpgsql;
COMMENT ON TABLE t IS 'ALTER TABLE t RENAME TO u';
ALTER TABLE "drop" ADD COLUMN "not null" int;`;
  assert.deepEqual(kinds(sql), []);
});

test('lines stay right after comments, strings and block comments', () => {
  const sql = `/* a
b */
-- c
SELECT 'x
y';
ALTER TABLE t DROP COLUMN c;`;
  assert.deepEqual(kinds(sql), ['warning 6 DROP COLUMN']);
});

test('a statement split over lines and with odd case is found at its first line', () => {
  assert.deepEqual(kinds('SELECT 1;\n  Alter   Table  t\n    drop\n    column c ;'), ['warning 2 DROP COLUMN']);
});

test('-- mistri: contract on the line before acknowledges one statement and makes it a note', () => {
  const sql = `-- mistri: contract
ALTER TABLE t DROP COLUMN old;
ALTER TABLE t DROP COLUMN other;
-- mistri: contract
-- the code stopped reading it in 1.4
DROP TABLE legacy;

-- mistri: contract

DROP VIEW v;`;
  assert.deepEqual(kinds(sql), ['info 2 DROP COLUMN', 'warning 3 DROP COLUMN', 'info 6 DROP TABLE', 'info 10 DROP VIEW']);
  const [note] = migrationFindings('V2__x.sql', sql);
  assert.match(note.message, /marked as a contract step/);
});

test('a marker after a statement does not acknowledge it, and a marker in a string does not count', () => {
  assert.deepEqual(kinds('DROP TABLE a;\n-- mistri: contract\nSELECT 1;'), ['warning 1 DROP TABLE']);
  assert.deepEqual(kinds("SELECT '-- mistri: contract';\nDROP TABLE a;"), ['warning 2 DROP TABLE']);
});

test('strict makes a finding an error, and a marked one stays a note', () => {
  assert.deepEqual(kinds('DROP TABLE a;\n-- mistri: contract\nDROP TABLE b;', true), ['error 1 DROP TABLE', 'info 3 DROP TABLE']);
});
