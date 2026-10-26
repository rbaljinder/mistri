/**
 * A metric whose data `target` counts the same thing with no more conditions is a share of that whole, not a goal:
 * the server proves the subset and serves `targetWhole`, and where it cannot, the target stays a goal.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseAppConfig, resolveViews, type AppDashboardView } from '../packages/mistri/src/shared/app.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

const column = (name: string, type = 'TEXT', primaryKey = false) => ({ name, type, nullable: !primaryKey, primaryKey });
const schema: DatabaseSchema = {
  label: 'Lending',
  dialect: 'sqlite',
  readAt: '',
  foreignKeys: [],
  tables: [
    {
      id: 'application',
      name: 'application',
      schema: '',
      isView: false,
      columns: [column('id', 'INTEGER', true), column('status'), column('region'), column('amount', 'REAL'), column('decided_on', 'DATE')],
      segments: { open_west: 'status = open and region = west' },
    } as DatabaseSchema['tables'][number],
    { id: 'quota', name: 'quota', schema: '', isView: false, columns: [column('id', 'INTEGER', true), column('amount', 'REAL')] },
  ],
};

function served(metric: object) {
  const parsed = parseAppConfig(
    {
      name: 'Lending',
      resources: { application: {}, quota: {} },
      views: {
        board: { kind: 'dashboard', label: 'Board', sections: [{ kind: 'metric', from: 'application', title: 'Approved', ...metric }] },
      },
      home: 'board',
      nav: ['board'],
    },
    'whole',
  );
  const section = (resolveViews(parsed, schema).board as AppDashboardView).sections[0];
  return section as typeof section & { targetWhole?: true; target?: { query?: string; over?: string; windowBase?: string } };
}

describe('a metric target that is a whole', () => {
  test('the same measure over the same table with no conditions is a whole', () => {
    const section = served({ query: 'status = approved', target: { measure: 'count' } });
    assert.equal(section.targetWhole, true);
  });

  test("a target whose conditions are a subset of the metric's is a whole, a segment written out", () => {
    assert.equal(served({ query: 'status = open and region = west and amount > 5', target: { query: 'open_west' } }).targetWhole, true);
    assert.equal(
      served({ query: 'region = west and status = open', target: { query: 'status = open and region = west' } }).targetWhole,
      true,
    );
  });

  test('a target with a condition the metric lacks, or a different measure or table, stays a goal', () => {
    assert.equal(served({ query: 'status = approved', target: { query: 'region = west' } }).targetWhole, undefined);
    assert.equal(served({ query: 'status = approved', target: { measure: 'sum amount' } }).targetWhole, undefined);
    assert.equal(served({ query: 'status = approved', target: { from: 'quota', measure: 'count' } }).targetWhole, undefined);
    assert.equal(served({ query: 'status = approved or region = west', target: { query: 'region = west' } }).targetWhole, undefined);
  });

  test('a number is a goal', () => {
    assert.equal(served({ query: 'status = approved', target: 10 }).targetWhole, undefined);
  });

  test("a whole follows the metric's clock, and its own authored window is carried into it", () => {
    const clocked = served({ query: 'status = approved', over: 'decided_on', target: { measure: 'count' } });
    assert.equal(clocked.targetWhole, true);
    assert.equal(clocked.target?.over, 'decided_on');

    const windowed = served({ query: 'status = approved and decided_on = last 90 days', over: 'decided_on', target: { measure: 'count' } });
    assert.equal(windowed.targetWhole, true);
    assert.match(windowed.target?.query ?? '', /decided_on = last 90 days/);
    assert.equal(windowed.target?.windowBase, '');
  });
});
