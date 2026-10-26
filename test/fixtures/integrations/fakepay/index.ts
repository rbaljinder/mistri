/**
 * FakePay: a test integration package, written as a vendor's package would
 * be — it imports `@mistriwork/mistri/integration` and nothing of the server. Two
 * actions (charge, refund), four webhook events (paid, refunded, and an
 * SMS STOP and START, which core reads as opt-out and opt-in), and an SMS
 * channel.
 *
 * The "provider" is an object in memory a test reads and steers: what it was
 * asked, under which API key, with which idempotency key; a charge it has
 * seen under a key answers the same charge again, as a real provider's
 * dedupe does. `failNext` makes the next calls fail as a network would;
 * `decline` makes a charge a definite no (refuse).
 *
 * A webhook is signed as Stripe's are: `fakepay-signature: t=<seconds>,v1=<hex>`,
 * an HMAC-SHA256 of `<t>.<raw body>` under the tenant's `webhookSecret`.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { defineIntegration, int, refuse, shape, text } from '@mistriwork/mistri/integration';

interface Client {
  readonly apiKey: string;
}

export interface FakePayProvider {
  charges: Array<{ id: string; apiKey: string; amount: number; customer: string; idempotencyKey: string }>;
  refunds: Array<{ id: string; apiKey: string; charge: string; idempotencyKey: string }>;
  texts: Array<{ id: string; apiKey: string; to: string; text: string; idempotencyKey: string }>;
  /** How many calls are tried and fail before one succeeds. */
  failNext: number;
  /** Every charge is declined. */
  decline: boolean;
  calls: number;
}

export const provider: FakePayProvider = { charges: [], refunds: [], texts: [], failNext: 0, decline: false, calls: 0 };

export function resetProvider(): void {
  Object.assign(provider, { charges: [], refunds: [], texts: [], failNext: 0, decline: false, calls: 0 });
}

function flaky(): void {
  provider.calls++;
  if (provider.failNext > 0) {
    provider.failNext--;
    throw new Error('connection reset');
  }
}

const signature = (secret: string, at: number, body: string) => createHmac('sha256', secret).update(`${at}.${body}`).digest('hex');

/** A delivery as FakePay sends it: the body and its signature header, signed at `at` (ms). */
export function signDelivery(secret: string, event: { id: string; type: string; data: unknown }, at = Date.now()) {
  const seconds = Math.floor(at / 1000);
  const body = JSON.stringify({ ...event, created: seconds });
  return {
    body,
    headers: { 'content-type': 'application/json', 'fakepay-signature': `t=${seconds},v1=${signature(secret, seconds, body)}` },
  };
}

export const fakepay = () =>
  defineIntegration({
    name: 'fakepay',
    secrets: ['apiKey', 'webhookSecret'],
    client: ({ secrets }): Client => ({ apiKey: secrets.apiKey }),
    actions: {
      charge: {
        input: shape({ amount: int({ min: 1 }), customer: text() }),
        output: shape({ id: text(), status: text() }),
        run(client: Client, input: { amount: number; customer: string }, { idempotencyKey }) {
          flaky();
          if (provider.decline) refuse('The card was declined.');
          const seen = provider.charges.find((charge) => charge.idempotencyKey === idempotencyKey);
          if (seen) return { id: seen.id, status: 'succeeded' };
          const id = `ch_${provider.charges.length + 1}`;
          provider.charges.push({ id, apiKey: client.apiKey, amount: input.amount, customer: input.customer, idempotencyKey });
          return { id, status: 'succeeded' };
        },
      },
      refund: {
        input: shape({ charge: text() }),
        output: shape({ id: text() }),
        run(client: Client, input: { charge: string }, { idempotencyKey }) {
          flaky();
          const id = `re_${provider.refunds.length + 1}`;
          provider.refunds.push({ id, apiKey: client.apiKey, charge: input.charge, idempotencyKey });
          return { id };
        },
      },
    },
    webhooks: {
      verify({ headers, body }, { secrets }) {
        const parts = Object.fromEntries(
          String(headers['fakepay-signature'] ?? '')
            .split(',')
            .map((part) => part.split('=') as [string, string]),
        );
        const at = Number(parts.t);
        if (!Number.isInteger(at) || typeof parts.v1 !== 'string') return null;
        const expected = Buffer.from(signature(secrets.webhookSecret, at, body.toString('utf8')), 'hex');
        const given = Buffer.from(parts.v1, 'hex');
        if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
        const event = JSON.parse(body.toString('utf8')) as { id: string; type: string; data: unknown };
        return { id: event.id, type: event.type, at: at * 1000, data: event.data };
      },
      events: {
        paid: { type: 'charge.succeeded', payload: shape({ charge: text(), amount: int() }) },
        refunded: { type: 'charge.refunded', payload: shape({ charge: text() }) },
        stopped: { type: 'sms.stop', payload: shape({ from: text() }), optOut: 'from' },
        started: { type: 'sms.start', payload: shape({ from: text() }), optIn: 'from' },
      },
    },
    channel: {
      name: 'sms',
      send(client: Client, message) {
        flaky();
        const seen = provider.texts.find((sent) => sent.idempotencyKey === message.idempotencyKey);
        if (seen) return { id: seen.id };
        const id = `sms_${provider.texts.length + 1}`;
        provider.texts.push({ id, apiKey: client.apiKey, to: message.to, text: message.text, idempotencyKey: message.idempotencyKey });
        return { id };
      },
    },
  });

/* What a package does so an App's calls are typed: `integrations.fakepay.charge({ amount, customer })` answers `{ id, status }`. */
declare module '@mistriwork/mistri/integration' {
  interface IntegrationRegistry {
    fakepay: ReturnType<typeof fakepay>;
  }
}
