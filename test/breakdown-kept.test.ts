/**
 * A breakdown compiled against a catalog nothing can change is kept with it
 * (breakdown.ts compileBreakdown): an enter asks for the same breakdowns again
 * and again. What a compile read of the clock is never kept — a statement that
 * wrote one request's `now` is that request's — and every caller is handed its
 * own arrays.
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { readSqliteReadCatalog } from '../packages/engine/src/adapters/scoped/sqliteScopeCatalog.js';
import {
  breakdownsCompiledSoFar,
  compileBreakdown,
  withBreakdownComputed,
  type BreakdownDef,
} from '../packages/engine/src/shared/breakdown.js';
import { readStatementInstantFrom } from '../packages/engine/src/shared/computed.js';
import { parseComputed } from '../packages/engine/src/shared/computedParse.js';
import { POSTGRES_STYLE } from '../packages/engine/src/shared/filter.js';
import { snapshotRowScope } from '../packages/engine/src/shared/rowScope.js';
import { freezeDerivedCatalog } from '../packages/engine/src/shared/scopeCatalog.js';
import { captureTenantData } from '../packages/engine/src/server/evidence.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

const read = (() => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE task (id INTEGER PRIMARY KEY, subject TEXT NOT NULL, updated_at DATETIME NOT NULL)`);
  db.exec('BEGIN');
  const { schema } = readSqliteReadCatalog(db);
  db.exec('COMMIT');
  db.close();
  return schema;
})();
const isColumn = (path: string) => ['id', 'subject', 'updated_at'].includes(path);
const column = (type: 'boolean', text: string, reads: string[]) => ({ type, expr: parseComputed(text, isColumn), reads });
const fixed = (): DatabaseSchema =>
  freezeDerivedCatalog({
    ...structuredClone(read),
    tables: read.tables.map((table) =>
      table.id === 'task'
        ? {
            ...structuredClone(table),
            computed: {
              late: column('boolean', "subject = 'late'", ['subject']),
              fresh: column('boolean', 'updated_at > now - 30 minutes', ['updated_at']),
            },
          }
        : structuredClone(table),
    ),
  });
const by = (schema: DatabaseSchema, path: string): BreakdownDef =>
  withBreakdownComputed(schema, { base: 'task', by: [{ path }], measures: [{ fn: 'count' }] } as BreakdownDef);
const compiled = (run: () => void) => {
  const before = breakdownsCompiledSoFar();
  run();
  return breakdownsCompiledSoFar() - before;
};

test('a breakdown against a fixed catalog is compiled once, and each caller gets its own arrays', () => {
  const schema = fixed();
  let first!: ReturnType<typeof compileBreakdown>, again!: ReturnType<typeof compileBreakdown>;
  assert.equal(
    compiled(() => {
      // A fresh copy of the definition each time, as a scoped reader snapshots it.
      first = compileBreakdown(schema, by(schema, 'late'), POSTGRES_STYLE);
      again = compileBreakdown(schema, by(schema, 'late'), POSTGRES_STYLE);
    }),
    1,
  );
  assert.equal(again.text, first.text);
  assert.deepEqual(again.params, first.params);
  assert.notEqual(again.params, first.params);
  assert.notEqual(again.columns, first.columns);
  // Another page, another scope or a catalog that can still change is compiled for itself.
  assert.equal(
    compiled(() => {
      compileBreakdown(schema, by(schema, 'late'), POSTGRES_STYLE, 50);
      compileBreakdown(
        schema,
        by(schema, 'late'),
        POSTGRES_STYLE,
        0,
        snapshotRowScope(schema, { task: { groups: [[{ column: 'subject', op: '=', value: 'mine' }]] } } as never),
      );
      const open = structuredClone(schema);
      compileBreakdown(open, by(open, 'late'), POSTGRES_STYLE);
      compileBreakdown(open, by(open, 'late'), POSTGRES_STYLE);
    }),
    4,
  );
});

test('a breakdown that writes the instant is compiled for every statement, each with its own', () => {
  const schema = fixed();
  let at = '2026-03-02T09:00:00.000Z';
  readStatementInstantFrom(() => at);
  try {
    let morning = '',
      evening = '';
    assert.equal(
      compiled(() => {
        morning = compileBreakdown(schema, by(schema, 'fresh'), POSTGRES_STYLE).text;
        at = '2026-03-02T17:00:00.000Z';
        evening = compileBreakdown(schema, by(schema, 'fresh'), POSTGRES_STYLE).text;
      }),
      2,
    );
    assert.ok(morning.includes('2026-03-02T09:00:00') && !morning.includes('2026-03-02T17:00:00'), morning);
    assert.ok(evening.includes('2026-03-02T17:00:00') && !evening.includes('2026-03-02T09:00:00'), evening);
  } finally {
    readStatementInstantFrom(() => undefined);
  }
});

test('a served tenant catalog keeps its breakdowns, and a definition is kept by all it says', () => {
  const schema = captureTenantData(structuredClone(fixed()));
  const late = by(schema, 'late');
  assert.equal(
    compiled(() => {
      // A snapshot's keys left undefined are the same definition as itself, every time.
      compileBreakdown(schema, { ...late, orderBy: undefined }, POSTGRES_STYLE);
      compileBreakdown(schema, { ...late, orderBy: undefined }, POSTGRES_STYLE);
    }),
    1,
  );
  // A key left undefined is not the key absent, and a Date is not the text it says: each is compiled for itself.
  const day = { ...late, filter: { groups: [[{ path: 'updated_at', op: '>', value: new Date('2026-03-02T09:00:00Z') }]] } };
  const said = { ...late, filter: { groups: [[{ path: 'updated_at', op: '>', value: '2026-03-02T09:00:00.000Z' }]] } };
  assert.equal(
    compiled(() => {
      compileBreakdown(schema, late, POSTGRES_STYLE);
      compileBreakdown(schema, said as BreakdownDef, POSTGRES_STYLE);
      const dated = compileBreakdown(schema, day as unknown as BreakdownDef, POSTGRES_STYLE);
      assert.ok(dated.params.some((param) => param instanceof Date));
      compileBreakdown(schema, day as unknown as BreakdownDef, POSTGRES_STYLE);
    }),
    4,
  );
});

test('a definition JSON cannot say whole is compiled afresh, never kept or thrown on', () => {
  const schema = captureTenantData(structuredClone(fixed()));
  const late = by(schema, 'late');
  // A BigInt throws in JSON.stringify; the key gives up and the breakdown compiles as if nothing were kept.
  const big = { ...late, filter: { groups: [[{ path: 'id', op: '>', value: 9007199254740993n }]] } };
  assert.equal(
    compiled(() => {
      compileBreakdown(schema, big as unknown as BreakdownDef, POSTGRES_STYLE);
      compileBreakdown(schema, big as unknown as BreakdownDef, POSTGRES_STYLE);
    }),
    2,
  );
});
