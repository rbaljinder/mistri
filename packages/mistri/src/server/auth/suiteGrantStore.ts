/** Suite-owned App grants, separate from sign-in and business rows. This is a
 * trusted maintenance port, not an HTTP authorizer: its caller must establish
 * operator or App-administrator authority before changing a grant. The caller
 * also owns file separation, the database handle, and its lifetime. Its rules
 * (the validators, stored-row readers and refusals exported here) are the
 * PostgreSQL ledger's too (suiteStoresPostgres.ts), so the two cannot drift. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { layoutRefusal, sqliteLayoutVersion } from '@mistriwork/engine/adapters/layoutRefusal.js';
import { captureTenantData, tenantRecord } from '@mistriwork/engine/server/evidence.js';
import {
  SUITE_INVITATIONS_MAX_OFFSET,
  SUITE_INVITATIONS_PAGE,
  SUITE_ACCESS_PAGE,
  type SuiteAccessView,
  type SuiteGrantView,
  type SuiteInvitationsView,
  type SuiteInvitationStatus,
  type SuiteInvitationSummary,
} from '../../shared/suiteAdministration.js';

const ddl = [
  'CREATE TABLE suite_binding (suite_id TEXT PRIMARY KEY NOT NULL, version INTEGER NOT NULL CHECK(version = 1))',
  'CREATE TABLE suite_grant (app_id TEXT NOT NULL, subject_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0), roles TEXT NOT NULL, PRIMARY KEY(app_id, subject_id))',
  'CREATE TABLE suite_grant_audit (id TEXT PRIMARY KEY NOT NULL, app_id TEXT NOT NULL, subject_id TEXT NOT NULL, actor_id TEXT NOT NULL, at INTEGER NOT NULL, revision INTEGER NOT NULL, before_roles TEXT NOT NULL, after_roles TEXT NOT NULL, UNIQUE(app_id, subject_id, revision))',
  "CREATE TRIGGER suite_grant_audit_no_update BEFORE UPDATE ON suite_grant_audit BEGIN SELECT RAISE(ABORT, 'Suite grant audit is append-only.'); END",
  "CREATE TRIGGER suite_grant_audit_no_delete BEFORE DELETE ON suite_grant_audit BEGIN SELECT RAISE(ABORT, 'Suite grant audit is append-only.'); END",
  'CREATE TABLE suite_invitation (id TEXT PRIMARY KEY NOT NULL, app_id TEXT NOT NULL, subject_id TEXT NOT NULL, expected_revision INTEGER NOT NULL CHECK(expected_revision >= 0), roles TEXT NOT NULL, issuer_id TEXT NOT NULL, administrator_revision INTEGER NOT NULL CHECK(administrator_revision > 0), issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK(expires_at > issued_at), token_hash TEXT UNIQUE NOT NULL, consumed_at INTEGER, revoked_at INTEGER, CHECK(consumed_at IS NULL OR revoked_at IS NULL))',
  "CREATE TRIGGER suite_invitation_immutable BEFORE UPDATE OF id, app_id, subject_id, expected_revision, roles, issuer_id, administrator_revision, issued_at, expires_at, token_hash ON suite_invitation BEGIN SELECT RAISE(ABORT, 'Suite invitation is immutable.'); END",
  "CREATE TRIGGER suite_invitation_terminal BEFORE UPDATE ON suite_invitation WHEN OLD.consumed_at IS NOT NULL OR OLD.revoked_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'Suite invitation is terminal.'); END",
  "CREATE TRIGGER suite_invitation_no_delete BEFORE DELETE ON suite_invitation BEGIN SELECT RAISE(ABORT, 'Suite invitation tombstones are permanent.'); END",
  "CREATE TABLE suite_invitation_audit (id TEXT PRIMARY KEY NOT NULL, invitation_id TEXT NOT NULL, app_id TEXT NOT NULL, subject_id TEXT NOT NULL, actor_id TEXT NOT NULL, at INTEGER NOT NULL, event TEXT NOT NULL CHECK(event IN ('issue', 'accept', 'revoke')), UNIQUE(invitation_id, event))",
  "CREATE TRIGGER suite_invitation_audit_no_update BEFORE UPDATE ON suite_invitation_audit BEGIN SELECT RAISE(ABORT, 'Suite invitation audit is append-only.'); END",
  "CREATE TRIGGER suite_invitation_audit_no_delete BEFORE DELETE ON suite_invitation_audit BEGIN SELECT RAISE(ABORT, 'Suite invitation audit is append-only.'); END",
] as const;
/** The actor of a grant derived from an identity provider's claims; reserved, so a hand-set grant is never mistaken for one. */
export const PROVIDER_ACTOR = 'provider:';
/** The message says which way the layout differs where the version row does (layoutRefusal.ts); otherwise only that the store is unavailable. */
class SuiteGrantStoreUnavailable extends Error {
  constructor(message = 'Suite grant storage is unavailable.') {
    super(message);
    this.name = 'SuiteGrantStoreUnavailable';
  }
}
export const unavailable = (message?: string): never => {
  throw new SuiteGrantStoreUnavailable(message);
};
const SUITE_GRANT_STORE_VERSION = 1;
export const invalid = (): never => {
  throw new Error('Invalid suite grant.');
};
export const identifier = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 1024 && value.trim() === value && !/[\p{Cc}\p{Cs}]/u.test(value);
export const appName = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);

export function rolesOf(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 256) return invalid();
  for (let index = 0; index < value.length; index++) {
    if (
      !Object.hasOwn(value, index) ||
      typeof value[index] !== 'string' ||
      !/^[a-z][a-z0-9_-]*$/i.test(value[index]) ||
      ['constructor', 'prototype', '__proto__'].includes(value[index])
    )
      return invalid();
  }
  if (new Set(value).size !== value.length) return invalid();
  return [...value];
}

function transaction<T>(db: DatabaseSync, work: () => T): T {
  if (db.isTransaction) return unavailable();
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = work();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

/** Explicit provisioning only, into an empty caller-owned database. Never
 * install a grant ledger in an existing auth store or business database. */
export function provisionSuiteGrantStore(db: DatabaseSync, suiteId: string): void {
  if (!appName(suiteId)) return invalid();
  transaction(db, () => {
    if (db.prepare('SELECT 1 FROM main.sqlite_schema LIMIT 1').get()) return unavailable();
    for (const sql of ddl) db.exec(sql);
    db.prepare('INSERT INTO suite_binding VALUES (?, 1)').run(suiteId);
  });
}

interface SuiteGrant {
  readonly revision: number;
  readonly roles: readonly string[];
}
interface SuiteGrantChange {
  appId: string;
  subjectId: string;
  actorId: string;
  expectedRevision: number;
  declaredRoles: readonly string[];
  /** Empty means revoked; retaining the revision prevents stale re-grants. */
  roles: readonly string[];
}
export class SuiteGrantConflict extends Error {
  constructor() {
    super('The App grant changed. Read its current revision before trying again.');
  }
}
interface SuiteInvitationIssue extends SuiteGrantChange {
  expiresAt: number;
}
interface SuiteInvitationAccept {
  appId: string;
  subjectId: string;
  token: string;
  declaredRoles: readonly string[];
}
interface SuiteInvitationRevoke {
  appId: string;
  id: string;
  actorId: string;
}
interface SuiteAdministrationRead {
  appId: string;
  subjectId: string;
  actorId: string;
  declaredRoles: readonly string[];
}
export class SuiteInvitationRefused extends Error {
  constructor() {
    super('The App invitation is unavailable.');
  }
}
export const refuseInvitation = (): never => {
  throw new SuiteInvitationRefused();
};
export const grantFields = ['appId', 'subjectId', 'actorId', 'expectedRevision', 'declaredRoles', 'roles'] as const;
export const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export const storedRoles = (text: unknown) => {
  if (typeof text !== 'string') return unavailable();
  try {
    return Object.freeze(rolesOf(JSON.parse(text)));
  } catch {
    return unavailable();
  }
};
/** One grant audit row as the Console reads it; a row that is not what this store wrote is unreadable. */
export const storedChange = (row: Record<string, unknown>) => {
  if (
    typeof row.subject_id !== 'string' ||
    typeof row.actor_id !== 'string' ||
    typeof row.at !== 'number' ||
    typeof row.revision !== 'number' ||
    typeof row.id !== 'string'
  )
    return unavailable();
  return Object.freeze({
    id: row.id,
    subjectId: row.subject_id,
    actorId: row.actor_id,
    at: row.at,
    revision: row.revision,
    before: storedRoles(row.before_roles),
    after: storedRoles(row.after_roles),
  });
};
export const tokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');

export function administratorRevision(authority: { administratorRevision: number }): number {
  const value = captureTenantData(authority);
  tenantRecord(value, ['administratorRevision']);
  if (!Number.isSafeInteger(value.administratorRevision) || value.administratorRevision < 1) return invalid();
  return value.administratorRevision;
}

export function grantRoles(value: SuiteGrantChange): string[] {
  if (
    !appName(value.appId) ||
    !identifier(value.subjectId) ||
    !identifier(value.actorId) ||
    !Number.isSafeInteger(value.expectedRevision) ||
    value.expectedRevision < 0 ||
    value.expectedRevision >= Number.MAX_SAFE_INTEGER
  )
    return invalid();
  const declared = rolesOf(value.declaredRoles),
    roles = rolesOf(value.roles);
  if (roles.some((role) => !declared.includes(role))) return invalid();
  return roles;
}

/** Open an existing, exactly recognized ledger. Never migrate or repair it. */
export function openSuiteGrantStore(db: DatabaseSync, suiteId: string) {
  if (!appName(suiteId)) return invalid();
  const binding = () => {
    const rows = db.prepare('SELECT suite_id, version FROM main.suite_binding').all();
    if (rows.length !== 1 || rows[0].suite_id !== suiteId || rows[0].version !== SUITE_GRANT_STORE_VERSION)
      return unavailable(
        layoutRefusal('The suite grant store', rows.length === 1 ? rows[0].version : undefined, SUITE_GRANT_STORE_VERSION),
      );
  };
  try {
    if (
      db
        .prepare('PRAGMA database_list')
        .all()
        .some((row) => row.name !== 'main' && row.name !== 'temp') ||
      db.prepare('SELECT 1 FROM temp.sqlite_schema LIMIT 1').get()
    )
      return unavailable();
    const schema = db
      .prepare('SELECT sql FROM main.sqlite_schema WHERE sql IS NOT NULL')
      .all()
      .map((row) => row.sql)
      .sort();
    const expected = [...ddl].sort();
    if (schema.length !== expected.length || schema.some((sql, i) => sql !== expected[i]))
      return unavailable(layoutRefusal('The suite grant store', sqliteLayoutVersion(db, 'suite_binding'), SUITE_GRANT_STORE_VERSION));
    binding();
  } catch (error) {
    if (error instanceof SuiteGrantStoreUnavailable) throw error;
    return unavailable();
  }

  const read = (subjectId: string, appId: string): SuiteGrant => {
    if (!identifier(subjectId) || !appName(appId)) return invalid();
    binding();
    const row = db.prepare('SELECT revision, roles FROM main.suite_grant WHERE app_id = ? AND subject_id = ?').get(appId, subjectId);
    if (!row) return Object.freeze({ revision: 0, roles: Object.freeze([]) });
    if (typeof row.revision !== 'number' || !Number.isSafeInteger(row.revision) || row.revision < 1 || typeof row.roles !== 'string')
      return unavailable();
    try {
      return Object.freeze({ revision: row.revision, roles: Object.freeze(rolesOf(JSON.parse(row.roles))) });
    } catch {
      return unavailable();
    }
  };
  /** The identity provider a grant was derived from (its latest change was the provider's), or undefined for a hand-set grant. */
  const derivedFrom = (subjectId: string, appId: string): string | undefined => {
    const last = db
      .prepare('SELECT actor_id FROM main.suite_grant_audit WHERE app_id = ? AND subject_id = ? ORDER BY revision DESC LIMIT 1')
      .get(appId, subjectId);
    if (!last) return undefined;
    if (typeof last.actor_id !== 'string') return unavailable();
    return last.actor_id.startsWith(PROVIDER_ACTOR) ? last.actor_id.slice(PROVIDER_ACTOR.length) : undefined;
  };
  const isAdministrator = (actorId: string, appId: string, revision: number, declared?: readonly string[]): boolean => {
    const actor = read(actorId, appId);
    return (
      actor.roles.includes('admin') && actor.revision === revision && (!declared || actor.roles.every((role) => declared.includes(role)))
    );
  };
  // The caller holds BEGIN IMMEDIATE, including invitation consumption.
  const changeInTransaction = (value: SuiteGrantChange, roles: readonly string[], at: number): SuiteGrant => {
    const previous = read(value.subjectId, value.appId);
    if (previous.revision !== value.expectedRevision) throw new SuiteGrantConflict();
    const revision = previous.revision + 1;
    const after = JSON.stringify(roles);
    db.prepare(`INSERT INTO main.suite_grant VALUES (?, ?, ?, ?)
      ON CONFLICT(app_id, subject_id) DO UPDATE SET revision = excluded.revision, roles = excluded.roles`).run(
      value.appId,
      value.subjectId,
      revision,
      after,
    );
    db.prepare('INSERT INTO main.suite_grant_audit VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      randomUUID(),
      value.appId,
      value.subjectId,
      value.actorId,
      at,
      revision,
      JSON.stringify(previous.roles),
      after,
    );
    return Object.freeze({ revision, roles: Object.freeze([...roles]) });
  };
  const invitationAudit = (
    id: string,
    appId: string,
    subjectId: string,
    actorId: string,
    at: number,
    event: 'issue' | 'accept' | 'revoke',
  ): void => {
    db.prepare('INSERT INTO main.suite_invitation_audit VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      randomUUID(),
      id,
      appId,
      subjectId,
      actorId,
      at,
      event,
    );
  };
  const authorizeRead = (value: SuiteAdministrationRead, revision: number) => {
    if (!appName(value.appId) || !identifier(value.subjectId) || !identifier(value.actorId)) return invalid();
    const declared = rolesOf(value.declaredRoles);
    if (!isAdministrator(value.actorId, value.appId, revision, declared)) return refuseInvitation();
    return declared;
  };
  return Object.freeze({
    /** What the account holds, for administration and account lookups. A session's authority is `readForSession`. */
    read,
    /**
     * The grant a signed-in session may use. A grant derived from an identity
     * provider's claims is the provider's to give, and only for as long as it
     * says so: it counts for a session that provider opened, never for a
     * password session of the same account or one another provider opened,
     * which could otherwise keep roles the provider has since taken away. A
     * hand-set grant counts for any session. `provider` is the provider that
     * opened the session, or undefined for any other sign-in.
     */
    readForSession: (subjectId: string, appId: string, session: Readonly<{ provider: string | undefined }>): SuiteGrant => {
      const grant = read(subjectId, appId);
      if (!grant.roles.length) return grant;
      const from = derivedFrom(subjectId, appId);
      return from === undefined || from === session?.provider
        ? grant
        : Object.freeze({ revision: grant.revision, roles: Object.freeze([]) });
    },
    readAdministration: (input: SuiteAdministrationRead, authority: { administratorRevision: number }): SuiteGrantView => {
      const value = captureTenantData(input);
      tenantRecord(value, ['appId', 'subjectId', 'actorId', 'declaredRoles']);
      const revision = administratorRevision(authority);
      return transaction(db, () => {
        const declared = authorizeRead(value, revision);
        return {
          accountId: value.actorId,
          appId: value.appId,
          subjectId: value.subjectId,
          ...read(value.subjectId, value.appId),
          assignableRoles: declared,
        };
      });
    },
    /**
     * Who holds a role in one App, and the latest grant changes there: the
     * Console's Governance room. The same administrator check as reading one
     * account's grant, with the caller as the account read.
     */
    listAccess: (input: Omit<SuiteAdministrationRead, 'subjectId'>, authority: { administratorRevision: number }): SuiteAccessView => {
      const value = captureTenantData(input);
      tenantRecord(value, ['appId', 'actorId', 'declaredRoles']);
      const revision = administratorRevision(authority);
      return transaction(db, () => {
        authorizeRead({ ...value, subjectId: value.actorId }, revision);
        const holders = db
          .prepare(
            "SELECT subject_id, revision, roles FROM main.suite_grant WHERE app_id = ? AND roles <> '[]' ORDER BY subject_id LIMIT ?",
          )
          .all(value.appId, SUITE_ACCESS_PAGE + 1);
        const changes = db
          .prepare(
            'SELECT id, subject_id, actor_id, at, revision, before_roles, after_roles FROM main.suite_grant_audit WHERE app_id = ? ORDER BY at DESC, id DESC LIMIT ?',
          )
          .all(value.appId, SUITE_ACCESS_PAGE);
        return Object.freeze({
          appId: value.appId,
          grants: Object.freeze(
            holders.slice(0, SUITE_ACCESS_PAGE).map((row) => {
              if (typeof row.subject_id !== 'string' || typeof row.revision !== 'number') return unavailable();
              return Object.freeze({ subjectId: row.subject_id, revision: row.revision, roles: storedRoles(row.roles) });
            }),
          ),
          changes: Object.freeze(changes.map(storedChange)),
          more: holders.length > SUITE_ACCESS_PAGE,
        });
      });
    },
    /**
     * One App's grant changes, newest first, for the Console's audit feed:
     * the same administrator check as listAccess. `actor` is who made the
     * change; `from`/`to` are epoch ms, `[from, to)`; `before` is the last
     * change of the page before.
     */
    listAccessChanges: (
      input: Omit<SuiteAdministrationRead, 'subjectId'>,
      authority: { administratorRevision: number },
      query: { actor?: string; from?: number; to?: number; before?: { at: number; id: string }; limit: number },
    ): SuiteAccessView['changes'] => {
      const value = captureTenantData(input);
      tenantRecord(value, ['appId', 'actorId', 'declaredRoles']);
      const revision = administratorRevision(authority);
      if (
        (query.actor !== undefined && (typeof query.actor !== 'string' || !query.actor)) ||
        (query.from !== undefined && !timestamp(query.from)) ||
        (query.to !== undefined && !timestamp(query.to)) ||
        (query.before !== undefined && (!timestamp(query.before.at) || typeof query.before.id !== 'string')) ||
        !Number.isSafeInteger(query.limit) ||
        query.limit < 1 ||
        query.limit > SUITE_ACCESS_PAGE
      )
        return invalid();
      return transaction(db, () => {
        authorizeRead({ ...value, subjectId: value.actorId }, revision);
        const where = ['app_id = ?'],
          params: (string | number)[] = [value.appId];
        const and = (clause: string, ...values: (string | number)[]) => {
          where.push(clause);
          params.push(...values);
        };
        if (query.actor !== undefined) and('actor_id = ?', query.actor);
        if (query.from !== undefined) and('at >= ?', query.from);
        if (query.to !== undefined) and('at < ?', query.to);
        if (query.before) and('(at < ? OR (at = ? AND id < ?))', query.before.at, query.before.at, query.before.id);
        const rows = db
          .prepare(
            `SELECT id, subject_id, actor_id, at, revision, before_roles, after_roles FROM main.suite_grant_audit WHERE ${where.join(' AND ')} ORDER BY at DESC, id DESC LIMIT ?`,
          )
          .all(...params, query.limit);
        return Object.freeze(rows.map(storedChange));
      });
    },
    listInvitations: (
      input: SuiteAdministrationRead & { offset: number },
      authority: { administratorRevision: number },
      now = Date.now(),
    ): SuiteInvitationsView => {
      const value = captureTenantData(input);
      tenantRecord(value, ['appId', 'subjectId', 'actorId', 'declaredRoles', 'offset']);
      const revision = administratorRevision(authority);
      if (!Number.isSafeInteger(value.offset) || value.offset < 0 || value.offset > SUITE_INVITATIONS_MAX_OFFSET || !timestamp(now))
        return invalid();
      return transaction(db, () => {
        const declared = authorizeRead(value, revision),
          target = read(value.subjectId, value.appId);
        const total = db
          .prepare('SELECT count(*) AS n FROM main.suite_invitation WHERE app_id = ? AND subject_id = ?')
          .get(value.appId, value.subjectId)!.n as number;
        const rows = db
          .prepare(`SELECT id, roles, expected_revision, issuer_id, administrator_revision, issued_at, expires_at, consumed_at, revoked_at
          FROM main.suite_invitation WHERE app_id = ? AND subject_id = ? ORDER BY issued_at DESC, id DESC LIMIT ? OFFSET ?`)
          .all(value.appId, value.subjectId, SUITE_INVITATIONS_PAGE, value.offset);
        const invitations: SuiteInvitationSummary[] = rows.map((row) => {
          if (
            !identifier(row.id) ||
            !identifier(row.issuer_id) ||
            typeof row.roles !== 'string' ||
            !timestamp(row.expected_revision) ||
            row.expected_revision >= Number.MAX_SAFE_INTEGER ||
            !timestamp(row.administrator_revision) ||
            row.administrator_revision < 1 ||
            !timestamp(row.issued_at) ||
            !timestamp(row.expires_at) ||
            (row.consumed_at !== null && !timestamp(row.consumed_at)) ||
            (row.revoked_at !== null && !timestamp(row.revoked_at))
          )
            return unavailable();
          const roles = rolesOf(JSON.parse(row.roles));
          const status: SuiteInvitationStatus =
            row.consumed_at !== null
              ? 'consumed'
              : row.revoked_at !== null
                ? 'revoked'
                : now >= row.expires_at
                  ? 'expired'
                  : now < row.issued_at
                    ? 'not-yet-valid'
                    : !isAdministrator(row.issuer_id, value.appId, row.administrator_revision, declared)
                      ? 'issuer-changed'
                      : row.expected_revision !== target.revision
                        ? 'target-changed'
                        : !roles.length || roles.some((role) => !declared.includes(role))
                          ? 'roles-changed'
                          : 'pending';
          return {
            id: row.id,
            roles,
            expectedRevision: row.expected_revision,
            actorId: row.issuer_id,
            issuedAt: row.issued_at,
            expiresAt: row.expires_at,
            status,
            canRevoke: row.consumed_at === null && row.revoked_at === null && now >= row.issued_at,
          };
        });
        return { accountId: value.actorId, appId: value.appId, subjectId: value.subjectId, invitations, total, offset: value.offset };
      });
    },
    lookup: async (subjectId: string, appId: string): Promise<readonly string[] | null> => {
      const { roles } = read(subjectId, appId);
      return roles.length ? [...roles] : null;
    },
    /**
     * The grant an identity provider's claims give (an App's `auth.roles.<role>.claims`), derived at each
     * sign-in through it. A grant an administrator set by hand — granted, narrowed or revoked — is never
     * changed here, so claims never widen it; a derived grant follows the claims, and is revoked when
     * they no longer give a role. Each change is audited with the provider as its actor.
     */
    deriveFromClaims: (
      input: { appId: string; subjectId: string; provider: string; declaredRoles: readonly string[]; roles: readonly string[] },
      now = Date.now(),
    ): SuiteGrant => {
      const value = captureTenantData(input);
      tenantRecord(value, ['appId', 'subjectId', 'provider', 'declaredRoles', 'roles']);
      if (!appName(value.provider)) return invalid();
      const actorId = `${PROVIDER_ACTOR}${value.provider}`;
      return transaction(db, () => {
        const current = read(value.subjectId, value.appId);
        const last = db
          .prepare('SELECT actor_id FROM main.suite_grant_audit WHERE app_id = ? AND subject_id = ? ORDER BY revision DESC LIMIT 1')
          .get(value.appId, value.subjectId);
        if (last && (typeof last.actor_id !== 'string' || !last.actor_id.startsWith(PROVIDER_ACTOR))) return current;
        const change = {
          appId: value.appId,
          subjectId: value.subjectId,
          actorId,
          expectedRevision: current.revision,
          declaredRoles: value.declaredRoles,
          roles: value.roles,
        };
        const roles = grantRoles(change);
        if (roles.length === current.roles.length && roles.every((role) => current.roles.includes(role))) return current;
        return changeInTransaction(change, roles, now);
      });
    },
    change: (input: SuiteGrantChange, authority?: { administratorRevision: number }): SuiteGrant => {
      const value = captureTenantData(input);
      tenantRecord(value, grantFields);
      const roles = grantRoles(value);
      // The provider prefix says a grant was derived from claims: no person or operator may write under it.
      if (value.actorId.startsWith(PROVIDER_ACTOR)) return invalid();
      const revision = authority === undefined ? undefined : administratorRevision(authority);
      return transaction(db, () => {
        // App-administrator callers recheck their grant under the same write
        // reservation as the target change. Operator maintenance omits this.
        if (revision !== undefined && !isAdministrator(value.actorId, value.appId, revision)) {
          throw new Error('The App administrator grant changed or is unavailable.');
        }
        return changeInTransaction(value, roles, Date.now());
      });
    },
    /** The caller verifies that subjectId exists in the shared suite identity.
     * The bearer token is returned once; no email or session grants authority. */
    issueInvitation: (input: SuiteInvitationIssue, authority: { administratorRevision: number }, now = Date.now()) => {
      const value = captureTenantData(input);
      tenantRecord(value, [...grantFields, 'expiresAt']);
      const roles = grantRoles(value),
        revision = administratorRevision(authority);
      if (
        !roles.length ||
        !timestamp(now) ||
        !timestamp(value.expiresAt) ||
        value.expiresAt <= now ||
        value.expiresAt - now > 7 * 24 * 60 * 60 * 1000
      )
        return invalid();
      return transaction(db, () => {
        if (!isAdministrator(value.actorId, value.appId, revision, value.declaredRoles)) return refuseInvitation();
        if (read(value.subjectId, value.appId).revision !== value.expectedRevision) throw new SuiteGrantConflict();
        const id = randomUUID(),
          token = randomBytes(32).toString('base64url');
        db.prepare('INSERT INTO main.suite_invitation VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)').run(
          id,
          value.appId,
          value.subjectId,
          value.expectedRevision,
          JSON.stringify(roles),
          value.actorId,
          revision,
          now,
          value.expiresAt,
          tokenHash(token),
        );
        invitationAudit(id, value.appId, value.subjectId, value.actorId, now, 'issue');
        return Object.freeze({
          id,
          token,
          appId: value.appId,
          subjectId: value.subjectId,
          expectedRevision: value.expectedRevision,
          roles: Object.freeze(roles),
          actorId: value.actorId,
          administratorRevision: revision,
          issuedAt: now,
          expiresAt: value.expiresAt,
        });
      });
    },
    acceptInvitation: (input: SuiteInvitationAccept, now = Date.now()): SuiteGrant => {
      const value = captureTenantData(input);
      tenantRecord(value, ['appId', 'subjectId', 'token', 'declaredRoles']);
      if (
        !appName(value.appId) ||
        !identifier(value.subjectId) ||
        typeof value.token !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(value.token) ||
        !timestamp(now)
      )
        return refuseInvitation();
      const declared = rolesOf(value.declaredRoles);
      return transaction(db, () => {
        binding();
        const row = db
          .prepare('SELECT * FROM main.suite_invitation WHERE app_id = ? AND subject_id = ? AND token_hash = ?')
          .get(value.appId, value.subjectId, tokenHash(value.token));
        if (!row || row.consumed_at !== null || row.revoked_at !== null) return refuseInvitation();
        if (
          !identifier(row.id) ||
          !identifier(row.issuer_id) ||
          typeof row.roles !== 'string' ||
          !timestamp(row.expires_at) ||
          !timestamp(row.issued_at) ||
          !timestamp(row.expected_revision) ||
          row.expected_revision >= Number.MAX_SAFE_INTEGER ||
          !timestamp(row.administrator_revision) ||
          row.administrator_revision < 1
        )
          return unavailable();
        if (
          now < row.issued_at ||
          now >= row.expires_at ||
          !isAdministrator(row.issuer_id, value.appId, row.administrator_revision, declared)
        )
          return refuseInvitation();
        let roles: string[];
        try {
          roles = rolesOf(JSON.parse(row.roles));
        } catch {
          return unavailable();
        }
        if (!roles.length || roles.some((role) => !declared.includes(role))) return refuseInvitation();
        const grant = changeInTransaction(
          {
            appId: value.appId,
            subjectId: value.subjectId,
            actorId: row.issuer_id,
            expectedRevision: row.expected_revision,
            declaredRoles: declared,
            roles,
          },
          roles,
          now,
        );
        db.prepare('UPDATE main.suite_invitation SET consumed_at = ? WHERE id = ?').run(now, row.id);
        invitationAudit(row.id, value.appId, value.subjectId, value.subjectId, now, 'accept');
        return grant;
      });
    },
    revokeInvitation: (input: SuiteInvitationRevoke, authority: { administratorRevision: number }, now = Date.now()): void => {
      const value = captureTenantData(input);
      tenantRecord(value, ['appId', 'id', 'actorId']);
      if (!appName(value.appId) || !identifier(value.id) || !identifier(value.actorId) || !timestamp(now)) return invalid();
      const revision = administratorRevision(authority);
      transaction(db, () => {
        if (!isAdministrator(value.actorId, value.appId, revision)) return refuseInvitation();
        const row = db
          .prepare('SELECT subject_id, issued_at, consumed_at, revoked_at FROM main.suite_invitation WHERE app_id = ? AND id = ?')
          .get(value.appId, value.id);
        if (!row || row.consumed_at !== null || row.revoked_at !== null) return refuseInvitation();
        if (!identifier(row.subject_id) || !timestamp(row.issued_at)) return unavailable();
        if (now < row.issued_at) return refuseInvitation();
        db.prepare('UPDATE main.suite_invitation SET revoked_at = ? WHERE id = ?').run(now, value.id);
        invitationAudit(value.id, value.appId, row.subject_id, value.actorId, now, 'revoke');
      });
    },
  });
}
