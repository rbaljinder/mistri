/**
 * The lexical half of the reserved-relation guard (packages/engine/src/adapters/reservedSql.ts),
 * held to the bypasses someone would actually try: case, quoting, schema
 * qualification, CTEs and subqueries, names inside strings and comments,
 * escapes it will not decode, and the Postgres constructs that name a
 * relation only when they run. The engine half — SQLite's authorizer and the
 * Postgres plan — is tried against real engines in mcp-safety.test.ts.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isReservedRelation, reservedInPlan, reservedInText } from '../packages/engine/src/adapters/reservedSql.js';

type Dialect = 'sqlite' | 'postgres';
const DIALECTS: Dialect[] = ['sqlite', 'postgres'];
const refused = (sql: string, dialect: Dialect) => assert.ok(reservedInText(sql, dialect), `${dialect} should refuse: ${sql}`);
const allowed = (sql: string, dialect: Dialect) => assert.equal(reservedInText(sql, dialect), null, `${dialect} should allow: ${sql}`);

describe('reserved relations in raw SQL, read as text', () => {
  test('a runtime table is refused however it is spelled or wherever it hides', () => {
    for (const dialect of DIALECTS) {
      refused('select * from __mistri_command_audit', dialect);
      refused('SELECT * FROM __MISTRI_COMMAND_AUDIT', dialect);
      refused('select * from main.__mistri_command_audit', dialect);
      refused('with a as (select * from __mistri_event_event) select * from a', dialect);
      refused('select * from invoice where exists (select 1 from __mistri_job_job j where j.id = invoice.id)', dialect);
      refused('select (select count(*) from __Mistri_x) as n', dialect);
      refused("select * from invoice where note = '__mistri_command_audit'", dialect);
      refused('select 1 -- __mistri_x\n', dialect);
      refused('select 1 /* __mistri_x */', dialect);
    }
    refused('select * from "__mistri_command_audit"', 'postgres');
    refused('select * from "public"."__MiStri_x"', 'postgres');
    refused('select * from "__mistri_x"', 'sqlite');
    refused('select * from [__mistri_x]', 'sqlite');
    refused('select * from `__mistri_x`', 'sqlite');
    refused("select 'it''s __mistri_x'", 'postgres');
  });

  test('the runtime schema is refused on Postgres, and only it', () => {
    refused('select * from mistri.auth_user', 'postgres');
    refused('select * from "mistri".auth_session', 'postgres');
    refused('select * from MISTRI.auth_account', 'postgres');
    refused("select * from pg_catalog.pg_tables where schemaname = 'mistri'", 'postgres');
    refused('select * from mistri.flag_binding', 'postgres');
    refused('update mistri.experiment_binding set id = 1', 'postgres');
    refused('select * from "mistri".analytics_meta', 'postgres');
    allowed('select * from tablewalk_authors', 'postgres');
    allowed('select tablewalk_authority from invoice', 'postgres');
    allowed('select * from tablewalk_flagship', 'postgres');
  });

  test('a relation named only when the statement runs is refused on Postgres', () => {
    refused("select * from query_to_xml('select * from tablewa' || 'lk_auth.session', true, false, '')", 'postgres');
    refused("select table_to_xml(16384, true, false, '')", 'postgres');
    refused("select 'invoice'::regclass", 'postgres');
    refused("select to_regclass('pub' || 'lic.x')", 'postgres');
    refused('select cast(16384 as pg_catalog.regclass)', 'postgres');
    refused("select * from ts_stat('select v from x')", 'postgres');
    refused("select * from dblink('dbname=x', 'select 1') as t(a int)", 'postgres');
    refused('select * from crosstab($$select 1$$) as t(a int)', 'postgres');
    refused('select * from "query_to_xml"($$select 1$$, true, false, $$$$)', 'postgres');
    refused('select $body$ __mistri_x $body$', 'postgres');
    refused("select E'\\x5f\\x5ftablewalk_x'::regclass", 'postgres');
  });

  test('an escape the check does not decode is refused rather than read', () => {
    refused('select * from U&"\\005f\\005ftablewalk_x"', 'postgres');
    refused('select * from u&"!005F!005Ftablewalk_x" uescape \'!\'', 'postgres');
    allowed('select * from U&"invoice"', 'postgres');
  });

  test('ordinary statements pass, words that only look close included', () => {
    for (const dialect of DIALECTS) {
      allowed('select id, total from invoice where total > 500 order by total desc', dialect);
      allowed('with big as (select * from invoice where total > 500) select count(*) from big', dialect);
      allowed('select my__mistri_notes from invoice', dialect);
      allowed("select 'tablewalk' as product", dialect);
      // Tokens do not join across a comment: that is two names, neither reserved.
      allowed('select * from __table/**/walk_x', dialect);
    }
    allowed('select regclass_note from notes', 'postgres');
    allowed('select 1::int, now()::date', 'postgres');
    allowed('select * from invoice where status = $1', 'postgres');
  });
});

describe('reserved relations in a Postgres plan', () => {
  test("the planner's account names relations the text never did", () => {
    const joined = [
      {
        Plan: {
          'Node Type': 'Hash Join',
          Plans: [
            { 'Node Type': 'Seq Scan', 'Relation Name': 'invoice', Schema: 'public', Alias: 'i' },
            { 'Node Type': 'Seq Scan', 'Relation Name': 'auth_session', Schema: 'mistri', Alias: 's' },
          ],
        },
      },
    ];
    assert.equal(reservedInPlan(joined), 'mistri.auth_session');
    assert.equal(
      reservedInPlan([{ Plan: { 'Node Type': 'Seq Scan', 'Relation Name': 'command_receipt', Schema: 'mistri' } }]),
      'mistri.command_receipt',
    );
    assert.equal(reservedInPlan([{ Plan: { 'Node Type': 'Seq Scan', 'Relation Name': 'invoice', Schema: 'public' } }]), null);
  });

  test('a relation is reserved by its name or by its schema', () => {
    assert.equal(isReservedRelation('MISTRI', 'auth_user'), true);
    assert.equal(isReservedRelation(undefined, '__MISTRI_x'), true);
    assert.equal(isReservedRelation('public', '__mistri_x'), true);
    assert.equal(isReservedRelation('public', 'mistri'), false);
    assert.equal(isReservedRelation('mistri', 'flag_binding'), true);
  });
});
