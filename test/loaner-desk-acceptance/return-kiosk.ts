/** A synthetic self-service return kiosk for Loaner Desk's signed callback (test/fixtures/apps/loaner-desk/jobs.ts).
 * It records scans and delivers them only when a test says so: no detached background work. */
import { createHmac } from 'node:crypto';
import { defineService } from '@mistriwork/mistri/testing';

interface Scan {
  loan: number;
  delivered: boolean;
}

/** The headers a delivery carries: the exact bytes and the time, under the shared secret. Pure. */
export function signDelivery(secret: string, timestamp: number, body: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-kiosk-timestamp': String(timestamp),
    'x-kiosk-signature': createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex'),
  };
}

export function createReturnKiosk(options: { callbackUrl: () => string; secret: string }) {
  if (!options.secret) throw new Error('The kiosk needs an explicit test signing secret.');
  const callback = (): URL => {
    const url = new URL(options.callbackUrl());
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('The kiosk only calls back to loopback.');
    return url;
  };
  // Each attempt is signed afresh with the kiosk's clock, as a real sender's retry is.
  async function deliver(id: string, scan: Scan, secret: string, now: number, signal: AbortSignal) {
    const body = JSON.stringify({ scan: id, loan: scan.loan });
    const response = await fetch(callback(), { method: 'POST', signal, headers: signDelivery(secret, now, body), body });
    await response.arrayBuffer();
    return response.status;
  }
  const dispatch = (secret: string) => ({
    id: 'dispatch',
    match: { method: 'POST', path: '/dispatch' },
    reply: async ({ state, clock, signal }: { state: { scans: Record<string, Scan> }; clock: { now(): number }; signal: AbortSignal }) => {
      const statuses: Record<string, number> = {};
      for (const [id, scan] of Object.entries(state.scans)) {
        if (scan.delivered) continue;
        statuses[id] = await deliver(id, scan, secret, clock.now(), signal);
        scan.delivered = statuses[id] >= 200 && statuses[id] < 300;
      }
      return { body: { statuses } };
    },
  });
  return defineService({
    name: 'return-kiosk',
    state: { scans: {} as Record<string, Scan>, sequence: 0 },
    routes: [
      {
        id: 'scan',
        match: { method: 'POST', path: '/scans', body: { predicate: (body) => Number.isSafeInteger((body as { loan?: unknown })?.loan) } },
        reply: ({ state, body }) => {
          const id = `scan-${++state.sequence}`;
          state.scans[id] = { loan: (body as { loan: number }).loan, delivered: false };
          return { status: 201, body: { id } };
        },
      },
      dispatch(options.secret),
      {
        id: 'redeliver',
        match: { method: 'POST', path: '/scans/:id/redeliver' },
        reply: async ({ params, state, clock, signal }) => {
          if (!Object.hasOwn(state.scans, params.id)) return { status: 404, body: { error: 'Unknown scan' } };
          return { body: { status: await deliver(params.id, state.scans[params.id], options.secret, clock.now(), signal) } };
        },
      },
    ],
    // A kiosk configured with another secret: what a forged delivery looks like to the App.
    scenarios: { 'wrong-secret': [dispatch(`${options.secret}-not-the-shared-one`)] },
  });
}
