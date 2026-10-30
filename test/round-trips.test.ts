/**
 * `roundTrips(response)` (@mistriwork/mistri/testing, Preview): the database flights a response's own request made,
 * summed over the databases its Server-Timing header names, for an App's tests to hold a budget with.
 */
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';
import { createTestWorkspace, roundTrips, startTestApp } from '../packages/mistri/src/server/testing.ts';

describe('roundTrips', () => {
  const header =
    'total;dur=41.2, cpu;dur=6.1, auth;dur=3.3, db-app;dur=12.5;desc="flights=3 max=1", db-auth;dur=4;desc="flights=2 max=1", pool-app;dur=0.1;desc="n=2"';

  test('sums the flights of every database the header names', () => {
    assert.equal(roundTrips(header), 5);
    assert.equal(roundTrips(new Response('', { headers: { 'Server-Timing': header } })), 5);
  });

  test('a request that touched no database made none', () => {
    assert.equal(roundTrips('total;dur=1, cpu;dur=0.5'), 0);
  });

  test('a response without the header is refused, saying how to get it', () => {
    assert.throws(() => roundTrips(new Response('')), /needs the Server-Timing header.*MISTRI_SERVER_TIMING=1/s);
  });

  test('is read by a budget in a test', () => {
    assert.ok(roundTrips(header) <= 6);
    assert.throws(() => assert.ok(roundTrips(header) <= 3));
  });
});

describe('a test host', () => {
  const ROOT = resolve('.');
  const work = mkdtempSync(join(ROOT, 'test', '.round-trips-'));
  after(() => rmSync(work, { recursive: true, force: true }));

  test('answers with Server-Timing, and no process entry', async (t) => {
    const directory = join(work, 'tick');
    cpSync(join(ROOT, 'examples', 'apps', 'tick'), directory, { recursive: true });
    const { seed } = (await import(join(ROOT, 'examples', 'databases', 'tick', 'seed.mjs'))) as { seed(file: string): unknown };
    await seed(join(directory, 'tick.db'));
    cpSync(join(directory, 'tick.db.json'), join(directory, 'mistri.json'));
    const workspace = await createTestWorkspace();
    t.after(() => workspace.close());
    const host = await startTestApp({ workspace, directory, config: await workspace.copyConfig(join(directory, 'mistri.json')) });
    const answer = await fetch(`${host.url}/api/whoami`);
    const timing = answer.headers.get('server-timing') ?? '';
    assert.match(timing, /^total;dur=/);
    assert.doesNotMatch(timing, /proc/);
    assert.equal(typeof roundTrips(answer), 'number');
  });
});
