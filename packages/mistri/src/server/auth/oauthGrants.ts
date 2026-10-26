/**
 * What the OAuth authorization server keeps, written once for both stores:
 * registered clients, the codes consent mints, the grants a code becomes, the
 * refresh tokens that rotate on each use, and which access token is whose.
 *
 * Each operation is a generator that yields the statements it needs and
 * judges their answers; a driver (oauthStore.ts) runs them in one transaction
 * of the native auth store, the file's synchronously and PostgreSQL's with
 * awaits, and commits whatever it returns. A refusal is a value, not a throw,
 * so the transaction that burned a code or revoked a grant on the way to it
 * still commits: a code tried twice stays spent, and the grant it made stays
 * revoked, whatever the second caller is told.
 *
 * The access token is an ordinary twa1 API token, issued through the one
 * issuance core the operator's CLI uses (apiTokenIssuance.ts): its roles are
 * the person's, the API's and the operator's ceiling at once, and every
 * request narrows them again (the token observers).
 *
 * In a tenant App the person's roles are one membership's, never their
 * account's: the code, the grant and every access token carry that
 * membership — its tenant, its id and its version — so the tenant runtime
 * refuses the token once the membership changes, and a refresh after that is
 * refused here. The membership lives in the business store, which no
 * transaction here can read: the caller reads it just before (`peekBinding`
 * says whose to read) and hands it in, and the operation compares it with
 * what the code or grant was made for.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AppDef } from '../../shared/appModel.js';
import { accountTokenRoles } from '../api/apiTokenScope.js';
import { assertApiTokenSecretId, apiTokenSecretId, matchesApiTokenSecret } from '../api/apiTokenSecret.js';
import { OAUTH_ACCESS_SECONDS, OAUTH_GRANT_SECONDS } from '../api/oauthConfig.js';
import { issueAccountToken } from './apiTokenIssuance.js';

/** The store's tables, as each engine names them. */
export type OAuthTables = Readonly<{ client: string; code: string; grant: string; refresh: string; access: string; token: string }>;
type Row = Record<string, unknown>;
type AccountRoles = Readonly<{ accountId: string; roles: readonly string[] }> | null;
/** One thing a driver does for an operation: `?` placeholders, in order. */
type OAuthStep =
  | Readonly<{ kind: 'all'; sql: string; params: readonly unknown[] }>
  | Readonly<{ kind: 'run'; sql: string; params: readonly unknown[] }>
  | Readonly<{ kind: 'eligible'; accountId: string }>
  | Readonly<{ kind: 'insert'; stored: unknown }>;
export type OAuthWork<T> = Generator<OAuthStep, T, unknown>;

/** Unconsented clients at most: registration is open, so it is bounded. */
export const OAUTH_UNCONSENTED_CLIENTS = 1000;
/** How long a client nobody consented to is kept. */
export const OAUTH_UNCONSENTED_SECONDS = 24 * 3600;

function* all(sql: string, ...params: unknown[]): Generator<OAuthStep, Row[], unknown> {
  return (yield { kind: 'all', sql, params }) as Row[];
}
function* run(sql: string, ...params: unknown[]): Generator<OAuthStep, number, unknown> {
  return (yield { kind: 'run', sql, params }) as number;
}
function* eligible(accountId: string): Generator<OAuthStep, AccountRoles, unknown> {
  return (yield { kind: 'eligible', accountId }) as AccountRoles;
}
/** The account as the native store reads it: null when it may not sign in. */
export function* readAccount(accountId: string): OAuthWork<AccountRoles> {
  return yield* eligible(accountId);
}

/** An integer column, as either engine gives it back (PostgreSQL's bigint is a string). */
const num = (value: unknown): number => {
  const n = typeof value === 'number' ? value : typeof value === 'bigint' || typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isSafeInteger(n)) throw new Error('The OAuth store holds a value it did not write.');
  return n;
};
const str = (value: unknown): string => {
  if (typeof value !== 'string') throw new Error('The OAuth store holds a value it did not write.');
  return value;
};
const list = (value: unknown): string[] => {
  const parsed: unknown = JSON.parse(str(value));
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string'))
    throw new Error('The OAuth store holds a value it did not write.');
  return parsed as string[];
};

/** The digest a code or a refresh token is kept by: the secret itself never is. */
export const oauthDigest = (secret: string): string => createHash('sha256').update(secret, 'utf8').digest('hex');
/** A code: 32 random bytes. */
export const mintOAuthCode = (): string => randomBytes(32).toString('base64url');
const REFRESH = /^twr1\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.[A-Za-z0-9_-]{43}$/;
/** Whether a string is spelled as a refresh token: `twr1.<grant id>.<32 bytes>`. */
const isRefreshToken = (value: string): boolean => REFRESH.test(value);

/** PKCE S256: the challenge is the verifier's SHA-256, base64url, compared in constant time. */
function pkceMatches(challenge: string, verifier: unknown): boolean {
  if (typeof verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const computed = Buffer.from(createHash('sha256').update(verifier, 'ascii').digest('base64url'));
  const expected = Buffer.from(challenge);
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}

interface OAuthClient {
  clientId: string;
  name: string | null;
  redirectUris: readonly string[];
  createdAt: number;
  consentedAt: number | null;
}
/** The App the tokens are for, and the operator's ceiling on their roles. */
export interface OAuthIssuer {
  app: AppDef;
  ceiling: readonly string[];
}
type OAuthTokenAnswer = Readonly<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  roles: readonly string[];
}>;
type OAuthRefusal = Readonly<{ error: 'invalid_grant' | 'invalid_client'; description: string }>;
/** A tenant membership, as the business store answers it now: active, with the roles it holds. */
export type OAuthMembership = Readonly<{ tenantId: string; membershipId: string; membershipVersion: string; roles: readonly string[] }>;
const tenantApp = (issuer: OAuthIssuer) => issuer.app.auth?.rows === 'tenant';
const refusal = (description: string, error: OAuthRefusal['error'] = 'invalid_grant'): OAuthRefusal =>
  Object.freeze({ error, description });

/**
 * A client registers: nobody nobody consented to within a day is kept, and
 * at most OAUTH_UNCONSENTED_CLIENTS wait for consent at once, so open
 * registration cannot fill the store.
 */
export function* registerClient(
  t: OAuthTables,
  input: Readonly<{ clientId: string; name: string | null; redirectUris: readonly string[]; now: number }>,
): OAuthWork<'registered' | 'full'> {
  yield* run(`DELETE FROM ${t.client} WHERE consented_at IS NULL AND created_at < ?`, input.now - OAUTH_UNCONSENTED_SECONDS * 1000);
  const [waiting] = yield* all(`SELECT count(*) AS n FROM ${t.client} WHERE consented_at IS NULL`);
  if (num(waiting.n) >= OAUTH_UNCONSENTED_CLIENTS) return 'full';
  yield* run(
    `INSERT INTO ${t.client} (client_id, name, redirect_uris_json, created_at, consented_at) VALUES (?, ?, ?, ?, NULL)`,
    input.clientId,
    input.name,
    JSON.stringify(input.redirectUris),
    input.now,
  );
  return 'registered';
}

export function* readClient(t: OAuthTables, clientId: string): OAuthWork<OAuthClient | null> {
  const rows = yield* all(
    `SELECT client_id, name, redirect_uris_json, created_at, consented_at FROM ${t.client} WHERE client_id = ?`,
    clientId,
  );
  if (!rows.length) return null;
  const row = rows[0];
  return Object.freeze({
    clientId: str(row.client_id),
    name: row.name === null ? null : str(row.name),
    redirectUris: Object.freeze(list(row.redirect_uris_json)),
    createdAt: num(row.created_at),
    consentedAt: row.consented_at === null ? null : num(row.consented_at),
  });
}

/** What is past keeping: codes long expired and never exchanged, and grants revoked or expired with all they made. */
function* prune(t: OAuthTables, now: number): OAuthWork<void> {
  yield* run(`DELETE FROM ${t.code} WHERE grant_id IS NULL AND expires_at < ?`, now - 600_000);
  const dead = yield* all(`SELECT grant_id FROM ${t.grant} WHERE revoked_at IS NOT NULL OR expires_at <= ? LIMIT 100`, now);
  for (const row of dead) yield* dropGrant(t, str(row.grant_id));
}

/** A grant gone with what it made: its codes, refresh tokens and access tokens (the token rows too). */
function* dropGrant(t: OAuthTables, grantId: string): OAuthWork<void> {
  const tokens = yield* all(`SELECT token_id FROM ${t.access} WHERE grant_id = ?`, grantId);
  yield* run(`DELETE FROM ${t.access} WHERE grant_id = ?`, grantId);
  for (const row of tokens) yield* run(`DELETE FROM ${t.token} WHERE token_id = ?`, str(row.token_id));
  yield* run(`DELETE FROM ${t.refresh} WHERE grant_id = ?`, grantId);
  yield* run(`DELETE FROM ${t.code} WHERE grant_id = ?`, grantId);
  yield* run(`DELETE FROM ${t.grant} WHERE grant_id = ?`, grantId);
}

function* revokeGrant(t: OAuthTables, grantId: string, now: number): OAuthWork<number> {
  return yield* run(
    `UPDATE ${t.grant} SET revoked_at = CASE WHEN created_at > ? THEN created_at ELSE ? END WHERE grant_id = ? AND revoked_at IS NULL`,
    now,
    now,
    grantId,
  );
}

/**
 * Consent, given: the client is marked consented (it is kept from now on) and
 * a code is minted for exactly what the person chose. The roles were judged
 * against the person, the API and the ceiling by the caller a moment ago; the
 * exchange judges them again.
 */
export function* issueCode(
  t: OAuthTables,
  input: Readonly<{
    codeDigest: string;
    clientId: string;
    subject: string;
    redirectUri: string;
    challenge: string;
    appId: string;
    version: number;
    roles: readonly string[];
    /** A tenant App's code: the membership consented with. */
    tenant?: OAuthMembership;
    expiresAt: number;
    now: number;
  }>,
): OAuthWork<'issued' | 'unknown_client'> {
  yield* prune(t, input.now);
  const changed = yield* run(
    `UPDATE ${t.client} SET consented_at = CASE WHEN consented_at IS NULL THEN CASE WHEN created_at > ? THEN created_at ELSE ? END ELSE consented_at END WHERE client_id = ?`,
    input.now,
    input.now,
    input.clientId,
  );
  if (changed !== 1) return 'unknown_client';
  yield* run(
    `INSERT INTO ${t.code} (code_digest, client_id, subject, redirect_uri, challenge, app_id, version, roles_json,
      tenant_id, membership_id, membership_version, expires_at, used_at, grant_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    input.codeDigest,
    input.clientId,
    input.subject,
    input.redirectUri,
    input.challenge,
    input.appId,
    input.version,
    JSON.stringify(input.roles),
    input.tenant?.tenantId ?? null,
    input.tenant?.membershipId ?? null,
    input.tenant?.membershipVersion ?? null,
    input.expiresAt,
  );
  return 'issued';
}

/**
 * The roles a token may carry now: the grant's, still the person's, the API's and within the ceiling. `person` is
 * the account's roles, or in a tenant App the membership's, of which a platform-realm role is never a token's.
 */
export const oauthTokenRoles = (issuer: OAuthIssuer, granted: readonly string[], person: readonly string[]): string[] => {
  const declared = issuer.app.auth?.roles ?? {};
  const held = tenantApp(issuer)
    ? person.filter((role) => (declared[role] as { realm?: string } | undefined)?.realm !== 'platform')
    : accountTokenRoles(issuer.app, person);
  return granted.filter(
    (role) => held.includes(role) && issuer.app.api!.roles.includes(role) && issuer.ceiling.includes(role) && Object.hasOwn(declared, role),
  );
};

/** An access token and the next refresh token for a grant, both for what it may carry now. */
function* mintFor(
  t: OAuthTables,
  issuer: OAuthIssuer,
  grant: Readonly<{ grantId: string; subject: string; roles: readonly string[]; expiresAt: number; label: string }>,
  person: NonNullable<AccountRoles>,
  now: number,
  membership?: OAuthMembership,
): OAuthWork<OAuthTokenAnswer> {
  const app = issuer.app;
  const issue = issueAccountToken({
    app,
    appId: app.id,
    // Every operation the roles may run: an OAuth token names none.
    catalog: { operations: [] },
    tokenId: randomUUID(),
    subjectId: grant.subject,
    actorId: grant.subject,
    roles: grant.roles,
    label: grant.label,
    expiresAt: Math.min(now + OAUTH_ACCESS_SECONDS * 1000, grant.expiresAt),
    createdAt: now,
    // Bound to the membership, as the CLI binds a tenant token: the tenant runtime judges its version on every request.
    ...(membership
      ? {
          tenant: {
            tenantId: membership.tenantId,
            membershipId: membership.membershipId,
            membershipVersion: membership.membershipVersion,
            roles: oauthTokenRoles(issuer, membership.roles, membership.roles),
          },
        }
      : {}),
  });
  issue.admit(person, person, now);
  const minted = issue.mint();
  yield { kind: 'insert', stored: minted.stored };
  yield* run(
    `INSERT INTO ${t.access} (token_id, grant_id, app_id, version) VALUES (?, ?, ?, ?)`,
    issue.record.id,
    grant.grantId,
    app.id,
    app.api!.version,
  );
  const refreshToken = `twr1.${grant.grantId}.${randomBytes(32).toString('base64url')}`;
  yield* run(
    `INSERT INTO ${t.refresh} (digest, grant_id, issued_at, used_at) VALUES (?, ?, ?, NULL)`,
    oauthDigest(refreshToken),
    grant.grantId,
    now,
  );
  return Object.freeze({
    accessToken: minted.result.token,
    refreshToken,
    expiresIn: Math.floor((issue.record.expiresAt - now) / 1000),
    roles: Object.freeze([...issue.record.roles]),
  });
}

const labelOf = (client: Row) => `OAuth: ${client.name === null ? str(client.client_id) : str(client.name)}`;

/**
 * Whose membership a tenant App's token request needs read before it runs: the code's or the refresh token's
 * person and tenant. Null for anything unknown, which the operation itself then refuses.
 */
export function* peekBinding(
  t: OAuthTables,
  input: Readonly<{ codeDigest: string } | { refreshToken: string }>,
): OAuthWork<Readonly<{ subject: string; tenantId: string | null }> | null> {
  let rows: Row[];
  if ('codeDigest' in input) rows = yield* all(`SELECT subject, tenant_id FROM ${t.code} WHERE code_digest = ?`, input.codeDigest);
  else if (!isRefreshToken(input.refreshToken)) return null;
  else
    rows = yield* all(
      `SELECT g.subject, g.tenant_id FROM ${t.refresh} r JOIN ${t.grant} g ON g.grant_id = r.grant_id WHERE r.digest = ?`,
      oauthDigest(input.refreshToken),
    );
  if (!rows.length) return null;
  return Object.freeze({ subject: str(rows[0].subject), tenantId: rows[0].tenant_id === null ? null : str(rows[0].tenant_id) });
}

/**
 * What a code or grant was made for, against the membership read now: a tenant App's must be the very
 * membership, unchanged — a revoke, a new role or a suspension each move its version — and any other App's
 * names none. Null when it holds, else why not.
 */
function bindingProblem(issuer: OAuthIssuer, row: Row, membership: OAuthMembership | null | undefined): string | null {
  if (!tenantApp(issuer))
    return row.tenant_id === null ? null : 'The grant is for an API this server no longer serves; the person consents again.';
  if (row.tenant_id === null) return 'The grant is for an API this server no longer serves; the person consents again.';
  if (
    !membership ||
    membership.tenantId !== str(row.tenant_id) ||
    membership.membershipId !== str(row.membership_id) ||
    membership.membershipVersion !== str(row.membership_version)
  )
    return 'The membership it was given for has changed or ended; the person consents again.';
  return null;
}
/**
 * A code becomes a grant, once. The code is spent by whatever happens to it
 * here — exchanged, or tried by the wrong client, with the wrong verifier or
 * redirect, or late — and a code tried after it was exchanged revokes the
 * grant it made (RFC 9700 §4.5): whoever holds it now is not who it was for.
 */
export function* exchangeCode(
  t: OAuthTables,
  issuer: OAuthIssuer,
  input: Readonly<{
    codeDigest: string;
    clientId: string;
    redirectUri: unknown;
    verifier: unknown;
    /** A tenant App's: the code's membership as the business store answers it now (peekBinding says whose). */
    membership?: OAuthMembership | null;
    now: number;
  }>,
): OAuthWork<OAuthTokenAnswer | OAuthRefusal> {
  const { now } = input;
  const rows = yield* all(
    `SELECT c.client_id, c.subject, c.redirect_uri, c.challenge, c.app_id, c.version, c.roles_json, c.expires_at, c.used_at, c.grant_id,
      c.tenant_id, c.membership_id, c.membership_version, k.name AS client_name FROM ${t.code} c JOIN ${t.client} k ON k.client_id = c.client_id WHERE c.code_digest = ?`,
    input.codeDigest,
  );
  if (!rows.length) return refusal('The code is unknown, spent or expired.');
  const code = rows[0];
  if (code.used_at !== null) {
    if (code.grant_id !== null) yield* revokeGrant(t, str(code.grant_id), now);
    return refusal('The code is unknown, spent or expired.');
  }
  // Spent now, whatever follows: a second try finds it used.
  const claimed = yield* run(`UPDATE ${t.code} SET used_at = ? WHERE code_digest = ? AND used_at IS NULL`, now, input.codeDigest);
  if (claimed !== 1) return refusal('The code is unknown, spent or expired.');
  if (str(code.client_id) !== input.clientId) return refusal('The code was issued to another client.');
  if (num(code.expires_at) <= now) return refusal('The code is unknown, spent or expired.');
  if (input.redirectUri !== str(code.redirect_uri)) return refusal('The redirect_uri is not the one the code was issued for.');
  if (!pkceMatches(str(code.challenge), input.verifier)) return refusal('The code_verifier does not match the code_challenge.');
  const app = issuer.app;
  if (str(code.app_id) !== app.id || num(code.version) !== app.api?.version)
    return refusal('The code is for an API this server no longer serves.');
  const subject = str(code.subject);
  const person = yield* eligible(subject);
  if (!person) return refusal('The account may not be given a token.');
  const bound = bindingProblem(issuer, code, input.membership);
  if (bound) return refusal(bound);
  const membership = tenantApp(issuer) ? input.membership! : undefined;
  const roles = list(code.roles_json);
  // Every role consented to, still held: a role lost in the minute since is not narrowed away, it refuses.
  if (oauthTokenRoles(issuer, roles, membership ? membership.roles : person.roles).length !== roles.length)
    return refusal('The account no longer holds the roles consented to.');
  const grantId = randomUUID();
  const expiresAt = now + OAUTH_GRANT_SECONDS * 1000;
  yield* run(
    `INSERT INTO ${t.grant} (grant_id, client_id, subject, app_id, version, roles_json, tenant_id, membership_id, membership_version,
      created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    grantId,
    input.clientId,
    subject,
    app.id,
    app.api!.version,
    JSON.stringify(roles),
    membership?.tenantId ?? null,
    membership?.membershipId ?? null,
    membership?.membershipVersion ?? null,
    now,
    expiresAt,
  );
  yield* run(`UPDATE ${t.code} SET grant_id = ? WHERE code_digest = ?`, grantId, input.codeDigest);
  try {
    return yield* mintFor(
      t,
      issuer,
      { grantId, subject, roles, expiresAt, label: labelOf({ name: code.client_name, client_id: code.client_id }) },
      person,
      now,
      membership,
    );
  } catch {
    yield* revokeGrant(t, grantId, now);
    return refusal('The account may not be given a token.');
  }
}

/**
 * A refresh token is spent for the next pair. One spent before means two
 * holders: the grant is revoked, and every token it made with it. The new
 * access token carries what the grant still may: roles the person lost are
 * gone from it, and a person who may no longer sign in gets nothing.
 */
export function* refreshGrant(
  t: OAuthTables,
  issuer: OAuthIssuer,
  input: Readonly<{
    refreshToken: string;
    clientId: string;
    /** A tenant App's: the grant's membership as the business store answers it now (peekBinding says whose). */
    membership?: OAuthMembership | null;
    now: number;
  }>,
): OAuthWork<OAuthTokenAnswer | OAuthRefusal> {
  const { now } = input;
  if (!isRefreshToken(input.refreshToken)) return refusal('The refresh token is unknown, spent or revoked.');
  const digest = oauthDigest(input.refreshToken);
  const rows = yield* all(
    `SELECT r.used_at, g.grant_id, g.client_id, g.subject, g.app_id, g.version, g.roles_json, g.tenant_id, g.membership_id,
      g.membership_version, g.expires_at, g.revoked_at, k.name AS client_name
      FROM ${t.refresh} r JOIN ${t.grant} g ON g.grant_id = r.grant_id JOIN ${t.client} k ON k.client_id = g.client_id WHERE r.digest = ?`,
    digest,
  );
  if (!rows.length) return refusal('The refresh token is unknown, spent or revoked.');
  const row = rows[0];
  const grantId = str(row.grant_id);
  if (row.used_at !== null || str(row.client_id) !== input.clientId) {
    yield* revokeGrant(t, grantId, now);
    return refusal('The refresh token is unknown, spent or revoked.');
  }
  const claimed = yield* run(
    `UPDATE ${t.refresh} SET used_at = CASE WHEN issued_at > ? THEN issued_at ELSE ? END WHERE digest = ? AND used_at IS NULL`,
    now,
    now,
    digest,
  );
  if (claimed !== 1) {
    yield* revokeGrant(t, grantId, now);
    return refusal('The refresh token is unknown, spent or revoked.');
  }
  if (row.revoked_at !== null) return refusal('The refresh token is unknown, spent or revoked.');
  const expiresAt = num(row.expires_at);
  if (expiresAt <= now) return refusal('The grant has expired; the person consents again.');
  const app = issuer.app;
  if (str(row.app_id) !== app.id || num(row.version) !== app.api?.version) {
    yield* revokeGrant(t, grantId, now);
    return refusal('The grant is for an API this server no longer serves; the person consents again.');
  }
  const subject = str(row.subject);
  const person = yield* eligible(subject);
  if (!person) {
    yield* revokeGrant(t, grantId, now);
    return refusal('The account may not be given a token.');
  }
  // A membership revoked, suspended or changed since consent ends the grant: the person consents again, as they are now.
  const bound = bindingProblem(issuer, row, input.membership);
  if (bound) {
    yield* revokeGrant(t, grantId, now);
    return refusal(bound);
  }
  const membership = tenantApp(issuer) ? input.membership! : undefined;
  const roles = oauthTokenRoles(issuer, list(row.roles_json), membership ? membership.roles : person.roles);
  if (!roles.length) {
    yield* revokeGrant(t, grantId, now);
    return refusal('The account no longer holds a role the grant gave.');
  }
  // The grant's access tokens that have expired go now: an hourly token would otherwise be kept for a month.
  const stale = yield* all(
    `SELECT a.token_id FROM ${t.access} a JOIN ${t.token} k ON k.token_id = a.token_id WHERE a.grant_id = ? AND k.expires_at <= ?`,
    grantId,
    now,
  );
  for (const token of stale) {
    yield* run(`DELETE FROM ${t.access} WHERE token_id = ?`, str(token.token_id));
    yield* run(`DELETE FROM ${t.token} WHERE token_id = ?`, str(token.token_id));
  }
  try {
    return yield* mintFor(
      t,
      issuer,
      { grantId, subject, roles, expiresAt, label: labelOf({ name: row.client_name, client_id: row.client_id }) },
      person,
      now,
      membership,
    );
  } catch {
    yield* revokeGrant(t, grantId, now);
    return refusal('The account may not be given a token.');
  }
}

/**
 * RFC 7009: a refresh token revokes its grant, an access token itself — each
 * only for the client it was issued to. Anything else is answered as if it
 * were revoked, so the endpoint says nothing about tokens that are not the
 * caller's.
 */
export function* revokeToken(
  t: OAuthTables,
  input: Readonly<{ token: string; clientId: string; appId: string; now: number }>,
): OAuthWork<void> {
  if (isRefreshToken(input.token)) {
    const rows = yield* all(
      `SELECT g.grant_id, g.client_id FROM ${t.refresh} r JOIN ${t.grant} g ON g.grant_id = r.grant_id WHERE r.digest = ?`,
      oauthDigest(input.token),
    );
    if (rows.length && str(rows[0].client_id) === input.clientId) yield* revokeGrant(t, str(rows[0].grant_id), input.now);
    return;
  }
  let tokenId: string;
  try {
    tokenId = apiTokenSecretId(input.token);
  } catch {
    return;
  }
  const rows = yield* all(
    `SELECT g.client_id, k.digest FROM ${t.access} a JOIN ${t.grant} g ON g.grant_id = a.grant_id JOIN ${t.token} k ON k.token_id = a.token_id
      WHERE a.token_id = ? AND k.app_id = ?`,
    tokenId,
    input.appId,
  );
  if (
    !rows.length ||
    str(rows[0].client_id) !== input.clientId ||
    !matchesApiTokenSecret(input.appId, tokenId, input.token, rows[0].digest)
  )
    return;
  // An hour's token, revoked: gone, which every observer refuses as surely as a revoked row.
  yield* run(`DELETE FROM ${t.access} WHERE token_id = ?`, tokenId);
  yield* run(`DELETE FROM ${t.token} WHERE token_id = ?`, tokenId);
}

type OAuthGrantView = Readonly<{
  grantId: string;
  client: string | null;
  clientId: string;
  roles: readonly string[];
  createdAt: number;
  expiresAt: number;
}>;

/** The grants a person has given for this App and that still stand: their Connected clients. */
export function* listGrants(t: OAuthTables, input: Readonly<{ subject: string; appId: string; now: number }>): OAuthWork<OAuthGrantView[]> {
  const rows = yield* all(
    `SELECT g.grant_id, g.client_id, g.roles_json, g.created_at, g.expires_at, k.name FROM ${t.grant} g JOIN ${t.client} k ON k.client_id = g.client_id
      WHERE g.subject = ? AND g.app_id = ? AND g.revoked_at IS NULL AND g.expires_at > ? ORDER BY g.created_at DESC LIMIT 100`,
    input.subject,
    input.appId,
    input.now,
  );
  return rows.map((row) =>
    Object.freeze({
      grantId: str(row.grant_id),
      client: row.name === null ? null : str(row.name),
      clientId: str(row.client_id),
      roles: Object.freeze(list(row.roles_json)),
      createdAt: num(row.created_at),
      expiresAt: num(row.expires_at),
    }),
  );
}

/** A person revokes one of their own grants: every token it made stops at the next request. */
export function* revokeOwnGrant(t: OAuthTables, input: Readonly<{ subject: string; grantId: string; now: number }>): OAuthWork<boolean> {
  try {
    assertApiTokenSecretId(input.grantId);
  } catch {
    return false;
  }
  const rows = yield* all(`SELECT subject FROM ${t.grant} WHERE grant_id = ?`, input.grantId);
  if (!rows.length || str(rows[0].subject) !== input.subject) return false;
  return (yield* revokeGrant(t, input.grantId, input.now)) === 1;
}
