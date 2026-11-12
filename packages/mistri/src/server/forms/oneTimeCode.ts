/**
 * One-time codes the platform emails: a status check's step-up, an
 * applicant proving the address they typed into a form, and a capability
 * link's step-up. Six digits, from the system's random source, good for ten
 * minutes and one use.
 *
 * A code is kept only as a digest beside its subject (one application, one
 * draft's address, one link), never in a log or a reply. Five wrong tries
 * burn it; a subject is sent at most three codes in an hour, whoever asks,
 * so a mailbox cannot be flooded through a form and a code cannot be ground
 * out by asking for more. Asking again replaces the code before it.
 *
 * Kept in the shared sign-in state (auth/signInState.ts), as the status
 * check's lockouts are: a code sent by one instance is spent on the next, its
 * wrong tries count on every instance, and a right code opens once however
 * many instances it is typed at together. Without a shared cache, in this
 * process.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { resetSignInState, signInState, type SignInState } from '../auth/signInState.js';

export const CODE_MINUTES = 10;
const CODE_TRIES = 5;
const CODES_PER_HOUR = 3;
const HOUR_SECONDS = 3_600;

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
