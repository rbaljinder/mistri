/** The one path an account's API token is issued by, whoever asks: the local
 * operator's maintenance (sqliteApiTokenMaintenance.ts,
 * postgresApiTokenMaintenance.ts) and the OAuth authorization server
 * (oauthServer.ts). Store-neutral: it captures the record, judges the subject
 * and actor the caller read natively in its own transaction, and mints the
 * secret; the caller inserts the row in that transaction and judges again
 * after it. No reads, writes, commits or retries of its own. */
import type { AppDef } from '../../shared/appModel.js';
import { assertApiTokenSecretId, mintApiTokenSecret } from '../api/apiTokenSecret.js';
import { accountTokenRoles, captureApiTokenRecord, captureTenantIssue, type TokenRecord } from '../api/apiTokenScope.js';

const refuse = (): never => {
  throw new Error('API token issuance is unavailable.');
};

/** The operations a token may name, each with the roles that may run it. */
export type IssueCatalog = Readonly<{ operations: readonly Readonly<{ id: string; eligibleRoles: readonly string[] }>[] }>;
/** An account as the native store reads it: eligible (not banned), with its roles. Null when it is not. */
type EligibleAccount = Readonly<{ accountId: string; roles: readonly string[] }> | null;

interface AccountTokenIssueInput {
  /** The App, a trusted parsed input: its `api.roles` and declared roles bound the token. */
  app: AppDef;
  /** The token store's App binding. */
  appId: string;
  catalog: IssueCatalog;
  tokenId: string;
  subjectId: string;
  actorId: string;
  roles: readonly string[];
  label: string;
  expiresAt: number;
  createdAt: number;
  /** Absent: every current and future operation the roles may run. `[]` is none. */
  operations?: readonly string[];
  /** Tenant Apps only: `{ tenantId, membershipId, membershipVersion, roles }` read natively from the business store. */
  tenant?: unknown;
}

/**
 * The checked issue: the record a store will hold, `admit` for the judgement
 * the caller makes before and after its insert (the subject and the actor
 * still eligible, every role still theirs and the API's, every named
 * operation one those roles may run, the instant before expiry), and `mint`
 * for the secret, handed out once the caller's transaction commits.
 */
export function issueAccountToken(raw: AccountTokenIssueInput) {
  const input = raw;
  const { app, catalog } = input;
  const tenant = input.tenant === undefined ? undefined : captureTenantIssue(input.tenant);
  // A tenant App issues bound tokens only; an `all` App never does.
  if (!app.api || (app.auth?.rows === 'tenant') !== (tenant !== undefined)) return refuse();
  assertApiTokenSecretId(input.tokenId);
  const apiRoles = Object.freeze([...app.api.roles]);
  const record: Readonly<TokenRecord> = captureApiTokenRecord({
    id: input.tokenId,
    appId: input.appId,
    subject: { kind: 'account', id: input.subjectId },
    createdBy: input.actorId,
    roles: input.roles,
    label: input.label,
    expiresAt: input.expiresAt,
    createdAt: input.createdAt,
    ...(input.operations !== undefined ? { operations: input.operations } : {}),
    ...(tenant ? { tenant: tenant.binding } : {}),
  });
  const admit = (subject: EligibleAccount, actor: EligibleAccount, now?: number): void => {
    // A tenant App grants by membership: the native account role is not its authority.
    const granted = tenant ? tenant.roles : accountTokenRoles(app, subject?.roles ?? []);
    if (
      !subject ||
      !actor ||
      subject.accountId !== record.subject.id ||
      actor.accountId !== record.createdBy ||
      (now !== undefined && now >= record.expiresAt) ||
      record.roles.some((role) => !granted.includes(role) || !apiRoles.includes(role))
    )
      return refuse();
    if (
      record.operations?.some(
        (id) =>
          !catalog.operations.some(
            (operation) => operation.id === id && operation.eligibleRoles.some((role) => record.roles.includes(role)),
          ),
      )
    )
      return refuse();
  };
  const mint = () => {
    const secret = mintApiTokenSecret(record.appId, record.id);
    return Object.freeze({
      stored: Object.freeze({ record, format: 'twa1' as const, digest: secret.digest, version: '1' as const }),
      result: Object.freeze({ token: secret.token, tokenId: record.id, version: '1' as const }),
    });
  };
  return Object.freeze({ record, admit, mint });
}
