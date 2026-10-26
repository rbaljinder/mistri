/**
 * One-time codes the platform emails: a status check's step-up, and an
 * applicant proving the address they typed into a form. Six digits, from
 * the system's random source, good for ten minutes and one use.
 *
 * A code is kept only as a digest beside its subject (one application, one
 * draft's address), never in a log or a reply. Five wrong tries burn it; a
 * subject is sent at most three codes in an hour, whoever asks, so a
 * mailbox cannot be flooded through a form and a code cannot be ground out
 * by asking for more. Asking again replaces the code before it.
 *
 * Kept in this process, as the status check's lockouts are: a deployment of
 * several processes routes a person's requests to one of them, or they ask
 * again.
 */
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

export const CODE_MINUTES = 10;
const CODE_TRIES = 5;
const CODES_PER_HOUR = 3;
const HOUR = 3_600_000;
const MAX_TRACKED = 10_000;

interface Held {
  digest: Buffer;
  until: number;
  tries: number;
}
const codes = new Map<string, Held>();
const issued = new Map<string, number[]>();

const digestOf = (subject: string, code: string) => createHash('sha256').update(`${subject}\u0000${code}`, 'utf8').digest();

/** Forget every code and every count: tests use it. */
export function resetOneTimeCodes(): void {
  codes.clear();
  issued.clear();
}

/**
 * A new code for `subject` (a purpose and what it opens, never an address
 * alone), or `limited` when three were sent in the last hour. `bound` is
 * what the code is for within it — the address it proves — and spending it
 * must name the same.
 */
export function issueCode(subject: string, now = Date.now(), bound = ''): { code: string } | { limited: true } {
  const recent = (issued.get(subject) ?? []).filter((at) => now - at < HOUR);
  if (recent.length >= CODES_PER_HOUR) {
    issued.set(subject, recent);
    return { limited: true };
  }
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  codes.delete(subject);
  codes.set(subject, { digest: digestOf(`${subject}\u0000${bound}`, code), until: now + CODE_MINUTES * 60_000, tries: 0 });
  issued.delete(subject);
  issued.set(subject, [...recent, now]);
  while (codes.size > MAX_TRACKED) codes.delete(codes.keys().next().value!);
  while (issued.size > MAX_TRACKED) issued.delete(issued.keys().next().value!);
  return { code };
}

/** Whether `typed` is the live code for `subject`. Right, it is spent; wrong five times, it is burned. */
export function spendCode(subject: string, typed: unknown, now = Date.now(), bound = ''): boolean {
  const held = codes.get(subject);
  const shaped = typeof typed === 'string' && /^\d{6}$/.test(typed.trim());
  // The same comparison whether or not a code is held.
  const matches = timingSafeEqual(
    held?.digest ?? digestOf(subject, '\u0000none'),
    digestOf(`${subject}\u0000${bound}`, shaped ? (typed as string).trim() : '\u0000bad'),
  );
  if (!held) return false;
  if (held.until <= now) {
    codes.delete(subject);
    return false;
  }
  if (!matches || !shaped) {
    held.tries += 1;
    if (held.tries >= CODE_TRIES) codes.delete(subject);
    return false;
  }
  codes.delete(subject);
  return true;
}
