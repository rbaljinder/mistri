/** Private current-layout check for explicit token maintenance. This is not
 * cookie-auth startup policy, file ownership, or evidence of a file's history.
 * The owner must open an existing separated file and fence its identity.
 * Exact DDL comes from this build's actual createAppAuth migration fixture;
 * unrecognized spellings refuse here without rewriting their storage.
 */
import { DatabaseSync } from 'node:sqlite';
import { SQLITE_API_TOKEN_CATALOG } from './sqliteApiTokenLayout.js';

/* The account-administration trail is append-only (server/auth/accountAudit.ts):
   SQLite has no privileges to revoke, so an update or a delete of a row is an error. */
const APPEND_ONLY = "BEGIN SELECT RAISE(ABORT, 'The account audit trail is append-only.'); END";
export const SQLITE_ACCOUNT_AUDIT_TRIGGERS: readonly (readonly [string, string])[] = Object.freeze([
  ['accountAudit_no_delete', `CREATE TRIGGER "accountAudit_no_delete" BEFORE DELETE ON "accountAudit" ${APPEND_ONLY}`],
  ['accountAudit_no_update', `CREATE TRIGGER "accountAudit_no_update" BEFORE UPDATE ON "accountAudit" ${APPEND_ONLY}`],
] as const);

/** The store's version row. */
export const SQLITE_AUTH_META_TABLE = '__mistri_auth_meta';
export const SQLITE_AUTH_STORE_VERSION = 1;
/** The version row's table, which pins its version in a CHECK. */
const sqliteAuthMetaDdl = (version: number): string => `CREATE TABLE "${SQLITE_AUTH_META_TABLE}" (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL CHECK (version = ${version})
)`;
export const SQLITE_AUTH_META_DDL = sqliteAuthMetaDdl(SQLITE_AUTH_STORE_VERSION);

const tables: Readonly<Record<string, string>> = Object.freeze({
  accountAudit:
    'CREATE TABLE "accountAudit" ("id" text not null primary key, "createdAt" date not null, "action" text not null, "actorId" text not null, "actorEmail" text not null, "principal" text not null, "targetId" text not null, "targetEmail" text not null, "before" text, "after" text)',
  account:
    'CREATE TABLE "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null)',
  session:
    'CREATE TABLE "session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade, "impersonatedBy" text)',
  user: 'CREATE TABLE "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null, "role" text, "banned" integer, "banReason" text, "banExpires" date)',
  verification:
    'CREATE TABLE "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null)',
});
const indexes = Object.freeze([
  ['accountAudit_createdAt_idx', 'accountAudit', 'CREATE INDEX "accountAudit_createdAt_idx" on "accountAudit" ("createdAt")'],
  ['accountAudit_targetId_idx', 'accountAudit', 'CREATE INDEX "accountAudit_targetId_idx" on "accountAudit" ("targetId")'],
  ['account_userId_idx', 'account', 'CREATE INDEX "account_userId_idx" on "account" ("userId")'],
  ['session_userId_idx', 'session', 'CREATE INDEX "session_userId_idx" on "session" ("userId")'],
  ['sqlite_autoindex_accountAudit_1', 'accountAudit', null],
  ['sqlite_autoindex_account_1', 'account', null],
  ['sqlite_autoindex_session_1', 'session', null],
  ['sqlite_autoindex_session_2', 'session', null],
  ['sqlite_autoindex_user_1', 'user', null],
  ['sqlite_autoindex_user_2', 'user', null],
  ['sqlite_autoindex_verification_1', 'verification', null],
  ['verification_identifier_idx', 'verification', 'CREATE INDEX "verification_identifier_idx" on "verification" ("identifier")'],
] as const);
/* Better Auth's own output for the identity plugin's schema, in the order it creates the tables. */
const identityTables: Readonly<Record<string, string>> = Object.freeze({
  idpSession:
    'CREATE TABLE "idpSession" ("id" text not null primary key, "sessionId" text not null references "session" ("id") on delete cascade, "provider" text not null, "issuer" text not null, "subject" text not null, "sid" text, "sessionIndex" text, "createdAt" date not null)',
  scimConnectionBinding:
    'CREATE TABLE "scimConnectionBinding" ("id" text not null primary key, "connectionId" text not null, "connectionKey" text not null unique, "provisioningDomainId" text not null, "createdAt" date not null, "decommissionedAt" date, "decommissionStatus" text not null, "decommissionCursorUserId" text, "decommissionReconciledUserCount" integer not null, "decommissionBatchCount" integer not null, "decommissionRevision" integer not null, "decommissionCompletedAt" date, "decommissionLeaseId" text, "decommissionLeaseExpiresAt" date)',
  scimIdentityTombstone:
    'CREATE TABLE "scimIdentityTombstone" ("id" text not null primary key, "connectionId" text not null, "provisioningDomainId" text not null, "externalId" text not null, "externalIdKey" text not null unique, "userId" text not null references "user" ("id") on delete cascade, "profile" text not null, "deletedAt" date not null)',
  scimSubject:
    'CREATE TABLE "scimSubject" ("id" text not null primary key, "userId" text not null unique references "user" ("id") on delete cascade, "profileSourceId" text, "revision" integer not null, "createdAt" date not null, "updatedAt" date not null)',
  scimUser:
    'CREATE TABLE "scimUser" ("id" text not null primary key, "connectionId" text not null, "provisioningDomainId" text not null, "userId" text not null references "user" ("id") on delete cascade, "connectionUserKey" text not null unique, "userName" text not null, "userNameKey" text not null unique, "primaryEmail" text not null, "workEmailValueIndex" text not null, "emailValueIndex" text not null, "displayName" text not null, "formattedName" text not null, "givenName" text, "familyName" text, "serializedEmails" text not null, "serializedAttributes" text, "externalId" text, "externalIdKey" text unique, "active" integer not null, "orderKey" text not null unique, "createdAt" date not null, "updatedAt" date not null)',
  scimProjectionGrant:
    'CREATE TABLE "scimProjectionGrant" ("id" text not null primary key, "connectionId" text not null, "provisioningDomainId" text not null, "scimUserId" text not null references "scimUser" ("id") on delete cascade, "userId" text not null references "user" ("id") on delete cascade, "sourceKind" text not null, "sourceId" text not null, "sourceValue" text, "role" text not null, "grantKey" text not null unique, "createdAt" date not null, "updatedAt" date not null)',
  scimGroup:
    'CREATE TABLE "scimGroup" ("id" text not null primary key, "connectionId" text not null, "provisioningDomainId" text not null, "revision" integer not null, "displayName" text not null, "displayNameKey" text not null unique, "externalId" text, "externalIdKey" text unique, "orderKey" text not null unique, "createdAt" date not null, "updatedAt" date not null)',
  scimGroupMember:
    'CREATE TABLE "scimGroupMember" ("id" text not null primary key, "connectionId" text not null, "groupId" text not null references "scimGroup" ("id") on delete cascade, "scimUserId" text not null references "scimUser" ("id") on delete cascade, "membershipKey" text not null unique, "createdAt" date not null)',
});
const identityIndexes = Object.freeze([
  ['idpSession_sessionId_idx', 'idpSession', 'CREATE INDEX "idpSession_sessionId_idx" on "idpSession" ("sessionId")'],
  ['idpSession_sid_idx', 'idpSession', 'CREATE INDEX "idpSession_sid_idx" on "idpSession" ("sid")'],
  ['idpSession_subject_idx', 'idpSession', 'CREATE INDEX "idpSession_subject_idx" on "idpSession" ("subject")'],
  [
    'scimConnectionBinding_connectionId_idx',
    'scimConnectionBinding',
    'CREATE INDEX "scimConnectionBinding_connectionId_idx" on "scimConnectionBinding" ("connectionId")',
  ],
  [
    'scimGroupMember_connectionId_idx',
    'scimGroupMember',
    'CREATE INDEX "scimGroupMember_connectionId_idx" on "scimGroupMember" ("connectionId")',
  ],
  ['scimGroupMember_groupId_idx', 'scimGroupMember', 'CREATE INDEX "scimGroupMember_groupId_idx" on "scimGroupMember" ("groupId")'],
  [
    'scimGroupMember_scimUserId_idx',
    'scimGroupMember',
    'CREATE INDEX "scimGroupMember_scimUserId_idx" on "scimGroupMember" ("scimUserId")',
  ],
  ['scimGroup_connectionId_idx', 'scimGroup', 'CREATE INDEX "scimGroup_connectionId_idx" on "scimGroup" ("connectionId")'],
  [
    'scimGroup_provisioningDomainId_idx',
    'scimGroup',
    'CREATE INDEX "scimGroup_provisioningDomainId_idx" on "scimGroup" ("provisioningDomainId")',
  ],
  [
    'scimIdentityTombstone_connectionId_idx',
    'scimIdentityTombstone',
    'CREATE INDEX "scimIdentityTombstone_connectionId_idx" on "scimIdentityTombstone" ("connectionId")',
  ],
  [
    'scimIdentityTombstone_provisioningDomainId_idx',
    'scimIdentityTombstone',
    'CREATE INDEX "scimIdentityTombstone_provisioningDomainId_idx" on "scimIdentityTombstone" ("provisioningDomainId")',
  ],
  [
    'scimIdentityTombstone_userId_idx',
    'scimIdentityTombstone',
    'CREATE INDEX "scimIdentityTombstone_userId_idx" on "scimIdentityTombstone" ("userId")',
  ],
  [
    'scimProjectionGrant_connectionId_idx',
    'scimProjectionGrant',
    'CREATE INDEX "scimProjectionGrant_connectionId_idx" on "scimProjectionGrant" ("connectionId")',
  ],
  [
    'scimProjectionGrant_provisioningDomainId_idx',
    'scimProjectionGrant',
    'CREATE INDEX "scimProjectionGrant_provisioningDomainId_idx" on "scimProjectionGrant" ("provisioningDomainId")',
  ],
  [
    'scimProjectionGrant_scimUserId_idx',
    'scimProjectionGrant',
    'CREATE INDEX "scimProjectionGrant_scimUserId_idx" on "scimProjectionGrant" ("scimUserId")',
  ],
  [
    'scimProjectionGrant_userId_idx',
    'scimProjectionGrant',
    'CREATE INDEX "scimProjectionGrant_userId_idx" on "scimProjectionGrant" ("userId")',
  ],
  ['scimSubject_profileSourceId_idx', 'scimSubject', 'CREATE INDEX "scimSubject_profileSourceId_idx" on "scimSubject" ("profileSourceId")'],
  ['scimUser_connectionId_idx', 'scimUser', 'CREATE INDEX "scimUser_connectionId_idx" on "scimUser" ("connectionId")'],
  [
    'scimUser_provisioningDomainId_idx',
    'scimUser',
    'CREATE INDEX "scimUser_provisioningDomainId_idx" on "scimUser" ("provisioningDomainId")',
  ],
  ['scimUser_userId_idx', 'scimUser', 'CREATE INDEX "scimUser_userId_idx" on "scimUser" ("userId")'],
  ['sqlite_autoindex_idpSession_1', 'idpSession', null],
  ['sqlite_autoindex_scimConnectionBinding_1', 'scimConnectionBinding', null],
  ['sqlite_autoindex_scimConnectionBinding_2', 'scimConnectionBinding', null],
  ['sqlite_autoindex_scimGroupMember_1', 'scimGroupMember', null],
  ['sqlite_autoindex_scimGroupMember_2', 'scimGroupMember', null],
  ['sqlite_autoindex_scimGroup_1', 'scimGroup', null],
  ['sqlite_autoindex_scimGroup_2', 'scimGroup', null],
  ['sqlite_autoindex_scimGroup_3', 'scimGroup', null],
  ['sqlite_autoindex_scimGroup_4', 'scimGroup', null],
  ['sqlite_autoindex_scimIdentityTombstone_1', 'scimIdentityTombstone', null],
  ['sqlite_autoindex_scimIdentityTombstone_2', 'scimIdentityTombstone', null],
  ['sqlite_autoindex_scimProjectionGrant_1', 'scimProjectionGrant', null],
  ['sqlite_autoindex_scimProjectionGrant_2', 'scimProjectionGrant', null],
  ['sqlite_autoindex_scimSubject_1', 'scimSubject', null],
  ['sqlite_autoindex_scimSubject_2', 'scimSubject', null],
  ['sqlite_autoindex_scimUser_1', 'scimUser', null],
  ['sqlite_autoindex_scimUser_2', 'scimUser', null],
  ['sqlite_autoindex_scimUser_3', 'scimUser', null],
  ['sqlite_autoindex_scimUser_4', 'scimUser', null],
  ['sqlite_autoindex_scimUser_5', 'scimUser', null],
] as const);
type Entry = { type: string; name: string; tbl_name: string; sql: string | null };
// The catalog's own order: type, then name, each by code unit (COLLATE BINARY).
const byCatalog = (a: Entry, b: Entry) => (a.type < b.type ? -1 : a.type > b.type ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
/** The core tables, their indexes and the trail's triggers. */
const coreEntries = (): Entry[] =>
  [
    ...indexes.map(([name, table, sql]) => ({
      type: 'index',
      name,
      tbl_name: table,
      sql,
    })),
    ...Object.entries(tables).map(([name, sql]) => ({
      type: 'table',
      name,
      tbl_name: name,
      sql,
    })),
    ...SQLITE_ACCOUNT_AUDIT_TRIGGERS.map(([name, sql]) => ({
      type: 'trigger',
      name,
      tbl_name: 'accountAudit',
      sql,
    })),
  ].sort(byCatalog);
const metaEntry = (version: number): Entry => ({
  type: 'table',
  name: SQLITE_AUTH_META_TABLE,
  tbl_name: SQLITE_AUTH_META_TABLE,
  sql: sqliteAuthMetaDdl(version),
});
const identityEntries: Entry[] = [
  ...identityIndexes.map(([name, table, sql]) => ({ type: 'index', name, tbl_name: table, sql })),
  ...Object.entries(identityTables).map(([name, sql]) => ({ type: 'table', name, tbl_name: name, sql })),
];
const expected = [...coreEntries(), ...identityEntries, metaEntry(SQLITE_AUTH_STORE_VERSION)].sort(byCatalog);
const withTokens = [...expected, ...SQLITE_API_TOKEN_CATALOG].sort(byCatalog);
const refuse = (): never => {
  throw new Error('SQLite authentication layout is unavailable for token maintenance.');
};

/** Requires an owner-held native transaction; performs no schema/data writes.
 * This does not establish a write reservation: maintenance must BEGIN IMMEDIATE
 * itself and retain the same handle/transaction through its final check/commit.
 * This entry accepts only the exact core-only layout; the token variant has
 * its own fixed whole-layout check. No returned capability admits credentials.
 */
export function assertSqliteAuthCoreLayout(db: DatabaseSync): void {
  assertLayout(db, false);
}

/** Fixed second layout only. Extension row/binding and credential authorization
 * remain separate owner checks; no arbitrary extra-object allowance exists. */
export function assertSqliteAuthTokenLayout(db: DatabaseSync): void {
  assertLayout(db, true);
}

function assertLayout(db: DatabaseSync, tokens: boolean): void {
  try {
    if (!(db instanceof DatabaseSync) || !db.isTransaction) return refuse();
    if (db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1) return refuse();
    const databases = db.prepare('PRAGMA database_list').all();
    if (databases.some((row) => row.name !== 'main' && row.name !== 'temp')) return refuse();
    if (db.prepare('SELECT 1 FROM temp.sqlite_schema LIMIT 1').get()) return refuse();
    // Do not let embedded NULs hide suffixes through SQLite string functions
    // or a future driver conversion. No catalog spelling is normalized.
    if (
      db
        .prepare(`SELECT 1 FROM main.sqlite_schema WHERE
      instr(type, char(0)) OR instr(name, char(0)) OR instr(tbl_name, char(0)) OR instr(sql, char(0)) LIMIT 1`)
        .get()
    )
      return refuse();
    const actual = db
      .prepare('SELECT type, name, tbl_name, sql FROM main.sqlite_schema ORDER BY type COLLATE BINARY, name COLLATE BINARY')
      .all();
    const layout = tokens ? withTokens : expected;
    if (
      actual.length !== layout.length ||
      actual.some((row, index) => {
        const want = layout[index];
        return row.type !== want.type || row.name !== want.name || row.tbl_name !== want.tbl_name || row.sql !== want.sql;
      }) ||
      !db.isTransaction
    )
      return refuse();
  } catch {
    return refuse();
  }
}
