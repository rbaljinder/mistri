/**
 * One-time codes: a status check's step-up, an applicant proving the address
 * they typed into a form, and a capability link's step-up. Six digits, from
 * the system's random source, good for ten minutes and one use. The platform
 * emails them; a step-up may name a channel an integration declares instead
 * (`stepUp: { sms: 'mobile' }`), sent under the tenant's
 * own secrets (`deliverCode`, below).
 *
 * A code is kept only as a digest beside its subject (one application, one
 * draft's address, one link), never in a log or a reply. Five wrong tries
 * burn it; a subject is sent at most three codes in an hour, whoever asks,
 * so a mailbox cannot be flooded through a form and a code cannot be ground
 * out by asking for more. Asking again replaces the code before it.
 *
 * A sent code costs whoever pays for the channel — a text to a premium number
 * is the tenant's money — so past each subject's three, a send is capped by
 * where it goes, by who asked, and on a channel by the tenant paying
 * (`deliverCode`, below).
 *
 * Kept in the shared sign-in state (auth/signInState.ts), as the status
 * check's lockouts are: a code sent by one instance is spent on the next, its
 * wrong tries count on every instance, and a right code opens once however
 * many instances it is typed at together. Without a shared cache, in this
 * process.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { resetSignInState, signInState, type SignInState } from '../auth/signInState.js';
import type { EmailTransport } from '../email/email.js';
import { integrationRuntimeOf, sendOnChannel } from '../integrations/integrationRuntime.js';

export const CODE_MINUTES = 10;
const CODE_TRIES = 5;
const CODES_PER_HOUR = 3;
const HOUR_SECONDS = 3_600;

/* The send caps, each an hour: codes to one destination however many records name it, codes one client asks for
   however many subjects it names, and texts one tenant pays for. Not settings: a person asks for a few codes an hour,
   and a tenant's real traffic is far under the hundred. */
const DEFAULT_CODE_CAPS = Object.freeze({ destination: 5, client: 20, tenant: 100 });
type CodeCaps = { readonly destination: number; readonly client: number; readonly tenant: number };
let codeCaps: CodeCaps = DEFAULT_CODE_CAPS;

/** Lower the send caps for a test that cannot send a hundred texts; called bare, the defaults again. */
export function codeCapsForTests(caps?: Partial<CodeCaps>): void {
  codeCaps = { ...DEFAULT_CODE_CAPS, ...caps };
}

interface Held {
  /** The digest, hex. */
  digest: string;
  until: number;
  /** Which code this is: tries and the one spend are counted per code, so a new code starts clean. */
  gen: string;
}

const digestOf = (subject: string, code: string) => createHash('sha256').update(`${subject}\u0000${code}`, 'utf8').digest();
/** Subjects carry a purpose and an id; the state's keys carry their digest, never the subject itself. */
const keyOf = (subject: string) => createHash('sha256').update(subject, 'utf8').digest('base64url');

/** Forget every code and every count this process holds: tests use it. */
export function resetOneTimeCodes(): void {
  resetSignInState();
}

interface OneTimeCodes {
  /**
   * A new code for `subject` (a purpose and what it opens, never an address
   * alone), or `limited` when three were sent in the last hour. `bound` is
   * what the code is for within it — the address it proves — and spending it
   * must name the same.
   */
  issue(subject: string, now?: number, bound?: string): Promise<{ code: string } | { limited: true }>;
  /** Whether `typed` is the live code for `subject`. Right, it is spent; wrong five times, it is burned. */
  spend(subject: string, typed: unknown, now?: number, bound?: string): Promise<boolean>;
}

/** Codes kept in `state`; the platform's are kept in its sign-in state. */
export function oneTimeCodes(state: SignInState = signInState): OneTimeCodes {
  return {
    async issue(subject, now = Date.now(), bound = '') {
      const key = keyOf(subject);
      if (!(await state.consume(`otp-sent:${key}`, { window: HOUR_SECONDS, max: CODES_PER_HOUR })).allowed) return { limited: true };
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      const until = now + CODE_MINUTES * 60_000;
      const held: Held = {
        digest: digestOf(`${subject}\u0000${bound}`, code).toString('hex'),
        until,
        gen: randomBytes(12).toString('base64url'),
      };
      await state.put('otp', key, held, until, now);
      return { code };
    },
    async spend(subject, typed, now = Date.now(), bound = '') {
      const key = keyOf(subject);
      const held = await state.read<Held>('otp', key);
      const shaped = typeof typed === 'string' && /^\d{6}$/.test(typed.trim());
      const digest = typeof held?.digest === 'string' && /^[0-9a-f]{64}$/.test(held.digest) ? Buffer.from(held.digest, 'hex') : undefined;
      // The same comparison whether or not a code is held.
      const matches = timingSafeEqual(
        digest ?? digestOf(subject, '\u0000none'),
        digestOf(`${subject}\u0000${bound}`, shaped ? (typed as string).trim() : '\u0000bad'),
      );
      if (!held || !digest || typeof held.gen !== 'string' || typeof held.until !== 'number') return false;
      if (held.until <= now) {
        await state.remove('otp', key);
        return false;
      }
      const tries = `otp:${key}:${held.gen}`;
      const window = Math.max(1, held.until - now);
      if (!matches || !shaped) {
        if ((await state.fail(tries, window)) >= CODE_TRIES) await state.remove('otp', key);
        return false;
      }
      // Wrong tries counted on another instance burn the code here too; and of two instances given the right code at
      // once, the one whose claim counts first opens.
      if ((await state.failures(tries)) >= CODE_TRIES) return false;
      if (!(await state.consume(`otp-spent:${key}:${held.gen}`, { window: Math.ceil(window / 1000), max: 1 })).allowed) return false;
      await state.remove('otp', key);
      return true;
    },
  };
}

const platform = oneTimeCodes();
export const issueCode = platform.issue;
export const spendCode = platform.spend;

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
/* The shape a `phone` field accepts (shared/commandInput.ts): a channel's address is a number. */
const PHONE = /^\+?[0-9 ().-]{7,32}$/;

/**
 * The address a code goes to on `channel` (email when absent), read from the record's stored value, or undefined
 * when the value is not one: an email for email, a number for any other channel.
 */
export function codeAddress(channel: string | undefined, stored: unknown): string | undefined {
  if (typeof stored !== 'string') return undefined;
  const address = stored.trim();
  if (channel === undefined) return EMAIL.test(address) ? address : undefined;
  return PHONE.test(address) && address.replace(/\D/g, '').length >= 7 ? address : undefined;
}

interface CodeDelivery {
  /** The step-up's channel; absent is email. */
  channel: string | undefined;
  /** The record's stored value; a code is never sent to an address a request names. */
  to: unknown;
  code: string;
  appName: string;
  /** What the code opens, in the words of the message ("the link you were sent from …"). */
  opens: string;
  mail: EmailTransport | undefined;
  /** The App and tenant whose integration sends a channel's code (`''` in an App without tenants). */
  appId: string | undefined;
  tenant: string;
  /** What the outcome is logged under; never the code or the address. */
  log: Readonly<Record<string, string>>;
  /** The client that asked (`clientAddress`), counted against its own cap; never logged. */
  client?: string;
}

/**
 * Whether a code may go to `address`: each cap counted in the shared sign-in state, so instances behind one balancer
 * count together. The destination is the number's digits or the email lowercased, so one number written two ways is
 * one destination; a tenant's cap counts only what its channel sends, the platform's email being nobody's bill.
 */
async function withinCodeCaps(
  channel: string | undefined,
  address: string,
  appId: string | undefined,
  tenant: string,
  client: string | undefined,
) {
  const destination = channel === undefined ? address.toLowerCase() : address.replace(/\D/g, '');
  const caps: Array<[string, number]> = [
    ...(client ? [[`otp-client:${keyOf(client)}`, codeCaps.client] as [string, number]] : []),
    [`otp-to:${keyOf(destination)}`, codeCaps.destination],
    ...(channel === undefined ? [] : [[`otp-tenant:${keyOf(`${appId ?? ''}\u0000${tenant}`)}`, codeCaps.tenant] as [string, number]]),
  ];
  for (const [key, max] of caps) if (!(await signInState.consume(key, { window: HOUR_SECONDS, max })).allowed) return false;
  return true;
}

/**
 * Sends a code and does not wait: a slow relay or provider must not tell a found record from a missing one by the
 * clock, and a send that fails, an address that is not one, a channel not set up and a send over a cap answer as a
 * sent code does: a capped asker learns nothing it could tune against. What became of it is logged, without the code,
 * the address or the client.
 */
export function deliverCode(delivery: CodeDelivery): void {
  const report = (outcome: string): void => {
    process.stderr.write(`${JSON.stringify({ ...delivery.log, outcome })}\n`);
  };
  const address = codeAddress(delivery.channel, delivery.to);
  if (!address) return report('undeliverable');
  void withinCodeCaps(delivery.channel, address, delivery.appId, delivery.tenant, delivery.client)
    .then((within) => (within ? send(delivery, address, report) : report('rate_limited')))
    .catch(() => report('send_failed'));
}

function send(
  { channel, code, appName, opens, mail, appId, tenant }: CodeDelivery,
  address: string,
  report: (outcome: string) => void,
): void {
  if (channel === undefined) {
    if (!mail) return report('undeliverable');
    void mail
      .send({
        to: address,
        subject: `${appName}: your code is ${code}`,
        text:
          `Your code is ${code}.\n\nIt opens ${opens}, once, for ${CODE_MINUTES} minutes.\n\n` +
          'If you did not ask for it, you can ignore this email: nothing opens without it.',
        sensitive: true,
      })
      .catch(() => report('send_failed'));
    return;
  }
  const runtime = appId === undefined ? undefined : integrationRuntimeOf(appId);
  if (!runtime) return report('no_runtime');
  const text = `${appName}: your code is ${code}. It opens ${opens}, once, for ${CODE_MINUTES} minutes. If you did not ask for it, ignore this message.`;
  void sendOnChannel(runtime, tenant, channel, { to: address, text })
    .then((outcome) => {
      if (outcome !== 'sent') report(outcome);
    })
    .catch(() => report('send_failed'));
}
