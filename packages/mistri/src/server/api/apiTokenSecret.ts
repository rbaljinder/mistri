/** Private credential syntax foundation, not issuance, storage or admission.
 * Format: twa1.<lowercase UUIDv4 token ID>.<32 random bytes as base64url>.
 * Exactly 85 ASCII characters; the ID is an opaque lookup locator, not an actor.
 * Only the SHA256 digest is suitable for storage. Never log the token handoff.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const domain = 'mistri:api-token-secret:twa1';
const refuse = (): never => {
  throw new TypeError('API token credential is unavailable.');
};
export function assertApiTokenAppId(value: unknown): asserts value is string {
  // Internal namespace limit, not a normalization rule or public naming policy.
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > 256 ||
    value !== value.trim() ||
    /[\p{Cc}\p{Cs}]/u.test(value) ||
    Buffer.byteLength(value, 'utf8') > 256
  )
    refuse();
}
export function assertApiTokenSecretId(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length !== 36 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  )
    refuse();
}
export function assertApiTokenDigest(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length !== 64 || !/^[0-9a-f]{64}$/.test(value)) refuse();
}
function parse(raw: unknown): Readonly<{ tokenId: string; secret: string }> {
  if (typeof raw !== 'string' || raw.length !== 85 || !raw.startsWith('twa1.') || raw[41] !== '.') return refuse();
  const tokenId = raw.slice(5, 41),
    secret = raw.slice(42);
  assertApiTokenSecretId(tokenId);
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) return refuse();
  const bytes = Buffer.from(secret, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== secret) return refuse();
  return Object.freeze({ tokenId, secret });
}
function digest(appId: string, tokenId: string, secret: string): Buffer {
  // Tuple framing prevents concatenation ambiguity. No mutable grants or roles
  // are carried by the secret; those require a fresh independent observation.
  return createHash('sha256')
    .update(JSON.stringify([domain, appId, tokenId, secret]))
    .digest();
}

/** Token ID is generated separately with randomUUID; mint does not persist it. */
export function mintApiTokenSecret(appId: unknown, tokenId: unknown): Readonly<{ token: string; digest: string }> {
  assertApiTokenAppId(appId);
  assertApiTokenSecretId(tokenId);
  const secret = randomBytes(32).toString('base64url');
  return Object.freeze({ token: `twa1.${tokenId}.${secret}`, digest: digest(appId, tokenId, secret).toString('hex') });
}

/** Syntax only. An extracted locator confers no account or token authority. */
export function apiTokenSecretId(raw: unknown): string {
  return parse(raw).tokenId;
}

/** Malformed inputs fail closed without coercion or secret-bearing diagnostics.
 * Fixed-size timing-safe digest comparison, not an end-to-end timing promise. */
export function matchesApiTokenSecret(appId: unknown, tokenId: unknown, raw: unknown, storedDigest: unknown): boolean {
  try {
    assertApiTokenAppId(appId);
    assertApiTokenSecretId(tokenId);
    assertApiTokenDigest(storedDigest);
    const parsed = parse(raw);
    if (parsed.tokenId !== tokenId) return false;
    return timingSafeEqual(digest(appId, tokenId, parsed.secret), Buffer.from(storedDigest, 'hex'));
  } catch {
    return false;
  }
}
