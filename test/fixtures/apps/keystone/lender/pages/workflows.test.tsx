/**
 * The workflows page over a stand-in for the host's operator routes: the
 * instances with their state, version, key, current step and next wake-up;
 * one chosen, its step history; Cancel asked twice and Retry on a failed
 * instance; and a role without the grant told so.
 */
import '@testing-library/jest-dom/vitest';
import { afterAll, afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, within } from '@testing-library/react';
import { renderPage } from '@mistriwork/mistri/ui/testing';
import page, { operationsBase } from './workflows.page.tsx';

const viewer = { signedIn: true, account: 'staff-1' };
const IDS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
/* The page says "in 3 days" by calendar day, so a fixture three 24-hour days
   out reads "in 4 days" late in the evening. Only the clock is pinned (timers
   stay real, the queries wait on them), at midday, and the dates are built
   from it. */
vi.useFakeTimers({ toFake: ['Date'] });
vi.setSystemTime(new Date(2026, 9, 2, 12, 0, 0));
afterAll(() => {
  vi.useRealTimers();
});
const later = new Date(Date.now() + 3 * 86_400_000).toISOString();
const instance = (n: number, over: Record<string, unknown> = {}) => ({
  id: IDS[n],
  workflow: 'creditDecision',
  version: 1,
  key: `APP-${n + 1}`,
  state: 'waiting',
  currentStep: 'credit-result',
  waitEvent: 'creditReported@1',
  wakeAt: later,
  problem: null,
  problemStep: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...over,
});
const steps = [
  { name: 'request-check', ordinal: 1, kind: 'call', status: 'completed', attempts: 1, wakeAt: null, errorCode: null },
  { name: 'credit-result', ordinal: 2, kind: 'waitFor', status: 'pending', attempts: 0, wakeAt: later, errorCode: null },
];

let instances: unknown[];
let calls: Array<{ path: string; method: string; body?: unknown }>;
let refuse: number | undefined;
beforeEach(() => {
  instances = [instance(0), instance(1, { state: 'failed', currentStep: 'refer', wakeAt: null, problem: 'refused', problemStep: 'refer' })];
  calls = [];
  refuse = undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.replace('/api/operations/workflows', '') || '/';
      calls.push({ path, method: init?.method ?? 'GET', ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (refuse) return new Response(JSON.stringify({ ok: false }), { status: refuse });
      const json = (value: unknown) => new Response(JSON.stringify({ ok: true, ...(value as object) }), { status: 200 });
      if (path.startsWith('/steps')) return json({ steps });
      if (path === '/cancel') return json({ outcome: 'cancelled', state: 'cancelled' });
      if (path === '/retry') return json({ instance: instance(1, { state: 'running' }) });
      return json({ instances });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('lists each instance with its state, version, key, current step and next wake-up', async () => {
  const view = renderPage(page, { viewer });
  const table = await view.findByRole('table', { name: 'Workflow instances' });
  const rows = within(table).getAllByRole('row').slice(1);
  expect(rows).toHaveLength(2);
  expect(within(rows[0]).getByText('APP-1')).toBeInTheDocument();
  expect(within(rows[0]).getByText('Waiting')).toBeInTheDocument();
  expect(within(rows[0]).getByText('v1')).toBeInTheDocument();
  expect(within(rows[0]).getByText('credit-result')).toBeInTheDocument();
  expect(within(rows[0]).getByText(/in 3 days/)).toBeInTheDocument();
  expect(within(rows[1]).getByText('Failed')).toBeInTheDocument();
});

test('a chosen instance shows its step history', async () => {
  const view = renderPage(page, { viewer });
  fireEvent.click((await view.findAllByRole('button', { name: 'creditDecision' }))[0]);
  const history = await view.findByRole('table', { name: 'Steps of this instance' });
  expect(within(history).getByText('request-check')).toBeInTheDocument();
  expect(within(history).getByText('waitFor')).toBeInTheDocument();
  expect(calls.some((call) => call.path === `/steps?id=${IDS[0]}`)).toBe(true);
  expect(view.queryByRole('button', { name: 'Retry' })).toBeNull();
});

test('Cancel asks once more, then cancels the instance', async () => {
  const view = renderPage(page, { viewer });
  fireEvent.click((await view.findAllByRole('button', { name: 'creditDecision' }))[0]);
  fireEvent.click(await view.findByRole('button', { name: 'Cancel' }));
  expect(calls.some((call) => call.path === '/cancel')).toBe(false);
  fireEvent.click(view.getByRole('button', { name: 'Yes, cancel it' }));
  expect(await view.findByText('Cancelled. The instance will not run again.')).toBeInTheDocument();
  expect(calls.find((call) => call.path === '/cancel')).toEqual({ path: '/cancel', method: 'POST', body: { id: IDS[0] } });
});

test('Retry is offered on a failed instance alone', async () => {
  const view = renderPage(page, { viewer });
  fireEvent.click((await view.findAllByRole('button', { name: 'creditDecision' }))[1]);
  fireEvent.click(await view.findByRole('button', { name: 'Retry' }));
  expect(await view.findByText('Retrying from its last good step.')).toBeInTheDocument();
  expect(calls.find((call) => call.path === '/retry')?.body).toEqual({ id: IDS[1] });
  expect(view.queryByRole('button', { name: 'Cancel' })).toBeNull();
});

test('a role without the grant is told so', async () => {
  refuse = 403;
  const view = renderPage(page, { viewer });
  expect(await view.findByRole('alert')).toHaveTextContent('Your role is not granted the workflows operation.');
});

test('asks the server the page is served from', () => {
  expect(operationsBase()).toBe('/api/operations/workflows');
  const meta = globalThis.document.createElement('meta');
  meta.name = 'mistri-mount';
  meta.content = JSON.stringify({ base: '/lender', apps: {} });
  globalThis.document.head.append(meta);
  expect(operationsBase()).toBe('/lender/api/operations/workflows');
  meta.remove();
});
