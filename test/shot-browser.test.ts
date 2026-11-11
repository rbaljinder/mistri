/**
 * A grade over many routes does not keep one browser for all of them (a field report: it took an 8 GB machine's
 * browser down): the browser is started again every few routes, the old one closed first.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Browser } from 'playwright-core';
import { recycledBrowser } from '../packages/mistri/src/server/build/shotBrowser.js';

test('the same browser serves `every` routes, then a new one, started after the old was gone', async () => {
  const events: string[] = [];
  let made = 0;
  const browser = (name: string) => ({ name }) as unknown as Browser;
  const lease = recycledBrowser(
    browser('b0'),
    async () => {
      events.push(`start b${++made}`);
      return browser(`b${made}`);
    },
    3,
  );
  const names: string[] = [];
  for (let route = 0; route < 8; route++) names.push(((await lease.forRoute()) as unknown as { name: string }).name);
  assert.deepEqual(names, ['b0', 'b0', 'b0', 'b1', 'b1', 'b1', 'b2', 'b2']);
  assert.deepEqual(events, ['start b1', 'start b2']);
});

test('the browser changes only when a route asks for one', async () => {
  let starts = 0;
  const lease = recycledBrowser({} as Browser, async () => (starts++, {}) as Browser, 2);
  const first = await lease.forRoute();
  assert.equal(await lease.forRoute(), first);
  assert.notEqual(await lease.forRoute(), first);
  assert.equal(starts, 1);
});
