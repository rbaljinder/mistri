/** The stream: what it parses, when it reconnects, what stops it. */
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { state } from '../../../kit/src/client/core.js';
import { useLiveActive } from '../../../kit/src/client/liveState.js';
import {
  captureSessionIdentity,
  establishSessionIdentity,
  establishTenantSelection,
  lockSessionIdentity,
  requireTenantSelection,
} from '../../../kit/src/client/sessionIdentity.js';
import { TENANT_HTTP_HEADERS as names, type TenantContextReply } from '../shared/tenantContext.js';
import { startLiveSync, stopLiveSync } from './liveSync.js';

const invalidated = vi.hoisted(() => vi.fn());
vi.mock('./liveInvalidate.js', async (original) => ({
  ...(await original<typeof import('./liveInvalidate.js')>()),
  invalidateLive: invalidated,
}));

interface Open {
  url: string;
  headers?: Record<string, string>;
  signal?: AbortSignal | null;
  send: (text: string) => void;
  close: () => void;
  error: (reason: unknown) => void;
}
let opened: Open[] = [];
let answers: Array<() => Response> = [];

/** A stream the test writes to. */
function stream(): { response: Response; at: Open } {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => (controller = c) });
  const at = {
    send: (text: string) => controller.enqueue(encoder.encode(text)),
    close: () => controller.close(),
    error: (reason: unknown) => controller.error(reason),
  } as Open;
  return { response: new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }), at };
}
const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

beforeEach(() => {
  vi.useFakeTimers();
  invalidated.mockReset();
  opened = [];
  answers = [];
  state.activeConnection = 'spoke';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const next = answers.shift();
      const made = next ? next() : undefined;
      const response = made ?? new Response(null, { status: 404 });
      const at = (response as Response & { at?: Open }).at ?? ({ send() {}, close() {} } as unknown as Open);
      at.url = String(url);
      at.headers = { ...(init?.headers as Record<string, string> | undefined) };
      at.signal = init?.signal;
      /* A real fetch fails its body when the request is aborted. */
      init?.signal?.addEventListener('abort', () => at.error?.(init.signal?.reason), { once: true });
      opened.push(at);
      return response;
    }),
  );
});
afterEach(() => {
  stopLiveSync();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
});

function answerWithStream() {
  const { response, at } = stream();
  (response as Response & { at?: Open }).at = at;
  answers.push(() => response);
  return at;
}
const settle = () => vi.advanceTimersByTimeAsync(0);
const start = () => startLiveSync({ connection: () => 'spoke' });

test('hello then change: the change is merged for 150 ms and handed on once', async () => {
  const at = answerWithStream();
  start();
  await settle();
  expect(opened[0].url).toContain('/api/live');
  at.send(event('hello', { cursor: '1' }));
  at.send(event('change', { cursor: '2', tables: { job: { keys: [{ id: 1 }], kinds: ['update'] } } }));
  at.send(event('change', { cursor: '3', tables: { job: { keys: [{ id: 2 }], kinds: ['update'] } } }));
  await vi.advanceTimersByTimeAsync(100);
  expect(invalidated).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(100);
  expect(invalidated).toHaveBeenCalledTimes(1);
  expect(invalidated.mock.calls[0][0].events).toBe(2);
});

test('a table hello names as off is never followed, while the rest are', async () => {
  const at = answerWithStream();
  start();
  await settle();
  at.send(event('hello', { cursor: '1', off: ['audit_event'] }));
  await settle();
  expect(renderHook(() => useLiveActive('audit_event')).result.current).toBe(false);
  expect(renderHook(() => useLiveActive('job')).result.current).toBe(true);
  expect(renderHook(() => useLiveActive()).result.current).toBe(true);
});

test('a reset asks everything once', async () => {
  const at = answerWithStream();
  start();
  await settle();
  at.send(event('reset', { cursor: '9' }));
  await vi.advanceTimersByTimeAsync(200);
  expect(invalidated.mock.calls[0][0].reset).toBe(true);
});

test('a stream that ends reconnects with the cursor it reached', async () => {
  const first = answerWithStream();
  answerWithStream();
  start();
  await settle();
  first.send(event('hello', { cursor: '1' }));
  first.send(event('change', { cursor: '7', tables: { job: { keys: 'many', kinds: ['update'] } } }));
  first.send(event('end', { reason: 'lifetime' }));
  first.close();
  await vi.advanceTimersByTimeAsync(300);
  expect(opened).toHaveLength(2);
  expect(opened[1].url).toContain('after=7');
});

test('a server that answers 204 is off for the page load: nothing is asked again', async () => {
  answers.push(() => new Response(null, { status: 204 }));
  start();
  await settle();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(opened).toHaveLength(1);
});

test('a 503 waits its Retry-After before asking again', async () => {
  answers.push(() => new Response(null, { status: 503, headers: { 'retry-after': '5' } }));
  answerWithStream();
  start();
  await settle();
  await vi.advanceTimersByTimeAsync(4_000);
  expect(opened).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1_500);
  expect(opened).toHaveLength(2);
});

test('a refusal (401) waits for the session to change instead of retrying', async () => {
  answers.push(() => new Response(null, { status: 401 }));
  start();
  await settle();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(opened).toHaveLength(1);
});

test('a hidden tab lets the stream go after 30 s, and comes back from its cursor when shown', async () => {
  const first = answerWithStream();
  answerWithStream();
  start();
  await settle();
  first.send(event('hello', { cursor: '4' }));
  await vi.advanceTimersByTimeAsync(10);
  Object.defineProperty(document, 'hidden', { configurable: true, value: true });
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(29_000);
  expect(opened[0].signal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(opened[0].signal?.aborted).toBe(true);
  expect(opened).toHaveLength(1);
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(10);
  expect(opened).toHaveLength(2);
  expect(opened[1].url).toContain('after=4');
});

test('a stream that says nothing for a minute is taken as gone and opened again', async () => {
  answerWithStream();
  answerWithStream();
  start();
  await settle();
  await vi.advanceTimersByTimeAsync(61_000);
  expect(opened).toHaveLength(2);
});

test('starting again for the same App is one stream', async () => {
  answerWithStream();
  start();
  start();
  await settle();
  expect(opened).toHaveLength(1);
});

/* ---------- a tenant App: never a stream that names no tenant ---------- */

let accounts = 0;
/** Signed in on a tenant host (a fresh account each time, so each test is its own identity), with no tenant yet. */
function tenantAccount(): { accountId: string } {
  const accountId = `account-${++accounts}`;
  establishSessionIdentity({ signedIn: true, accountId, appId: 'spoke' });
  requireTenantSelection();
  return { accountId };
}
function chooseTenant(accountId: string): TenantContextReply {
  const lease: TenantContextReply = {
    appId: 'spoke',
    accountId,
    tenantId: 'north',
    tabId: 'tab-1',
    context: `context-${accounts}`,
    revision: 1,
    expiresAt: Date.now() + 5 * 60_000,
  };
  establishTenantSelection(lease);
  return lease;
}
/** A stream the tenant host answers for this lease: its owner headers say whose it is, as tenantLive.ts checks. */
function answerTenantStream(lease: TenantContextReply) {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => (controller = c) });
  const at = {
    send: (text: string) => controller.enqueue(encoder.encode(text)),
    close: () => controller.close(),
    error: (reason: unknown) => controller.error(reason),
  } as Open;
  const response = new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      [names.app]: lease.appId,
      [names.account]: lease.accountId,
      [names.tenant]: lease.tenantId,
      [names.tab]: lease.tabId,
      [names.context]: lease.context,
      [names.revision]: String(lease.revision),
    },
  });
  (response as Response & { at?: Open }).at = at;
  answers.push(() => response);
  return at;
}
/* The stream's tenant half is a part of its own (liveSync.ts open): loaded here, so the fake clock never waits on it. */
await import('./tenantLive.js');
const tenantStart = () => startLiveSync({ connection: () => 'spoke', tenant: true });
const untenanted = () => opened.filter((at) => !new URL(at.url, 'http://x').searchParams.has('tenant'));

test('a tenant page with no tenant chosen yet waits for its lease, then opens a stream that names the tenant', async () => {
  const { accountId } = tenantAccount();
  tenantStart();
  await settle();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(opened).toEqual([]);
  const lease = chooseTenant(accountId);
  const at = answerTenantStream(lease);
  await settle();
  expect(opened).toHaveLength(1);
  expect(new URL(opened[0].url, 'http://x').searchParams.get('tenant')).toBe('north');
  expect(opened[0].headers?.[names.context]).toBe(lease.context);
  at.send(event('hello', { cursor: '1' }));
  await settle();
  expect(renderHook(() => useLiveActive()).result.current).toBe(true);
});

test('a tenant page whose session locks under it never reopens as a bare /api/live', async () => {
  const { accountId } = tenantAccount();
  const lease = chooseTenant(accountId);
  answerTenantStream(lease);
  tenantStart();
  await settle();
  expect(opened).toHaveLength(1);
  /* A denied context locks the session (sessionLifecycle.ts): the stream is let go, and none is opened in its place. */
  lockSessionIdentity();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(opened[0].signal?.aborted).toBe(true);
  expect(opened).toHaveLength(1);
  expect(untenanted()).toEqual([]);
});

test('a tenant page whose identity is replaced without its tenant waits rather than asking untenanted', async () => {
  const { accountId } = tenantAccount();
  answerTenantStream(chooseTenant(accountId));
  tenantStart();
  await settle();
  /* Another account at the who-am-I check: an identity with no `tenantRequired` until a tenant is chosen again. */
  establishSessionIdentity({ signedIn: true, accountId: `${accountId}-next`, appId: 'spoke' });
  expect(captureSessionIdentity().tenantRequired).toBeUndefined();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(opened).toHaveLength(1);
  expect(untenanted()).toEqual([]);
});

test('a refused stream (400 tenant_context_unavailable) waits for a new lease and leaves the session as it was', async () => {
  const { accountId } = tenantAccount();
  chooseTenant(accountId);
  answers.push(
    () =>
      new Response(JSON.stringify({ error: 'The tenant context could not be verified.', code: 'tenant_context_unavailable' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
  );
  tenantStart();
  await settle();
  const before = captureSessionIdentity();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(opened).toHaveLength(1);
  expect(captureSessionIdentity()).toBe(before);
  expect(captureSessionIdentity().mode).toBe('authenticated');
});
