/** Private encrypted cursor data, never bearer authority or query admission. */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { types } from 'node:util';
import { snapshot } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import { createApiReadBoundaryCodec } from './apiReadBoundary.js';

const PREFIX = 'twc1.',
  DOMAIN = Buffer.from('mistri:api-read-cursor:twc1');
const MAX_PLAIN = 3000,
  MAX_TOKEN = 4096;
const fail = (): never => {
  throw new Error('API read cursor is unavailable.');
};
const record = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) return fail();
  return value as Record<string, unknown>;
};
const time = (value: unknown): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000 ? value : fail();
const text = (value: unknown): string =>
  typeof value === 'string' && !!value && value === value.trim() && !/[\p{Cc}\p{Cs}]/u.test(value) && Buffer.byteLength(value) <= 256
    ? value
    : fail();
type BoundaryArgs = Parameters<typeof createApiReadBoundaryCodec>;

/** Expected bindings must be freshly computed by a trusted caller. Their
 * equality proves neither host identity, current grants nor DB collation.
 * No TTL/default representation, key persistence or live transport is chosen.
 */
export function createApiReadCursorCodec(
  secret: unknown,
  operation: BoundaryArgs[0],
  schema: BoundaryArgs[1],
  order: BoundaryArgs[2],
  options: BoundaryArgs[3],
) {
  let key: Buffer;
  try {
    if (
      types.isProxy(secret) ||
      !types.isUint8Array(secret) ||
      ![Uint8Array.prototype, Buffer.prototype].includes(Object.getPrototypeOf(secret))
    )
      return fail();
    const descriptors = Object.getOwnPropertyDescriptors(secret);
    if (Reflect.ownKeys(descriptors).length !== 32) return fail();
    key = Buffer.alloc(32);
    for (let i = 0; i < 32; i++) {
      const descriptor = descriptors[String(i)];
      if (
        !descriptor ||
        !('value' in descriptor) ||
        typeof descriptor.value !== 'number' ||
        !Number.isInteger(descriptor.value) ||
        descriptor.value < 0 ||
        descriptor.value > 255
      )
        return fail();
      key[i] = descriptor.value;
    }
  } catch {
    return fail();
  }
  const boundary = createApiReadBoundaryCodec(operation, schema, order, options);
  const operationId = operation.id,
    integers = options.integers;
  const binding = (raw: unknown) => {
    const value = record(snapshot(raw, MAX_PLAIN).value, [
      'appId',
      'apiVersion',
      'operationId',
      'scopeFingerprint',
      'queryFingerprint',
      'orderFingerprint',
      'integers',
    ]);
    if (
      typeof value.apiVersion !== 'number' ||
      !Number.isSafeInteger(value.apiVersion) ||
      value.apiVersion < 1 ||
      value.operationId !== operationId ||
      value.integers !== integers
    )
      return fail();
    return Object.freeze({
      appId: text(value.appId),
      apiVersion: value.apiVersion as number,
      operationId: text(value.operationId),
      scopeFingerprint: text(value.scopeFingerprint),
      queryFingerprint: text(value.queryFingerprint),
      orderFingerprint: text(value.orderFingerprint),
      integers,
    });
  };
  const typed = (raw: unknown) => {
    const copy = snapshot(raw, MAX_PLAIN).value;
    const encoded = boundary.encode(copy);
    if (
      !copy ||
      typeof copy !== 'object' ||
      Array.isArray(copy) ||
      Object.keys(copy).length !== Object.keys(encoded).length ||
      Object.keys(encoded).some((name) => !Object.hasOwn(copy, name))
    )
      return fail();
    return encoded;
  };
  return Object.freeze({
    stage: 'encrypted-read-cursor' as const,
    authorization: 'pending' as const,
    collationValidation: 'pending' as const,
    seal(rawBinding: unknown, rawBoundary: unknown, issuedAt: number, expiresAt: number): string {
      try {
        const issued = time(issuedAt),
          expires = time(expiresAt);
        if (expires <= issued) return fail();
        const payload = snapshot(
          { binding: binding(rawBinding), boundary: typed(rawBoundary), issuedAt: issued, expiresAt: expires },
          MAX_PLAIN,
        ).json;
        const nonce = randomBytes(12),
          cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
        cipher.setAAD(DOMAIN);
        const encrypted = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
        const token = PREFIX + Buffer.concat([nonce, encrypted, cipher.getAuthTag()]).toString('base64url');
        if (Buffer.byteLength(token) > MAX_TOKEN) return fail();
        return token;
      } catch {
        return fail();
      }
    },
    open(token: unknown, expectedBinding: unknown, now: number) {
      try {
        const expected = binding(expectedBinding),
          clock = time(now);
        if (typeof token !== 'string' || token.length > MAX_TOKEN || !token.startsWith(PREFIX)) return fail();
        const body = token.slice(PREFIX.length);
        if (!/^[A-Za-z0-9_-]+$/.test(body)) return fail();
        const bytes = Buffer.from(body, 'base64url');
        if (bytes.length <= 28 || bytes.length > MAX_PLAIN + 28 || bytes.toString('base64url') !== body) return fail();
        const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12), { authTagLength: 16 });
        decipher.setAAD(DOMAIN);
        decipher.setAuthTag(bytes.subarray(-16));
        const plain = Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]);
        const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(plain);
        const captured = snapshot(JSON.parse(decoded), MAX_PLAIN);
        if (captured.json !== decoded) return fail();
        const payload = record(captured.value, ['binding', 'boundary', 'issuedAt', 'expiresAt']);
        if (snapshot(binding(payload.binding), MAX_PLAIN).json !== snapshot(expected, MAX_PLAIN).json) return fail();
        const issuedAt = time(payload.issuedAt),
          expiresAt = time(payload.expiresAt);
        if (expiresAt <= issuedAt || clock < issuedAt || clock >= expiresAt) return fail();
        const value = typed(payload.boundary);
        if (snapshot(value, MAX_PLAIN).json !== snapshot(payload.boundary, MAX_PLAIN).json) return fail();
        return Object.freeze({ boundary: value, issuedAt, expiresAt, authorization: 'pending' as const });
      } catch {
        return fail();
      }
    },
  });
}
