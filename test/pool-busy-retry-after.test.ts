/**
 * `Retry-After` on a refused checkout: a full queue clears in a moment, but a pool the database refused another
 * connection holds at what it has for POOL_LIMIT_HOLD_MS, so asking again in a second meets the same refusal.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PoolBusy, POOL_LIMIT_HOLD_MS, poolBusyRetryAfterSeconds } from '../packages/engine/src/adapters/poolMetrics.js';
import { sendBusy } from '../packages/engine/src/server/http/reply.js';

function reply() {
  const headers: Record<string, string> = {};
  let status = 0;
  const res = {
    headersSent: false,
    setHeader: (name: string, value: string) => void (headers[name] = value),
    writeHead(code: number, more?: Record<string, string>) {
      status = code;
      Object.assign(headers, more);
      return res;
    },
    end() {},
  };
  return { res, headers, status: () => status };
}

test('a full queue says one second; a connection limit says how long the pool holds', () => {
  assert.equal(poolBusyRetryAfterSeconds(new PoolBusy('read', 'queue_full')), 1);
  assert.equal(poolBusyRetryAfterSeconds(new PoolBusy('write', 'queue_timeout')), 1);
  assert.equal(poolBusyRetryAfterSeconds(new PoolBusy('read', 'connection_limit')), POOL_LIMIT_HOLD_MS / 1000);
  assert.equal(poolBusyRetryAfterSeconds(new Error('wrapped', { cause: new PoolBusy('write', 'connection_limit') })), 30);
  assert.equal(poolBusyRetryAfterSeconds(undefined), 1);
});

test('sendBusy puts that number in the Retry-After header', () => {
  for (const [why, seconds] of [
    ['queue_full', '1'],
    ['connection_limit', '30'],
  ] as const) {
    const out = reply();
    sendBusy(out.res as never, {}, false, new PoolBusy('read', why));
    assert.equal(out.status(), 503);
    assert.equal(out.headers['retry-after'], seconds, why);
  }
  const bare = reply();
  sendBusy(bare.res as never);
  assert.equal(bare.headers['retry-after'], '1');
});

test('the tenant path says the same: a connection limit holds 30 s, anything else 1', async () => {
  const { send } = await import('../packages/mistri/src/server/tenant/tenantHttp.js');
  const said = (status: number, cause?: unknown) => {
    const out = reply();
    const res = Object.assign(out.res, { destroyed: false, writableEnded: false });
    send({ method: 'POST' } as never, res as never, status, { error: 'x' }, {}, cause);
    return out.headers['retry-after'];
  };
  assert.equal(said(503, new PoolBusy('read', 'connection_limit')), '30');
  assert.equal(said(503, new Error('wrapped', { cause: new PoolBusy('write', 'connection_limit') })), '30');
  assert.equal(said(503, new PoolBusy('read', 'queue_full')), '1');
  assert.equal(said(503), '1');
  assert.equal(said(403, new PoolBusy('read', 'connection_limit')), undefined, 'only a 503 asks to be retried');
});
