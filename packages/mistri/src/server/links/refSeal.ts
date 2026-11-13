/**
 * The seal on a link reference a command minted (`mistri-link:<id>.<seal>`, `mistri-public:<view>.<seal>`).
 *
 * A reference is said as a URL where it is delivered — a notice's mail, a channel's text, an effect, an answer — and the
 * text it rides in may hold what a visitor typed. Without a seal, a visitor who types `mistri-public:apply` into a
 * field that a notice quotes has it said as a live URL, and one who types `mistri-public:nope` stops the mail. The seal
 * is an HMAC over the App, the kind and the reference, keyed per App (formKey.ts sealKey): only a reference the
 * server made has one, so a look-alike stays the text it is and never refuses delivery. It is checked by the key
 * alone, so a reference kept in the receipt or the outbox is still known after a restart wherever the App has a form
 * key or an auth secret.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { sealKey } from '../forms/formKey.js';

/** A seal's spelling: 128 bits, base64url. */
export const SEAL = '[A-Za-z0-9_-]{22}';

const sealOf = (appId: string, kind: 'link' | 'public', said: string): Buffer =>
  createHmac('sha256', sealKey('mistri link ref v1', appId)).update(`${kind}|${appId}|${said}`, 'utf8').digest().subarray(0, 16);

/** The seal for a reference the App makes. */
export const refSeal = (appId: string, kind: 'link' | 'public', said: string): string => sealOf(appId, kind, said).toString('base64url');

/** Whether `seal` is the one the App made for this reference. */
export function refSealed(appId: string, kind: 'link' | 'public', said: string, seal: string): boolean {
  const given = Buffer.from(seal, 'base64url');
  const expected = sealOf(appId, kind, said);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
