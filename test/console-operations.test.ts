/** The Console's Operations and Analytics rooms: every action answers to the
 * App's own `operations` grant, one App's grant never reaches another's
 * queues, the operator is recorded, and analytics sends counts only. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { consoleHostFixture } from './fixtures/consoleHost.js';
import { consoleOperations } from './fixtures/consoleOperations.js';

async function setup(t: Parameters<typeof consoleHostFixture>[0]) {
  const operations = consoleOperations();
  t.after(() => operations.close());
  const f = await consoleHostFixture(t, false, 0, operations.build);
  f.consoleHost.start();
  f.grant('mistri-console', ['admitted']);
  return { f, state: operations.state };
}
const post = (f: Awaited<ReturnType<typeof setup>>['f'], path: string, body: unknown, account = 'alice') =>
  f.call(path, body, account, { 'x-mistri-account': account });

test('the catalog lists only the Apps and sections the account is granted, App by App', async (t) => {
  const { f } = await setup(t);
  let catalog = await f.call('/api/console/operations');
  assert.equal(catalog.response.status, 200, catalog.text);
  assert.deepEqual(catalog.json().apps, [], 'the Console grant alone opens no App');
  f.grant('depot', ['operator']);
  f.grant('ledger', ['clerk']);
  catalog = await f.call('/api/console/operations');
  assert.deepEqual(
    catalog.json().apps.map((app: { id: string; sections: string[] }) => [app.id, app.sections]),
    [['depot', ['jobs', 'deliveries', 'workflows', 'stores']]],
  );
  assert.deepEqual(catalog.json().apps[0].destinations, [{ id: 'webhook:warehouse', kind: 'webhook', name: 'warehouse' }]);
  f.grant('ledger', ['operator']);
  catalog = await f.call('/api/console/operations');
  assert.deepEqual(
    catalog.json().apps.map((app: { id: string; sections: string[] }) => [app.id, app.sections]),
    [
      ['depot', ['jobs', 'deliveries', 'workflows', 'stores']],
      ['ledger', ['jobs']],
    ],
  );
  const analytics = await f.call('/api/console/analytics');
  assert.deepEqual(analytics.json().apps, [{ id: 'depot', name: 'Depot', funnels: ['checkout'] }]);
  f.grant('mistri-console', []);
  assert.equal((await f.call('/api/console/operations')).response.status, 403, 'Console admission still gates every room');
});

test("each action needs its own App's grant and sub-scope; a grant in one App never reaches another", async (t) => {
  const { f, state } = await setup(t);
  f.grant('depot', ['operator']);
  f.grant('ledger', ['clerk']);
  // Reads and the redrive in an App where the account holds no operations grant.
  for (const path of ['/api/console/operations/ledger/jobs', `/api/console/operations/ledger/jobs/attempts?id=${state.dead.ledger}`]) {
    const read = await f.call(path);
    assert.equal(read.response.status, 403, path);
    assert.equal(read.json().code, 'not_granted');
    assert.doesNotMatch(read.text, /reconcile/);
  }
  const refused = await post(f, '/api/console/operations/ledger/jobs/redrive', { id: state.dead.ledger });
  assert.equal(refused.response.status, 403, refused.text);
  assert.equal((await state.jobs.ledger.inspect({}, 10))[0].state, 'failed', 'nothing changed');
  // Naming another App's job id under the granted App finds nothing there.
  const crossed = await post(f, '/api/console/operations/depot/jobs/redrive', { id: state.dead.ledger });
  assert.equal(crossed.response.status, 404, crossed.text);
  assert.equal((await state.jobs.ledger.inspect({}, 10))[0].state, 'failed');
  // An App the Console does not serve is told as an ungranted one.
  assert.equal((await f.call('/api/console/operations/nowhere/jobs')).json().code, 'not_granted');
  // Bob holds nothing anywhere.
  assert.equal((await f.call('/api/console/operations/depot/jobs', undefined, 'bob')).response.status, 403);
  // A sub-scope is its own: ledger's operator holds jobs, not deliveries, workflows, stores or analytics.
  f.grant('ledger', ['operator']);
  assert.equal((await f.call('/api/console/operations/ledger/jobs')).response.status, 200);
  for (const section of ['deliveries', 'workflows', 'stores']) {
    assert.equal((await f.call(`/api/console/operations/ledger/${section}`)).response.status, 403, section);
  }
  assert.equal((await f.call('/api/console/analytics/ledger')).response.status, 403);
});

test('a dead job is listed and redriven, with the account recorded as its operator', async (t) => {
  const { f, state } = await setup(t);
  f.grant('depot', ['operator']);
  const dead = await f.call('/api/console/operations/depot/jobs?state=failed');
  assert.equal(dead.response.status, 200, dead.text);
  assert.deepEqual(
    dead.json().jobs.map((job: { id: string; job: string; state: string }) => [job.id, job.job, job.state]),
    [[state.dead.depot, 'restock', 'failed']],
  );
  assert.doesNotMatch(dead.text, /fixture|service:/, 'no provenance or input leaves');
  assert.equal(
    (await f.call('/api/console/operations/depot/jobs/redrive', { id: state.dead.depot })).response.status,
    409,
    'a write without the account header is refused',
  );
  const done = await post(f, '/api/console/operations/depot/jobs/redrive', { id: state.dead.depot });
  assert.equal(done.response.status, 200, done.text);
  assert.deepEqual(done.json().job, { id: state.dead.depot, state: 'retry', redrives: 1 });
  const attempts = await f.call(`/api/console/operations/depot/jobs/attempts?id=${state.dead.depot}`);
  assert.equal(attempts.json().attempts.at(-1).operator, 'alice');
  assert.equal(attempts.json().attempts.at(-1).outcome, 'redriven');
  const again = await post(f, '/api/console/operations/depot/jobs/redrive', { id: state.dead.depot });
  assert.equal(again.response.status, 409);
  assert.equal(again.json().code, 'not_redrivable');
  for (const body of [{}, { id: state.dead.depot, extra: 1 }, { id: '../x' }, []]) {
    assert.equal((await post(f, '/api/console/operations/depot/jobs/redrive', body)).response.status, 400, JSON.stringify(body));
  }
  assert.equal((await f.call('/api/console/operations/depot/jobs?state=dead')).response.status, 400);
  assert.equal((await f.call('/api/console/operations/depot/jobs/redrive')).response.status, 405);
});

test('a revoked grant refuses the next write', async (t) => {
  const { f, state } = await setup(t);
  f.grant('depot', ['operator']);
  f.grant('depot', ['clerk']);
  const refused = await post(f, '/api/console/operations/depot/jobs/redrive', { id: state.dead.depot });
  assert.equal(refused.response.status, 403);
  assert.equal((await state.jobs.depot.inspect({}, 10))[0].state, 'failed');
});

test('deliveries and workflows redrive, cancel and retry under their own sub-scopes, recording the operator', async (t) => {
  const { f, state } = await setup(t);
  f.grant('depot', ['operator']);
  const listed = await f.call('/api/console/operations/depot/deliveries?destination=webhook:warehouse&state=failed');
  assert.equal(listed.response.status, 200, listed.text);
  assert.deepEqual(
    listed.json().deliveries.map((row: { eventId: string }) => row.eventId),
    ['evt-1'],
  );
  assert.equal((await f.call('/api/console/operations/depot/deliveries?destination=webhook:other')).response.status, 400);
  const redriven = await post(f, '/api/console/operations/depot/deliveries/redrive', { destination: 'webhook:warehouse', id: 'evt-1' });
  assert.equal(redriven.response.status, 200, redriven.text);
  assert.deepEqual(state.redriven, [{ eventId: 'evt-1', operator: 'alice' }]);
  const delivered = await post(f, '/api/console/operations/depot/deliveries/redrive', { destination: 'webhook:warehouse', id: 'evt-2' });
  assert.equal(delivered.response.status, 409);
  assert.equal(delivered.json().code, 'not_redrivable');

  const instances = await f.call('/api/console/operations/depot/workflows');
  assert.equal(instances.response.status, 200, instances.text);
  assert.equal(instances.json().instances[0].workflow, 'restock');
  const id = instances.json().instances[0].id;
  const retried = await post(f, '/api/console/operations/depot/workflows/retry', { id });
  assert.equal(retried.response.status, 200, retried.text);
  assert.equal(state.workflow.retried, `${id}:alice`);
  assert.equal((await post(f, '/api/console/operations/depot/workflows/cancel', { id })).response.status, 200);
  assert.equal(state.workflow.cancelled, `${id}:alice`);
});

test('the summary counts each granted section, and a group lists its states together', async (t) => {
  const { f } = await setup(t);
  f.grant('depot', ['operator']);
  const summary = await f.call('/api/console/operations/depot/summary');
  assert.equal(summary.response.status, 200, summary.text);
  const sections = summary.json().sections;
  assert.equal(typeof sections.jobs.dead, 'number');
  assert.equal(typeof sections.stores.total, 'number');
  const attention = await f.call('/api/console/operations/depot/jobs?group=attention');
  assert.equal(attention.response.status, 200, attention.text);
  assert.ok(
    (attention.json().jobs as { state: string }[]).every((row) => ['failed', 'unknown', 'retry'].includes(row.state)),
    attention.text,
  );
  assert.equal((await f.call('/api/console/operations/depot/jobs?group=everything')).response.status, 400);
});

test('store layouts report each database by name, never its address', async (t) => {
  const { f } = await setup(t);
  f.grant('depot', ['operator']);
  const stores = await f.call('/api/console/operations/depot/stores');
  assert.equal(stores.response.status, 200, stores.text);
  const rows = stores.json().stores as { database: string; id: string; found: number | null; pending: number[] }[];
  assert.ok(
    rows.some((row) => row.database === 'jobs' && row.id === 'jobs' && row.found === 1 && !row.pending.length),
    stores.text,
  );
  assert.ok(
    rows.some((row) => row.database === 'analytics' && row.id === 'analytics' && row.found === 1),
    stores.text,
  );
  assert.doesNotMatch(stores.text, /tw-console-host|\.db/, 'no path or URL leaves');
});

test('analytics counts events by day, funnels and breakdowns, with no unit id or field value', async (t) => {
  const { f } = await setup(t);
  f.grant('depot', ['clerk']);
  assert.equal((await f.call('/api/console/analytics/depot')).response.status, 403);
  f.grant('depot', ['operator']);
  const report = await f.call('/api/console/analytics/depot');
  assert.equal(report.response.status, 200, report.text);
  const body = report.json();
  assert.equal(body.days.length, 30);
  assert.equal(
    body.days.reduce((sum: number, day: { tracked: number; business: number }) => sum + day.tracked + day.business, 0),
    6,
  );
  assert.equal(
    body.days.reduce((sum: number, day: { business: number }) => sum + day.business, 0),
    1,
  );
  assert.deepEqual(
    body.funnels[0].result.steps.map((step: { units: number }) => step.units),
    [2, 1],
  );
  assert.deepEqual(Object.fromEntries(body.breakdowns.unit.map((row: { key: string; events: number }) => [row.key, row.events])), {
    subject: 4,
    visitor: 1,
    none: 1,
  });
  assert.equal(body.breakdowns.tenant, undefined);
  assert.deepEqual(body.names[0], { kind: 'view', name: 'items', events: 4, units: 3 });
  assert.doesNotMatch(report.text, /subject-a|subject-b|visitor-z|src-1|secret-sku/, 'no unit or source id leaves');
  // One event: the days and the totals follow it; the names and breakdowns stay the whole window's.
  const only = (await f.call('/api/console/analytics/depot?kind=view&name=items')).json();
  assert.equal(
    only.days.reduce((sum: number, day: { tracked: number; business: number }) => sum + day.tracked + day.business, 0),
    4,
  );
  assert.equal(only.units, 3);
  assert.deepEqual(only.names, body.names);
  for (const query of [
    '?from=2026-13-01',
    '?from=2020-01-01&to=2026-01-01',
    '?to=2026-01-01&from=2026-02-01',
    '?unit=x',
    '?kind=view',
    '?name=items',
  ]) {
    assert.equal((await f.call(`/api/console/analytics/depot${query}`)).response.status, 400, query);
  }
  assert.equal((await post(f, '/api/console/analytics/depot', {})).response.status, 405, 'analytics is read-only');
});
