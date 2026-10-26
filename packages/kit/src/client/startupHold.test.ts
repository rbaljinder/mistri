import { afterEach, beforeEach, expect, test } from 'vitest';
import { beginWork } from './pendingWork.js';
import { setStartupProbe, startupSettled } from './startupHold.js';

const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  document.documentElement.setAttribute('data-starting', '');
});
afterEach(() => {
  document.documentElement.removeAttribute('data-starting');
  setStartupProbe({ busy: () => false, watch: () => () => {} });
  document.body.replaceChildren();
});

test('the veil waits for a request still out, then for the frames that draw its answer', async () => {
  const done = beginWork();
  let settled = false;
  const waiting = startupSettled(5_000).then(() => {
    settled = true;
  });
  await later(200);
  expect(settled).toBe(false);
  done();
  await waiting;
  expect(settled).toBe(true);
});

test('a read still running holds it too, and so does a page still being drawn', async () => {
  let busy = true;
  setStartupProbe({ busy: () => busy, watch: () => () => {} });
  let settled = false;
  const waiting = startupSettled(5_000).then(() => {
    settled = true;
  });
  await later(150);
  expect(settled).toBe(false);
  busy = false;
  /* Something drawn every 20 ms keeps it from being quiet. */
  const drawing = setInterval(() => document.body.append(document.createElement('p')), 20);
  await later(200);
  expect(settled).toBe(false);
  clearInterval(drawing);
  await waiting;
  expect(settled).toBe(true);
});

test('a request that never answers costs the cap, not the page', async () => {
  const done = beginWork();
  const started = performance.now();
  await startupSettled(300);
  expect(performance.now() - started).toBeGreaterThanOrEqual(290);
  expect(performance.now() - started).toBeLessThan(2_000);
  done();
});

test('a page already shown is not held', async () => {
  document.documentElement.removeAttribute('data-starting');
  const done = beginWork();
  const started = performance.now();
  await startupSettled(5_000);
  expect(performance.now() - started).toBeLessThan(50);
  done();
});
