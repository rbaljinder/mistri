import { afterEach, expect, test, vi } from 'vitest';
import { captureAppFlagValues } from '../shared/appFlagValues.js';
import { captureExperimentExposureSender, createExperimentExposureQueue, EXPOSURE_QUEUE_LIMITS } from './experimentExposure.js';
import {
  acceptTenantRenewal,
  establishSessionIdentity,
  establishTenantSelection,
  requireTenantSelection,
  sessionIdentity,
  suspendTenantLease,
} from '../../../kit/src/client/sessionIdentity.js';

const token = (n = 0) => `ar1.${'a'.repeat(60)}${n}`;
const ack = (outcomes: string[], dropped = 0) => ({
  outcomes,
  coverage: {
    received: outcomes.length + dropped,
    ...Object.fromEntries(
      ['recorded', 'duplicate', 'failed', 'unknown'].map((status) => [status, outcomes.filter((value) => value === status).length]),
    ),
    dropped,
  },
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('visitor sender sends only receipts and opaque cookies, and retires on sign-in', async () => {
  establishSessionIdentity({ signedIn: false, appId: 'desk' });
  const sender = captureExperimentExposureSender({ appId: 'desk', current: () => true }, { visitor: true })!;
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(ack(['recorded'])), { headers: { 'x-mistri-app': 'desk' } }));
  vi.stubGlobal('fetch', fetcher);
  expect(await sender.send([token()], new AbortController().signal)).toEqual(ack(['recorded']));
  expect(fetcher.mock.calls[0][1].headers).not.toHaveProperty('x-mistri-account');
  expect(fetcher.mock.calls[0][1].credentials).toBe('same-origin');
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ receipts: [token()] });
  establishSessionIdentity({ signedIn: true, accountId: 'alice', appId: 'desk' });
  expect(sender.current()).toBe(false);
  await expect(sender.send([token()], new AbortController().signal)).rejects.toThrow();
});

test('evaluated receipt metadata is closed, bounded, detached and cannot name another flag or endpoint', () => {
  const input = { values: { copy: 'a' }, version: { global: 1, tenant: null }, assignmentReceipts: { copy: token() } };
  const captured = captureAppFlagValues(input);
  input.assignmentReceipts.copy = token(2);
  expect(captured.assignmentReceipts?.copy).toBe(token());
  expect(Object.isFrozen(captured.assignmentReceipts)).toBe(true);
  for (const assignmentReceipts of [
    { absent: token() },
    { copy: 'https://evil.test' },
    { copy: 'ar1.a' },
    { copy: `ar1.${'a'.repeat(4096)}` },
    { copy: { receipt: token(), url: 'https://evil.test' } },
    [],
    null,
  ]) {
    expect(() => captureAppFlagValues({ ...input, assignmentReceipts })).toThrow();
  }
  expect(() => captureAppFlagValues({ ...input, exposureEndpoint: 'https://evil.test' })).toThrow();
});

test('consumption is deferred, deduplicated per receipt and serialized in batches of at most sixteen', async () => {
  let release!: (value: unknown) => void;
  const send = vi
    .fn<(receipts: readonly string[], signal: AbortSignal) => Promise<unknown>>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    )
    .mockImplementation(async (receipts) => ack(receipts.map(() => 'duplicate')));
  const queue = createExperimentExposureQueue({ current: () => true, send });
  for (let i = 0; i < 34; i++) {
    queue.consume(token(i));
    queue.consume(token(i));
  }
  expect(send).not.toHaveBeenCalled();
  await Promise.resolve();
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][0]).toHaveLength(16);
  const pending = queue.flush();
  release(ack(Array(16).fill('recorded')));
  await pending;
  expect(send.mock.calls.map((call) => call[0].length)).toEqual([16, 16, 2]);
  expect(queue.coverage()).toEqual({ queued: 0, inFlight: 0, recorded: 16, duplicate: 18, failed: 0, unknown: 0, dropped: 0 });
  queue.consume(token(1));
  await queue.flush();
  expect(send).toHaveBeenCalledTimes(3);
});

test('partial/unknown/failure responses are counted honestly and later reads never retry', async () => {
  const send = vi.fn().mockResolvedValue(ack(['recorded', 'duplicate', 'failed', 'unknown'], 1));
  const queue = createExperimentExposureQueue({ current: () => true, send });
  for (let i = 0; i < 5; i++) queue.consume(token(i));
  await queue.flush();
  expect(queue.coverage()).toEqual({ queued: 0, inFlight: 0, recorded: 1, duplicate: 1, failed: 1, unknown: 1, dropped: 1 });
  for (let i = 0; i < 5; i++) queue.consume(token(i));
  await queue.flush();
  expect(send).toHaveBeenCalledTimes(1);
  for (const reply of [
    { recorded: true },
    { ...ack(['recorded']), coverage: { ...ack(['recorded']).coverage, recorded: 0 } },
    ack(['recorded', 'recorded']),
    { outcomes: ['invented'], coverage: ack(['failed']).coverage },
  ]) {
    const malformed = createExperimentExposureQueue({ current: () => true, send: async () => reply });
    malformed.consume(token());
    await malformed.flush();
    expect(malformed.coverage()).toMatchObject({ recorded: 0, unknown: 1 });
  }
  const unavailable = createExperimentExposureQueue({
    current: () => true,
    send: async () => {
      throw new Error('Lost acknowledgement.');
    },
  });
  unavailable.consume(token());
  await unavailable.flush();
  expect(unavailable.coverage().unknown).toBe(1);
});

test('bounded queue and dedupe memory drop explicitly rather than evicting and resending', async () => {
  const send = vi.fn(async (receipts: readonly string[]) => ack(receipts.map(() => 'recorded')));
  const queue = createExperimentExposureQueue({ current: () => true, send });
  for (let i = 0; i < 80; i++) queue.consume(token(i));
  expect(queue.coverage()).toMatchObject({ queued: EXPOSURE_QUEUE_LIMITS.queued, dropped: 16 });
  await queue.flush();
  for (let i = 80; i < 256; i++) {
    queue.consume(token(i));
    await queue.flush();
  }
  queue.consume(token(256));
  queue.consume(token(0));
  await queue.flush();
  expect(queue.coverage()).toMatchObject({ recorded: 240, dropped: 17, inFlight: 0, queued: 0 });
});

test('retirement aborts in-flight work, drops pending entries and ignores late success', async () => {
  let finish!: (value: unknown) => void;
  const send = vi.fn(
    (_receipts: readonly string[], _signal: AbortSignal) =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const queue = createExperimentExposureQueue({ current: () => true, send });
  for (let i = 0; i < 20; i++) queue.consume(token(i));
  const done = queue.flush();
  await Promise.resolve();
  queue.retire();
  expect(send.mock.calls[0][1].aborted).toBe(true);
  expect(queue.coverage()).toMatchObject({ unknown: 16, dropped: 4, inFlight: 0, queued: 0 });
  finish(ack(Array(16).fill('recorded')));
  await done;
  expect(queue.coverage().recorded).toBe(0);
  queue.consume(token(21));
  await queue.flush();
  expect(send).toHaveBeenCalledTimes(1);
});

test('sender uses fixed canonical endpoint and normal authenticated account/tenant ownership headers', async () => {
  establishSessionIdentity({ signedIn: true, accountId: 'alice', appId: 'desk' });
  const fetcher = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(ack(['recorded'])), {
      headers: { 'x-mistri-account': 'alice', 'x-mistri-app': 'desk' },
    }),
  );
  vi.stubGlobal('fetch', fetcher);
  const sender = captureExperimentExposureSender({ appId: 'desk', current: () => true })!;
  await sender.send([token()], new AbortController().signal);
  expect(fetcher.mock.calls[0][0]).toBe('/api/experiments/exposures?app=desk');
  expect(fetcher.mock.calls[0][1]).toMatchObject({
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'content-type': 'application/json', 'x-mistri-app': 'desk', 'x-mistri-account': 'alice' },
    body: JSON.stringify({ receipts: [token()] }),
  });
  requireTenantSelection();
  const lease = {
    appId: 'desk',
    accountId: 'alice',
    tenantId: 'north',
    tabId: 'tab-one',
    context: 'context-one',
    revision: 1,
    expiresAt: Date.now() + 60_000,
  };
  establishTenantSelection(lease);
  fetcher.mockResolvedValue(
    new Response(JSON.stringify(ack(['unknown'])), {
      status: 503,
      headers: {
        'x-mistri-account': 'alice',
        'x-mistri-app': 'desk',
        'x-mistri-tenant': 'north',
        'x-mistri-tab': 'tab-one',
        'x-mistri-context': 'context-one',
        'x-mistri-lease-revision': '1',
      },
    }),
  );
  const tenant = captureExperimentExposureSender({ appId: 'desk', current: () => true })!;
  expect(await tenant.send([token()], new AbortController().signal)).toEqual(ack(['unknown']));
  expect(fetcher.mock.calls[1][0]).toBe('/api/experiments/exposures?app=desk&tenant=north');
  expect(fetcher.mock.calls[1][1].headers).toMatchObject({
    'x-mistri-tab': 'tab-one',
    'x-mistri-context': 'context-one',
    'x-mistri-lease-revision': '1',
  });
  acceptTenantRenewal(sessionIdentity(), 1, { ...lease, revision: 2 });
  expect(tenant.current()).toBe(false);
  const renewed = captureExperimentExposureSender({ appId: 'desk', current: () => true })!;
  suspendTenantLease();
  expect(renewed.current()).toBe(false);
});

test('anonymous callers get no sender and changed response ownership never acknowledges exposure', async () => {
  establishSessionIdentity({ signedIn: false, appId: 'desk' });
  expect(captureExperimentExposureSender({ appId: 'desk', current: () => true })).toBeUndefined();
  establishSessionIdentity({ signedIn: true, accountId: 'alice', appId: 'desk' });
  const sender = captureExperimentExposureSender({ appId: 'desk', current: () => true })!;
  const fetcher = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify(ack(['recorded'])), { headers: { 'x-mistri-account': 'bob', 'x-mistri-app': 'desk' } }));
  vi.stubGlobal('fetch', fetcher);
  await expect(sender.send([token()], new AbortController().signal)).rejects.toThrow();
  establishSessionIdentity({ signedIn: true, accountId: 'bob', appId: 'desk' });
  expect(sender.current()).toBe(false);
  await expect(sender.send([token()], new AbortController().signal)).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
