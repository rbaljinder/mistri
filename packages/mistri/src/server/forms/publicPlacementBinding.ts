/** Stateless public-intake continuity. This proves no membership, row access,
 * or eligibility: the placement transaction owner must admit every execution. */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { snapshotScopedData } from '@mistriwork/engine/adapters/scoped/scopedReads.js';
import { normalizeSuitePublicOrigin } from '../http/tenantHosts.js';

const EXECUTION_MS = 2 * 60 * 60 * 1000;
const RECOVERY_MS = 24 * 60 * 60 * 1000;
const SKEW_MS = 2 * 60 * 1000;
const MAX_TOKEN = 4096;
const purpose = 'mistri.public-placement.v1';
const scopeKeys = [
  'appId',
  'form',
  'commandId',
  'commandVersion',
  'sourceIdentity',
  'tenant',
  'host',
  'origin',
  'epoch',
  'formRevision',
] as const;

interface PlacementScope {
  readonly appId: string;
  readonly form: string;
  readonly commandId: string;
  readonly commandVersion: number;
  readonly sourceIdentity: string;
  readonly tenant: string;
  readonly host: string;
  readonly origin: string;
  readonly epoch: string;
  readonly formRevision: string;
}

interface PublicPlacementBindingClaims extends PlacementScope {
  readonly version: 1;
  readonly issuerId: string;
  readonly submission: string;
  readonly issuedAt: number;
  readonly executeBefore: number;
  readonly recoverBefore: number;
}

interface KeyConfig {
  readonly id: string;
  /** Dedicated operator-managed 32-byte base64url secret. */
  readonly secret: string;
  readonly issueFrom: number;
  /** Last issuance time for a retained, decrypt-only previous key. */
  readonly issueUntil?: number;
}

interface IssuerConfig {
  readonly issuerId: string;
  readonly activeKey: string;
  readonly keys: readonly KeyConfig[];
}

export class PublicPlacementBindingError extends Error {
  constructor(readonly code: 'forbidden' | 'placement_changed' | 'placement_expired' = 'forbidden') {
    super('The public form placement could not be verified.');
    this.name = 'PublicPlacementBindingError';
  }
}
const deny = (): never => {
  throw new PublicPlacementBindingError();
};
const timestamp = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const identifier = (value: unknown, max = 256): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && value === value.trim() && !/\p{Cc}/u.test(value);

function record(input: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  let value: unknown;
  try {
    value = snapshotScopedData(input);
  } catch {
    return deny();
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return deny();
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some((key) => !keys.includes(key) && !optional.includes(key)) || keys.some((key) => !Object.hasOwn(data, key)))
    return deny();
  return data;
}

function bytes(value: unknown, length?: number): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > MAX_TOKEN) return deny();
  const result = Buffer.from(value, 'base64url');
  if (result.toString('base64url') !== value || (length !== undefined && result.length !== length)) return deny();
  return result;
}

function scope(input: unknown): Readonly<PlacementScope> {
  const data = record(input, scopeKeys);
  for (const key of scopeKeys) {
    if (key === 'commandVersion') {
      if (!timestamp(data[key]) || data[key] < 1) return deny();
    } else if (!identifier(data[key], key === 'tenant' ? 1024 : 256)) return deny();
  }
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(data.form as string)) return deny();
  try {
    const origin = normalizeSuitePublicOrigin(data.origin);
    if (origin !== data.origin || new URL(origin).hostname !== data.host) return deny();
  } catch {
    return deny();
  }
  return Object.freeze(data) as unknown as Readonly<PlacementScope>;
}

function claims(input: unknown): Readonly<PublicPlacementBindingClaims> {
  const data = record(input, [...scopeKeys, 'version', 'issuerId', 'submission', 'issuedAt', 'executeBefore', 'recoverBefore']);
  scope(Object.fromEntries(scopeKeys.map((key) => [key, data[key]])));
  if (
    data.version !== 1 ||
    !identifier(data.issuerId) ||
    bytes(data.submission, 24).length !== 24 ||
    !timestamp(data.issuedAt) ||
    !timestamp(data.executeBefore) ||
    !timestamp(data.recoverBefore) ||
    data.executeBefore !== data.issuedAt + EXECUTION_MS ||
    data.recoverBefore !== data.issuedAt + RECOVERY_MS
  )
    return deny();
  return Object.freeze(data) as unknown as Readonly<PublicPlacementBindingClaims>;
}

/** The keyring must survive process restarts. Serving never generates keys or
 * stores preparations. Retain previous keys for 24 hours plus skew after their
 * last issuance; cross-process rotation/drain belongs to the deployment owner. */
export function createPublicPlacementBindingIssuer(input: IssuerConfig, clock: () => number = Date.now) {
  const config = record(input, ['issuerId', 'activeKey', 'keys']);
  if (
    !identifier(config.issuerId) ||
    !identifier(config.activeKey, 64) ||
    !Array.isArray(config.keys) ||
    !config.keys.length ||
    config.keys.length > 2
  )
    return deny();
  const issuerId = config.issuerId;
  const keyring = new Map<string, { secret: Buffer; issueFrom: number; issueUntil?: number }>();
  for (const raw of config.keys) {
    const key = record(raw, ['id', 'secret', 'issueFrom'], ['issueUntil']);
    if (
      typeof key.id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(key.id) ||
      keyring.has(key.id) ||
      !timestamp(key.issueFrom) ||
      (key.issueUntil !== undefined && (!timestamp(key.issueUntil) || key.issueUntil < key.issueFrom)) ||
      (key.id !== config.activeKey && key.issueUntil === undefined)
    )
      return deny();
    keyring.set(key.id, {
      secret: bytes(key.secret, 32),
      issueFrom: key.issueFrom,
      ...(key.issueUntil === undefined ? {} : { issueUntil: key.issueUntil as number }),
    });
  }
  const activeId = config.activeKey,
    active = keyring.get(activeId);
  if (!active) return deny();
  const now = () => {
    const value = clock();
    if (!timestamp(value)) return deny();
    return value;
  };
  const authenticate = (binding: unknown, submission: unknown): Readonly<PublicPlacementBindingClaims> => {
    try {
      if (typeof binding !== 'string' || binding.length > MAX_TOKEN) return deny();
      const parts = binding.split('.');
      if (parts.length !== 5 || parts[0] !== 'pp1') return deny();
      const [, id, nonce, ciphertext, tag] = parts,
        key = keyring.get(id);
      if (!key) return deny();
      const decipher = createDecipheriv('aes-256-gcm', key.secret, bytes(nonce, 12));
      decipher.setAAD(Buffer.from(`${purpose}:${id}`));
      decipher.setAuthTag(bytes(tag, 16));
      const clear = Buffer.concat([decipher.update(bytes(ciphertext)), decipher.final()]);
      const value = claims(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(clear)));
      const at = now();
      if (
        value.issuerId !== issuerId ||
        value.submission !== submission ||
        value.issuedAt > at + SKEW_MS ||
        value.issuedAt < key.issueFrom ||
        (key.issueUntil !== undefined && value.issuedAt > key.issueUntil) ||
        at >= value.recoverBefore
      )
        return deny();
      return value;
    } catch {
      return deny();
    }
  };
  return Object.freeze({
    issue(inputScope: PlacementScope) {
      const captured = scope(inputScope),
        issuedAt = now();
      if (issuedAt < active.issueFrom || (active.issueUntil !== undefined && issuedAt > active.issueUntil)) return deny();
      const value = claims({
        ...captured,
        version: 1,
        issuerId,
        submission: randomBytes(24).toString('base64url'),
        issuedAt,
        executeBefore: issuedAt + EXECUTION_MS,
        recoverBefore: issuedAt + RECOVERY_MS,
      });
      const nonce = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', active.secret, nonce);
      cipher.setAAD(Buffer.from(`${purpose}:${activeId}`));
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
      const binding = [
        'pp1',
        activeId,
        nonce.toString('base64url'),
        ciphertext.toString('base64url'),
        cipher.getAuthTag().toString('base64url'),
      ].join('.');
      if (binding.length > MAX_TOKEN) return deny();
      return Object.freeze({
        version: 1 as const,
        binding,
        submission: value.submission,
        expiresAt: new Date(value.executeBefore).toISOString(),
        recoverUntil: new Date(value.recoverBefore).toISOString(),
      });
    },
    verifyExecution(binding: unknown, submission: unknown, expected: PlacementScope): Readonly<PublicPlacementBindingClaims> {
      const wanted = scope(expected),
        value = authenticate(binding, submission);
      if (value.appId !== wanted.appId || value.form !== wanted.form || value.host !== wanted.host || value.origin !== wanted.origin)
        return deny();
      if (now() >= value.executeBefore) throw new PublicPlacementBindingError('placement_expired');
      if (scopeKeys.some((key) => value[key] !== wanted[key])) throw new PublicPlacementBindingError('placement_changed');
      return value;
    },
    /** The caller must resolve this original sourceIdentity to its retained
     * receipt owner. It must never bind the returned proof to an executor. */
    verifyRecovery(
      binding: unknown,
      submission: unknown,
      expected: { readonly appId: string; readonly form: string },
    ): Readonly<PublicPlacementBindingClaims> {
      const wanted = record(expected, ['appId', 'form']),
        value = authenticate(binding, submission);
      if (wanted.appId !== value.appId || wanted.form !== value.form) return deny();
      return value;
    },
  });
}
