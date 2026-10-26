/** Private logical storage/CAS only. No provisioning, credentials or admission. */
import { snapshot } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import { captureApiTokenRecord, type TokenRecord } from './apiTokenScope.js';
import { assertApiTokenDigest, assertApiTokenSecretId } from './apiTokenSecret.js';

const refuse = (): never => {
  throw new TypeError('API token storage is unavailable.');
};
function exact(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return refuse();
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) return refuse();
  return value;
}
function revision(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length > 128 || !/^[1-9]/.test(value) || /[^0-9]/.test(value)) refuse();
}
function safely<T>(work: () => T): T {
  try {
    return work();
  } catch {
    return refuse();
  }
}

export function captureStoredApiToken(raw: unknown) {
  return safely(() => {
    const value = exact(snapshot(raw, 1_048_576).value, ['record', 'format', 'digest', 'version']);
    if (value.format !== 'twa1') return refuse();
    assertApiTokenDigest(value.digest);
    revision(value.version);
    const record: Readonly<TokenRecord> = captureApiTokenRecord(value.record);
    assertApiTokenSecretId(record.id);
    return Object.freeze({ record, format: 'twa1' as const, digest: value.digest, version: value.version });
  });
}

export const apiTokenSqlColumns = Object.freeze([
  'token_id',
  'app_id',
  'subject_kind',
  'subject_id',
  'label',
  'roles_json',
  'operations_json',
  'created_at',
  'created_by',
  'expires_at',
  'revoked_at',
  'revoked_by',
  'last_used_at',
  'format',
  'digest',
  'version',
  'tenant_id',
  'membership_id',
  'membership_version',
] as const);

/** SQL NULL is absence, not JSON null or []. Drivers must supply exact numeric
 * instants; this codec never coerces strings, Date instances or unsafe numbers. */
export function encodeApiTokenSqlRow(raw: unknown) {
  const token = captureStoredApiToken(raw),
    row = token.record;
  return Object.freeze({
    token_id: row.id,
    app_id: row.appId,
    subject_kind: row.subject.kind,
    subject_id: row.subject.id,
    label: row.label,
    roles_json: JSON.stringify(row.roles),
    operations_json: row.operations === undefined ? null : JSON.stringify(row.operations),
    created_at: row.createdAt,
    created_by: row.createdBy,
    expires_at: row.expiresAt,
    revoked_at: row.revokedAt ?? null,
    revoked_by: row.revokedBy ?? null,
    last_used_at: row.lastUsedAt ?? null,
    format: token.format,
    digest: token.digest,
    version: token.version,
    tenant_id: row.tenant?.tenantId ?? null,
    membership_id: row.tenant?.membershipId ?? null,
    membership_version: row.tenant?.membershipVersion ?? null,
  });
}

export function decodeApiTokenSqlRow(raw: unknown) {
  return safely(() => {
    const row = exact(snapshot(raw, 1_048_576).value, apiTokenSqlColumns);
    if (typeof row.roles_json !== 'string' || (row.operations_json !== null && typeof row.operations_json !== 'string')) return refuse();
    const roles: unknown = JSON.parse(row.roles_json);
    const operations: unknown = row.operations_json === null ? undefined : JSON.parse(row.operations_json as string);
    // All three or none: a partial binding is not a weaker one, it is corrupt.
    const bound = [row.tenant_id, row.membership_id, row.membership_version];
    if (bound.some((value) => value !== null) && bound.some((value) => typeof value !== 'string')) return refuse();
    const token = captureStoredApiToken({
      format: row.format,
      digest: row.digest,
      version: row.version,
      record: {
        id: row.token_id,
        appId: row.app_id,
        subject: { kind: row.subject_kind, id: row.subject_id },
        label: row.label,
        roles,
        ...(row.operations_json === null ? {} : { operations }),
        createdAt: row.created_at,
        createdBy: row.created_by,
        expiresAt: row.expires_at,
        ...(row.tenant_id === null
          ? {}
          : { tenant: { tenantId: row.tenant_id, membershipId: row.membership_id, membershipVersion: row.membership_version } }),
        ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
        ...(row.revoked_by === null ? {} : { revokedBy: row.revoked_by }),
        ...(row.last_used_at === null ? {} : { lastUsedAt: row.last_used_at }),
      },
    });
    // Canonical strings are an exact roundtrip, not lossy parse-and-normalize.
    if (
      JSON.stringify(token.record.roles) !== row.roles_json ||
      (token.record.operations === undefined ? null : JSON.stringify(token.record.operations)) !== row.operations_json
    )
      return refuse();
    return token;
  });
}

/** A plan is data, not a write or authorization. Store must atomically match
 * every where field (including still-unrevoked), then require one changed row. */
export function planApiTokenRevocation(current: unknown, input: unknown) {
  return safely(() => {
    const token = captureStoredApiToken(current);
    const request = exact(snapshot(input, 16384).value, ['tokenId', 'appId', 'expectedVersion', 'revokedAt', 'revokedBy']);
    assertApiTokenSecretId(request.tokenId);
    revision(request.expectedVersion);
    if (
      request.tokenId !== token.record.id ||
      request.appId !== token.record.appId ||
      request.expectedVersion !== token.version ||
      token.record.revokedAt !== undefined
    )
      return refuse();
    const next = captureStoredApiToken({
      ...token,
      version: String(BigInt(token.version) + 1n),
      record: { ...token.record, revokedAt: request.revokedAt, revokedBy: request.revokedBy },
    });
    return Object.freeze({
      where: Object.freeze({ tokenId: token.record.id, appId: token.record.appId, version: token.version, revokedAt: null }),
      next,
    });
  });
}
