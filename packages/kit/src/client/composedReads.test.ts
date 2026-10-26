/*
 * A record page's composed answers stand for the record only while no write
 * has been sent or answered since the compose left (composedReads.ts). A
 * compose that was out across a command, a post or a tag — seconds, for a
 * tenant on PostgreSQL — used to be kept, and the refresh the write asked for
 * was answered with the row from before it: the page went on showing the old
 * status and fields, and the next change was refused as stale.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { api } from './core.js';
import { composeRecordPage } from './recordCompose.js';
import { establishSessionIdentity } from './sessionIdentity.js';
import { configureSessionLifecycle } from './sessionLifecycle.js';
import './composedReads.js';

const APP = 'desk';
const key = { id: 7 };
/* The fields section's read of the record's own row, exactly as the compose asks it on the page's behalf. */
const rowBody = {
  count: 'none',
  view: {
    id: 'page:ticket:fields',
    name: 'ticket',
    base: 'ticket',
    columns: [{ path: 'status' }],
    filter: { groups: [[{ path: 'id', op: '=', value: 7 }]] },
    limit: 1,
  },
};
const rowReply = (status: string) => ({ view: { columns: [{ path: 'status' }] }, columns: ['status'], rows: [{ status }] });
const composed = (status: string) => ({
  planned: true,
  page: { id: 'ticket', name: 'Ticket', base: 'ticket', sections: [] },
  plans: [],
  reads: [{ path: '/api/view/run', body: rowBody, status: 200, reply: rowReply(status) }],
});
const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'x-mistri-account': 'alice' } });

/* Each request held until the test answers it, so a compose and a write can be interleaved as they are on a slow server. */
type Held = { path: string; answer: (body: unknown) => void };
let out: Held[] = [];
let stored = 'open';
const answer = async (path: string, body: unknown) => {
  const index = out.findIndex((request) => request.path === path);
  expect(index, `${path} is out`).toBeGreaterThanOrEqual(0);
  const [request] = out.splice(index, 1);
  request.answer(body);
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const rowRead = () => api('/api/view/run', { ...rowBody, app: APP } as never) as unknown as Promise<{ rows: Array<{ status: string }> }>;
const command = () =>
  api('/api/commands/execute', {
    app: APP,
    command: 'solve',
    commandVersion: 1,
    key,
    expectedVersion: 0,
    idempotencyKey: 'g117',
    input: {},
  } as never);
const asked = (path: string) => fetchStub.mock.calls.filter(([url]) => new URL(String(url), 'http://x').pathname === path).length;

const fetchStub = vi.fn((url: string) => {
  const path = new URL(url, 'http://x').pathname;
  /* The record's row read at the server is what is stored when it is read. */
  if (path === '/api/view/run') return Promise.resolve(reply(rowReply(stored)));
  return new Promise<Response>((resolve) => out.push({ path, answer: (body) => resolve(reply(body)) }));
});

beforeEach(() => {
  configureSessionLifecycle({ onLock: vi.fn() });
  establishSessionIdentity({ signedIn: true, accountId: 'alice', appId: APP });
  vi.stubGlobal('fetch', fetchStub);
  out = [];
  stored = 'open';
});
afterEach(async () => {
  /* Each test leaves with a write answered, so no compose of one is kept for the next. */
  const write = command();
  await answer('/api/commands/execute', { status: 'applied' });
  await write;
  fetchStub.mockClear();
  vi.unstubAllGlobals();
});

test("a compose with no write across it answers the record's own read, once", async () => {
  const plan = composeRecordPage(APP, 'ticket', key);
  await answer('/api/pages/compose', composed('open'));
  await plan;
  expect((await rowRead()).rows[0].status).toBe('open');
  expect(asked('/api/view/run')).toBe(0);
});

/* Every way a record page writes: a command form, a timeline post and a tag chip run a command (useCommand); a
   tag chip without commands inserts or deletes its link row; a fixed action and an inline edit update the row. */
const writes: Array<[string, string, Record<string, unknown>]> = [
  [
    'a command, a post or a command-run tag chip',
    '/api/commands/execute',
    { command: 'solve', commandVersion: 1, key, expectedVersion: 0, idempotencyKey: 'g117-a', input: {} },
  ],
  ['a tag chip added as its link row', '/api/insert', { table: 'ticket_tag', values: { ticket_id: 7, tag: 'vpn' } }],
  ['a tag chip removed as its link row', '/api/delete', { table: 'ticket_tag', key: { ticket_id: 7, tag: 'vpn' } }],
  ['a fixed action or an inline edit', '/api/update', { table: 'ticket', key, values: { status: 'solved' }, expected: { status: 'open' } }],
  [
    'the status of a command whose answer was lost',
    '/api/commands/status',
    { command: 'solve', commandVersion: 1, key, idempotencyKey: 'g117-a' },
  ],
  ['a file uploaded to the record', '/api/file/upload', { table: 'attachment', values: { ticket_id: 7 }, file: 'AAAA' }],
  ['a record flow started', '/api/record-flows/start', { flow: 'escalate', key }],
  ['an agent call', '/api/agent/call', { tool: 'assign', input: { key } }],
  ['an HTTP operation', '/api/http/operation', { operation: 'notify', key }],
];
test.each(writes)(
  'a compose begun before %s and answered after it is not kept: the refresh reads the record as stored',
  async (_, path, body) => {
    const plan = composeRecordPage(APP, 'ticket', key);
    // A path picked from the table is a string, not one of api's named routes.
    const write = (api as unknown as (path: string, body: unknown) => Promise<unknown>)(path, { app: APP, ...body });
    // The server read the row before the write landed, and the compose arrives once it has.
    await answer('/api/pages/compose', composed('open'));
    await plan;
    stored = 'solved';
    await answer(path, { status: 'applied' });
    await write;
    expect((await rowRead()).rows[0].status).toBe('solved');
    expect(asked('/api/view/run')).toBe(1);
  },
);

test('a compose begun while a command is out, answered after its answer, is not kept either', async () => {
  const write = command();
  // Asked while the command runs: on PostgreSQL its read can see the row before the command commits.
  const plan = composeRecordPage(APP, 'ticket', key);
  stored = 'solved';
  await answer('/api/commands/execute', { status: 'applied' });
  await write;
  await answer('/api/pages/compose', composed('open'));
  await plan;
  expect((await rowRead()).rows[0].status).toBe('solved');
  expect(asked('/api/view/run')).toBe(1);
});

test("a compose begun after the command's answer is the record as it now stands, and answers the read", async () => {
  const write = command();
  stored = 'solved';
  await answer('/api/commands/execute', { status: 'applied' });
  await write;
  const plan = composeRecordPage(APP, 'ticket', key);
  await answer('/api/pages/compose', composed('solved'));
  await plan;
  expect((await rowRead()).rows[0].status).toBe('solved');
  expect(asked('/api/view/run')).toBe(0);
});

test("a record's own read does not wait for a compose a write has already made the past", async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
  try {
    const plan = composeRecordPage(APP, 'ticket', key);
    const write = command();
    stored = 'solved';
    await answer('/api/commands/execute', { status: 'applied' });
    await write;
    // The old compose is still out; the read goes to the server at once rather than waiting out its five seconds.
    const read = rowRead();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(asked('/api/view/run')).toBe(1);
    expect((await read).rows[0].status).toBe('solved');
    await answer('/api/pages/compose', composed('open'));
    await plan;
  } finally {
    vi.useRealTimers();
  }
});

test('only a write is a write: a command check and an unconfirmed revert leave a held compose standing', async () => {
  const { isWritePath } = await import('./writePaths.js');
  expect(isWritePath('/api/commands/prepare')).toBe(false);
  expect(isWritePath('/api/revert', { limit: 1 })).toBe(false);
  expect(isWritePath('/api/revert', { confirm: true })).toBe(true);
  expect(isWritePath('/api/view/run')).toBe(false);
  expect(isWritePath('/api/forms/submit')).toBe(true);
});
