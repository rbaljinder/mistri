/**
 * A page's flows section: a server without --jobs says how to get
 * one, a record nothing ran on says so, a run shows its state, what it waits
 * for and its steps, a failed one its problem, and a manual flow starts with
 * the record's own key.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';
import type { PageSection } from './pageModel.js';

const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
let reply: unknown;
let refuseStart = false;

const task: TableMeta = {
  id: 'task',
  name: 'task',
  schema: '',
  isView: false,
  indexed: ['id'],
  columns: [{ name: 'id', type: 'INTEGER', nullable: false, primaryKey: true }] as TableMeta['columns'],
};

vi.mock('../core.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core.js')>()),
  findTable: () => task,
  api: async (path: string, body: Record<string, unknown>) => {
    calls.push({ path, body });
    if (path === '/api/record-flows') return reply;
    if (path === '/api/record-flows/start') {
      if (refuseStart) throw new Error('That flow does not apply to this record.');
      return { ok: true };
    }
    throw new Error(`unexpected ${path}`);
  },
}));

const { RecordFlows } = await import('./PageFlows.js');
const { api } = await import('../core.js');
const { SectionBox } = await import('./PageSectionBox.js');

function draw() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const section: PageSection = { kind: 'flows' };
  return render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(RecordFlows, {
        base: task,
        recordKey: { id: 1 },
        api: api as never,
        loading: null,
        frame: (body, broken) => createElement(SectionBox, { section, body, foldable: false, broken }),
      }),
    ),
  );
}

const run = (extra = {}) => ({
  id: 'r1',
  flow: 'f1',
  name: 'Onboarding',
  state: 'completed',
  waitingFor: null,
  wakeAt: null,
  problem: null,
  startedAt: '2026-09-20T14:05:00.000Z',
  updatedAt: '2026-09-20T14:06:00.000Z',
  steps: [],
  ...extra,
});

beforeEach(() => {
  calls.length = 0;
  refuseStart = false;
});
afterEach(() => cleanup());

test('a server without a jobs host says how to get one', async () => {
  reply = { running: false, runs: [], manual: [] };
  draw();
  expect(await screen.findByText('Flows run when the server is started with --jobs.')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Flows' })).toBeTruthy();
  expect(calls[0]).toMatchObject({ path: '/api/record-flows', body: { table: 'task', key: { id: 1 } } });
});

test('a record no flow has run on says so', async () => {
  reply = { running: true, runs: [], manual: [] };
  draw();
  expect(await screen.findByText('No flows have run on this record.')).toBeTruthy();
});

test('a waiting run shows its state, what it waits for and its steps', async () => {
  reply = {
    running: true,
    manual: [],
    runs: [
      run({
        state: 'waiting',
        waitingFor: 'approval',
        steps: [
          { label: 'Set the owner', status: 'completed', at: '2026-09-20T14:05:10.000Z' },
          { label: 'Wait for approval', status: 'waiting', at: '2026-09-20T14:05:20.000Z' },
        ],
      }),
    ],
  };
  draw();
  expect(await screen.findByText('Onboarding')).toBeTruthy();
  expect(screen.getByText('Waiting')).toBeTruthy();
  expect(screen.getByText('Waiting for approval')).toBeTruthy();
  expect(screen.getByText('Set the owner')).toBeTruthy();
  expect(screen.getByText('done')).toBeTruthy();
});

test('a failed run says its problem', async () => {
  reply = { running: true, manual: [], runs: [run({ state: 'failed', problem: 'The email address is missing.' })] };
  draw();
  const problem = await screen.findByText('The email address is missing.');
  expect(problem).toHaveClass('flows-problem');
  expect(screen.getByText('Failed')).toBeTruthy();
});

test('a manual flow starts with the record key, then the runs are read again', async () => {
  reply = { running: true, runs: [], manual: [{ id: 'f9', name: 'Escalate' }] };
  draw();
  await userEvent.click(await screen.findByRole('button', { name: 'Start Escalate' }));
  await waitFor(() => expect(calls.some((call) => call.path === '/api/record-flows/start')).toBe(true));
  expect(calls.find((call) => call.path === '/api/record-flows/start')?.body).toEqual({ table: 'task', key: { id: 1 }, flow: 'f9' });
  await waitFor(() => expect(calls.filter((call) => call.path === '/api/record-flows')).toHaveLength(2));
});

test('a refused start says why, in place', async () => {
  reply = { running: true, runs: [], manual: [{ id: 'f9', name: 'Escalate' }] };
  refuseStart = true;
  draw();
  await userEvent.click(await screen.findByRole('button', { name: 'Start Escalate' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not start Escalate: That flow does not apply to this record.');
});
