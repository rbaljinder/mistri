/**
 * The receipt a public form answers with: opaque and random, never a key or a
 * counter. A reference an applicant quotes is the one thing about their
 * application they hold, so it must not say how many came before it or be
 * guessable from a neighbour's — the difference between a receipt and an
 * enumeration oracle once anything, such as a status check, reads by it.
 *
 * Sixty random bits in Crockford's base 32 (no I, L, O or U to misread),
 * grouped in fours after the App's prefix: `IGN-7K2M-QX4T-9BRD`. At a million
 * applications a guess finds one about once in a million million tries, which
 * the status check's rate limits and lockout make out of reach.
 */
import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PREFIX = /^[A-Z][A-Z0-9]{0,7}$/;

const checkPrefix = (prefix: string) => {
  if (typeof prefix !== 'string' || !PREFIX.test(prefix))
    throw new TypeError("A public reference's prefix is 1 to 8 capital letters and digits, starting with a letter.");
};

/** A fresh receipt: `PREFIX-XXXX-XXXX-XXXX`, sixty random bits. */
export function publicReference(prefix: string): string {
  checkPrefix(prefix);
  const bytes = randomBytes(8);
  let bits = 0n;
  for (const byte of bytes) bits = (bits << 8n) | BigInt(byte);
  let out = '';
  for (let index = 0; index < 12; index++) {
    out += ALPHABET[Number(bits & 31n)];
    bits >>= 5n;
  }
  return `${prefix}-${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8)}`;
}

/** The pattern a receipt of this prefix matches, for the output shape: `text({ pattern: publicReferencePattern('IGN') })`. */
export function publicReferencePattern(prefix: string): RegExp {
  checkPrefix(prefix);
  const group = '[0-9A-HJKMNP-TV-Z]{4}';
  return new RegExp(`^${prefix}-${group}-${group}-${group}$`);
}
