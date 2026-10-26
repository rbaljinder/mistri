import { beforeEach, expect, test, vi } from 'vitest';

const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
let batchRoute: 'answers' | 'missing' | 'broken' = 'answers';
vi.mock('./core.js', () => ({
  api: async (path: string, body: Record<string, unknown>) => {
    calls.push({ path, body });
    const answer = (ask: Record<string, unknown>) => ({ rows: [{ text: ask.text }] });
    if (path === '/api/breakdown') {
      if (String(body.text).includes('refused')) throw Object.assign(new Error('No column "nowhere".'), { status: 400 });
      return answer(body);
    }
    if (batchRoute === 'missing') throw Object.assign(new Error('No such endpoint'), { status: 404 });
    if (batchRoute === 'broken') throw Object.assign(new Error('The data could not be loaded.'), { status: 500 });
    if (path === '/api/run') return { rows: [{ q: body.q }] };
    return {
      results: (body.items as Array<Record<string, unknown>>).map((item) =>
        item.run
          ? { status: 200, body: { rows: [{ q: (item.run as Record<string, unknown>).q }] } }
          : String(item.text).includes('refused')
            ? { status: 400, body: { error: 'No column "nowhere".' } }
            : { status: 200, body: answer(item) },
      ),
    };
  },
}));

const { batchedBreakdown, batchedRun, resetBreakdownBatch } = await import('./breakdownBatch.js');

beforeEach(() => {
  calls.length = 0;
  batchRoute = 'answers';
  resetBreakdownBatch();
});

test('the breakdowns of one moment go as one request, each answered with its own', async () => {
  const [a, b] = await Promise.all([batchedBreakdown({ text: 'deal count' }), batchedBreakdown({ text: 'deal count by stage', limit: 5 })]);
  expect(a).toEqual({ rows: [{ text: 'deal count' }] });
  expect(b).toEqual({ rows: [{ text: 'deal count by stage' }] });
  expect(calls).toEqual([
    { path: '/api/breakdowns', body: { items: [{ text: 'deal count' }, { text: 'deal count by stage', limit: 5 }] } },
  ]);
});

test('a list asked in the same moment rides in the batch, and alone is asked as /api/run', async () => {
  const [count, rows] = await Promise.all([
    batchedBreakdown({ text: 'deal count' }),
    batchedRun({ q: 'deal sort name', limit: 5, offset: 0, count: 'none' }),
  ]);
  expect(count).toEqual({ rows: [{ text: 'deal count' }] });
  expect(rows).toEqual({ rows: [{ q: 'deal sort name' }] });
  expect(calls).toEqual([
    {
      path: '/api/breakdowns',
      body: { items: [{ text: 'deal count' }, { run: { q: 'deal sort name', limit: 5, offset: 0, count: 'none' } }] },
    },
  ]);
  calls.length = 0;
  await batchedRun({ q: 'note', limit: 3 });
  expect(calls).toEqual([{ path: '/api/run', body: { q: 'note', limit: 3 } }]);
});

test('one alone is asked as it always was, and a refused item fails alone', async () => {
  await batchedBreakdown({ text: 'deal count' });
  expect(calls.map((call) => call.path)).toEqual(['/api/breakdown']);
  calls.length = 0;
  const [good, bad] = await Promise.allSettled([batchedBreakdown({ text: 'deal count' }), batchedBreakdown({ text: 'refused' })]);
  expect(good.status).toBe('fulfilled');
  expect(bad).toMatchObject({ status: 'rejected', reason: { message: 'No column "nowhere".', status: 400 } });
});

test('a server without the route is asked one at a time from then on', async () => {
  batchRoute = 'missing';
  await Promise.all([batchedBreakdown({ text: 'a' }), batchedBreakdown({ text: 'b' })]);
  expect(calls.map((call) => call.path)).toEqual(['/api/breakdowns', '/api/breakdown', '/api/breakdown']);
  calls.length = 0;
  await Promise.all([batchedBreakdown({ text: 'c' }), batchedBreakdown({ text: 'd' })]);
  expect(calls.map((call) => call.path)).toEqual(['/api/breakdown', '/api/breakdown']);
});

test('a failed batch hands each card the answer its own read gets, and keeps batching', async () => {
  batchRoute = 'broken';
  const settled = await Promise.allSettled([batchedBreakdown({ text: 'a' }), batchedBreakdown({ text: 'refused' })]);
  expect(settled.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
  batchRoute = 'answers';
  calls.length = 0;
  await Promise.all([batchedBreakdown({ text: 'c' }), batchedBreakdown({ text: 'd' })]);
  expect(calls.map((call) => call.path)).toEqual(['/api/breakdowns']);
});

test('a support lease, whose every read is ledgered as the one it is, answers 404 and is asked a card at a time', async () => {
  // tenantHttp.ts refuses the batch on a support lease with a 404, as a server without the route would.
  batchRoute = 'missing';
  await Promise.all([batchedBreakdown({ text: 'a' }), batchedBreakdown({ text: 'b' })]);
  calls.length = 0;
  await Promise.all([batchedBreakdown({ text: 'c' }), batchedBreakdown({ text: 'd' })]);
  expect(calls.map((call) => call.path)).toEqual(['/api/breakdown', '/api/breakdown']);
});
