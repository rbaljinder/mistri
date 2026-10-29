/**
 * `funnel()`: stages counted in order, in one statement. The stages' chains (a row reaches a stage when it holds the
 * section's conditions and every required stage up to it; an optional one is a side count), the line they ask in, the
 * statement that line becomes on each dialect, the counts it answers (equal to the separate counts, from one snapshot)
 * and the opposite of a stage that a "dropped" figure opens.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { compileBreakdown, measureToText } from '../packages/engine/src/shared/breakdown.js';
import { textToBreakdown } from '../packages/engine/src/shared/breakdowntext.js';
import { ANSI_STYLE, POSTGRES_STYLE } from '../packages/engine/src/shared/filter.js';
import {
  droppedQuery,
  funnelBasis,
  funnelChains,
  funnelText,
  negateCondition,
  negateQuery,
  type FunnelStage,
} from '../packages/engine/src/shared/funnel.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { dispatchResourceReadHttp } from '../packages/engine/src/server/resourceReadHttp.js';

const STAGES: FunnelStage[] = [
  { label: 'Started' },
  { label: 'Submitted', query: 'submitted_at is not empty' },
  { label: 'Documents in', query: 'docs_ok = 1' },
  { label: 'Test drive', query: 'test_drive = 1', optional: true },
  { label: 'Approved', query: 'status in (approved, funded)' },
  { label: 'Funded', query: 'funded_at is not empty' },
];

const schemaOf = (dialect: string): DatabaseSchema =>
  ({
    dialect,
    tables: [
      {
        id: 'application',
        name: 'application',
        columns: [
          { name: 'id', type: 'integer', pk: true },
          { name: 'store', type: 'text' },
          { name: 'status', type: 'text' },
          { name: 'submitted_at', type: 'date' },
          { name: 'docs_ok', type: 'integer' },
          { name: 'test_drive', type: 'integer' },
          { name: 'funded_at', type: 'date' },
        ],
      },
    ],
    foreignKeys: [],
  }) as unknown as DatabaseSchema;

test('a stage is reached by the section, every required stage before it and its own conditions; an optional one is a side count', () => {
  assert.deepEqual(funnelChains(STAGES), [
    '',
    'submitted_at is not empty',
    'submitted_at is not empty and docs_ok = 1',
    'submitted_at is not empty and docs_ok = 1 and test_drive = 1',
    'submitted_at is not empty and docs_ok = 1 and status in (approved, funded)',
    'submitted_at is not empty and docs_ok = 1 and status in (approved, funded) and funded_at is not empty',
  ]);
  // Each stage is a share of the last required stage before it; the first has none.
  assert.deepEqual(funnelBasis(STAGES), [null, 0, 1, 2, 2, 4]);
  // Every stage after the first optional: an any-order checklist, each counted against the base alone.
  const checklist: FunnelStage[] = [
    { label: 'Asked' },
    { label: 'A', query: 'a = 1', optional: true },
    { label: 'B', query: 'b = 1', optional: true },
  ];
  assert.deepEqual(funnelChains(checklist), ['', 'a = 1', 'b = 1']);
  assert.deepEqual(funnelBasis(checklist), [null, 0, 0]);
});

test('a funnel asks one line: the section’s conditions, then a count for each stage', () => {
  assert.equal(
    funnelText({ table: 'application', query: "store = 'north'", stages: STAGES.slice(0, 3) }),
    "application store = 'north' count as stage_1, count when [submitted_at is not empty] as stage_2, count when [submitted_at is not empty and docs_ok = 1] as stage_3",
  );
  assert.equal(funnelText({ table: 'application' }), null);
});

test('the line parses: each when is its conditions, a measure that reads back as it was written, and a comma or a "by" inside holds', () => {
  const parsed = textToBreakdown(
    schemaOf('sqlite'),
    "application count as a, count when [status in (approved, funded) and store = 'north, by'] as b",
  );
  assert.deepEqual(parsed.errors, []);
  const [, second] = parsed.breakdown!.measures;
  assert.equal(second.when, "status in (approved, funded) and store = 'north, by'");
  assert.equal(second.where!.groups.length, 1);
  assert.equal(second.where!.groups[0].length, 2);
  assert.equal(measureToText(second), "count when [status in (approved, funded) and store = 'north, by'] as b");
  assert.deepEqual(parsed.breakdown!.by, []);
});

test('a when is refused with the fix where it cannot mean anything', () => {
  const asked = (text: string) =>
    textToBreakdown(schemaOf('sqlite'), text)
      .errors.map((e) => e.message)
      .join(' | ');
  assert.match(asked('application sum docs_ok when [docs_ok = 1]'), /bare `count`/);
  assert.match(asked('application count when [docs_ok = 1'), /not closed/);
  assert.match(asked('application count when []'), /needs conditions/);
  assert.match(asked('application count when [nope = 1]'), /nope/);
  assert.match(asked('application count when [docs_ok = 1 sort id]'), /conditions only/);
});

test('one statement on every dialect, the conditions bound in the order the text reads them', () => {
  const line = funnelText({ table: 'application', query: "store = 'north'", stages: STAGES.slice(0, 3) })!;
  for (const [dialect, style, placeholder] of [
    ['sqlite', ANSI_STYLE, /\?/],
    ['postgres', POSTGRES_STYLE, /\$1/],
  ] as const) {
    const schema = schemaOf(dialect);
    const parsed = textToBreakdown(schema, line);
    assert.deepEqual(parsed.errors, [], dialect);
    const compiled = compileBreakdown(schema, parsed.breakdown!, style);
    assert.equal((compiled.text.match(/\bSELECT\b/g) ?? []).length, 1, `${dialect}: one SELECT`);
    assert.equal((compiled.text.match(/COUNT\(CASE WHEN/g) ?? []).length, 2, `${dialect}: a conditional count per stage after the first`);
    assert.match(compiled.text, /COUNT\(\*\) AS /, `${dialect}: the first stage counts every row`);
    assert.match(compiled.text, placeholder);
    assert.doesNotMatch(compiled.text, /GROUP BY/, `${dialect}: one group, the whole answer`);
    // Stage 2 binds nothing (is not empty), stage 3 binds docs_ok = 1, then the section's store, then the limit and offset.
    assert.deepEqual(compiled.params.slice(0, 2), [1, 'north'], dialect);
    assert.equal(compiled.params.length, 4, dialect);
    if (dialect === 'postgres') assert.match(compiled.text, /"docs_ok" = \$1[\s\S]*"store" = \$2/);
  }
});

test('the counts are the separate counts, from one statement', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-funnel-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(join(directory, 'funnel.db'));
  db.exec(`CREATE TABLE application (id INTEGER PRIMARY KEY, store TEXT, status TEXT, submitted_at DATE, docs_ok INTEGER, test_drive INTEGER, funded_at DATE);
    INSERT INTO application VALUES
      (1, 'north', NULL, NULL, NULL, NULL, NULL),
      (2, 'north', NULL, '2026-10-01', NULL, NULL, NULL),
      (3, 'north', NULL, '2026-10-01', 1, 1, NULL),
      (4, 'north', 'approved', '2026-10-01', 1, NULL, NULL),
      (5, 'north', 'funded', '2026-10-01', 1, 1, '2026-10-09'),
      (6, 'south', 'funded', '2026-10-02', 1, NULL, '2026-10-08'),
      (7, 'south', 'approved', NULL, 1, NULL, NULL),
      (8, 'south', 'declined', '2026-10-02', 1, 1, NULL);`);
  db.close();
  const adapter = new SqliteAdapter(join(directory, 'funnel.db'), 'funnel');
  t.after(() => adapter.close());
  const schema = await adapter.introspect();
  const ask = async (text: string) => {
    const reply = await dispatchResourceReadHttp('/api/breakdown', { text }, adapter, schema, {
      app: undefined,
      now: () => new Date('2026-10-13T00:00:00Z'),
    });
    assert.equal(reply?.status, 200);
    const body = reply!.body as { rows: Array<Record<string, unknown>>; errors?: unknown };
    assert.equal(body.errors, undefined);
    return body.rows;
  };
  const chains = funnelChains(STAGES);
  const together = (await ask(funnelText({ table: 'application', stages: STAGES })!))[0];
  const apart = await Promise.all(
    chains.map(async (chain) => Number((await ask(`application ${chain} count`.replace('  ', ' ')))[0].count)),
  );
  assert.deepEqual(Object.values(together).map(Number), apart);
  assert.deepEqual(apart, [8, 6, 5, 3, 3, 2]);
  // A dropped figure opens exactly the rows it counted: those that reached the stage it is a share of and not this one.
  const basis = funnelBasis(STAGES);
  for (const index of [1, 2, 4, 5]) {
    const dropped = droppedQuery(STAGES, index)!;
    assert.equal(Number((await ask(`application ${dropped} count`))[0].count), apart[basis[index]!] - apart[index], STAGES[index].label);
  }
  // Inside the section's own conditions too.
  const north = (await ask(funnelText({ table: 'application', query: "store = 'north'", stages: STAGES })!))[0];
  assert.deepEqual(Object.values(north).map(Number), [5, 4, 3, 2, 2, 1]);
});

test('the opposite of a stage is exact: a row with nothing in the column is not one that reached it', () => {
  assert.equal(negateCondition('submitted_at is not empty'), 'submitted_at is empty');
  assert.equal(negateCondition('submitted_at is empty'), 'submitted_at is not empty');
  assert.equal(negateCondition('any test_drive'), 'no test_drive');
  assert.equal(negateCondition('no test_drive where status = open'), 'any test_drive where status = open');
  assert.equal(negateCondition('status = approved'), 'status != approved or status is empty');
  assert.equal(negateCondition('status != "on hold"'), 'status = "on hold" or status is empty');
  assert.equal(negateCondition('amount >= 100'), 'amount < 100 or amount is empty');
  assert.equal(negateCondition('status in (approved, funded)'), 'status != approved and status != funded or status is empty');
  // Said nowhere: a phrase of dates, a nested or, a tag, words the language has no opposite for.
  for (const unsaid of [
    'created_at = last 30 days',
    'created_at = today',
    '(a = 1 or b = 2)',
    'tags has vpn',
    'name contains x',
    'owner_id = me or b = 1',
  ])
    assert.equal(negateCondition(unsaid), undefined, unsaid);
  // A query is all its conditions at once, so its opposite is any one's opposite.
  assert.equal(negateQuery('docs_ok = 1 and submitted_at is not empty'), 'docs_ok != 1 or docs_ok is empty or submitted_at is empty');
  assert.equal(negateQuery('docs_ok = 1 and created_at = last 30 days'), undefined);
  assert.equal(negateQuery('late', { late: 'due_on is not empty and paid_on is empty' }), 'due_on is empty or paid_on is not empty');
});

test('a stage’s dropped rows reached the stage before it and not this one; an optional stage drops none', () => {
  assert.equal(droppedQuery(STAGES, 0), undefined);
  assert.equal(droppedQuery(STAGES, 1), 'submitted_at is empty');
  assert.equal(droppedQuery(STAGES, 2), 'submitted_at is not empty and (docs_ok != 1 or docs_ok is empty)');
  assert.equal(droppedQuery(STAGES, 3), undefined, 'optional');
  // Approved follows Documents in, the side road skipped.
  assert.equal(
    droppedQuery(STAGES, 4),
    'submitted_at is not empty and docs_ok = 1 and (status != approved and status != funded or status is empty)',
  );
  assert.equal(droppedQuery([{ label: 'a' }, { label: 'b', query: 'created_at = last 30 days' }], 1), undefined);
});
