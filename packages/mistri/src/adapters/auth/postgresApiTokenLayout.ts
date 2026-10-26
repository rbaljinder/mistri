/** Fixed private API token extension: the tenant membership binding and the
 * OAuth authorization server's rows beside the token table
 * (sqliteApiTokenLayout.ts says what each holds). Core native auth meta is its own version. JSON
 * canonicalization/role uniqueness and authority belong to the record codec,
 * not these storage constraints. No account FK or deletion cascade. */
import { RUNTIME_SCHEMA, runtimeTable } from '@mistriwork/engine/shared/runtimeTables.js';
import type { PostgresRelationDescription } from '../commands/postgresCommandJournal.js';

/* Both dialects' token stores are at this version. It is said here rather than in sqliteApiTokenLayout.ts because the
   PostgreSQL auth store loads this module on every startup path, `--mcp` included, and SQLite's layout need not come
   with it. */
export const API_TOKEN_STORE_VERSION = 1;

/* The tables sit in the runtime schema beside the sign-in store's, under the same `auth_` prefix
   (postgresAuthStore.ts), so the one attestation of `auth_` relations covers both. */
const t = (name: string) => runtimeTable('postgres', name);
const whitespace = [
  9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279,
]
  .map((code) => `chr(${code})`)
  .join(' || ');
const text = (name: string, max: number, nullable = false) =>
  `${name} text COLLATE "C"${nullable ? '' : ' NOT NULL'} CHECK (${nullable ? `${name} IS NULL OR ` : ''}(octet_length(${name}) BETWEEN 1 AND ${max} AND ${name} = btrim(${name}, ${whitespace}) AND ${name} !~ ('[' || chr(1) || '-' || chr(31) || chr(127) || '-' || chr(159) || ']')))`;
const uuid = (name: string) =>
  `${text(name, 36)} CHECK (${name} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')`;
const instant = (name: string, nullable = false) =>
  `${name} bigint${nullable ? '' : ' NOT NULL'} CHECK (${nullable ? `${name} IS NULL OR ` : ''}(${name} BETWEEN 0 AND 8640000000000000))`;

const nullableUuid = (name: string) =>
  `${text(name, 36, true)} CHECK (${name} IS NULL OR ${name} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')`;
const digest = (name: string) => `${text(name, 64)} CHECK (${name} ~ '^[0-9a-f]{64}$')`;
const apiVersion = (name: string) => `${name} bigint NOT NULL CHECK (${name} BETWEEN 1 AND 9007199254740991)`;
const roles = (name: string) =>
  `${text(name, 131072)} CHECK (jsonb_typeof(${name}::jsonb) = 'array' AND jsonb_array_length(${name}::jsonb) BETWEEN 1 AND 128)`;
const tenantColumns = `${text('tenant_id', 128, true)} CHECK (tenant_id IS NULL OR tenant_id ~ '^[a-z0-9][a-z0-9_-]{0,127}$'),
  ${text('membership_id', 3072, true)},
  ${text('membership_version', 128, true)} CHECK (membership_version IS NULL OR membership_version ~ '^[1-9][0-9]{0,127}$')`;
const tenantBound = 'CHECK ((tenant_id IS NULL) = (membership_id IS NULL) AND (tenant_id IS NULL) = (membership_version IS NULL))';

/** The version row's table. */
const metaDdl = (version: number) => `CREATE TABLE ${t('auth_api_token_meta')} (
  singleton integer PRIMARY KEY CHECK (singleton = 1),
  version integer NOT NULL CHECK (version = ${version}),
  ${text('app_id', 256)},
  ${uuid('store_id')},
  ${text('format', 4)} CHECK (format = 'twa1')
)`;

/** The OAuth rows (v3), in the order their references need. */
function postgresApiTokenOauthDdl(): readonly string[] {
  return Object.freeze([
    `CREATE TABLE ${t('auth_oauth_client')} (
  ${text('client_id', 41)} CHECK (client_id ~ '^twc1[.][0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') PRIMARY KEY,
  ${text('name', 400, true)},
  ${text('redirect_uris_json', 16384)} CHECK (jsonb_typeof(redirect_uris_json::jsonb) = 'array' AND jsonb_array_length(redirect_uris_json::jsonb) BETWEEN 1 AND 5),
  ${instant('created_at')},
  ${instant('consented_at', true)},
  CHECK (consented_at IS NULL OR consented_at >= created_at)
)`,
    `CREATE TABLE ${t('auth_oauth_grant')} (
  ${uuid('grant_id')} PRIMARY KEY,
  ${text('client_id', 41)} REFERENCES ${t('auth_oauth_client')} (client_id),
  ${text('subject', 3072)},
  ${text('app_id', 256)},
  ${apiVersion('version')},
  ${roles('roles_json')},
  ${tenantColumns},
  ${instant('created_at')},
  ${instant('expires_at')},
  ${instant('revoked_at', true)},
  ${tenantBound},
  CHECK (expires_at > created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
)`,
    `CREATE TABLE ${t('auth_oauth_code')} (
  ${digest('code_digest')} PRIMARY KEY,
  ${text('client_id', 41)} REFERENCES ${t('auth_oauth_client')} (client_id),
  ${text('subject', 3072)},
  ${text('redirect_uri', 2048)},
  ${text('challenge', 43)} CHECK (challenge ~ '^[A-Za-z0-9_-]{43}$'),
  ${text('app_id', 256)},
  ${apiVersion('version')},
  ${roles('roles_json')},
  ${tenantColumns},
  ${instant('expires_at')},
  ${instant('used_at', true)},
  ${nullableUuid('grant_id')} REFERENCES ${t('auth_oauth_grant')} (grant_id),
  ${tenantBound},
  CHECK (grant_id IS NULL OR used_at IS NOT NULL)
)`,
    `CREATE TABLE ${t('auth_oauth_refresh')} (
  ${digest('digest')} PRIMARY KEY,
  ${uuid('grant_id')} REFERENCES ${t('auth_oauth_grant')} (grant_id),
  ${instant('issued_at')},
  ${instant('used_at', true)},
  CHECK (used_at IS NULL OR used_at >= issued_at)
)`,
    `CREATE TABLE ${t('auth_oauth_access')} (
  ${uuid('token_id')} PRIMARY KEY REFERENCES ${t('auth_api_token')} (token_id) ON DELETE CASCADE,
  ${uuid('grant_id')} REFERENCES ${t('auth_oauth_grant')} (grant_id),
  ${text('app_id', 256)},
  ${apiVersion('version')}
)`,
    `CREATE INDEX auth_oauth_grant_subject_idx ON ${t('auth_oauth_grant')} (subject)`,
    `CREATE INDEX auth_oauth_refresh_grant_idx ON ${t('auth_oauth_refresh')} (grant_id)`,
    `CREATE INDEX auth_oauth_access_grant_idx ON ${t('auth_oauth_access')} (grant_id)`,
  ]);
}

export function postgresApiTokenDdl(): readonly string[] {
  return Object.freeze([
    metaDdl(API_TOKEN_STORE_VERSION),
    `CREATE TABLE ${t('auth_api_token')} (
  ${uuid('token_id')} PRIMARY KEY,
  ${text('app_id', 256)},
  ${text('subject_kind', 7)} CHECK (subject_kind IN ('account', 'service')),
  ${text('subject_id', 3072)},
  ${text('label', 512)},
  ${text('roles_json', 131072)} CHECK (jsonb_typeof(roles_json::jsonb) = 'array' AND jsonb_array_length(roles_json::jsonb) BETWEEN 1 AND 128),
  ${text('operations_json', 131072, true)} CHECK (operations_json IS NULL OR (jsonb_typeof(operations_json::jsonb) = 'array' AND jsonb_array_length(operations_json::jsonb) BETWEEN 0 AND 1024)),
  ${instant('created_at')},
  ${text('created_by', 3072)},
  ${instant('expires_at')},
  ${instant('revoked_at', true)},
  ${text('revoked_by', 3072, true)},
  ${instant('last_used_at', true)},
  ${text('format', 4)} CHECK (format = 'twa1'),
  ${text('digest', 64)} CHECK (digest ~ '^[0-9a-f]{64}$'),
  ${text('version', 128)} CHECK (version ~ '^[1-9][0-9]{0,127}$'),
  ${text('tenant_id', 128, true)} CHECK (tenant_id IS NULL OR tenant_id ~ '^[a-z0-9][a-z0-9_-]{0,127}$'),
  ${text('membership_id', 3072, true)},
  ${text('membership_version', 128, true)} CHECK (membership_version IS NULL OR membership_version ~ '^[1-9][0-9]{0,127}$'),
  CHECK ((tenant_id IS NULL) = (membership_id IS NULL) AND (tenant_id IS NULL) = (membership_version IS NULL)),
  CHECK (expires_at > created_at),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CHECK (last_used_at IS NULL OR last_used_at >= created_at),
  CHECK (subject_kind <> 'service' OR subject_id ~ '^[a-z][a-z0-9-]{0,62}$')
)`,
    // The OAuth rows follow the token table.
    ...postgresApiTokenOauthDdl(),
  ]);
}

/** Fixed description, never learned from a deployment. The token table and
 * its version row were captured from our unique-owned PostgreSQL fixture; the
 * OAuth rows are written in the same deparsed spelling by the helpers below
 * (test/postgres-api-token-layout.test.ts). A fresh copy on every call. */
export function postgresApiTokenCatalog(): readonly PostgresRelationDescription[] {
  return structuredClone([...pinned, ...oauthPinned()]);
}

const pinned: readonly PostgresRelationDescription[] = [
  {
    schema: RUNTIME_SCHEMA,
    name: 'auth_api_token',
    kind: 'r',
    rls: false,
    columns: [
      {
        name: 'token_id',
        type: 'text',
        notnull: true,
        collation: 'C',
        default: null,
      },
      {
        name: 'app_id',
        type: 'text',
        notnull: true,
        collation: 'C',
        default: null,
      },
      {
        name: 'subject_kind',
        type: 'text',
        notnull: true,
        collation: 'C',
        default: null,
      },
      {
        name: 'subject_id',
        type: 'text',
        notnull: true,
        collation: 'C',
        default: null,
      },
      {
        name: 'label',
        type: 'text',
        notnull: true,
        collation: 'C',
        default: null,
      },
      {
        name: 'roles_json',
        type: 'text',
        notnull: true,
        collation: 'C',
        default: null,
      },
      {
        name: 'operations_json',
        type: 'text',
        notnull: false,
        collation: 'C',
        default: null,
      },
      {
        name: 'created_at',
        type: 'bigint',
        notnull: true,
        collation: null,
        default: null,
      },
      {
        name: 'created_by',
        type: 'text',
        notnull: true,
        collation: 'C',
        default: null,
      },
      {
        name: 'expires_at',
        type: 'bigint',
        notnull: true,
        collation: null,
        default: null,
      },
      {
        name: 'revoked_at',
        type: 'bigint',
        notnull: false,
        collation: null,
        default: null,
      },
      {
        name: 'revoked_by',
        type: 'text',
        notnull: false,
        collation: 'C',
        default: null,
      },
      {
        name: 'last_used_at',
        type: 'bigint',
        notnull: false,
        collation: null,
        default: null,
      },
      {
        name: 'format',
        type: 'text',
        notnull: true,
        collation: 'C',
        default: null,
      },
      {
        name: 'digest',
        type: 'text',
        notnull: true,
        collation: 'C',
        default: null,
      },
      {
        name: 'version',
        type: 'text',
        notnull: true,
        collation: 'C',
        default: null,
      },
      {
        name: 'tenant_id',
        type: 'text',
        notnull: false,
        collation: 'C',
        default: null,
      },
      {
        name: 'membership_id',
        type: 'text',
        notnull: false,
        collation: 'C',
        default: null,
      },
      {
        name: 'membership_version',
        type: 'text',
        notnull: false,
        collation: 'C',
        default: null,
      },
    ],
    constraints: [
      "CHECK ((((octet_length(app_id) >= 1) AND (octet_length(app_id) <= 256)) AND (app_id = btrim(app_id, ((((((((((((((((((((((((chr(9) || chr(10)) || chr(11)) || chr(12)) || chr(13)) || chr(32)) || chr(160)) || chr(5760)) || chr(8192)) || chr(8193)) || chr(8194)) || chr(8195)) || chr(8196)) || chr(8197)) || chr(8198)) || chr(8199)) || chr(8200)) || chr(8201)) || chr(8202)) || chr(8232)) || chr(8233)) || chr(8239)) || chr(8287)) || chr(12288)) || chr(65279)))) AND (app_id !~ ((((((('['::text || chr(1)) || '-'::text) || chr(31)) || chr(127)) || '-'::text) || chr(159)) || ']'::text))))",
      "CHECK ((((octet_length(created_by) >= 1) AND (octet_length(created_by) <= 3072)) AND (created_by = btrim(created_by, ((((((((((((((((((((((((chr(9) || chr(10)) || chr(11)) || chr(12)) || chr(13)) || chr(32)) || chr(160)) || chr(5760)) || chr(8192)) || chr(8193)) || chr(8194)) || chr(8195)) || chr(8196)) || chr(8197)) || chr(8198)) || chr(8199)) || chr(8200)) || chr(8201)) || chr(8202)) || chr(8232)) || chr(8233)) || chr(8239)) || chr(8287)) || chr(12288)) || chr(65279)))) AND (created_by !~ ((((((('['::text || chr(1)) || '-'::text) || chr(31)) || chr(127)) || '-'::text) || chr(159)) || ']'::text))))",
      "CHECK ((((octet_length(digest) >= 1) AND (octet_length(digest) <= 64)) AND (digest = btrim(digest, ((((((((((((((((((((((((chr(9) || chr(10)) || chr(11)) || chr(12)) || chr(13)) || chr(32)) || chr(160)) || chr(5760)) || chr(8192)) || chr(8193)) || chr(8194)) || chr(8195)) || chr(8196)) || chr(8197)) || chr(8198)) || chr(8199)) || chr(8200)) || chr(8201)) || chr(8202)) || chr(8232)) || chr(8233)) || chr(8239)) || chr(8287)) || chr(12288)) || chr(65279)))) AND (digest !~ ((((((('['::text || chr(1)) || '-'::text) || chr(31)) || chr(127)) || '-'::text) || chr(159)) || ']'::text))))",
      "CHECK ((((octet_length(format) >= 1) AND (octet_length(format) <= 4)) AND (format = btrim(format, ((((((((((((((((((((((((chr(9) || chr(10)) || chr(11)) || chr(12)) || chr(13)) || chr(32)) || chr(160)) || chr(5760)) || chr(8192)) || chr(8193)) || chr(8194)) || chr(8195)) || chr(8196)) || chr(8197)) || chr(8198)) || chr(8199)) || chr(8200)) || chr(8201)) || chr(8202)) || chr(8232)) || chr(8233)) || chr(8239)) || chr(8287)) || chr(12288)) || chr(65279)))) AND (format !~ ((((((('['::text || chr(1)) || '-'::text) || chr(31)) || chr(127)) || '-'::text) || chr(159)) || ']'::text))))",
      "CHECK ((((octet_length(label) >= 1) AND (octet_length(label) <= 512)) AND (label = btrim(label, ((((((((((((((((((((((((chr(9) || chr(10)) || chr(11)) || chr(12)) || chr(13)) || chr(32)) || chr(160)) || chr(5760)) || chr(8192)) || chr(8193)) || chr(8194)) || chr(8195)) || chr(8196)) || chr(8197)) || chr(8198)) || chr(8199)) || chr(8200)) || chr(8201)) || chr(8202)) || chr(8232)) || chr(8233)) || chr(8239)) || chr(8287)) || chr(12288)) || chr(65279)))) AND (label !~ ((((((('['::text || chr(1)) || '-'::text) || chr(31)) || chr(127)) || '-'::text) || chr(159)) || ']'::text))))",
      "CHECK ((((octet_length(roles_json) >= 1) AND (octet_length(roles_json) <= 131072)) AND (roles_json = btrim(roles_json, ((((((((((((((((((((((((chr(9) || chr(10)) || chr(11)) || chr(12)) || chr(13)) || chr(32)) || chr(160)) || chr(5760)) || chr(8192)) || chr(8193)) || chr(8194)) || chr(8195)) || chr(8196)) || chr(8197)) || chr(8198)) || chr(8199)) || chr(8200)) || chr(8201)) || chr(8202)) || chr(8232)) || chr(8233)) || chr(8239)) || chr(8287)) || chr(12288)) || chr(65279)))) AND (roles_json !~ ((((((('['::text || chr(1)) || '-'::text) || chr(31)) || chr(127)) || '-'::text) || chr(159)) || ']'::text))))",
      "CHECK ((((octet_length(subject_id) >= 1) AND (octet_length(subject_id) <= 3072)) AND (subject_id = btrim(subject_id, ((((((((((((((((((((((((chr(9) || chr(10)) || chr(11)) || chr(12)) || chr(13)) || chr(32)) || chr(160)) || chr(5760)) || chr(8192)) || chr(8193)) || chr(8194)) || chr(8195)) || chr(8196)) || chr(8197)) || chr(8198)) || chr(8199)) || chr(8200)) || chr(8201)) || chr(8202)) || chr(8232)) || chr(8233)) || chr(8239)) || chr(8287)) || chr(12288)) || chr(65279)))) AND (subject_id !~ ((((((('['::text || chr(1)) || '-'::text) || chr(31)) || chr(127)) || '-'::text) || chr(159)) || ']'::text))))",
      "CHECK ((((octet_length(subject_kind) >= 1) AND (octet_length(subject_kind) <= 7)) AND (subject_kind = btrim(subject_kind, ((((((((((((((((((((((((chr(9) || chr(10)) || chr(11)) || chr(12)) || chr(13)) || chr(32)) || chr(160)) || chr(5760)) || chr(8192)) || chr(8193)) || chr(8194)) || chr(8195)) || chr(8196)) || chr(8197)) || chr(8198)) || chr(8199)) || chr(8200)) || chr(8201)) || chr(8202)) || chr(8232)) || chr(8233)) || chr(8239)) || chr(8287)) || chr(12288)) || chr(65279)))) AND (subject_kind !~ ((((((('['::text || chr(1)) || '-'::text) || chr(31)) || chr(127)) || '-'::text) || chr(159)) || ']'::text))))",
      "CHECK ((((octet_length(token_id) >= 1) AND (octet_length(token_id) <= 36)) AND (token_id = btrim(token_id, ((((((((((((((((((((((((chr(9) || chr(10)) || chr(11)) || chr(12)) || chr(13)) || chr(32)) || chr(160)) || chr(5760)) || chr(8192)) || chr(8193)) || chr(8194)) || chr(8195)) || chr(8196)) || chr(8197)) || chr(8198)) || chr(8199)) || chr(8200)) || chr(8201)) || chr(8202)) || chr(8232)) || chr(8233)) || chr(8239)) || chr(8287)) || chr(12288)) || chr(65279)))) AND (token_id !~ ((((((('['::text || chr(1)) || '-'::text) || chr(31)) || chr(127)) || '-'::text) || chr(159)) || ']'::text))))",
      "CHECK ((((octet_length(version) >= 1) AND (octet_length(version) <= 128)) AND (version = btrim(version, ((((((((((((((((((((((((chr(9) || chr(10)) || chr(11)) || chr(12)) || chr(13)) || chr(32)) || chr(160)) || chr(5760)) || chr(8192)) || chr(8193)) || chr(8194)) || chr(8195)) || chr(8196)) || chr(8197)) || chr(8198)) || chr(8199)) || chr(8200)) || chr(8201)) || chr(8202)) || chr(8232)) || chr(8233)) || chr(8239)) || chr(8287)) || chr(12288)) || chr(65279)))) AND (version !~ ((((((('['::text || chr(1)) || '-'::text) || chr(31)) || chr(127)) || '-'::text) || chr(159)) || ']'::text))))",
      'CHECK ((((tenant_id IS NULL) = (membership_id IS NULL)) AND ((tenant_id IS NULL) = (membership_version IS NULL))))',
      "CHECK (((created_at >= 0) AND (created_at <= '8640000000000000'::bigint)))",
      "CHECK (((expires_at >= 0) AND (expires_at <= '8640000000000000'::bigint)))",
      "CHECK (((jsonb_typeof((roles_json)::jsonb) = 'array'::text) AND ((jsonb_array_length((roles_json)::jsonb) >= 1) AND (jsonb_array_length((roles_json)::jsonb) <= 128))))",
      "CHECK (((last_used_at IS NULL) OR ((last_used_at >= 0) AND (last_used_at <= '8640000000000000'::bigint))))",
      'CHECK (((last_used_at IS NULL) OR (last_used_at >= created_at)))',
      "CHECK (((membership_id IS NULL) OR (((octet_length(membership_id) >= 1) AND (octet_length(membership_id) <= 3072)) AND (membership_id = btrim(membership_id, ((((((((((((((((((((((((chr(9) || chr(10)) || chr(11)) || chr(12)) || chr(13)) || chr(32)) || chr(160)) || chr(5760)) || chr(8192)) || chr(8193)) || chr(8194)) || chr(8195)) || chr(8196)) || chr(8197)) || chr(8198)) || chr(8199)) || chr(8200)) || chr(8201)) || chr(8202)) || chr(8232)) || chr(8233)) || chr(8239)) || chr(8287)) || chr(12288)) || chr(65279)))) AND (membership_id !~ ((((((('['::text || chr(1)) || '-'::text) || chr(31)) || chr(127)) || '-'::text) || chr(159)) || ']'::text)))))",
      "CHECK (((membership_version IS NULL) OR (((octet_length(membership_version) >= 1) AND (octet_length(membership_version) <= 128)) AND (membership_version = btrim(membership_version, ((((((((((((((((((((((((chr(9) || chr(10)) || chr(11)) || chr(12)) || chr(13)) || chr(32)) || chr(160)) || chr(5760)) || chr(8192)) || chr(8193)) || chr(8194)) || chr(8195)) || chr(8196)) || chr(8197)) || chr(8198)) || chr(8199)) || chr(8200)) || chr(8201)) || chr(8202)) || chr(8232)) || chr(8233)) || chr(8239)) || chr(8287)) || chr(12288)) || chr(65279)))) AND (membership_version !~ ((((((('['::text || chr(1)) || '-'::text) || chr(31)) || chr(127)) || '-'::text) || chr(159)) || ']'::text)))))",
      "CHECK (((membership_version IS NULL) OR (membership_version ~ '^[1-9][0-9]{0,127}$'::text)))",
      "CHECK (((operations_json IS NULL) OR (((octet_length(operations_json) >= 1) AND (octet_length(operations_json) <= 131072)) AND (operations_json = btrim(operations_json, ((((((((((((((((((((((((chr(9) || chr(10)) || chr(11)) || chr(12)) || chr(13)) || chr(32)) || chr(160)) || chr(5760)) || chr(8192)) || chr(8193)) || chr(8194)) || chr(8195)) || chr(8196)) || chr(8197)) || chr(8198)) || chr(8199)) || chr(8200)) || chr(8201)) || chr(8202)) || chr(8232)) || chr(8233)) || chr(8239)) || chr(8287)) || chr(12288)) || chr(65279)))) AND (operations_json !~ ((((((('['::text || chr(1)) || '-'::text) || chr(31)) || chr(127)) || '-'::text) || chr(159)) || ']'::text)))))",
      "CHECK (((operations_json IS NULL) OR ((jsonb_typeof((operations_json)::jsonb) = 'array'::text) AND ((jsonb_array_length((operations_json)::jsonb) >= 0) AND (jsonb_array_length((operations_json)::jsonb) <= 1024)))))",
      'CHECK (((revoked_at IS NULL) = (revoked_by IS NULL)))',
      "CHECK (((revoked_at IS NULL) OR ((revoked_at >= 0) AND (revoked_at <= '8640000000000000'::bigint))))",
      'CHECK (((revoked_at IS NULL) OR (revoked_at >= created_at)))',
      "CHECK (((revoked_by IS NULL) OR (((octet_length(revoked_by) >= 1) AND (octet_length(revoked_by) <= 3072)) AND (revoked_by = btrim(revoked_by, ((((((((((((((((((((((((chr(9) || chr(10)) || chr(11)) || chr(12)) || chr(13)) || chr(32)) || chr(160)) || chr(5760)) || chr(8192)) || chr(8193)) || chr(8194)) || chr(8195)) || chr(8196)) || chr(8197)) || chr(8198)) || chr(8199)) || chr(8200)) || chr(8201)) || chr(8202)) || chr(8232)) || chr(8233)) || chr(8239)) || chr(8287)) || chr(12288)) || chr(65279)))) AND (revoked_by !~ ((((((('['::text || chr(1)) || '-'::text) || chr(31)) || chr(127)) || '-'::text) || chr(159)) || ']'::text)))))",
      "CHECK (((subject_kind <> 'service'::text) OR (subject_id ~ '^[a-z][a-z0-9-]{0,62}$'::text)))",
      "CHECK (((tenant_id IS NULL) OR (((octet_length(tenant_id) >= 1) AND (octet_length(tenant_id) <= 128)) AND (tenant_id = btrim(tenant_id, ((((((((((((((((((((((((chr(9) || chr(10)) || chr(11)) || chr(12)) || chr(13)) || chr(32)) || chr(160)) || chr(5760)) || chr(8192)) || chr(8193)) || chr(8194)) || chr(8195)) || chr(8196)) || chr(8197)) || chr(8198)) || chr(8199)) || chr(8200)) || chr(8201)) || chr(8202)) || chr(8232)) || chr(8233)) || chr(8239)) || chr(8287)) || chr(12288)) || chr(65279)))) AND (tenant_id !~ ((((((('['::text || chr(1)) || '-'::text) || chr(31)) || chr(127)) || '-'::text) || chr(159)) || ']'::text)))))",
      "CHECK (((tenant_id IS NULL) OR (tenant_id ~ '^[a-z0-9][a-z0-9_-]{0,127}$'::text)))",
      "CHECK ((digest ~ '^[0-9a-f]{64}$'::text))",
      'CHECK ((expires_at > created_at))',
      "CHECK ((format = 'twa1'::text))",
      "CHECK ((subject_kind = ANY (ARRAY['account'::text, 'service'::text])))",
      "CHECK ((token_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text))",
      "CHECK ((version ~ '^[1-9][0-9]{0,127}$'::text))",
      'PRIMARY KEY (token_id)',
    ],
    indexes: [`CREATE UNIQUE INDEX auth_api_token_pkey ON ${RUNTIME_SCHEMA}.auth_api_token USING btree (token_id)`],
    triggers: 0,
    rules: 0,
    policies: 0,
  },
  {
    schema: RUNTIME_SCHEMA,
    name: 'auth_api_token_meta',
    kind: 'r',
    rls: false,
    columns: [
      {
        name: 'singleton',
        type: 'integer',
        notnull: true,
        collation: null,
        default: null,
      },
      {
        name: 'version',
        type: 'integer',
        notnull: true,
        collation: null,
        default: null,
      },
      {
        name: 'app_id',
        type: 'text',
        notnull: true,
        collation: 'C',
        default: null,
      },
      {
        name: 'store_id',
        type: 'text',
        notnull: true,
        collation: 'C',
        default: null,
      },
      {
        name: 'format',
        type: 'text',
        notnull: true,
        collation: 'C',
        default: null,
      },
    ],
    constraints: [
      "CHECK ((((octet_length(app_id) >= 1) AND (octet_length(app_id) <= 256)) AND (app_id = btrim(app_id, ((((((((((((((((((((((((chr(9) || chr(10)) || chr(11)) || chr(12)) || chr(13)) || chr(32)) || chr(160)) || chr(5760)) || chr(8192)) || chr(8193)) || chr(8194)) || chr(8195)) || chr(8196)) || chr(8197)) || chr(8198)) || chr(8199)) || chr(8200)) || chr(8201)) || chr(8202)) || chr(8232)) || chr(8233)) || chr(8239)) || chr(8287)) || chr(12288)) || chr(65279)))) AND (app_id !~ ((((((('['::text || chr(1)) || '-'::text) || chr(31)) || chr(127)) || '-'::text) || chr(159)) || ']'::text))))",
      "CHECK ((((octet_length(format) >= 1) AND (octet_length(format) <= 4)) AND (format = btrim(format, ((((((((((((((((((((((((chr(9) || chr(10)) || chr(11)) || chr(12)) || chr(13)) || chr(32)) || chr(160)) || chr(5760)) || chr(8192)) || chr(8193)) || chr(8194)) || chr(8195)) || chr(8196)) || chr(8197)) || chr(8198)) || chr(8199)) || chr(8200)) || chr(8201)) || chr(8202)) || chr(8232)) || chr(8233)) || chr(8239)) || chr(8287)) || chr(12288)) || chr(65279)))) AND (format !~ ((((((('['::text || chr(1)) || '-'::text) || chr(31)) || chr(127)) || '-'::text) || chr(159)) || ']'::text))))",
      "CHECK ((((octet_length(store_id) >= 1) AND (octet_length(store_id) <= 36)) AND (store_id = btrim(store_id, ((((((((((((((((((((((((chr(9) || chr(10)) || chr(11)) || chr(12)) || chr(13)) || chr(32)) || chr(160)) || chr(5760)) || chr(8192)) || chr(8193)) || chr(8194)) || chr(8195)) || chr(8196)) || chr(8197)) || chr(8198)) || chr(8199)) || chr(8200)) || chr(8201)) || chr(8202)) || chr(8232)) || chr(8233)) || chr(8239)) || chr(8287)) || chr(12288)) || chr(65279)))) AND (store_id !~ ((((((('['::text || chr(1)) || '-'::text) || chr(31)) || chr(127)) || '-'::text) || chr(159)) || ']'::text))))",
      "CHECK ((format = 'twa1'::text))",
      'CHECK ((singleton = 1))',
      "CHECK ((store_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text))",
      'CHECK ((version = 1))',
      'PRIMARY KEY (singleton)',
    ],
    indexes: [`CREATE UNIQUE INDEX auth_api_token_meta_pkey ON ${RUNTIME_SCHEMA}.auth_api_token_meta USING btree (singleton)`],
    triggers: 0,
    rules: 0,
    policies: 0,
  },
];

/* PostgreSQL's deparsed spelling of the DDL helpers above, as pg_get_constraintdef
   prints them: each binary operator parenthesized, BETWEEN as two comparisons, a
   literal past int4 cast to bigint. */
const deparsedWhitespace = [
  9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279,
].reduce((chain, code, index) => (index === 0 ? `chr(${code})` : `(${chain} || chr(${code}))`), '');
const deparsedControls = "((((((('['::text || chr(1)) || '-'::text) || chr(31)) || chr(127)) || '-'::text) || chr(159)) || ']'::text)";
const textCheck = (name: string, max: number, nullable = false) => {
  const body = `((((octet_length(${name}) >= 1) AND (octet_length(${name}) <= ${max})) AND (${name} = btrim(${name}, ${deparsedWhitespace}))) AND (${name} !~ ${deparsedControls}))`;
  return nullable ? `CHECK (((${name} IS NULL) OR ${body}))` : `CHECK (${body})`;
};
const between = (name: string, low: number, high: string) => `((${name} >= ${low}) AND (${name} <= '${high}'::bigint))`;
const instantCheck = (name: string, nullable = false) =>
  nullable ? `CHECK (((${name} IS NULL) OR ${between(name, 0, '8640000000000000')}))` : `CHECK (${between(name, 0, '8640000000000000')})`;
const matchCheck = (name: string, pattern: string, nullable = false) =>
  nullable ? `CHECK (((${name} IS NULL) OR (${name} ~ '${pattern}'::text)))` : `CHECK ((${name} ~ '${pattern}'::text))`;
const arrayCheck = (name: string, low: number, high: number) =>
  `CHECK (((jsonb_typeof((${name})::jsonb) = 'array'::text) AND ((jsonb_array_length((${name})::jsonb) >= ${low}) AND (jsonb_array_length((${name})::jsonb) <= ${high}))))`;
const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
const tenantChecks = [
  textCheck('tenant_id', 128, true),
  matchCheck('tenant_id', '^[a-z0-9][a-z0-9_-]{0,127}$', true),
  textCheck('membership_id', 3072, true),
  textCheck('membership_version', 128, true),
  matchCheck('membership_version', '^[1-9][0-9]{0,127}$', true),
  'CHECK ((((tenant_id IS NULL) = (membership_id IS NULL)) AND ((tenant_id IS NULL) = (membership_version IS NULL))))',
];
type Column = PostgresRelationDescription['columns'][number];
const textColumn = (name: string, notnull = true): Column => ({ name, type: 'text', notnull, collation: 'C', default: null });
const bigintColumn = (name: string, notnull = true): Column => ({ name, type: 'bigint', notnull, collation: null, default: null });
const tenantColumnsPinned = [textColumn('tenant_id', false), textColumn('membership_id', false), textColumn('membership_version', false)];
const relation = (name: string, columns: Column[], constraints: string[], indexes: string[]): PostgresRelationDescription => ({
  schema: RUNTIME_SCHEMA,
  name,
  kind: 'r',
  rls: false,
  columns,
  constraints: [...constraints].sort(byCodeUnit),
  indexes: [...indexes].sort(byCodeUnit),
  triggers: 0,
  rules: 0,
  policies: 0,
});
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const primary = (table: string, column: string) => [
  `PRIMARY KEY (${column})`,
  `CREATE UNIQUE INDEX ${table}_pkey ON ${RUNTIME_SCHEMA}.${table} USING btree (${column})`,
];
const secondary = (table: string, column: string, name: string) =>
  `CREATE INDEX ${name} ON ${RUNTIME_SCHEMA}.${table} USING btree (${column})`;

/** Exported for the spelling check against version 2's captured token table. */
export const deparsedTextCheck = textCheck;

function oauthPinned(): PostgresRelationDescription[] {
  return [
    relation(
      'auth_oauth_access',
      [textColumn('token_id'), textColumn('grant_id'), textColumn('app_id'), bigintColumn('version')],
      [
        textCheck('token_id', 36),
        matchCheck('token_id', UUID),
        textCheck('grant_id', 36),
        matchCheck('grant_id', UUID),
        textCheck('app_id', 256),
        `CHECK (${between('version', 1, '9007199254740991')})`,
        primary('auth_oauth_access', 'token_id')[0],
        'FOREIGN KEY (token_id) REFERENCES auth_api_token(token_id) ON DELETE CASCADE',
        'FOREIGN KEY (grant_id) REFERENCES auth_oauth_grant(grant_id)',
      ],
      [primary('auth_oauth_access', 'token_id')[1], secondary('auth_oauth_access', 'grant_id', 'auth_oauth_access_grant_idx')],
    ),
    relation(
      'auth_oauth_client',
      [
        textColumn('client_id'),
        textColumn('name', false),
        textColumn('redirect_uris_json'),
        bigintColumn('created_at'),
        bigintColumn('consented_at', false),
      ],
      [
        textCheck('client_id', 41),
        matchCheck('client_id', '^twc1[.][0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
        textCheck('name', 400, true),
        textCheck('redirect_uris_json', 16384),
        arrayCheck('redirect_uris_json', 1, 5),
        instantCheck('created_at'),
        instantCheck('consented_at', true),
        'CHECK (((consented_at IS NULL) OR (consented_at >= created_at)))',
        primary('auth_oauth_client', 'client_id')[0],
      ],
      [primary('auth_oauth_client', 'client_id')[1]],
    ),
    relation(
      'auth_oauth_code',
      [
        textColumn('code_digest'),
        textColumn('client_id'),
        textColumn('subject'),
        textColumn('redirect_uri'),
        textColumn('challenge'),
        textColumn('app_id'),
        bigintColumn('version'),
        textColumn('roles_json'),
        ...tenantColumnsPinned,
        bigintColumn('expires_at'),
        bigintColumn('used_at', false),
        textColumn('grant_id', false),
      ],
      [
        textCheck('code_digest', 64),
        matchCheck('code_digest', '^[0-9a-f]{64}$'),
        textCheck('client_id', 41),
        textCheck('subject', 3072),
        textCheck('redirect_uri', 2048),
        textCheck('challenge', 43),
        matchCheck('challenge', '^[A-Za-z0-9_-]{43}$'),
        textCheck('app_id', 256),
        `CHECK (${between('version', 1, '9007199254740991')})`,
        textCheck('roles_json', 131072),
        arrayCheck('roles_json', 1, 128),
        ...tenantChecks,
        instantCheck('expires_at'),
        instantCheck('used_at', true),
        textCheck('grant_id', 36, true),
        matchCheck('grant_id', UUID, true),
        'CHECK (((grant_id IS NULL) OR (used_at IS NOT NULL)))',
        primary('auth_oauth_code', 'code_digest')[0],
        'FOREIGN KEY (client_id) REFERENCES auth_oauth_client(client_id)',
        'FOREIGN KEY (grant_id) REFERENCES auth_oauth_grant(grant_id)',
      ],
      [primary('auth_oauth_code', 'code_digest')[1]],
    ),
    relation(
      'auth_oauth_grant',
      [
        textColumn('grant_id'),
        textColumn('client_id'),
        textColumn('subject'),
        textColumn('app_id'),
        bigintColumn('version'),
        textColumn('roles_json'),
        ...tenantColumnsPinned,
        bigintColumn('created_at'),
        bigintColumn('expires_at'),
        bigintColumn('revoked_at', false),
      ],
      [
        textCheck('grant_id', 36),
        matchCheck('grant_id', UUID),
        textCheck('client_id', 41),
        textCheck('subject', 3072),
        textCheck('app_id', 256),
        `CHECK (${between('version', 1, '9007199254740991')})`,
        textCheck('roles_json', 131072),
        arrayCheck('roles_json', 1, 128),
        ...tenantChecks,
        instantCheck('created_at'),
        instantCheck('expires_at'),
        instantCheck('revoked_at', true),
        'CHECK ((expires_at > created_at))',
        'CHECK (((revoked_at IS NULL) OR (revoked_at >= created_at)))',
        primary('auth_oauth_grant', 'grant_id')[0],
        'FOREIGN KEY (client_id) REFERENCES auth_oauth_client(client_id)',
      ],
      [primary('auth_oauth_grant', 'grant_id')[1], secondary('auth_oauth_grant', 'subject', 'auth_oauth_grant_subject_idx')],
    ),
    relation(
      'auth_oauth_refresh',
      [textColumn('digest'), textColumn('grant_id'), bigintColumn('issued_at'), bigintColumn('used_at', false)],
      [
        textCheck('digest', 64),
        matchCheck('digest', '^[0-9a-f]{64}$'),
        textCheck('grant_id', 36),
        matchCheck('grant_id', UUID),
        instantCheck('issued_at'),
        instantCheck('used_at', true),
        'CHECK (((used_at IS NULL) OR (used_at >= issued_at)))',
        primary('auth_oauth_refresh', 'digest')[0],
        'FOREIGN KEY (grant_id) REFERENCES auth_oauth_grant(grant_id)',
      ],
      [primary('auth_oauth_refresh', 'digest')[1], secondary('auth_oauth_refresh', 'grant_id', 'auth_oauth_refresh_grant_idx')],
    ),
  ];
}
