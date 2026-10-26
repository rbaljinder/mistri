/**
 * The bulk contract on its own: one read for `when`, one write per record,
 * and an answer per record that nothing about one record changes for another.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { TableMeta } from '../../../engine/src/shared/schema.js';

const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
let answer: (path: string, body: Record<string, unknown>) => unknown = () => ({});
vi.mock('./core.js', () => ({
  api: async (path: string, body: Record<string, unknown>) => {
    calls.push({ path, body });
    return answer(path, body);
  },
  primaryKey: (table: TableMeta) => table.columns.filter((c) => c.primaryKey).map((c) => c.name),
  quote: (value: string) => (/^[A-Za-z0-9_]+$/.test(value) ? value : `"${value.replace(/"/g, '\\"')}"`),
}));
const identity = { epoch: 1, mode: 'anonymous', tenantRequired: false };
vi.mock('./sessionIdentity.js', () => ({
  sessionIdentity: () => identity,
  captureSessionIdentity: () => identity,
  tenantLeaseActive: () => false,
  subscribeSessionIdentity: () => () => {},
}));

const { applyBulk, bulkKey, bulkSummary, countedLabel, matchingKeys } = await import('./bulkActions.js');
const { updateAttempts } = await import('./updateAttempts.js');

const table: TableMeta = {
  id: 'issue',
  name: 'issue',
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
    { name: 'status', type: 'TEXT', nullable: false, primaryKey: false },
  ],
};
const composite: TableMeta = {
  ...table,
  id: 'link',
  name: 'link',
  columns: [
    { name: 'tenant', type: 'TEXT', nullable: false, primaryKey: true },
    { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
  ],
};

beforeEach(() => {
  calls.length = 0;
  answer = () => ({});
  updateAttempts.reset();
});
afterEach(() => vi.restoreAllMocks());

describe('bulkKey', () => {
  test('is the key columns in primary-key order as text, so big ids stay exact', () => {
    expect(bulkKey(table, { id: '9007199254740993' })).toBe(bulkKey(table, { id: '9007199254740993' }));
    expect(bulkKey(table, { id: '9007199254740993' })).not.toBe(bulkKey(table, { id: '9007199254740992' }));
    expect(bulkKey(composite, { id: 2, tenant: 'a' })).toBe(bulkKey(composite, { tenant: 'a', id: 2 }));
  });
});

describe('matchingKeys', () => {
  test('without a condition every key matches and nothing is read', async () => {
    const set = await matchingKeys(table, [{ id: 1 }, { id: 2 }], undefined, 'demo');
    expect([...set]).toEqual([bulkKey(table, { id: 1 }), bulkKey(table, { id: 2 })]);
    expect(calls).toEqual([]);
  });
  test('with a condition it asks once for exactly these keys and keeps the ones the server returned', async () => {
    answer = () => ({ columns: ['id'], rows: [{ id: 2 }], errors: [] });
    const set = await matchingKeys(table, [{ id: 1 }, { id: 2 }], 'status = ready', 'demo');
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/api/run');
    expect(calls[0].body).toEqual({
      q: 'issue ((id = 1) or (id = 2)) and status = ready show id',
      limit: 2,
      offset: 0,
      count: 'none',
      conn: 'demo',
    });
    expect([...set]).toEqual([bulkKey(table, { id: 2 })]);
  });
  test('composite keys and quoted values travel whole', async () => {
    answer = () => ({ columns: ['tenant', 'id'], rows: [], errors: [] });
    await matchingKeys(composite, [{ tenant: 'a b', id: 1 }], 'done = false');
    expect(calls[0].body.q).toBe('link (tenant = "a b" and id = 1) and done = false show tenant, id');
    expect(calls[0].body).not.toHaveProperty('conn');
  });
  test('a read that fails or errors matches nothing, so nothing is offered on a guess', async () => {
    answer = () => {
      throw new Error('down');
    };
    expect((await matchingKeys(table, [{ id: 1 }], 'status = ready')).size).toBe(0);
    answer = () => ({ errors: [{ message: 'bad' }], rows: [{ id: 1 }] });
    expect((await matchingKeys(table, [{ id: 1 }], 'status = ready')).size).toBe(0);
  });
});

describe('applyBulk', () => {
  const targets = [
    { key: { id: 1 }, label: 'One' },
    { key: { id: 2 }, label: 'Two' },
    { key: { id: 3 }, label: 'Three' },
  ];
  test('writes each record on its own, in order, and reports per record', async () => {
    answer = (_path, body) => ({ affected: 1, applied: body.values });
    const progress: number[] = [];
    const result = await applyBulk(
      { connection: 'demo', table: 'issue' },
      { status: 'done' },
      targets,
      () => true,
      (done) => progress.push(done),
    );
    expect(calls.map((call) => call.body)).toEqual(
      [1, 2, 3].map((id) => ({ conn: 'demo', table: 'issue', key: { id }, values: { status: 'done' } })),
    );
    expect(result.outcomes.map((outcome) => outcome.kind)).toEqual(['applied', 'applied', 'applied']);
    expect(result.counts).toEqual({ applied: 3, rejected: 0, uncertain: 0, blocked: 0, skipped: 0 });
    expect(result.stopped).toBe(false);
    expect(progress).toEqual([1, 2, 3]);
    expect(updateAttempts.get({ connection: 'demo', table: 'issue', key: { id: 2 } })).toBeUndefined();
  });
  test('a refusal on one record neither stops nor undoes the others, and its reason is kept', async () => {
    answer = (_path, body) => {
      if ((body.key as { id: number }).id === 2) throw Object.assign(new Error('Changed elsewhere.'), { status: 409 });
      return { affected: 1, applied: body.values };
    };
    const result = await applyBulk({ connection: 'demo', table: 'issue' }, { status: 'done' }, targets, () => true);
    expect(result.outcomes.map((outcome) => [outcome.kind, outcome.message])).toEqual([
      ['applied', ''],
      ['rejected', 'Changed elsewhere.'],
      ['applied', ''],
    ]);
    expect(calls).toHaveLength(3);
    expect(bulkSummary('Mark done', result)).toBe('Mark done: 2 applied, 1 rejected.');
  });
  test('a lost acknowledgement is reported as unconfirmed and left pending on that record only', async () => {
    answer = (_path, body) => {
      if ((body.key as { id: number }).id === 1) throw new Error('socket closed');
      return { affected: 1, applied: body.values };
    };
    const result = await applyBulk({ connection: 'demo', table: 'issue' }, { status: 'done' }, targets, () => true);
    expect(result.outcomes.map((outcome) => outcome.kind)).toEqual(['uncertain', 'applied', 'applied']);
    expect(updateAttempts.get({ connection: 'demo', table: 'issue', key: { id: 1 } })?.phase).toBe('uncertain');
    expect(updateAttempts.get({ connection: 'demo', table: 'issue', key: { id: 2 } })).toBeUndefined();
    expect(bulkSummary('Mark done', result)).toBe('Mark done: 2 applied, 1 unconfirmed.');
  });
  test('a record with a pending attempt is blocked rather than written twice', async () => {
    answer = (_path, body) => ({ affected: 1, applied: body.values });
    const held = updateAttempts.run({ connection: 'demo', table: 'issue', key: { id: 2 } }, { status: 'x' }, () => new Promise(() => {}));
    const result = await applyBulk({ connection: 'demo', table: 'issue' }, { status: 'done' }, targets, () => true);
    expect(result.outcomes.map((outcome) => outcome.kind)).toEqual(['applied', 'blocked', 'applied']);
    expect(calls.map((call) => (call.body.key as { id: number }).id)).toEqual([1, 3]);
    expect(bulkSummary('Mark done', result)).toBe('Mark done: 2 applied, 1 already pending.');
    void held;
  });
  test('once the list is no longer current the rest are skipped, not written', async () => {
    answer = (_path, body) => ({ affected: 1, applied: body.values });
    let current = true;
    const result = await applyBulk(
      { connection: 'demo', table: 'issue' },
      { status: 'done' },
      targets,
      () => current,
      (done) => {
        if (done === 1) current = false;
      },
    );
    expect(calls).toHaveLength(1);
    expect(result.outcomes.map((outcome) => outcome.kind)).toEqual(['applied', 'skipped', 'skipped']);
    expect(result.outcomes[1].message).toBe('Not written: the list is no longer current.');
    expect(result.stopped).toBe(true);
    expect(bulkSummary('Mark done', result)).toBe('Mark done: 1 applied, 2 not written.');
  });
  test('an unusable key is rejected before any request', async () => {
    const result = await applyBulk({ connection: 'demo', table: 'issue' }, { status: 'done' }, [{ key: {}, label: 'Nothing' }], () => true);
    expect(calls).toEqual([]);
    expect(result.outcomes[0].kind).toBe('rejected');
    expect(result.outcomes[0].message).toBe('This record has no usable key.');
  });
});

describe('a verb counted for its selection', () => {
  const timesheet = { one: 'timesheet', many: 'timesheets' };
  test('a label ending in the record’s noun says how many, in the plural', () => {
    expect(countedLabel('Approve timesheet', 2, timesheet)).toBe('Approve 2 timesheets');
    expect(countedLabel('Approve timesheets', 3, timesheet)).toBe('Approve 3 timesheets');
    expect(countedLabel('Approve Timesheet', 1200, timesheet)).toBe('Approve 1,200 timesheets');
    expect(countedLabel('Approve timesheet', 1, timesheet)).toBe('Approve timesheet');
  });
  test('a label that does not name the record stays as written', () => {
    expect(countedLabel('Send reminder', 2, { one: 'document', many: 'documents' })).toBe('Send reminder');
    expect(countedLabel('Timesheet', 2, timesheet)).toBe('Timesheet');
    expect(countedLabel('Approve subtimesheet', 2, timesheet)).toBe('Approve subtimesheet');
    expect(countedLabel('Close', 2, { one: 'category', many: 'categories' })).toBe('Close');
  });
});
