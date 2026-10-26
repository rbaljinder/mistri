/** Published-helper acceptance: controlled completion and authenticated callback. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { defineService, startService } from '@mistriwork/mistri/testing';
import { createCreditService } from './keystone-acceptance/credit-service.js';

test('pending credit checks complete on logical time and deliver signed, deduplicated callbacks', async () => {
  const secret = 'synthetic-test-key';
  await using receiver = await startService(
    defineService({
      name: 'callback',
      state: { events: [] as string[] },
      routes: [
        {
          id: 'callback',
          match: { method: 'POST', path: '/callback' },
          reply: ({ rawBody, headers, state, clock }) => {
            const timestamp = headers['x-credit-timestamp'],
              signature = headers['x-credit-signature'];
            if (typeof timestamp !== 'string' || typeof signature !== 'string' || !/^[0-9a-f]{64}$/.test(signature)) return { status: 401 };
            const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest();
            if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) return { status: 401 };
            if (!/^\d+$/.test(timestamp) || Math.abs(clock.now() - Number(timestamp)) > 300000) return { status: 401 };
            const payload = JSON.parse(rawBody) as { id: string; status: string; score: number };
            if (typeof payload.id !== 'string' || payload.status !== 'complete' || !Number.isInteger(payload.score)) return { status: 400 };
            // Deduplication comes from signed content, never an unsigned routing header.
            const event = `credit:${payload.id}`;
            if (!state.events.includes(event)) state.events.push(event);
            return { status: 204 };
          },
        },
      ],
    }),
  );
  await using provider = await startService(createCreditService({ callbackUrl: `${receiver.url}/callback`, secret }), { seed: 42 });
  const response = await fetch(`${provider.url}/checks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"applicationId":"loan-1"}',
  });
  assert.equal(response.status, 202);
  const { id } = await response.json();
  assert.equal((await (await fetch(`${provider.url}/checks/${id}`)).json()).status, 'pending');
  assert.deepEqual(await (await fetch(`${provider.url}/dispatch`, { method: 'POST' })).json(), { delivered: 0 });
  provider.clock.advance(1000);
  const result = await (await fetch(`${provider.url}/checks/${id}`)).json();
  assert.equal(result.status, 'complete');
  assert.ok(result.score >= 300 && result.score <= 850);
  assert.deepEqual(await (await fetch(`${provider.url}/dispatch`, { method: 'POST' })).json(), { delivered: 1 });
  assert.deepEqual(await (await fetch(`${provider.url}/dispatch`, { method: 'POST' })).json(), { delivered: 0 });
  receiver.verify({ path: '/callback' }, { times: 1 });
  assert.deepEqual(receiver.state().events, ['credit:1']);
  assert.equal(
    (
      await fetch(`${receiver.url}/callback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-credit-timestamp': '1000', 'x-credit-signature': '0'.repeat(64) },
        body: '{"id":"forged"}',
      })
    ).status,
    401,
  );
  assert.deepEqual(receiver.state().events, ['credit:1']);
});
