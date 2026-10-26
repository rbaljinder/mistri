/**
 * A signed link to one record of one tenant, for someone who has no account
 * there: the requester a desk works for, who wrote in by email.
 *
 * The token is `<payload>.<signature>`, both base64url: the payload says the
 * tenant, the record (its resource and key), when it expires and a nonce;
 * the signature is an HMAC-SHA256 of the payload under the deployment's link
 * secret (`links.secret` in the email service). A token opens nothing on
 * its own: its nonce must also be a row of the mail store that is not
 * revoked (adapters/mail/mailStore.ts), so one link can be ended without
 * ending every other. What it opens is the App's own choice — the `links`
 * command, run as its principal on that record in that tenant — so a link
 * shows what the App decided a requester may see, and no more.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** What a link names. */
interface MailLinkClaim {
  tenant: string;
  resource: string;
  key: Readonly<Record<string, string | number>>;
  /** When it stops opening, epoch milliseconds. */
  expires: number;
  nonce: string;
}

/** A record key as one canonical text: its columns in order, the form a revocation names it by. */
export function mailLinkKey(key: Readonly<Record<string, string | number>>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(key).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
}

const sign = (secret: string, payload: string) => createHmac('sha256', secret).update(`mistri.mail-link.v1\n${payload}`).digest();

/** A new link's claim and token. */
export function issueMailLink(
  secret: string,
  claim: Omit<MailLinkClaim, 'nonce' | 'key'> & { key: Readonly<Record<string, string | number>> },
): { token: string; claim: MailLinkClaim } {
  if (!secret) throw new Error('A mail link needs a secret.');
  const full: MailLinkClaim = { ...claim, key: JSON.parse(mailLinkKey(claim.key)), nonce: randomBytes(16).toString('base64url') };
  const payload = Buffer.from(
    JSON.stringify({ v: 1, t: full.tenant, r: full.resource, k: full.key, e: full.expires, n: full.nonce }),
    'utf8',
  ).toString('base64url');
  return { token: `${payload}.${sign(secret, payload).toString('base64url')}`, claim: full };
}

const plainKey = (value: unknown): value is Record<string, string | number> =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length > 0 &&
  Object.keys(value).length <= 16 &&
  Object.values(value).every((part) => (typeof part === 'string' ? part.length <= 1024 : Number.isSafeInteger(part)));

/**
 * The claim a token makes, when its signature is the secret's and it has not
 * expired; `expired` when it is genuine and past its time; undefined for
 * anything else. Whether it was revoked is the store's to say.
 */
export function readMailLink(secret: string, token: string, now: number): MailLinkClaim | 'expired' | undefined {
  if (!secret || typeof token !== 'string' || token.length > 4096) return undefined;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined || !/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(signature))
    return undefined;
  const given = Buffer.from(signature, 'base64url'),
    expected = sign(secret, payload);
  /* One spelling per signature: base64url's last character carries bits a
     decoder drops, so `…Q` and `…R` can read as the same bytes. */
  if (given.toString('base64url') !== signature) return undefined;
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (
    body?.v !== 1 ||
    typeof body.t !== 'string' ||
    typeof body.r !== 'string' ||
    !plainKey(body.k) ||
    !Number.isSafeInteger(body.e) ||
    typeof body.n !== 'string'
  )
    return undefined;
  if ((body.e as number) <= now) return 'expired';
  return { tenant: body.t, resource: body.r, key: body.k, expires: body.e as number, nonce: body.n };
}
