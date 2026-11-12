/** `POST /api/v<n>/$scope {scope, key, ttl?}`: an unscoped token asks for a
 * child narrowed to one row of a declared `api.scopes` entry. The child holds
 * its parent's account, roles, operations and tenant binding, lives no longer
 * than the parent and at most an hour, and stands only while its parent does —
 * every observation reads the parent in the same transaction
 * (observedRowScope), so revoking the parent ends the child without a write of
 * its own. A key the parent cannot read answers exactly as a missing one. */
import { randomUUID } from 'node:crypto';
import type { AppDef } from '../../shared/appModel.js';
import type { AppAuthRuntime } from '../auth/auth.js';
import { acquireApiTokenStoreOperation } from '../auth/auth.js';
import { issueAccountToken } from '../auth/apiTokenIssuance.js';
import type { OAuthStep, OAuthTables } from '../auth/oauthGrants.js';
import { ApiReadFailure } from './apiReadFailure.js';
import { apiTokenSecretId, matchesApiTokenSecret } from './apiTokenSecret.js';
import type { ApiRowScopeRef } from './apiRowScope.js';
import type { TokenRecord } from './apiTokenScope.js';

/** The default and the ceiling on a child's life, in seconds. */
const API_SCOPE_TTL_DEFAULT = 15 * 60;
const API_SCOPE_TTL_MAX = 60 * 60;
/** The largest `$scope` body the transport reads. */
export const API_SCOPE_BODY_BYTES = 4096;

type Answer = Readonly<{ status: number; body: string }>;
type ItemSend = (answer: Readonly<{ status: number; body: string }>) => void;

const problem = (status: number, code: string, message: string): Answer =>
  Object.freeze({ status, body: JSON.stringify({ error: { code, message } }) });
const NOT_FOUND = problem(404, 'not_found', 'The API request could not be completed.');

type Request = Readonly<{ name: string; key: string; ttl: number }>;

/** Exactly `{scope, key, ttl?}`: a declared scope's name, the key as text of at most 256 bytes, whole seconds up to an hour. */
function parse(app: AppDef, body: unknown): Request | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const value = body as Record<string, unknown>;
  const keys = Object.keys(value);
  if (keys.some((key) => !['scope', 'key', 'ttl'].includes(key)) || !keys.includes('scope') || !keys.includes('key')) return undefined;
  const { scope, key, ttl } = value;
  if (typeof scope !== 'string' || !app.api?.scopes || !Object.hasOwn(app.api.scopes, scope)) return undefined;
  // A number key is accepted as the text it is; the key column coerces it.
  const text = typeof key === 'number' && Number.isSafeInteger(key) ? String(key) : key;
  // The store holds a key of at most 256 bytes (the token layout's scope_key).
  if (typeof text !== 'string' || !text.length || Buffer.byteLength(text, 'utf8') > 256) return undefined;
  if (ttl !== undefined && (typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl < 1 || ttl > API_SCOPE_TTL_MAX)) return undefined;
  return Object.freeze({ name: scope, key: text, ttl: (ttl as number | undefined) ?? API_SCOPE_TTL_DEFAULT });
}

type Minted =
  | { kind: 'minted'; token: string; tokenId: string; expiresAt: number }
  | { kind: 'unauthenticated' }
  | { kind: 'scope_fixed' }
  | { kind: 'forbidden' };

/** The child's insert in the auth store's one transaction: the parent read and judged there, so a parent revoked a moment ago mints nothing. */
function* mintChild(
  t: OAuthTables,
  app: AppDef,
  credential: unknown,
  request: Request,
  now: number,
): Generator<OAuthStep, Minted, unknown> {
  let id: string;
  try {
    id = apiTokenSecretId(credential);
  } catch {
    return { kind: 'unauthenticated' };
  }
  const stored = (yield { kind: 'token', tokenId: id }) as { record: Readonly<TokenRecord>; digest: string } | null;
  if (!stored || !matchesApiTokenSecret(app.id, id, credential, stored.digest)) return { kind: 'unauthenticated' };
  const parent = stored.record;
  if (parent.subject.kind !== 'account' || parent.revokedAt !== undefined || !(parent.expiresAt > now)) return { kind: 'unauthenticated' };
  if (parent.rowScope) return { kind: 'scope_fixed' };
  // An OAuth-issued token answers to its grant and the operator's ceiling, which a child would not: it mints none.
  const access = (yield { kind: 'all', sql: `SELECT 1 AS one FROM ${t.access} WHERE token_id = ?`, params: [id] }) as unknown[];
  if (access.length) return { kind: 'forbidden' };
  const person = (yield { kind: 'eligible', accountId: parent.subject.id }) as Readonly<{
    accountId: string;
    roles: readonly string[];
  }> | null;
  if (!person) return { kind: 'unauthenticated' };
  let issue;
  try {
    issue = issueAccountToken({
      app,
      appId: parent.appId,
      // The parent's operations, as it holds them (absent stays absent): judged when it was issued, and narrowed
      // again on every observation of the child, so here they need only be the parent's.
      catalog: { operations: (parent.operations ?? []).map((id) => ({ id, eligibleRoles: parent.roles })) },
      tokenId: randomUUID(),
      subjectId: parent.subject.id,
      actorId: parent.subject.id,
      roles: parent.roles,
      label: `$scope ${request.name}:${request.key}`.slice(0, 200),
      expiresAt: Math.min(parent.expiresAt, now + request.ttl * 1000),
      createdAt: now,
      ...(parent.operations !== undefined ? { operations: parent.operations } : {}),
      // The membership the parent is bound to; the tenant runtime judges it again on every request.
      ...(parent.tenant ? { tenant: { ...parent.tenant, roles: parent.roles } } : {}),
      rowScope: { name: request.name, key: request.key, parentId: parent.id },
    });
    issue.admit(person, person, now);
  } catch {
    return { kind: 'forbidden' };
  }
  const minted = issue.mint();
  yield { kind: 'insert', stored: minted.stored };
  return { kind: 'minted', token: minted.result.token, tokenId: minted.result.tokenId, expiresAt: issue.record.expiresAt };
}

/**
 * The owner's `$scope` (api/postgresApiReadHttp.ts dispatches to it). `observe`
 * is the owner's own token observation and `readItem` its own item read: the
 * key is proven readable by the parent through exactly the path a read takes.
 */
export function createApiScopeMint(input: {
  app: AppDef;
  auth: AppAuthRuntime;
  observe: (credential: unknown) => Promise<{ observed: { scope?: ApiRowScopeRef } }>;
  readItem: (credential: unknown, operationId: string, key: string, send: ItemSend) => Promise<unknown>;
}) {
  const { app, auth } = input;
  return async (credential: unknown, body: unknown, send: (answer: Answer) => void): Promise<'sent'> => {
    const request = parse(app, body);
    if (!request) {
      send(
        problem(400, 'invalid_request', 'The body must be {"scope", "key", "ttl"?}: a declared scope, its key, and seconds up to 3600.'),
      );
      return 'sent';
    }
    // The credential first: a token gone is 401 whatever it asked for.
    const { observed } = await input.observe(credential);
    if (observed.scope) {
      send(problem(409, 'scope_fixed', 'This token is already scoped; ask with the token it was issued from.'));
      return 'sent';
    }
    const scope = app.api!.scopes![request.name]!;
    let status = 0;
    let found: unknown;
    try {
      await input.readItem(credential, `item:${scope.key}`, encodeURIComponent(request.key), (answer) => {
        status = answer.status;
        if (answer.status === 200) found = JSON.parse(answer.body);
      });
    } catch (error) {
      if (error instanceof ApiReadFailure && (error.code === 'unauthenticated' || error.code === 'temporarily_unavailable')) throw error;
      // Not readable by this token, or not a key at all: the same answer as a row that is not there.
      status = 404;
    }
    // The key stored is the one the proving read found, as the row spells its primary key (the scope's key column,
    // checkApiScopes): what the caller typed may be a spelling of it — "007" for 7 — and the scope compares the column.
    const column = scope.rows[scope.key] as string;
    const proven = found && typeof found === 'object' ? (found as Record<string, unknown>)[column] : undefined;
    if (status !== 200 || (typeof proven !== 'string' && typeof proven !== 'number') || !String(proven).length) {
      send(NOT_FOUND);
      return 'sent';
    }
    const child: Request = Object.freeze({ ...request, key: String(proven) });
    let minted: Minted;
    try {
      const store = await acquireApiTokenStoreOperation(auth, app.id);
      const now = Date.now();
      minted = await store((tables) => mintChild(tables, app, credential, child, now));
    } catch {
      // The store could not answer, or would not take the row: nothing about the credential was decided.
      throw new ApiReadFailure('temporarily_unavailable');
    }
    if (minted.kind === 'unauthenticated') throw new ApiReadFailure('unauthenticated');
    if (minted.kind === 'scope_fixed') {
      send(problem(409, 'scope_fixed', 'This token is already scoped; ask with the token it was issued from.'));
      return 'sent';
    }
    if (minted.kind === 'forbidden') throw new ApiReadFailure('forbidden');
    send(
      Object.freeze({
        status: 201,
        body: JSON.stringify({
          token: minted.token,
          tokenId: minted.tokenId,
          expiresAt: new Date(minted.expiresAt).toISOString(),
          scope: { name: child.name, key: child.key },
        }),
      }),
    );
    return 'sent';
  };
}
