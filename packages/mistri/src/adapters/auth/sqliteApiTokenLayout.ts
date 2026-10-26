/** Fixed private token extension: the tenant membership binding and the
 * OAuth 2.1 authorization server's rows (server/auth/oauthServer.ts): the
 * registered clients, the one-time codes, the grants a person consented
 * to, their refresh digests, and which issued access token belongs to which
 * grant. An OAuth access token is an ordinary twa1 token with an
 * `oauth_access` row beside it. No provisioning or caller-defined objects. JSON
 * canonical form, Unicode/trim semantics and grants remain codec/owner
 * checks; these physical constraints never constitute token authorization. */
import { API_TOKEN_STORE_VERSION } from './postgresApiTokenLayout.js';

export { API_TOKEN_STORE_VERSION };
export const SQLITE_API_TOKEN_TABLES = Object.freeze({
  meta: '__mistri_api_token_meta',
  token: '__mistri_api_token',
  client: '__mistri_oauth_client',
  code: '__mistri_oauth_code',
  grant: '__mistri_oauth_grant',
  refresh: '__mistri_oauth_refresh',
  access: '__mistri_oauth_access',
});
const whitespace = 'char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)';
const text = (name: string, max: number, nullable = false) =>
  `${name} TEXT COLLATE BINARY${nullable ? '' : ' NOT NULL'} CHECK (${nullable ? `${name} IS NULL OR ` : ''}(typeof(${name}) = 'text' AND instr(${name}, char(0)) = 0 AND ${name} NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || ']*') AND ${name} = trim(${name}, ${whitespace}) AND length(CAST(${name} AS BLOB)) BETWEEN 1 AND ${max}))`;
const hex = '[0-9a-f]';
const uuidPattern = `${hex.repeat(8)}-${hex.repeat(4)}-4${hex.repeat(3)}-[89ab]${hex.repeat(3)}-${hex.repeat(12)}`;
// The not-null spelling is exact, character for character: the catalog check compares the text.
const uuid = (name: string, nullable = false) =>
  nullable
    ? `${text(name, 36, true)} CHECK (${name} IS NULL OR (length(${name}) = 36 AND ${name} GLOB '${uuidPattern}'))`
    : `${text(name, 36)} CHECK (length(${name}) = 36 AND ${name} GLOB '${uuidPattern}')`;
const instant = (name: string, nullable = false) =>
  `${name} INTEGER${nullable ? '' : ' NOT NULL'} CHECK (${nullable ? `${name} IS NULL OR ` : ''}(typeof(${name}) = 'integer' AND ${name} BETWEEN 0 AND 8640000000000000))`;
const digest = (name: string) => `${text(name, 64)} CHECK (length(${name}) = 64 AND ${name} NOT GLOB '*[^0-9a-f]*')`;
/** An App API version: a positive safe integer, as the App declares it. */
const apiVersion = (name: string) =>
  `${name} INTEGER NOT NULL CHECK (typeof(${name}) = 'integer' AND ${name} BETWEEN 1 AND 9007199254740991)`;
const roles = (name: string) =>
  `${text(name, 131072)} CHECK (json_valid(${name}) AND json_type(${name}) = 'array' AND json_array_length(${name}) BETWEEN 1 AND 128)`;
/** The tenant membership binding, as the token table spells it. */
const tenantColumns = [
  `${text('tenant_id', 128, true)} CHECK (tenant_id IS NULL OR (tenant_id GLOB '[a-z0-9]*' AND tenant_id NOT GLOB '*[^a-z0-9_-]*'))`,
  `${text('membership_id', 3072, true)}`,
  `${text('membership_version', 128, true)} CHECK (membership_version IS NULL OR (membership_version GLOB '[1-9]*' AND membership_version NOT GLOB '*[^0-9]*'))`,
];
const tenantBound = 'CHECK ((tenant_id IS NULL) = (membership_id IS NULL) AND (tenant_id IS NULL) = (membership_version IS NULL))';
const tables = SQLITE_API_TOKEN_TABLES;
const metaDdl = (version: number) => `CREATE TABLE "${tables.meta}" (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL CHECK (version = ${version}),
  ${text('app_id', 256)},
  ${uuid('store_id')},
  ${text('format', 4)} CHECK (format = 'twa1')
)`;
const tokenDdl = `CREATE TABLE "${tables.token}" (
  ${uuid('token_id')} PRIMARY KEY,
  ${text('app_id', 256)},
  ${text('subject_kind', 7)} CHECK (subject_kind IN ('account', 'service')),
  ${text('subject_id', 3072)},
  ${text('label', 512)},
  ${text('roles_json', 131072)} CHECK (json_valid(roles_json) AND json_type(roles_json) = 'array' AND json_array_length(roles_json) BETWEEN 1 AND 128),
  ${text('operations_json', 131072, true)} CHECK (operations_json IS NULL OR (json_valid(operations_json) AND json_type(operations_json) = 'array' AND json_array_length(operations_json) BETWEEN 0 AND 1024)),
  ${instant('created_at')},
  ${text('created_by', 3072)},
  ${instant('expires_at')},
  ${instant('revoked_at', true)},
  ${text('revoked_by', 3072, true)},
  ${instant('last_used_at', true)},
  ${text('format', 4)} CHECK (format = 'twa1'),
  ${text('digest', 64)} CHECK (length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*'),
  ${text('version', 128)} CHECK (version GLOB '[1-9]*' AND version NOT GLOB '*[^0-9]*'),
  ${text('tenant_id', 128, true)} CHECK (tenant_id IS NULL OR (tenant_id GLOB '[a-z0-9]*' AND tenant_id NOT GLOB '*[^a-z0-9_-]*')),
  ${text('membership_id', 3072, true)},
  ${text('membership_version', 128, true)} CHECK (membership_version IS NULL OR (membership_version GLOB '[1-9]*' AND membership_version NOT GLOB '*[^0-9]*')),
  CHECK ((tenant_id IS NULL) = (membership_id IS NULL) AND (tenant_id IS NULL) = (membership_version IS NULL)),
  CHECK (expires_at > created_at),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CHECK (last_used_at IS NULL OR last_used_at >= created_at),
  CHECK (subject_kind <> 'service' OR (length(subject_id) BETWEEN 1 AND 63 AND subject_id GLOB '[a-z]*' AND subject_id NOT GLOB '*[^a-z0-9-]*'))
)`;
/** The OAuth rows (v3), in the order their references need. Clients are
 * public (no secret): `twc1.` and a UUID. Every secret is a digest. */
const SQLITE_API_TOKEN_OAUTH_DDL = Object.freeze([
  `CREATE TABLE "${tables.client}" (
  ${text('client_id', 41)} CHECK (length(client_id) = 41 AND client_id GLOB 'twc1.${uuidPattern}') PRIMARY KEY,
  ${text('name', 400, true)},
  ${text('redirect_uris_json', 16384)} CHECK (json_valid(redirect_uris_json) AND json_type(redirect_uris_json) = 'array' AND json_array_length(redirect_uris_json) BETWEEN 1 AND 5),
  ${instant('created_at')},
  ${instant('consented_at', true)},
  CHECK (consented_at IS NULL OR consented_at >= created_at)
)`,
  `CREATE TABLE "${tables.grant}" (
  ${uuid('grant_id')} PRIMARY KEY,
  ${text('client_id', 41)} REFERENCES "${tables.client}" (client_id),
  ${text('subject', 3072)},
  ${text('app_id', 256)},
  ${apiVersion('version')},
  ${roles('roles_json')},
  ${tenantColumns.join(',\n  ')},
  ${instant('created_at')},
  ${instant('expires_at')},
  ${instant('revoked_at', true)},
  ${tenantBound},
  CHECK (expires_at > created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
)`,
  `CREATE TABLE "${tables.code}" (
  ${digest('code_digest')} PRIMARY KEY,
  ${text('client_id', 41)} REFERENCES "${tables.client}" (client_id),
  ${text('subject', 3072)},
  ${text('redirect_uri', 2048)},
  ${text('challenge', 43)} CHECK (length(challenge) = 43 AND challenge NOT GLOB '*[^A-Za-z0-9_-]*'),
  ${text('app_id', 256)},
  ${apiVersion('version')},
  ${roles('roles_json')},
  ${tenantColumns.join(',\n  ')},
  ${instant('expires_at')},
  ${instant('used_at', true)},
  ${uuid('grant_id', true)} REFERENCES "${tables.grant}" (grant_id),
  ${tenantBound},
  CHECK (grant_id IS NULL OR used_at IS NOT NULL)
)`,
  `CREATE TABLE "${tables.refresh}" (
  ${digest('digest')} PRIMARY KEY,
  ${uuid('grant_id')} REFERENCES "${tables.grant}" (grant_id),
  ${instant('issued_at')},
  ${instant('used_at', true)},
  CHECK (used_at IS NULL OR used_at >= issued_at)
)`,
  `CREATE TABLE "${tables.access}" (
  ${uuid('token_id')} PRIMARY KEY REFERENCES "${tables.token}" (token_id) ON DELETE CASCADE,
  ${uuid('grant_id')} REFERENCES "${tables.grant}" (grant_id),
  ${text('app_id', 256)},
  ${apiVersion('version')}
)`,
  `CREATE INDEX "${tables.grant}_subject" ON "${tables.grant}" (subject)`,
  `CREATE INDEX "${tables.refresh}_grant" ON "${tables.refresh}" (grant_id)`,
  `CREATE INDEX "${tables.access}_grant" ON "${tables.access}" (grant_id)`,
]);
export const SQLITE_API_TOKEN_DDL = Object.freeze([metaDdl(API_TOKEN_STORE_VERSION), tokenDdl, ...SQLITE_API_TOKEN_OAUTH_DDL]);

type Entry = Readonly<{ type: string; name: string; tbl_name: string; sql: string | null }>;
const byCatalog = (a: Entry, b: Entry) => (a.type < b.type ? -1 : a.type > b.type ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const tableEntry = (name: string, sql: string): Entry => Object.freeze({ type: 'table', name, tbl_name: name, sql });
const autoindex = (table: string): Entry =>
  Object.freeze({ type: 'index', name: `sqlite_autoindex_${table}_1`, tbl_name: table, sql: null });
/** Exact native sqlite_schema expectations. INTEGER PRIMARY KEY has no index;
 * each TEXT PRIMARY KEY has precisely one automatic index. */
const oauthTables = [tables.client, tables.grant, tables.code, tables.refresh, tables.access];
export const SQLITE_API_TOKEN_CATALOG: readonly Entry[] = Object.freeze(
  [
    autoindex(tables.token),
    tableEntry(tables.meta, metaDdl(API_TOKEN_STORE_VERSION)),
    tableEntry(tables.token, tokenDdl),
    ...oauthTables.map((name, index) => tableEntry(name, SQLITE_API_TOKEN_OAUTH_DDL[index])),
    ...oauthTables.map(autoindex),
    ...SQLITE_API_TOKEN_OAUTH_DDL.slice(oauthTables.length).map((sql) => {
      const [, name, table] = /^CREATE INDEX "([^"]+)" ON "([^"]+)"/.exec(sql)!;
      return Object.freeze({ type: 'index', name, tbl_name: table, sql });
    }),
  ].sort(byCatalog),
);
