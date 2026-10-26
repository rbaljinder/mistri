/** Synthetic credit-provider protocol for Keystone-style integration tests.
 * Clock advancement and dispatch are explicit; no detached background tasks. */
import { createHmac } from 'node:crypto';
import { defineService } from '@mistriwork/mistri/testing';

interface Check {
  applicationId: string;
  score: number;
  readyAt: number;
  delivered: boolean;
}

export function createCreditService(options: {
  callbackUrl: string | (() => string);
  secret: string;
  score?: (applicationId: string) => number;
}) {
  // A function lets a test name the callback once the App's own port is known.
  const resolveCallback = (): URL => {
    const callback = new URL(typeof options.callbackUrl === 'function' ? options.callbackUrl() : options.callbackUrl);
    if (callback.protocol !== 'http:' || callback.hostname !== '127.0.0.1' || !options.secret) {
      throw new Error('This test provider requires a loopback callback and explicit test signing secret.');
    }
    return callback;
  };
  if (typeof options.callbackUrl === 'string') resolveCallback();
  const secret = options.secret;
  return defineService({
    name: 'credit-provider',
    state: { checks: {} as Record<string, Check>, sequence: 0, attempts: 0 },
    routes: [
      {
        id: 'create',
        match: {
          method: 'POST',
          path: '/checks',
          body: {
            predicate: (body) => !!body && typeof body === 'object' && typeof (body as Record<string, unknown>).applicationId === 'string',
          },
        },
        reply: ({ state, clock, random, body }) => {
          const id = String(++state.sequence);
          state.checks[id] = {
            applicationId: (body as { applicationId: string }).applicationId,
            score: options.score ? options.score((body as { applicationId: string }).applicationId) : 300 + Math.floor(random() * 551),
            readyAt: clock.now() + 1000,
            delivered: false,
          };
          return { status: 202, body: { id, status: 'pending' } };
        },
      },
      {
        id: 'read',
        match: { method: 'GET', path: '/checks/:id' },
        reply: ({ params, state, clock }) => {
          if (!Object.hasOwn(state.checks, params.id)) return { status: 404, body: { error: 'Unknown check' } };
          const check = state.checks[params.id];
          return {
            body:
              clock.now() < check.readyAt
                ? { id: params.id, status: 'pending' }
                : { id: params.id, status: 'complete', score: check.score },
          };
        },
      },
      {
        id: 'dispatch',
        match: { method: 'POST', path: '/dispatch' },
        reply: async ({ state, clock, signal }) => {
          let delivered = 0;
          for (const [id, check] of Object.entries(state.checks)) {
            if (check.delivered || clock.now() < check.readyAt) continue;
            const body = JSON.stringify({ id, applicationId: check.applicationId, status: 'complete', score: check.score }),
              timestamp = String(clock.now());
            const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
            const response = await fetch(resolveCallback(), {
              method: 'POST',
              signal,
              headers: {
                'content-type': 'application/json',
                'x-credit-timestamp': timestamp,
                'x-credit-signature': signature,
                'x-credit-event': `credit:${id}`,
              },
              body,
            });
            await response.arrayBuffer();
            if (!response.ok) throw new Error(`Callback refused with ${response.status}.`);
            check.delivered = true;
            delivered++;
          }
          return { body: { delivered } };
        },
      },
    ],
    scenarios: {
      unavailable: [{ id: 'create', match: { method: 'POST', path: '/checks' }, reply: { status: 503 } }],
      slow: [{ id: 'create', match: { method: 'POST', path: '/checks' }, reply: { delayMs: 1000, status: 503 } }],
      disconnected: [{ id: 'create', match: { method: 'POST', path: '/checks' }, reply: { fault: 'disconnect' } }],
      retry: [
        {
          id: 'create',
          match: { method: 'POST', path: '/checks' },
          reply: ({ state, clock, random, body }) => {
            if (++state.attempts <= 2) return { status: 503 };
            const id = String(++state.sequence);
            state.checks[id] = {
              applicationId: (body as { applicationId: string }).applicationId,
              score: options.score ? options.score((body as { applicationId: string }).applicationId) : 300 + Math.floor(random() * 551),
              readyAt: clock.now() + 1000,
              delivered: false,
            };
            return { status: 202, body: { id, status: 'pending' } };
          },
        },
      ],
    },
  });
}
