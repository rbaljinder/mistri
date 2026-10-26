// Explicit --jobs entry, optional: the return kiosk's signed callback. Never import this module from the App graph.
//
// A self-service drop box scans a returned item and calls `POST /api/inbound/kioskReturn`.
// The platform verifies the exact bytes and the time under the secret named here, then
// runs `returnEquipment` on the scanned loan as the `return-kiosk` principal, which holds
// the `kiosk` service role (`service: true`): that one command, no generic writes, and no
// person's role. The kiosk's own scan id is the receipt's key, so a delivery it retries
// (re-signed, with a new timestamp) replays the receipt and returns nothing twice; the
// same bytes again are a replay, refused. Set KIOSK_CALLBACK_SECRET, provision the
// integrations store, and serve with `--jobs test/fixtures/apps/loaner-desk/jobs.ts`;
// without it the App is unchanged.
import { defineInbound, defineJobs, hmac } from '@mistriwork/mistri/jobs';

/** The parts of a kiosk delivery the App acts on, or a throw for one it cannot read. Pure. */
export function kioskScan(body: unknown): { scan: string; loan: number } {
  const value = (body ?? {}) as Record<string, unknown>;
  if (typeof value.scan !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value.scan)) throw new Error('A scan needs its kiosk id.');
  if (!Number.isSafeInteger(value.loan) || (value.loan as number) < 1) throw new Error('A scan names the loan it returns.');
  return { scan: value.scan, loan: value.loan as number };
}

export default defineJobs(
  {},
  {
    principals: { 'return-kiosk': { roles: ['kiosk'] } },
    inbound: {
      kioskReturn: defineInbound({
        verify: hmac({
          secret: 'KIOSK_CALLBACK_SECRET',
          signature: { header: 'x-kiosk-signature', encoding: 'hex' },
          timestamp: { header: 'x-kiosk-timestamp', window: '5 minutes' },
          signed: '{timestamp}.{body}',
        }),
        runAs: 'return-kiosk',
        command: 'returnEquipment',
        key: (body) => kioskScan(body).scan,
        target: (body) => ({ id: kioskScan(body).loan }),
        input: () => ({}),
      }),
    },
  },
);
