/**
 * A tenant server's /readyz waits for each tenant's first open to settle (tenantWarmup.ts): 503 with how far it has
 * got while any is pending, 200 once every one succeeded or failed, a failed tenant named by key and nothing else.
 */
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import { probe } from '../packages/engine/src/server/http/probes.js';
import { startTenantWarmup } from '../packages/mistri/src/server/tenant/tenantWarmup.js';

function ask(ready: Parameters<typeof probe>[3]) {
  let status = 0;
  let body = '';
  const res = {
    writeHead(code: number) {
      status = code;
      return res;
    },
    end(text?: string) {
      body = text ?? '';
    },
  } as unknown as ServerResponse;
  probe({ method: 'GET' } as IncomingMessage, res, '/readyz', ready);
  return { status, body: JSON.parse(body) };
}

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

test('/readyz is 503 with progress until every tenant has settled, then 200 and names the failed ones', async () => {
  const slow = gate();
  const lines: string[] = [];
  const started: string[] = [];
  let live = 0;
  let most = 0;
  const warmup = startTenantWarmup(
    {
      readActiveTenants: async () => ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id })),
      async readServiceAnchors(id) {
        started.push(id as string);
        live++;
        most = Math.max(most, live);
        try {
          if (id === 'b') throw new Error('postgres://secret@host refused');
          if (id === 'c') await slow.promise;
        } finally {
          live--;
        }
        return {};
      },
    },
    { concurrency: 2, log: (line) => lines.push(line) },
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  const waiting = ask(warmup.answer);
  assert.equal(waiting.status, 503);
  assert.equal(waiting.body.ready, false);
  assert.equal(waiting.body.of, 6);
  assert.ok(waiting.body.opened < 6);
  assert.equal(waiting.body.failed, undefined);
  slow.open();
  await warmup.settled;
  assert.ok(most <= 2, 'bounded concurrency');
  assert.equal(started.length, 6);
  const after = ask(warmup.answer);
  assert.equal(after.status, 200);
  assert.deepEqual(after.body.failed, ['b']);
  assert.equal(after.body.ready, undefined);
  assert.ok(lines.length === 1 && lines[0].includes('tenant b') && !lines[0].includes('secret'));
});

test('no failures: 200 without a failed list; an unlistable tenant set does not hold readiness', async () => {
  const clean = startTenantWarmup({ readActiveTenants: async () => [{ id: 'a' }], readServiceAnchors: async () => ({}) });
  await clean.settled;
  assert.equal(ask(clean.answer).status, 200);
  assert.equal(ask(clean.answer).body.failed, undefined);
  const lines: string[] = [];
  const blind = startTenantWarmup(
    {
      readActiveTenants: async () => {
        throw new Error('down');
      },
      readServiceAnchors: async () => ({}),
    },
    { log: (line) => lines.push(line) },
  );
  await blind.settled;
  assert.equal(ask(blind.answer).status, 200);
  assert.equal(lines.length, 1);
});

test('maxTenants bounds warmup work in O(1) and empty tenant lists still warm the shared pool once', async () => {
  const opened: Array<string | null> = [];
  const capped = startTenantWarmup(
    {
      readActiveTenants: async () => Array.from({ length: 50 }, (_, i) => ({ id: `t-${i}` })),
      async readServiceAnchors(id) {
        opened.push(id);
        return {};
      },
    },
    { maxTenants: 4 },
  );
  await capped.settled;
  assert.equal(opened.length, 4);
  assert.equal(ask(capped.answer).status, 200);

  const emptyOpened: Array<string | null> = [];
  const empty = startTenantWarmup({
    readActiveTenants: async () => [],
    async readServiceAnchors(id) {
      emptyOpened.push(id);
      return {};
    },
  });
  await empty.settled;
  assert.deepEqual(emptyOpened, [null]);
  assert.equal(ask(empty.answer).status, 200);
});
