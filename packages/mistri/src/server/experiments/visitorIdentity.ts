/** Explicit-interaction visitor identity. Reading a cacheable page never mints
 * a cookie. This proof identifies an experiment unit, never an App principal. */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { digest, ensure, identifier, normalizeBinding, opaqueIdentifier, record, time, type ExperimentBinding } from './contracts.js';

declare const visitorProof: unique symbol;
export interface VerifiedExperimentVisitor {
  readonly [visitorProof]: true;
}
interface ExperimentVisitorIdentity {
  readonly visitorId: string;
  readonly proofId: string;
  readonly expiresAtMs: number;
}
const MAX_LIFETIME = 30 * 24 * 60 * 60 * 1000;
const PURPOSE = 'mistri.experiments.visitor.aes256gcm.v1';

export function createExperimentVisitorIdentity(options: {
  readonly binding: ExperimentBinding;
  readonly appId: string;
  readonly environment: string;
  readonly key: Uint8Array;
  readonly mount: string;
  readonly secure: boolean;
  readonly clock?: () => number;
  readonly lifetimeMs?: number;
}) {
  const binding = normalizeBinding(options.binding),
    appId = identifier(options.appId),
    environment = identifier(options.environment);
  ensure(options.key instanceof Uint8Array && options.key.byteLength === 32, 'A dedicated 32-byte experiment key is required.');
  const key = Buffer.from(options.key),
    clock = options.clock ?? Date.now,
    lifetime = options.lifetimeMs ?? MAX_LIFETIME;
  ensure(Number.isSafeInteger(lifetime) && lifetime >= 1000 && lifetime <= MAX_LIFETIME);
  const mount = options.mount;
  ensure(mount === '' || /^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(mount), 'Invalid visitor cookie mount.');
  const path = mount || '/',
    secure = options.secure;
  ensure(typeof secure === 'boolean' && typeof clock === 'function');
  const owner = JSON.stringify([PURPOSE, binding, appId, environment, path]);
  const aad = Buffer.from(owner),
    cookieName = `mistri_visitor_${digest(owner).slice(0, 20)}`;
  const issued = new WeakMap<VerifiedExperimentVisitor, ExperimentVisitorIdentity>();
  const proof = (identity: ExperimentVisitorIdentity): VerifiedExperimentVisitor => {
    const handle = Object.freeze({}) as VerifiedExperimentVisitor;
    issued.set(handle, Object.freeze({ visitorId: identity.visitorId, proofId: identity.proofId, expiresAtMs: identity.expiresAtMs }));
    return handle;
  };
  const capture = (handle: VerifiedExperimentVisitor): ExperimentVisitorIdentity => {
    const identity = issued.get(handle);
    ensure(identity && time(clock()) < identity.expiresAtMs, 'Visitor identity expired or belongs to another owner.');
    return identity;
  };
  const tokenFrom = (request: IncomingMessage) => {
    const cookies = (request.headers.cookie ?? '')
      .split(';')
      .map((value) => value.trim())
      .filter((value) => value.startsWith(`${cookieName}=`));
    if (cookies.length !== 1) return null;
    return cookies[0].slice(cookieName.length + 1);
  };
  const decode = (token: string): ExperimentVisitorIdentity => {
    ensure(token.length <= 1024 && /^vi1\.[A-Za-z0-9_-]+$/.test(token));
    const data = Buffer.from(token.slice(4), 'base64url');
    ensure(data.length > 28 && data.toString('base64url') === token.slice(4));
    const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
    decipher.setAAD(aad);
    decipher.setAuthTag(data.subarray(12, 28));
    const raw = record(JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8')), [
      'visitorId',
      'proofId',
      'issuedAtMs',
      'expiresAtMs',
    ]);
    const now = time(clock()),
      issuedAtMs = time(raw.issuedAtMs),
      expiresAtMs = time(raw.expiresAtMs);
    ensure(issuedAtMs <= now && expiresAtMs > now && expiresAtMs - issuedAtMs === lifetime);
    return Object.freeze({ visitorId: opaqueIdentifier(raw.visitorId), proofId: opaqueIdentifier(raw.proofId), expiresAtMs });
  };
  const read = (request: IncomingMessage): VerifiedExperimentVisitor | null => {
    const token = tokenFrom(request);
    if (!token) return null;
    try {
      return proof(decode(token));
    } catch {
      return null;
    }
  };
  return Object.freeze({
    cookieName,
    read,
    capture,
    /** Call only from an admitted explicit-interaction POST, never a GET or
     * ordinary feature evaluation. Existing valid identity is not rotated. */
    establish(request: IncomingMessage): { readonly proof: VerifiedExperimentVisitor; readonly setCookie: string | null } {
      const existing = read(request);
      if (existing) return Object.freeze({ proof: existing, setCookie: null });
      const issuedAtMs = time(clock()),
        expiresAtMs = time(issuedAtMs + lifetime);
      const identity = {
        visitorId: `v-${randomBytes(24).toString('base64url')}`,
        proofId: `p-${randomBytes(24).toString('base64url')}`,
        issuedAtMs,
        expiresAtMs,
      };
      const iv = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(aad);
      const encrypted = Buffer.concat([cipher.update(JSON.stringify(identity), 'utf8'), cipher.final()]);
      const token = `vi1.${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url')}`;
      return Object.freeze({
        proof: proof(identity),
        setCookie: `${cookieName}=${token}; Path=${path}; Max-Age=${Math.floor(lifetime / 1000)}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`,
      });
    },
    assertCurrent(handle: VerifiedExperimentVisitor, request: IncomingMessage): void {
      const identity = capture(handle),
        fresh = read(request);
      ensure(fresh, 'Visitor cookie changed or expired.');
      const current = capture(fresh);
      ensure(current.visitorId === identity.visitorId && current.proofId === identity.proofId, 'Visitor identity changed.');
    },
  });
}
export type ExperimentVisitorIdentityOwner = ReturnType<typeof createExperimentVisitorIdentity>;
