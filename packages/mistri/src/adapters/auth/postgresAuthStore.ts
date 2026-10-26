/**
 * The Better Auth session store on PostgreSQL.
 *
 * The file store is a SQLite database Better Auth migrates itself on start.
 * On PostgreSQL the layout is this file's, pinned: the tables Better Auth's
 * own `getMigrations` would create for the installed version (the core four
 * plus the admin plugin's columns), plus a meta row that says which version
 * of this layout is present.
 *
 * The tables are the runtime schema's (shared/runtimeTables.ts), each named
 * `auth_…`: Better Auth's own models are renamed with its `modelName` option
 * (`withPostgresAuthModels`), so `user` is `mistri.auth_user`. Better Auth's
 * Kysely adapter queries them by those plain names, and every statement the
 * `pg` pool it is handed runs carries `search_path=pg_catalog,mistri,pg_temp`,
 * so the names resolve in the runtime schema and nowhere else. The business
 * adapter never lists that schema and refuses a generic write into it
 * (`postgres.ts`).
 *
 * What is the same as the journal, and why: the migration is an explicit
 * maintenance step under the server-wide advisory lock, idempotent, and it
 * refuses a layout that is not exactly this one rather than altering it;
 * startup attests and never migrates. The attestation is a catalog
 * description of the `auth_` relations compared to the one the DDL produces,
 * because PostgreSQL does not keep CREATE text the way SQLite does.
 *
 * And, because the runtime resolves names inside the schema, the schema and
 * the store's tables in it have to be this role's alone: owned by it,
 * creatable in by nobody else, holding nothing but the runtime's tables
 * (`postgresRuntimeSchemaProblems`). Tables someone else prepared under these
 * names are refused by the migration, not adopted.
 */
import { Refusal } from '@mistriwork/engine/adapters/adapter.js';
import { RUNTIME_SCHEMA, runtimeTable } from '@mistriwork/engine/shared/runtimeTables.js';
import { layoutRefusal, postgresLayoutVersion } from '@mistriwork/engine/adapters/layoutRefusal.js';
import { postgresRuntimeSchemaProblems } from '@mistriwork/engine/adapters/postgresMaintenance.js';
import type { PgPool, PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import { withPostgresMaintenanceTransaction, type PostgresRelationDescription } from '../commands/postgresCommandJournal.js';
import { describePostgresRelations, foldRelations } from '../commands/postgresRelations.js';
import { canonicalCommandJson } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import { API_TOKEN_STORE_VERSION, postgresApiTokenCatalog } from './postgresApiTokenLayout.js';

/** The prefix every table of the store carries in the runtime schema: the
 * attestation, the ownership check and the store-layout tooling scan by it. */
export const POSTGRES_AUTH_PREFIX = 'auth_';
/** Each Better Auth model the store keeps, and the table it is kept in on
 * PostgreSQL. The file store keeps Better Auth's own names (`user`,
 * `session`, …): it is a file of its own, with nothing to tell them from. */
const POSTGRES_AUTH_TABLES = Object.freeze({
  user: 'auth_user',
  session: 'auth_session',
  account: 'auth_account',
  verification: 'auth_verification',
  accountAudit: 'auth_account_audit',
  idpSession: 'auth_idp_session',
  scimConnectionBinding: 'auth_scim_connection_binding',
  scimIdentityTombstone: 'auth_scim_identity_tombstone',
  scimSubject: 'auth_scim_subject',
  scimUser: 'auth_scim_user',
  scimProjectionGrant: 'auth_scim_projection_grant',
  scimGroup: 'auth_scim_group',
  scimGroupMember: 'auth_scim_group_member',
} as const);
type AuthModel = keyof typeof POSTGRES_AUTH_TABLES;
const T = POSTGRES_AUTH_TABLES;
/* The layout's version. A later layout is brought forward one version at a time by `mistri migrate stores up`
   (storeLayouts.ts); anything else is refused. */
const POSTGRES_AUTH_STORE_VERSION = 1;
/** The search path every statement Better Auth sends runs on, so its
 * unqualified table names resolve in the runtime schema and never in `public`.
 * `pg_catalog` is named first, explicitly, so no name in the schema can
 * shadow a built-in, and `pg_temp` last rather than its implicit first.
 * Better Auth's queries name their tables and nothing else unqualified, so
 * they resolve exactly as before. Set on each session, or behind a
 * transaction-mode pooler in each transaction (authStore.ts); never as a
 * startup `options` parameter, which a pooler does not carry to the server.
 * (Better Auth's migration planner, which the runtime never runs on
 * PostgreSQL, reads the path's first entry as the schema to plan in; the test
 * runs it with the schema alone.) */
export const POSTGRES_AUTH_SEARCH_PATH = `pg_catalog, ${RUNTIME_SCHEMA}, pg_temp`;

/**
 * Better Auth's options with every table the store keeps renamed to its
 * PostgreSQL name: the core models through their own `modelName`, and each
 * plugin's tables through theirs. Better Auth merges plugin schemas by model
 * key, the last one's `modelName` winning, so every plugin is renamed, the
 * admin plugin's columns on `user` and the SCIM plugin's copy of the identity
 * tables included. A plugin table the store does not pin is refused here, by
 * name, rather than by Better Auth's schema check at the first request.
 */
export function withPostgresAuthModels<O extends Record<string, unknown>>(options: O): O {
  const table = (model: string): string => {
    if (!Object.hasOwn(T, model)) throw new Error(`The PostgreSQL authentication store keeps no table for Better Auth's "${model}" model.`);
    return T[model as AuthModel];
  };
  const core = (model: 'user' | 'session' | 'account' | 'verification') => ({
    ...(options[model] as Record<string, unknown> | undefined),
    modelName: table(model),
  });
  const plugins = options.plugins as ReadonlyArray<{ schema?: Record<string, Record<string, unknown>> }> | undefined;
  return {
    ...options,
    user: core('user'),
    session: core('session'),
    account: core('account'),
    verification: core('verification'),
    ...(plugins
      ? {
          plugins: plugins.map((plugin) =>
            plugin.schema
              ? {
                  ...plugin,
                  schema: Object.fromEntries(
                    Object.entries(plugin.schema).map(([model, value]) => [model, { ...value, modelName: table(model) }]),
                  ),
                }
              : plugin,
          ),
        }
      : {}),
  };
}

/** Why the layout was refused, when the version row says: a newer or an older store (see layoutRefusal.ts). Best effort: a transaction the failure aborted cannot be read, and the generic message stands. */
async function layoutMessage(client: PgQuery): Promise<string | undefined> {
  return layoutRefusal(
    'The PostgreSQL authentication store',
    await postgresLayoutVersion(client, q('auth_meta')),
    POSTGRES_AUTH_STORE_VERSION,
  );
}

/* How a message names the store: its tables, by prefix, in the runtime schema. */
const WHERE = `the ${POSTGRES_AUTH_PREFIX} tables in schema "${RUNTIME_SCHEMA}"`;

export class AuthStoreUnavailable extends Refusal {
  constructor(
    message = `The PostgreSQL authentication store is missing or is not the layout this version expects (${WHERE}, version ${POSTGRES_AUTH_STORE_VERSION}). Run migratePostgresAuthStore(url) from @mistriwork/mistri/commands once to provision it, or mistri migrate stores up to bring an older one forward, before starting the server; a foreign layout is refused, not altered.`,
  ) {
    super(message);
    this.name = 'AuthStoreUnavailable';
  }
}

/** The schema or the store's tables are not this role's alone. Migration
 * cannot fix that, so the message says what does rather than naming the
 * maintenance step. */
export class AuthStoreNotOwned extends AuthStoreUnavailable {
  constructor(problems: readonly string[]) {
    super(
      `The PostgreSQL authentication store (${WHERE}) is refused, not altered: ${problems.join('; ')}. ` +
        `The schema and every ${POSTGRES_AUTH_PREFIX} table in it must be owned by the connecting role, or by a role whose privileges it inherits ` +
        '(a superuser counts only itself); no other role may hold a privilege on the schema or on those tables; ' +
        "and the schema may hold nothing but the runtime's tables and its own trigger functions.",
    );
    this.name = 'AuthStoreNotOwned';
  }
}

const q = (name: string) => runtimeTable('postgres', name);

/* The account-administration trail: Better Auth's own output for the audit
   plugin's schema, and two rules that make it append-only. Rules rather than
   triggers because a trigger needs a function, and the schema holds no
   function but the runtime's own (`postgresRuntimeSchemaProblems`); and rather
   than a revoked privilege because a rule binds every role, the owner and a
   superuser included. */
const auditDefinitions: readonly string[] = [
  `CREATE TABLE ${q(T.accountAudit)} (
  "id" text NOT NULL PRIMARY KEY,
  "createdAt" timestamptz NOT NULL,
  "action" text NOT NULL,
  "actorId" text NOT NULL,
  "actorEmail" text NOT NULL,
  "principal" text NOT NULL,
  "targetId" text NOT NULL,
  "targetEmail" text NOT NULL,
  "before" text,
  "after" text
)`,
  `CREATE INDEX "auth_account_audit_createdAt_idx" ON ${q(T.accountAudit)} ("createdAt")`,
  `CREATE INDEX "auth_account_audit_targetId_idx" ON ${q(T.accountAudit)} ("targetId")`,
  `CREATE RULE "auth_account_audit_no_update" AS ON UPDATE TO ${q(T.accountAudit)} DO INSTEAD NOTHING`,
  `CREATE RULE "auth_account_audit_no_delete" AS ON DELETE TO ${q(T.accountAudit)} DO INSTEAD NOTHING`,
];

/* Better Auth 1.7's own `compileMigrations()` output for the identity
   plugin's schema (server/auth/identityStore.ts): the identity-provider
   session index and @better-auth/scim 1.7.10's tables, in the order Better
   Auth creates them, so every reference names a table already made. */
const identityDefinitions: readonly string[] = [
  `CREATE TABLE ${q(T.idpSession)} (
  "id" text NOT NULL PRIMARY KEY,
  "sessionId" text NOT NULL REFERENCES ${q(T.session)} ("id") ON DELETE CASCADE,
  "provider" text NOT NULL,
  "issuer" text NOT NULL,
  "subject" text NOT NULL,
  "sid" text,
  "sessionIndex" text,
  "createdAt" timestamptz NOT NULL
)`,
  `CREATE TABLE ${q(T.scimConnectionBinding)} (
  "id" text NOT NULL PRIMARY KEY,
  "connectionId" text NOT NULL,
  "connectionKey" text NOT NULL UNIQUE,
  "provisioningDomainId" text NOT NULL,
  "createdAt" timestamptz NOT NULL,
  "decommissionedAt" timestamptz,
  "decommissionStatus" text NOT NULL,
  "decommissionCursorUserId" text,
  "decommissionReconciledUserCount" integer NOT NULL,
  "decommissionBatchCount" integer NOT NULL,
  "decommissionRevision" integer NOT NULL,
  "decommissionCompletedAt" timestamptz,
  "decommissionLeaseId" text,
  "decommissionLeaseExpiresAt" timestamptz
)`,
  `CREATE TABLE ${q(T.scimIdentityTombstone)} (
  "id" text NOT NULL PRIMARY KEY,
  "connectionId" text NOT NULL,
  "provisioningDomainId" text NOT NULL,
  "externalId" text NOT NULL,
  "externalIdKey" text NOT NULL UNIQUE,
  "userId" text NOT NULL REFERENCES ${q(T.user)} ("id") ON DELETE CASCADE,
  "profile" text NOT NULL,
  "deletedAt" timestamptz NOT NULL
)`,
  `CREATE TABLE ${q(T.scimSubject)} (
  "id" text NOT NULL PRIMARY KEY,
  "userId" text NOT NULL UNIQUE REFERENCES ${q(T.user)} ("id") ON DELETE CASCADE,
  "profileSourceId" text,
  "revision" integer NOT NULL,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL
)`,
  `CREATE TABLE ${q(T.scimUser)} (
  "id" text NOT NULL PRIMARY KEY,
  "connectionId" text NOT NULL,
  "provisioningDomainId" text NOT NULL,
  "userId" text NOT NULL REFERENCES ${q(T.user)} ("id") ON DELETE CASCADE,
  "connectionUserKey" text NOT NULL UNIQUE,
  "userName" text NOT NULL,
  "userNameKey" text NOT NULL UNIQUE,
  "primaryEmail" text NOT NULL,
  "workEmailValueIndex" text NOT NULL,
  "emailValueIndex" text NOT NULL,
  "displayName" text NOT NULL,
  "formattedName" text NOT NULL,
  "givenName" text,
  "familyName" text,
  "serializedEmails" text NOT NULL,
  "serializedAttributes" text,
  "externalId" text,
  "externalIdKey" text UNIQUE,
  "active" boolean NOT NULL,
  "orderKey" text NOT NULL UNIQUE,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL
)`,
  `CREATE TABLE ${q(T.scimProjectionGrant)} (
  "id" text NOT NULL PRIMARY KEY,
  "connectionId" text NOT NULL,
  "provisioningDomainId" text NOT NULL,
  "scimUserId" text NOT NULL REFERENCES ${q(T.scimUser)} ("id") ON DELETE CASCADE,
  "userId" text NOT NULL REFERENCES ${q(T.user)} ("id") ON DELETE CASCADE,
  "sourceKind" text NOT NULL,
  "sourceId" text NOT NULL,
  "sourceValue" text,
  "role" text NOT NULL,
  "grantKey" text NOT NULL UNIQUE,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL
)`,
  `CREATE TABLE ${q(T.scimGroup)} (
  "id" text NOT NULL PRIMARY KEY,
  "connectionId" text NOT NULL,
  "provisioningDomainId" text NOT NULL,
  "revision" integer NOT NULL,
  "displayName" text NOT NULL,
  "displayNameKey" text NOT NULL UNIQUE,
  "externalId" text,
  "externalIdKey" text UNIQUE,
  "orderKey" text NOT NULL UNIQUE,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL
)`,
  `CREATE TABLE ${q(T.scimGroupMember)} (
  "id" text NOT NULL PRIMARY KEY,
  "connectionId" text NOT NULL,
  "groupId" text NOT NULL REFERENCES ${q(T.scimGroup)} ("id") ON DELETE CASCADE,
  "scimUserId" text NOT NULL REFERENCES ${q(T.scimUser)} ("id") ON DELETE CASCADE,
  "membershipKey" text NOT NULL UNIQUE,
  "createdAt" timestamptz NOT NULL
)`,
  ...(
    [
      ['idpSession', 'sessionId'],
      ['idpSession', 'subject'],
      ['idpSession', 'sid'],
      ['scimConnectionBinding', 'connectionId'],
      ['scimIdentityTombstone', 'connectionId'],
      ['scimIdentityTombstone', 'provisioningDomainId'],
      ['scimIdentityTombstone', 'userId'],
      ['scimSubject', 'profileSourceId'],
      ['scimUser', 'connectionId'],
      ['scimUser', 'provisioningDomainId'],
      ['scimUser', 'userId'],
      ['scimProjectionGrant', 'connectionId'],
      ['scimProjectionGrant', 'provisioningDomainId'],
      ['scimProjectionGrant', 'scimUserId'],
      ['scimProjectionGrant', 'userId'],
      ['scimGroup', 'connectionId'],
      ['scimGroup', 'provisioningDomainId'],
      ['scimGroupMember', 'connectionId'],
      ['scimGroupMember', 'groupId'],
      ['scimGroupMember', 'scimUserId'],
    ] as const
  ).map(([model, column]) => `CREATE INDEX "${T[model]}_${column}_idx" ON ${q(T[model])} ("${column}")`),
];

/* Better Auth 1.7's own `compileMigrations()` output for the core tables and
   the admin plugin under their PostgreSQL names, schema-qualified, with the
   meta table added. Index names match the ones Better Auth derives from those
   names, so its migration planner finds them and plans nothing. */
const definitions: readonly string[] = [
  `CREATE TABLE ${q('auth_meta')} (
  singleton integer PRIMARY KEY CHECK (singleton = 1),
  version integer NOT NULL CONSTRAINT auth_meta_version_check CHECK (version = ${POSTGRES_AUTH_STORE_VERSION})
)`,
  `CREATE TABLE ${q(T.user)} (
  "id" text NOT NULL PRIMARY KEY,
  "name" text NOT NULL,
  "email" text NOT NULL UNIQUE,
  "emailVerified" boolean NOT NULL,
  "image" text,
  "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "role" text,
  "banned" boolean,
  "banReason" text,
  "banExpires" timestamptz
)`,
  `CREATE TABLE ${q(T.session)} (
  "id" text NOT NULL PRIMARY KEY,
  "expiresAt" timestamptz NOT NULL,
  "token" text NOT NULL UNIQUE,
  "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamptz NOT NULL,
  "ipAddress" text,
  "userAgent" text,
  "userId" text NOT NULL REFERENCES ${q(T.user)} ("id") ON DELETE CASCADE,
  "impersonatedBy" text
)`,
  `CREATE TABLE ${q(T.account)} (
  "id" text NOT NULL PRIMARY KEY,
  "accountId" text NOT NULL,
  "providerId" text NOT NULL,
  "userId" text NOT NULL REFERENCES ${q(T.user)} ("id") ON DELETE CASCADE,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  "scope" text,
  "password" text,
  "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamptz NOT NULL
)`,
  `CREATE TABLE ${q(T.verification)} (
  "id" text NOT NULL PRIMARY KEY,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL
)`,
  `CREATE INDEX "auth_session_userId_idx" ON ${q(T.session)} ("userId")`,
  `CREATE INDEX "auth_account_userId_idx" ON ${q(T.account)} ("userId")`,
  `CREATE INDEX "auth_verification_identifier_idx" ON ${q(T.verification)} ("identifier")`,
  ...auditDefinitions,
  ...identityDefinitions,
];

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

type Column = PostgresRelationDescription['columns'][number];
const col = (name: string, type: string, notnull: boolean, collation: string | null, def: string | null = null): Column => ({
  name,
  type,
  notnull,
  collation,
  default: def,
});
const text = (name: string, notnull = false) => col(name, 'text', notnull, 'default');
const when = (name: string, notnull = false, def: string | null = null) => col(name, 'timestamp with time zone', notnull, null, def);
const bool = (name: string, notnull = false) => col(name, 'boolean', notnull, null);
const int = (name: string) => col(name, 'integer', true, null);
const NOW = 'CURRENT_TIMESTAMP';
const table = (name: string, columns: Column[], constraints: string[], indexes: string[], rules = 0): PostgresRelationDescription => ({
  schema: RUNTIME_SCHEMA,
  name,
  kind: 'r',
  rls: false,
  columns,
  constraints: [...constraints].sort(byCodeUnit),
  indexes: [...indexes].sort(byCodeUnit),
  triggers: 0,
  rules,
  policies: 0,
});
const S = RUNTIME_SCHEMA;
const userFk = `FOREIGN KEY ("userId") REFERENCES ${T.user}(id) ON DELETE CASCADE`;

const meta = (version: number) =>
  table(
    'auth_meta',
    [col('singleton', 'integer', true, null), col('version', 'integer', true, null)],
    ['CHECK ((singleton = 1))', `CHECK ((version = ${version}))`, 'PRIMARY KEY (singleton)'],
    [`CREATE UNIQUE INDEX auth_meta_pkey ON ${S}.auth_meta USING btree (singleton)`],
  );

/* The description the DDL above produces, read back from a PostgreSQL 18
   catalog. Pinned rather than derived at runtime so the attestation is of
   this layout and not of whatever is there. It is built in layers (the core, the trail, the
   identity plugin), and the last is the layout. */
const baseRelations: readonly PostgresRelationDescription[] = [
  table(
    T.account,
    [
      text('id', true),
      text('issuer', true),
      text('accountId', true),
      text('providerId', true),
      text('userId', true),
      text('accessToken'),
      text('refreshToken'),
      text('idToken'),
      when('accessTokenExpiresAt'),
      when('refreshTokenExpiresAt'),
      text('scope'),
      text('password'),
      when('createdAt', true, NOW),
      when('updatedAt', true),
    ],
    ['PRIMARY KEY (id)', userFk],
    [
      `CREATE UNIQUE INDEX auth_account_pkey ON ${S}.auth_account USING btree (id)`,
      `CREATE INDEX "auth_account_userId_idx" ON ${S}.auth_account USING btree ("userId")`,
      `CREATE UNIQUE INDEX "auth_account_issuer_accountId_uidx" ON ${S}.auth_account USING btree (issuer, "accountId")`,
    ],
  ),
  meta(1),
  table(
    T.session,
    [
      text('id', true),
      when('expiresAt', true),
      text('token', true),
      when('createdAt', true, NOW),
      when('updatedAt', true),
      text('ipAddress'),
      text('userAgent'),
      text('userId', true),
      text('impersonatedBy'),
    ],
    ['PRIMARY KEY (id)', 'UNIQUE (token)', userFk],
    [
      `CREATE UNIQUE INDEX auth_session_pkey ON ${S}.auth_session USING btree (id)`,
      `CREATE UNIQUE INDEX auth_session_token_key ON ${S}.auth_session USING btree (token)`,
      `CREATE INDEX "auth_session_userId_idx" ON ${S}.auth_session USING btree ("userId")`,
    ],
  ),
  table(
    T.user,
    [
      text('id', true),
      text('name', true),
      text('email', true),
      bool('emailVerified', true),
      text('image'),
      when('createdAt', true, NOW),
      when('updatedAt', true, NOW),
      text('role'),
      bool('banned'),
      text('banReason'),
      when('banExpires'),
    ],
    ['PRIMARY KEY (id)', 'UNIQUE (email)'],
    [
      `CREATE UNIQUE INDEX auth_user_pkey ON ${S}.auth_user USING btree (id)`,
      `CREATE UNIQUE INDEX auth_user_email_key ON ${S}.auth_user USING btree (email)`,
    ],
  ),
  table(
    T.verification,
    [
      text('id', true),
      text('identifier', true),
      text('value', true),
      when('expiresAt', true),
      when('createdAt', true, NOW),
      when('updatedAt', true, NOW),
    ],
    ['PRIMARY KEY (id)'],
    [
      `CREATE UNIQUE INDEX auth_verification_pkey ON ${S}.auth_verification USING btree (id)`,
      `CREATE INDEX auth_verification_identifier_idx ON ${S}.auth_verification USING btree (identifier)`,
    ],
  ),
];
const byName = (a: PostgresRelationDescription, b: PostgresRelationDescription) => byCodeUnit(a.name, b.name);
const withTrail: readonly PostgresRelationDescription[] = [
  ...baseRelations.filter((relation) => relation.name !== 'auth_meta'),
  meta(2),
  table(
    T.accountAudit,
    [
      text('id', true),
      when('createdAt', true),
      text('action', true),
      text('actorId', true),
      text('actorEmail', true),
      text('principal', true),
      text('targetId', true),
      text('targetEmail', true),
      text('before'),
      text('after'),
    ],
    ['PRIMARY KEY (id)'],
    [
      `CREATE UNIQUE INDEX auth_account_audit_pkey ON ${S}.auth_account_audit USING btree (id)`,
      `CREATE INDEX "auth_account_audit_createdAt_idx" ON ${S}.auth_account_audit USING btree ("createdAt")`,
      `CREATE INDEX "auth_account_audit_targetId_idx" ON ${S}.auth_account_audit USING btree ("targetId")`,
    ],
    2,
  ),
].sort(byName);

/* Version 3: the identity plugin's tables (server/auth/identityStore.ts). */
/* PostgreSQL prints a name bare when it can: `auth_scim_user`, `sid`, but `"sessionId"` (mixed case). */
const printed = (name: string) => (/^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name}"`);
const fk = (column: string, target: AuthModel) => `FOREIGN KEY ("${column}") REFERENCES ${T[target]}(id) ON DELETE CASCADE`;
const unique = (relation: string, column: string) => [
  `UNIQUE ("${column}")`,
  `CREATE UNIQUE INDEX ${printed(`${relation}_${column}_key`)} ON ${S}.${relation} USING btree ("${column}")`,
];
const index = (relation: string, column: string) =>
  `CREATE INDEX ${printed(`${relation}_${column}_idx`)} ON ${S}.${relation} USING btree (${printed(column)})`;
/** A table of the identity plugin: its columns, its unique and referencing columns, and its single-column indexes. */
const identityTable = (model: AuthModel, columns: Column[], uniques: string[], references: [string, AuthModel][], indexed: string[]) => {
  const name = T[model];
  return table(
    name,
    [text('id', true), ...columns],
    ['PRIMARY KEY (id)', ...uniques.map((column) => unique(name, column)[0]), ...references.map(([column, target]) => fk(column, target))],
    [
      `CREATE UNIQUE INDEX ${name}_pkey ON ${S}.${name} USING btree (id)`,
      ...uniques.map((column) => unique(name, column)[1]),
      ...indexed.map((column) => index(name, column)),
    ],
  );
};
const identityRelations: readonly PostgresRelationDescription[] = [
  identityTable(
    'idpSession',
    [
      text('sessionId', true),
      text('provider', true),
      text('issuer', true),
      text('subject', true),
      text('sid'),
      text('sessionIndex'),
      when('createdAt', true),
    ],
    [],
    [['sessionId', 'session']],
    ['sessionId', 'subject', 'sid'],
  ),
  identityTable(
    'scimConnectionBinding',
    [
      text('connectionId', true),
      text('connectionKey', true),
      text('provisioningDomainId', true),
      when('createdAt', true),
      when('decommissionedAt'),
      text('decommissionStatus', true),
      text('decommissionCursorUserId'),
      int('decommissionReconciledUserCount'),
      int('decommissionBatchCount'),
      int('decommissionRevision'),
      when('decommissionCompletedAt'),
      text('decommissionLeaseId'),
      when('decommissionLeaseExpiresAt'),
    ],
    ['connectionKey'],
    [],
    ['connectionId'],
  ),
  identityTable(
    'scimIdentityTombstone',
    [
      text('connectionId', true),
      text('provisioningDomainId', true),
      text('externalId', true),
      text('externalIdKey', true),
      text('userId', true),
      text('profile', true),
      when('deletedAt', true),
    ],
    ['externalIdKey'],
    [['userId', 'user']],
    ['connectionId', 'provisioningDomainId', 'userId'],
  ),
  identityTable(
    'scimSubject',
    [text('userId', true), text('profileSourceId'), int('revision'), when('createdAt', true), when('updatedAt', true)],
    ['userId'],
    [['userId', 'user']],
    ['profileSourceId'],
  ),
  identityTable(
    'scimUser',
    [
      text('connectionId', true),
      text('provisioningDomainId', true),
      text('userId', true),
      text('connectionUserKey', true),
      text('userName', true),
      text('userNameKey', true),
      text('primaryEmail', true),
      text('workEmailValueIndex', true),
      text('emailValueIndex', true),
      text('displayName', true),
      text('formattedName', true),
      text('givenName'),
      text('familyName'),
      text('serializedEmails', true),
      text('serializedAttributes'),
      text('externalId'),
      text('externalIdKey'),
      bool('active', true),
      text('orderKey', true),
      when('createdAt', true),
      when('updatedAt', true),
    ],
    ['connectionUserKey', 'userNameKey', 'externalIdKey', 'orderKey'],
    [['userId', 'user']],
    ['connectionId', 'provisioningDomainId', 'userId'],
  ),
  identityTable(
    'scimProjectionGrant',
    [
      text('connectionId', true),
      text('provisioningDomainId', true),
      text('scimUserId', true),
      text('userId', true),
      text('sourceKind', true),
      text('sourceId', true),
      text('sourceValue'),
      text('role', true),
      text('grantKey', true),
      when('createdAt', true),
      when('updatedAt', true),
    ],
    ['grantKey'],
    [
      ['scimUserId', 'scimUser'],
      ['userId', 'user'],
    ],
    ['connectionId', 'provisioningDomainId', 'scimUserId', 'userId'],
  ),
  identityTable(
    'scimGroup',
    [
      text('connectionId', true),
      text('provisioningDomainId', true),
      int('revision'),
      text('displayName', true),
      text('displayNameKey', true),
      text('externalId'),
      text('externalIdKey'),
      text('orderKey', true),
      when('createdAt', true),
      when('updatedAt', true),
    ],
    ['displayNameKey', 'externalIdKey', 'orderKey'],
    [],
    ['connectionId', 'provisioningDomainId'],
  ),
  identityTable(
    'scimGroupMember',
    [text('connectionId', true), text('groupId', true), text('scimUserId', true), text('membershipKey', true), when('createdAt', true)],
    ['membershipKey'],
    [
      ['groupId', 'scimGroup'],
      ['scimUserId', 'scimUser'],
    ],
    ['connectionId', 'groupId', 'scimUserId'],
  ),
];
const withIdentity: readonly PostgresRelationDescription[] = [
  ...withTrail.filter((relation) => relation.name !== 'auth_meta'),
  meta(3),
  ...identityRelations,
].sort(byName);
/* Version 4: the account as Better Auth 1.7.3 and later make it, without the issuer 1.7.0–1.7.2 keyed it by. */
const ISSUER_INDEX = 'auth_account_issuer_accountId_uidx';
const expected: readonly PostgresRelationDescription[] = withIdentity
  .map((relation) =>
    relation.name === 'auth_meta'
      ? meta(POSTGRES_AUTH_STORE_VERSION)
      : relation.name === T.account
        ? {
            ...relation,
            columns: relation.columns.filter((column) => column.name !== 'issuer'),
            indexes: relation.indexes.filter((index) => !index.includes(ISSUER_INDEX)),
          }
        : relation,
  )
  .sort(byName);

const canonical = (value: readonly PostgresRelationDescription[]) => canonicalCommandJson(foldRelations(value), 1_048_576);
// Two fixed whole layouts, never arbitrary caller-approved extra relations.
// Ordinary v1 migration/startup does not create or activate this extension.
const withTokens = (layout: readonly PostgresRelationDescription[]) => [...layout, ...postgresApiTokenCatalog()].sort(byName);
/** The whole layout, core and core+tokens. */
const CURRENT = { core: canonical(expected), tokens: canonical(withTokens(expected)) } as const;

/**
 * Exact layout attestation: no `auth_` relations in the runtime schema, one
 * of another name, an altered column or constraint, an added index, trigger,
 * rule or policy, or a meta row of another version all refuse; and so, with
 * its own message, does a schema or a store table that is not solely this
 * role's (`postgresRuntimeSchemaProblems`).
 *
 * Inside a transaction, because the description is read with `search_path`
 * pinned to the runtime schema for that transaction only: PostgreSQL prints
 * a foreign key's target unqualified when the target schema is visible and
 * qualified when it is not, so the same layout would otherwise describe
 * differently from the runtime pool (whose path is the schema) and from a
 * maintenance client (whose path is the server default). Pinning it makes
 * a reference into `public.auth_user` print qualified, and refuse, on both.
 * A caller outside a transaction is refused rather than attested on
 * whatever its session happens to see.
 */
export async function assertPostgresAuthStore(client: PgQuery): Promise<void> {
  const layout = CURRENT;

  let same: boolean;
  let problems: string[] = [];
  try {
    await client.query('SAVEPOINT auth_store_attest');
    await client.query('RELEASE SAVEPOINT auth_store_attest');
    await client.query(`SET LOCAL search_path TO ${POSTGRES_AUTH_SEARCH_PATH}`);
    const actual = canonical(await describePostgresRelations(client, POSTGRES_AUTH_PREFIX));
    const core = actual === layout.core;
    const tokens = !core && actual === layout.tokens;
    same = core || tokens;
    if (same) {
      const rows = (await client.query(`SELECT singleton, version FROM ${q('auth_meta')}`)).rows;
      same = rows.length === 1 && rows[0].singleton === 1 && rows[0].version === POSTGRES_AUTH_STORE_VERSION;
    }
    if (same && tokens) {
      const rows = (await client.query(`SELECT singleton, version, app_id, store_id, format FROM ${q('auth_api_token_meta')}`)).rows;
      const meta = rows[0];
      // The token extension's own version row.
      same =
        rows.length === 1 &&
        meta.singleton === 1 &&
        meta.version === API_TOKEN_STORE_VERSION &&
        meta.format === 'twa1' &&
        typeof meta.app_id === 'string' &&
        meta.app_id.length > 0 &&
        Buffer.byteLength(meta.app_id, 'utf8') <= 256 &&
        meta.app_id === meta.app_id.trim() &&
        !/[\p{Cc}\p{Cs}]/u.test(meta.app_id) &&
        typeof meta.store_id === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\s\S])/.test(meta.store_id);
    }
    if (same) problems = await postgresRuntimeSchemaProblems(client, POSTGRES_AUTH_PREFIX);
  } catch {
    same = false;
  }
  if (!same) throw new AuthStoreUnavailable(await layoutMessage(client));
  if (problems.length) throw new AuthStoreNotOwned(problems);
}

/** The attestation on a leased client of the runtime's pool, in a transaction
 * of its own; the client goes back to the pool with the path it came with. */
export async function attestPostgresAuthStore(pool: PgPool): Promise<void> {
  const client = await pool.connect();
  let destroy = false;
  try {
    await client.query('BEGIN');
    try {
      await assertPostgresAuthStore(client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {
        destroy = true;
      });
      throw error;
    }
  } finally {
    client.release(destroy);
  }
}

/**
 * Explicit maintenance operation, never run implicitly when the App starts.
 * Creates the layout when the runtime schema holds no `auth_` relation and
 * is this role's (the maintenance transaction creates the schema where it is
 * absent; other stores' tables may already be in it); idempotent once it is
 * there; any other `auth_` content — an older version, a hand-made table, an
 * extra index — is refused unchanged, and so is a schema another role owns,
 * may create in or use, or has put a function, type or operator in: the
 * migration does not adopt what someone else prepared. An older version is brought forward
 * by `mistri migrate stores up` (storeLayouts.ts), not here. Under the
 * same server-wide advisory lock as the journal migration, so two operators
 * running maintenance at once serialise.
 */
export async function migratePostgresAuthStore(url: string): Promise<{ version: typeof POSTGRES_AUTH_STORE_VERSION; migrated: boolean }> {
  if (typeof url !== 'string' || !/^postgres(ql)?:\/\//i.test(url))
    throw new Refusal('Authentication store migration requires a postgres:// URL.');
  return withPostgresMaintenanceTransaction(url, async (client) => {
    const problems = await postgresRuntimeSchemaProblems(client, POSTGRES_AUTH_PREFIX);
    if (problems.length) throw new AuthStoreNotOwned(problems);
    await client.query(`SET LOCAL search_path TO ${POSTGRES_AUTH_SEARCH_PATH}`);
    const empty = (await describePostgresRelations(client, POSTGRES_AUTH_PREFIX)).length === 0;
    if (empty) {
      for (const ddl of definitions) await client.query(ddl);
      await client.query(`INSERT INTO ${q('auth_meta')} (singleton, version) VALUES (1, ${POSTGRES_AUTH_STORE_VERSION})`);
    }
    const migrated = empty;
    await assertPostgresAuthStore(client);
    return { version: POSTGRES_AUTH_STORE_VERSION, migrated };
  });
}
