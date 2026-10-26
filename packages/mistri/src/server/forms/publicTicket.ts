/**
 * A public door's ticket: what the server hands a page when it serves a public page's command (and a public form, which
 * may carry one), and what a submission through the page's door must bring back. It says which App and which door it
 * was issued for and when, signed with an HMAC, so a script that posts straight at the route — never having loaded
 * the page — has none, and one that loads the page and posts at once is too quick to be a person filling it in.
 *
 * Nothing is stored: a ticket is checked by its signature and its age alone (3 seconds to 24 hours), and a replay of
 * one is answered by the submission key's idempotency, as any retry is. The key is derived from `MISTRI_FORM_KEY`
 * where the deployment has one, so every process of a deployment checks every other's tickets; without one it is
 * this process's own, made at start, and a restart asks a page that was open to be loaded again. A start that knows it
 * is one of several processes refuses without the key, and a production start warns (`ticketKeyStart`).
 */
import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

/** Younger than this, the form was not filled by a person. */
const TICKET_MIN_AGE_MS = 3_000;
/** Older than this, the page was left open for a day: loaded again, it gets a new one. */
export const TICKET_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const PROCESS_KEY = randomBytes(32);
const derived = new Map<string, Buffer>();

function ticketKey(): Buffer {
  const secret = process.env.MISTRI_FORM_KEY;
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) return PROCESS_KEY;
  let key = derived.get(secret);
  if (!key) {
    key = Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), 'mistri.form-key', 'public-ticket.v1', 32));
    derived.clear();
    derived.set(secret, key);
  }
  return key;
}

/** Whether the deployment names the key tickets are signed with: `MISTRI_FORM_KEY`, at least 32 bytes. */
export function hasTicketKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return typeof env.MISTRI_FORM_KEY === 'string' && Buffer.byteLength(env.MISTRI_FORM_KEY, 'utf8') >= 32;
}

/**
 * What a start does about the ticket key when an App opens a public page's door: nothing with the key; refuse where
 * it knows it is one of several processes — a shared cache named, or `WEB_CONCURRENCY` above one — since each would
 * sign with its own key and refuse the others' tickets; warn in production (`NODE_ENV=production`, or a build served),
 * where a restart or a second instance soon makes the same trouble.
 */
export function ticketKeyStart(options: {
  doors: boolean;
  shared: boolean;
  production: boolean;
  env?: NodeJS.ProcessEnv;
}): { refuse: string } | { warn: string } | undefined {
  const env = options.env ?? process.env;
  if (!options.doors || hasTicketKey(env)) return undefined;
  const several = options.shared || Number(env.WEB_CONCURRENCY) > 1;
  const why =
    "a public page's door signs its tickets with MISTRI_FORM_KEY (a secret of at least 32 bytes); without it each process makes its own key";
  if (several)
    return {
      refuse: `${why}, and this deployment runs several processes${options.shared ? ' (it names a shared cache)' : ' (WEB_CONCURRENCY)'}, so each would refuse the tickets another issued. Set MISTRI_FORM_KEY in every process.`,
    };
  if (options.production)
    return { warn: `${why}, so a restart or a second instance refuses the tickets of pages already open. Set MISTRI_FORM_KEY.` };
  return undefined;
}

const sign = (body: string) => createHmac('sha256', ticketKey()).update(body).digest('base64url');

/** A ticket for one door of one App, issued now. */
export function issueTicket(appId: string, door: string, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify([1, appId, door, now, randomBytes(9).toString('base64url')])).toString('base64url');
  return `${body}.${sign(body)}`;
}

type TicketRefusal = 'missing' | 'invalid' | 'early' | 'expired';

/** Why a ticket does not admit a submission through this door, or undefined when it does. */
export function ticketRefusal(ticket: unknown, appId: string, door: string, now = Date.now()): TicketRefusal | undefined {
  if (ticket === undefined) return 'missing';
  if (typeof ticket !== 'string' || ticket.length > 512) return 'invalid';
  const [body, mac, ...rest] = ticket.split('.');
  if (!body || !mac || rest.length) return 'invalid';
  const expected = Buffer.from(sign(body));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return 'invalid';
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return 'invalid';
  }
  if (!Array.isArray(parsed) || parsed[0] !== 1 || parsed[1] !== appId || parsed[2] !== door || typeof parsed[3] !== 'number')
    return 'invalid';
  const age = now - parsed[3];
  if (age < TICKET_MIN_AGE_MS) return 'early';
  if (age > TICKET_MAX_AGE_MS) return 'expired';
  return undefined;
}

/** The sentence a refused ticket is answered with: fixed, and never which check failed beyond what a person can act on. */
export function ticketMessage(refusal: TicketRefusal): string {
  return refusal === 'early'
    ? 'That was quicker than a person fills this in. Wait a moment and send it again.'
    : 'This page has been open too long or was not loaded here. Reload it and send it again.';
}
