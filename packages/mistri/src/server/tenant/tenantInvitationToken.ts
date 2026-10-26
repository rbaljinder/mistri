import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { denyTenant, tenantIdentifier, tenantOptions } from '@mistriwork/engine/server/evidence.js';
import type { TenantStoreBinding } from './tenantStore.js';

const domain = 'mistri:tenant-invitation-token:twi1';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const tokenLength = 5 + 36 + 1 + 43;

function identifier(value: unknown, maximum = 256): asserts value is string {
  tenantIdentifier(value, maximum);
  if (Buffer.byteLength(value, 'utf8') > maximum || /[\uD800-\uDFFF]/u.test(value)) denyTenant();
}

function captureBinding(input: TenantStoreBinding): TenantStoreBinding {
  // Inspect only exact data descriptors before copying; caller objects stay mutable.
  const value = tenantOptions(input, ['appId', 'storeId', 'source']);
  const source = tenantOptions(value.source, ['id', 'connection']);
  identifier(value.appId);
  identifier(value.storeId);
  identifier(source.id);
  identifier(source.connection, 1024);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(source.id)) return denyTenant();
  return Object.freeze({
    appId: value.appId,
    storeId: value.storeId,
    source: Object.freeze({ id: source.id, connection: source.connection }),
  });
}

function invitationId(value: unknown): asserts value is string {
  // Invitation IDs are generated separately by node:crypto randomUUID().
  if (typeof value !== 'string' || value.length !== 36 || !uuid.test(value)) denyTenant();
}

function parseToken(token: unknown): Readonly<{ id: string; secret: string }> {
  if (typeof token !== 'string' || token.length !== tokenLength || !token.startsWith('twi1.')) return denyTenant();
  const id = token.slice(5, 41),
    secret = token.slice(42);
  invitationId(id);
  if (token[41] !== '.' || !/^[A-Za-z0-9_-]{43}$/.test(secret)) return denyTenant();
  // Node's decoder accepts padding-bit aliases; only the round-tripped form is canonical.
  const bytes = Buffer.from(secret, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== secret) return denyTenant();
  return Object.freeze({ id, secret });
}

function tokenDigest(binding: TenantStoreBinding, id: string, accountId: string, secret: string): Buffer {
  // The tuple frames each field unambiguously. Connection aliases are validated
  // above but deliberately excluded from durable namespace identity.
  return createHash('sha256')
    .update(JSON.stringify([domain, binding.appId, binding.storeId, binding.source.id, id, accountId, secret]))
    .digest();
}

/** One-time handoff only: callers persist the digest and must not log the token. */
export function mintInvitationToken(
  binding: TenantStoreBinding,
  invitationIdInput: string,
  accountId: string,
): Readonly<{ token: string; digest: string }> {
  const owner = captureBinding(binding);
  invitationId(invitationIdInput);
  identifier(accountId, 1024);
  const secret = randomBytes(32).toString('base64url');
  return Object.freeze({
    token: `twi1.${invitationIdInput}.${secret}`,
    digest: tokenDigest(owner, invitationIdInput, accountId, secret).toString('hex'),
  });
}

/** Parses only canonical syntax; this supplies no authentication or membership authority. */
export function invitationTokenId(token: unknown): string {
  return parseToken(token).id;
}

/** Invalid inputs fail closed. Only canonical SHA256 digests reach the fixed-size comparison. */
export function matchesInvitationToken(
  binding: TenantStoreBinding,
  invitationIdInput: string,
  accountId: string,
  token: unknown,
  digest: unknown,
): boolean {
  try {
    const owner = captureBinding(binding);
    invitationId(invitationIdInput);
    identifier(accountId, 1024);
    const parsed = parseToken(token);
    if (parsed.id !== invitationIdInput || typeof digest !== 'string' || digest.length !== 64 || !/^[0-9a-f]{64}$/.test(digest))
      return false;
    return timingSafeEqual(tokenDigest(owner, invitationIdInput, accountId, parsed.secret), Buffer.from(digest, 'hex'));
  } catch {
    return false;
  }
}
