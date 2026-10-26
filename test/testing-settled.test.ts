/**
 * `settled(page)` (@mistriwork/mistri/testing): the one wait `mistri grade`, `mistri shot` and an App's own browser tests share.
 * Driven here over a stand-in page that emits Playwright's request events, so each rule is seen alone: a request in
 * flight holds the wait, a stream (`/api/live`, `/api/app/live`, an EventSource, a WebSocket, an event-stream answer)
 * does not, a `data:` load is not the network, and the quiet is 400 ms unless the caller says otherwise.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { settled, watchRequests, type SettledPage } from '../packages/mistri/src/server/testing/settled.js';

class FakeRequest {
  constructor(
    private readonly address: string,
    private readonly type = 'fetch',
  ) {}
  url() {
    return this.address;
  }
  resourceType() {
    return this.type;
  }
}

function fakePage() {
  const page = new EventEmitter();
  const context = new EventEmitter();
  const fire = (event: string, value: unknown) => {
    page.emit(event, value);
    context.emit(event, value);
  };
  const stand: SettledPage = Object.assign(page, {
    context: () => context as unknown as ReturnType<SettledPage['context']>,
    waitForTimeout: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    waitForLoadState: async () => {},
    evaluate: async <R>() => 0 as R,
  }) as unknown as SettledPage;
  return { page: stand, fire };
}

const timed = async (work: Promise<void>) => {
  const start = Date.now();
  await work;
  return Date.now() - start;
};

test('a quiet page settles after the quiet window and no sooner', async () => {
  const { page } = fakePage();
  const took = await timed(settled(page));
  assert.ok(took >= 380 && took < 1_500, `took ${took} ms`);
  assert.ok((await timed(settled(page, { quietMs: 100 }))) < 400);
});

test('a request in flight holds the wait until it is answered, then the quiet runs again', async () => {
  const { page, fire } = fakePage();
  watchRequests(page.context());
  const slow = new FakeRequest('http://127.0.0.1/api/app');
  fire('request', slow);
  setTimeout(() => fire('requestfinished', slow), 600);
  const took = await timed(settled(page));
  assert.ok(took >= 950, `waited for the answer and 400 ms after it: ${took} ms`);
  const failed = new FakeRequest('http://127.0.0.1/api/table/x');
  fire('request', failed);
  setTimeout(() => fire('requestfailed', failed), 300);
  assert.ok((await timed(settled(page))) >= 650, 'a failed request is answered too');
});

test('streams and memory reads are not waited for', async () => {
  const { page, fire } = fakePage();
  watchRequests(page.context());
  for (const request of [
    new FakeRequest('http://127.0.0.1/api/live'),
    new FakeRequest('http://127.0.0.1/mount/api/app/live'),
    new FakeRequest('http://127.0.0.1/api/events', 'eventsource'),
    new FakeRequest('ws://127.0.0.1/socket', 'websocket'),
    new FakeRequest('data:image/png;base64,AAAA'),
    new FakeRequest('blob:http://127.0.0.1/1234'),
  ])
    fire('request', request);
  // An answer whose headers say event-stream is answered once its headers are in.
  const stream = new FakeRequest('http://127.0.0.1/api/feed');
  fire('request', stream);
  fire('response', { request: () => stream, headers: () => ({ 'content-type': 'text/event-stream; charset=utf-8' }) });
  const took = await timed(settled(page, { timeout: 5_000 }));
  assert.ok(took < 1_500, `settled beside open streams: ${took} ms`);
});

test('a request that never ends is given up on at the deadline, and the page taken as it stands', async () => {
  const { page, fire } = fakePage();
  watchRequests(page);
  fire('request', new FakeRequest('http://127.0.0.1/api/hangs'));
  const took = await timed(settled(page, { timeout: 700 }));
  assert.ok(took >= 650 && took < 1_500, `took ${took} ms`);
});
