/** A suite's grants, account preferences and authority history on PostgreSQL:
 * a set of tables each in the runtime schema, under its own name prefix, side
 * by side in one database the suite keeps for them (and, if it likes, its flag
 * control), never an identity or business database. The rules are the SQLite
 * stores' own, imported from them; what differs is only how a row is reached.
 * Provisioning creates all three or none; opening attests each layout and
 * binding and never repairs or migrates. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { RUNTIME_SCHEMA } from '@mistriwork/engine/shared/runtimeTables.js';
import { layoutRefusal, postgresLayoutVersion } from '@mistriwork/engine/adapters/layoutRefusal.js';
import type { PgPool, PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import { pgConnectionOptions } from '@mistriwork/engine/adapters/postgresValues.js';
import { postgresRuntimeSchemaProblems, withPostgresMaintenanceTransaction } from '@mistriwork/engine/adapters/postgresMaintenance.js';
import type { PostgresRelationDescription } from '../../adapters/commands/postgresRelations.js';
import { describePostgresRelations, foldRelations } from '../../adapters/commands/postgresRelations.js';
import { canonicalCommandJson } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import { captureTenantData, tenantRecord } from '@mistriwork/engine/server/evidence.js';
import {
  SUITE_ACCESS_PAGE,
  SUITE_INVITATIONS_MAX_OFFSET,
  SUITE_INVITATIONS_PAGE,
  type SuiteInvitationStatus,
  type SuiteInvitationSummary,
} from '../../shared/suiteAdministration.js';
import * as grantRules from './suiteGrantStore.js';
import * as preferenceRules from './suitePreferences.js';
import * as authorityRules from './suiteAuthority.js';
import type { Asynchronous } from './suiteStores.js';
import type { openSuiteGrantStore } from './suiteGrantStore.js';
import type { openSuitePreferencesStore } from './suitePreferences.js';
import type { openSuiteAuthorityStore } from './suiteAuthority.js';

const S = RUNTIME_SCHEMA;
/** Each store's name prefix in the runtime schema: every table, index and rule of the store is named under it. */
const G = 'suite_grant',
  P = 'suite_preference',
  A = 'suite_authority';
/** The three stores, which a suite's database holds together or not at all. */
export const POSTGRES_SUITE_PREFIXES: readonly string[] = [G, P, A];
/** A name prefix as a LIKE pattern, its underscores literal. */
const like = (prefix: string) => `${prefix.replaceAll('_', '\\_')}%`;
/** Each store's layout version: the PostgreSQL layouts began here, apart from the SQLite files' own versions. */
const POSTGRES_SUITE_STORE_VERSION = 1;

/* Every text column is "C": SQLite compares TEXT bytewise, and a page's cursor (`id < $n`) and its order must mean
   what they mean there, whatever the database's locale. Times and revisions are bigint, read back as numbers below.
   The append-only and immutable tables are kept so by rules, as the sign-in store's account audit is: a rule is
   described with its table and the store adds no function another role could replace. */
const binding = (store: string) =>
  `CREATE TABLE ${S}.${store}_binding (singleton integer PRIMARY KEY CHECK (singleton = 1), version integer NOT NULL CHECK (version = 1), suite_id text COLLATE "C" NOT NULL)`;
const appendOnly = (table: string) => [
  `CREATE RULE ${table}_no_update AS ON UPDATE TO ${S}.${table} DO INSTEAD NOTHING`,
  `CREATE RULE ${table}_no_delete AS ON DELETE TO ${S}.${table} DO INSTEAD NOTHING`,
];
const DDL: Readonly<Record<string, readonly string[]>> = {
  [G]: [
    binding(G),
    `CREATE TABLE ${S}.suite_grant (app_id text COLLATE "C" NOT NULL, subject_id text COLLATE "C" NOT NULL,
      revision bigint NOT NULL CHECK (revision > 0), roles text NOT NULL, PRIMARY KEY (app_id, subject_id))`,
    `CREATE TABLE ${S}.suite_grant_audit (id text COLLATE "C" PRIMARY KEY, app_id text COLLATE "C" NOT NULL,
      subject_id text COLLATE "C" NOT NULL, actor_id text COLLATE "C" NOT NULL, at bigint NOT NULL, revision bigint NOT NULL,
      before_roles text NOT NULL, after_roles text NOT NULL, UNIQUE (app_id, subject_id, revision))`,
    ...appendOnly('suite_grant_audit'),
    `CREATE TABLE ${S}.suite_grant_invitation (id text COLLATE "C" PRIMARY KEY, app_id text COLLATE "C" NOT NULL,
      subject_id text COLLATE "C" NOT NULL, expected_revision bigint NOT NULL CHECK (expected_revision >= 0), roles text NOT NULL,
      issuer_id text COLLATE "C" NOT NULL, administrator_revision bigint NOT NULL CHECK (administrator_revision > 0),
      issued_at bigint NOT NULL, expires_at bigint NOT NULL, token_hash text COLLATE "C" NOT NULL UNIQUE, consumed_at bigint,
      revoked_at bigint, CHECK (expires_at > issued_at), CHECK (consumed_at IS NULL OR revoked_at IS NULL))`,
    // An invitation's terms never change, a consumed or revoked one never changes again, and none is ever deleted.
    `CREATE RULE suite_grant_invitation_immutable AS ON UPDATE TO ${S}.suite_grant_invitation
      WHERE OLD.consumed_at IS NOT NULL OR OLD.revoked_at IS NOT NULL OR NEW.id <> OLD.id OR NEW.app_id <> OLD.app_id
        OR NEW.subject_id <> OLD.subject_id OR NEW.expected_revision <> OLD.expected_revision OR NEW.roles <> OLD.roles
        OR NEW.issuer_id <> OLD.issuer_id OR NEW.administrator_revision <> OLD.administrator_revision
        OR NEW.issued_at <> OLD.issued_at OR NEW.expires_at <> OLD.expires_at OR NEW.token_hash <> OLD.token_hash
      DO INSTEAD NOTHING`,
    `CREATE RULE suite_grant_invitation_no_delete AS ON DELETE TO ${S}.suite_grant_invitation DO INSTEAD NOTHING`,
    `CREATE TABLE ${S}.suite_grant_invitation_audit (id text COLLATE "C" PRIMARY KEY, invitation_id text COLLATE "C" NOT NULL,
      app_id text COLLATE "C" NOT NULL, subject_id text COLLATE "C" NOT NULL, actor_id text COLLATE "C" NOT NULL,
      at bigint NOT NULL, event text COLLATE "C" NOT NULL CHECK (event IN ('issue', 'accept', 'revoke')), UNIQUE (invitation_id, event))`,
    ...appendOnly('suite_grant_invitation_audit'),
  ],
  [P]: [
    binding(P),
    `CREATE TABLE ${S}.suite_preference (subject_id text COLLATE "C" PRIMARY KEY, default_app text COLLATE "C",
      revision bigint NOT NULL CHECK (revision > 0))`,
  ],
  [A]: [
    binding(A),
    `CREATE TABLE ${S}.suite_authority (id bigint PRIMARY KEY, app_id text COLLATE "C" NOT NULL, recorded_at bigint NOT NULL,
      sha256 text COLLATE "C" NOT NULL, report text NOT NULL)`,
    `CREATE INDEX suite_authority_app ON ${S}.suite_authority (app_id, id)`,
    ...appendOnly('suite_authority'),
  ],
};

/* ---------- the layout each store holds, exactly ---------- */

type Column = PostgresRelationDescription['columns'][number];
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const column = (name: string, type: string, notnull: boolean, collation: string | null): Column => ({
  name,
  type,
  notnull,
  collation,
  default: null,
});
/** An identifier, compared bytewise. */
const key = (name: string, notnull = true) => column(name, 'text', notnull, 'C');
/** Free text the store parses itself (a roles list, an authority report). */
const prose = (name: string) => column(name, 'text', true, 'default');
const big = (name: string, notnull = true) => column(name, 'bigint', notnull, null);
const index = (table: string, name: string, columns: string, unique = true) =>
  `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${name} ON ${S}.${table} USING btree (${columns})`;
const relation = (name: string, columns: Column[], constraints: string[], indexes: string[], rules = 0): PostgresRelationDescription => ({
  schema: S,
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
const bindingLayout = (store: string) =>
  relation(
    `${store}_binding`,
    [column('singleton', 'integer', true, null), column('version', 'integer', true, null), key('suite_id')],
    ['CHECK ((singleton = 1))', 'CHECK ((version = 1))', 'PRIMARY KEY (singleton)'],
    [index(`${store}_binding`, `${store}_binding_pkey`, 'singleton')],
  );
const LAYOUTS: Readonly<Record<string, readonly PostgresRelationDescription[]>> = {
  [G]: [
    bindingLayout(G),
    relation(
      'suite_grant',
      [key('app_id'), key('subject_id'), big('revision'), prose('roles')],
      ['CHECK ((revision > 0))', 'PRIMARY KEY (app_id, subject_id)'],
      [index('suite_grant', 'suite_grant_pkey', 'app_id, subject_id')],
    ),
    relation(
      'suite_grant_audit',
      [
        key('id'),
        key('app_id'),
        key('subject_id'),
        key('actor_id'),
        big('at'),
        big('revision'),
        prose('before_roles'),
        prose('after_roles'),
      ],
      ['PRIMARY KEY (id)', 'UNIQUE (app_id, subject_id, revision)'],
      [
        index('suite_grant_audit', 'suite_grant_audit_app_id_subject_id_revision_key', 'app_id, subject_id, revision'),
        index('suite_grant_audit', 'suite_grant_audit_pkey', 'id'),
      ],
      2,
    ),
    relation(
      'suite_grant_invitation',
      [
        key('id'),
        key('app_id'),
        key('subject_id'),
        big('expected_revision'),
        prose('roles'),
        key('issuer_id'),
        big('administrator_revision'),
        big('issued_at'),
        big('expires_at'),
        key('token_hash'),
        big('consumed_at', false),
        big('revoked_at', false),
      ],
      [
        'CHECK (((consumed_at IS NULL) OR (revoked_at IS NULL)))',
        'CHECK ((administrator_revision > 0))',
        'CHECK ((expected_revision >= 0))',
        'CHECK ((expires_at > issued_at))',
        'PRIMARY KEY (id)',
        'UNIQUE (token_hash)',
      ],
      [
        index('suite_grant_invitation', 'suite_grant_invitation_pkey', 'id'),
        index('suite_grant_invitation', 'suite_grant_invitation_token_hash_key', 'token_hash'),
      ],
      2,
    ),
    relation(
      'suite_grant_invitation_audit',
      [key('id'), key('invitation_id'), key('app_id'), key('subject_id'), key('actor_id'), big('at'), key('event')],
      ["CHECK ((event = ANY (ARRAY['issue'::text, 'accept'::text, 'revoke'::text])))", 'PRIMARY KEY (id)', 'UNIQUE (invitation_id, event)'],
      [
        index('suite_grant_invitation_audit', 'suite_grant_invitation_audit_invitation_id_event_key', 'invitation_id, event'),
        index('suite_grant_invitation_audit', 'suite_grant_invitation_audit_pkey', 'id'),
      ],
      2,
    ),
  ],
  [P]: [
    bindingLayout(P),
    relation(
      'suite_preference',
      [key('subject_id'), key('default_app', false), big('revision')],
      ['CHECK ((revision > 0))', 'PRIMARY KEY (subject_id)'],
      [index('suite_preference', 'suite_preference_pkey', 'subject_id')],
    ),
  ],
  [A]: [
    bindingLayout(A),
    relation(
      'suite_authority',
      [big('id'), key('app_id'), big('recorded_at'), key('sha256'), prose('report')],
      ['PRIMARY KEY (id)'],
      [index('suite_authority', 'suite_authority_app', 'app_id, id', false), index('suite_authority', 'suite_authority_pkey', 'id')],
      2,
    ),
  ],
};
/* The description counts a table's rules; what each says is read apart, since a rule that lets a row change is
   exactly the difference that matters here. Compared with whitespace folded and the schema left off the name. */
const nothing = (table: string, event: 'UPDATE' | 'DELETE') =>
  [
    `${table}_no_${event.toLowerCase()}`,
    `CREATE RULE ${table}_no_${event.toLowerCase()} AS ON ${event} TO ${table} DO INSTEAD NOTHING;`,
  ] as const;
/* In the order the attestation reads them: by name, code unit by code unit. */
const RULES: Readonly<Record<string, ReadonlyArray<readonly [string, string]>>> = {
  [G]: [
    nothing('suite_grant_audit', 'DELETE'),
    nothing('suite_grant_audit', 'UPDATE'),
    nothing('suite_grant_invitation_audit', 'DELETE'),
    nothing('suite_grant_invitation_audit', 'UPDATE'),
    [
      'suite_grant_invitation_immutable',
      'CREATE RULE suite_grant_invitation_immutable AS ON UPDATE TO suite_grant_invitation WHERE ((old.consumed_at IS NOT NULL) OR ' +
        '(old.revoked_at IS NOT NULL) OR (new.id <> old.id) OR (new.app_id <> old.app_id) OR (new.subject_id <> old.subject_id) OR ' +
        '(new.expected_revision <> old.expected_revision) OR (new.roles <> old.roles) OR (new.issuer_id <> old.issuer_id) OR ' +
        '(new.administrator_revision <> old.administrator_revision) OR (new.issued_at <> old.issued_at) OR ' +
        '(new.expires_at <> old.expires_at) OR (new.token_hash <> old.token_hash)) DO INSTEAD NOTHING;',
    ],
    nothing('suite_grant_invitation', 'DELETE'),
  ],
  [P]: [],
  [A]: [nothing('suite_authority', 'DELETE'), nothing('suite_authority', 'UPDATE')],
};
const canonical = (value: readonly PostgresRelationDescription[]) =>
  canonicalCommandJson(
    foldRelations(value).sort((a, b) => byCodeUnit(`${a.schema}.${a.name}`, `${b.schema}.${b.name}`)),
    1_048_576,
  );
const EXPECTED: Readonly<Record<string, string>> = Object.fromEntries(
  POSTGRES_SUITE_PREFIXES.map((store) => [store, canonical(LAYOUTS[store])]),
);

/** Each store as its refusals name it, with the error it refuses in: the SQLite store's own. */
const STORES: Readonly<Record<string, { readonly name: string; readonly unavailable: (message?: string) => never }>> = {
  [G]: { name: 'The suite grant store', unavailable: grantRules.unavailable },
  [P]: { name: 'The suite preferences store', unavailable: preferenceRules.unavailable },
  [A]: { name: 'The suite authority store', unavailable: authorityRules.unavailable },
};

/* ---------- the database and the connection ---------- */

/** What else the runtime schema may hold: the suite's flag control, its tables and its trigger function
    (flags/storePostgres.ts allows these stores in turn). */
const NEIGHBOURS = ['flag_'],
  NEIGHBOUR_FUNCTIONS = ['flag_immutable'];

/**
 * A suite's database holds the suite's stores and nothing of anyone else's, as a
 * suite's SQLite stores are files of their own: never an identity store or a
 * business database, whose roles could then read or write a grant. Any schema
 * but `public` and the runtime schema, anything in `public`, a table or function
 * in the runtime schema that is no store's here, an extension other than
 * plpgsql, or rules switched off for replication (`session_replication_role`)
 * is refused.
 */
async function dedicated(client: PgQuery, unavailable: (message?: string) => never): Promise<void> {
  const row = (
    await client.query(
      `SELECT current_setting('session_replication_role') = 'origin' AS origin,
      NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname <> ALL($1::text[]) AND left(nspname, 3) <> 'pg_' AND nspname <> 'information_schema') AS schemas,
      NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' OR (n.nspname = $2 AND NOT (lower(c.relname) LIKE ANY ($3::text[])))) AS relations,
      NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' OR (n.nspname = $2 AND p.proname <> ALL($4::text[]))) AS routines,
      NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public') AS types,
      NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname <> 'plpgsql') AS extensions`,
      [['public', S], S, [...POSTGRES_SUITE_PREFIXES, ...NEIGHBOURS].map(like), NEIGHBOUR_FUNCTIONS],
    )
  ).rows[0];
  if (!row || Object.values(row).some((value) => value !== true))
    return unavailable(
      "The suite's PostgreSQL database holds more than a suite's stores: keep its grants, preferences and authority history " +
        'in a database of their own (its flag control may share it), never the identity database or a business database.',
    );
}

/** One store's layout, rules, binding and ownership, in the caller's transaction. */
async function attest(client: PgQuery, prefix: string, suiteId: string): Promise<void> {
  const store = STORES[prefix];
  let same = false;
  // A failed read (a relation of another shape) must not abort the transaction the refusal is then read in.
  await client.query('SAVEPOINT attest');
  try {
    // The description prints a name qualified or not by what is on the path: pinned, it reads the same everywhere.
    await client.query(`SET LOCAL search_path TO pg_catalog, "${S}", pg_temp`);
    same = canonical(await describePostgresRelations(client, prefix)) === EXPECTED[prefix];
    if (same) {
      const rules = (
        await client.query(
          `SELECT r.rulename AS name, pg_get_ruledef(r.oid) AS definition FROM pg_rewrite r JOIN pg_class c ON c.oid = r.ev_class
          JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND lower(c.relname) LIKE $2 ORDER BY r.rulename COLLATE "C"`,
          [S, like(prefix)],
        )
      ).rows.map((row) => [row.name, String(row.definition).replace(/\s+/g, ' ').replaceAll(`${S}.`, '')] as const);
      same = JSON.stringify(rules) === JSON.stringify(RULES[prefix]);
    }
    if (same) await bound(client, prefix, suiteId);
    await client.query('RELEASE SAVEPOINT attest');
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT attest');
    if (same) throw error;
  }
  await client.query('SET LOCAL search_path TO pg_catalog');
  if (!same)
    return store.unavailable(
      layoutRefusal(store.name, await postgresLayoutVersion(client, `${S}.${prefix}_binding`), POSTGRES_SUITE_STORE_VERSION),
    );
  const problems = await postgresRuntimeSchemaProblems(client, prefix);
  if (problems.length) return store.unavailable(`${store.name} is not solely this role's: ${problems.join('; ')}.`);
}

/** The binding row, read before each operation as the SQLite stores read theirs. */
async function bound(client: PgQuery, prefix: string, suiteId: string): Promise<void> {
  const rows = (await client.query(`SELECT singleton, version, suite_id FROM ${S}.${prefix}_binding`)).rows;
  if (rows.length !== 1 || rows[0].singleton !== 1 || rows[0].suite_id !== suiteId || rows[0].version !== POSTGRES_SUITE_STORE_VERSION)
    return STORES[prefix].unavailable(
      layoutRefusal(STORES[prefix].name, rows.length === 1 ? rows[0].version : undefined, POSTGRES_SUITE_STORE_VERSION),
    );
}

const lockOf = (prefix: string) => createHash('sha256').update(`${S}.${prefix}`).digest().readBigInt64BE().toString();

interface PoolModule {
  Pool?: new (options: Record<string, unknown>) => PgPool;
  types?: { getTypeParser(oid: number, format?: string): (value: string) => unknown };
  default?: PoolModule;
}

async function openPool(url: string): Promise<PgPool> {
  const specifier = 'pg';
  const pg = (await import(specifier).catch(() => {
    throw new Error('A suite on PostgreSQL needs the "pg" package. Install it with: npm install pg');
  })) as PoolModule;
  const Pool = pg.Pool ?? pg.default?.Pool,
    types = pg.types ?? pg.default?.types;
  if (!Pool || !types) throw new Error('Could not find a Pool export in the "pg" package.');
  const pool = new Pool({
    ...pgConnectionOptions(url),
    max: 4,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    application_name: 'mistri-suite',
    /* Revisions and instants are bigint, which the driver reads as text; as numbers, they are what the SQLite stores
       read, and one past 2^53 is not a safe integer, so the stores' own checks refuse it. */
    types: { getTypeParser: (oid: number, format?: string) => (oid === 20 ? Number : types.getTypeParser(oid, format)) },
  });
  // An idle client's failure is the pool's to hear; the query a leased one was running rejects with it.
  pool.on('error', () => {});
  return pool;
}

/**
 * One operation, on a client of its own. A write is what BEGIN IMMEDIATE is to the SQLite stores: their one write
 * lock taken before the first read, so the transaction reads every write committed before it and no other writer
 * of the store runs until it ends. Here that lock is a transaction-scoped advisory lock per store, taken first, and
 * READ COMMITTED reads each statement from a fresh snapshot, so every read after the lock sees every write
 * committed before it. SERIALIZABLE would be as safe but answers a conflict with a serialization failure the caller
 * would have to retry; the lock makes it a wait, as SQLite's own lock does. A read alone (no lock) is one
 * REPEATABLE READ snapshot, as a SQLite read sees one database state.
 */
async function operation<T>(
  pool: PgPool,
  prefix: string,
  suiteId: string,
  write: boolean,
  work: (client: PgQuery) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query(write ? 'BEGIN ISOLATION LEVEL READ COMMITTED' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      await client.query("SET LOCAL search_path TO pg_catalog; SET LOCAL lock_timeout = '10s'; SET LOCAL statement_timeout = '15s'");
      if (write) await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockOf(prefix)]);
      await bound(client, prefix, suiteId);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {
        broken = true;
      });
      throw error;
    }
  } finally {
    client.release(broken);
  }
}

/* ---------- the grant ledger ---------- */

type GrantStore = ReturnType<typeof openSuiteGrantStore>;
type Grant = ReturnType<GrantStore['read']>;
const {
  PROVIDER_ACTOR,
  unavailable,
  invalid,
  identifier,
  appName,
  rolesOf,
  refuseInvitation,
  grantFields,
  timestamp,
  storedRoles,
  storedChange,
  tokenHash,
  administratorRevision,
  grantRoles,
  SuiteGrantConflict,
} = grantRules;

function grantStore(pool: PgPool, suiteId: string): Asynchronous<GrantStore> {
  const run = <T>(write: boolean, work: (client: PgQuery) => Promise<T>) => operation(pool, G, suiteId, write, work);
  const readIn = async (client: PgQuery, subjectId: string, appId: string): Promise<Grant> => {
    const row = (
      await client.query(`SELECT revision, roles FROM ${S}.suite_grant WHERE app_id = $1 AND subject_id = $2`, [appId, subjectId])
    ).rows[0];
    if (!row) return Object.freeze({ revision: 0, roles: Object.freeze([]) });
    if (typeof row.revision !== 'number' || !Number.isSafeInteger(row.revision) || row.revision < 1 || typeof row.roles !== 'string')
      return unavailable();
    try {
      return Object.freeze({ revision: row.revision, roles: Object.freeze(rolesOf(JSON.parse(row.roles))) });
    } catch {
      return unavailable();
    }
  };
  const lastActor = async (client: PgQuery, subjectId: string, appId: string) =>
    (
      await client.query(
        `SELECT actor_id FROM ${S}.suite_grant_audit WHERE app_id = $1 AND subject_id = $2 ORDER BY revision DESC LIMIT 1`,
        [appId, subjectId],
      )
    ).rows[0];
  const derivedFrom = async (client: PgQuery, subjectId: string, appId: string): Promise<string | undefined> => {
    const last = await lastActor(client, subjectId, appId);
    if (!last) return undefined;
    if (typeof last.actor_id !== 'string') return unavailable();
    return last.actor_id.startsWith(PROVIDER_ACTOR) ? last.actor_id.slice(PROVIDER_ACTOR.length) : undefined;
  };
  const isAdministrator = async (client: PgQuery, actorId: string, appId: string, revision: number, declared?: readonly string[]) => {
    if (!identifier(actorId) || !appName(appId)) return invalid();
    const actor = await readIn(client, actorId, appId);
    return (
      actor.roles.includes('admin') && actor.revision === revision && (!declared || actor.roles.every((role) => declared.includes(role)))
    );
  };
  // The caller holds the store's write lock, including invitation consumption.
  const changeIn = async (
    client: PgQuery,
    value: Parameters<GrantStore['change']>[0],
    roles: readonly string[],
    at: number,
  ): Promise<Grant> => {
    const previous = await readIn(client, value.subjectId, value.appId);
    if (previous.revision !== value.expectedRevision) throw new SuiteGrantConflict();
    const revision = previous.revision + 1;
    const after = JSON.stringify(roles);
    await client.query(
      `INSERT INTO ${S}.suite_grant VALUES ($1, $2, $3, $4)
      ON CONFLICT (app_id, subject_id) DO UPDATE SET revision = excluded.revision, roles = excluded.roles`,
      [value.appId, value.subjectId, revision, after],
    );
    await client.query(`INSERT INTO ${S}.suite_grant_audit VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [
      randomUUID(),
      value.appId,
      value.subjectId,
      value.actorId,
      at,
      revision,
      JSON.stringify(previous.roles),
      after,
    ]);
    return Object.freeze({ revision, roles: Object.freeze([...roles]) });
  };
  const invitationAudit = (
    client: PgQuery,
    id: string,
    appId: string,
    subjectId: string,
    actorId: string,
    at: number,
    event: 'issue' | 'accept' | 'revoke',
  ) =>
    client.query(`INSERT INTO ${S}.suite_grant_invitation_audit VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
      randomUUID(),
      id,
      appId,
      subjectId,
      actorId,
      at,
      event,
    ]);
  const authorizeRead = async (client: PgQuery, value: Parameters<GrantStore['readAdministration']>[0], revision: number) => {
    if (!appName(value.appId) || !identifier(value.subjectId) || !identifier(value.actorId)) return invalid();
    const declared = rolesOf(value.declaredRoles);
    if (!(await isAdministrator(client, value.actorId, value.appId, revision, declared))) return refuseInvitation();
    return declared;
  };
  const read = async (subjectId: string, appId: string) => {
    if (!identifier(subjectId) || !appName(appId)) return invalid();
    return run(false, (client) => readIn(client, subjectId, appId));
  };
  return Object.freeze({
    read,
    readForSession: async (subjectId: string, appId: string, session: Readonly<{ provider: string | undefined }>) => {
      if (!identifier(subjectId) || !appName(appId)) return invalid();
      return run(false, async (client) => {
        const grant = await readIn(client, subjectId, appId);
        if (!grant.roles.length) return grant;
        const from = await derivedFrom(client, subjectId, appId);
        return from === undefined || from === session?.provider
          ? grant
          : Object.freeze({ revision: grant.revision, roles: Object.freeze([]) });
      });
    },
    readAdministration: async (input, authority) => {
      const value = captureTenantData(input);
      tenantRecord(value, ['appId', 'subjectId', 'actorId', 'declaredRoles']);
      const revision = administratorRevision(authority);
      return run(true, async (client) => {
        const declared = await authorizeRead(client, value, revision);
        return {
          accountId: value.actorId,
          appId: value.appId,
          subjectId: value.subjectId,
          ...(await readIn(client, value.subjectId, value.appId)),
          assignableRoles: declared,
        };
      });
    },
    listAccess: async (input, authority) => {
      const value = captureTenantData(input);
      tenantRecord(value, ['appId', 'actorId', 'declaredRoles']);
      const revision = administratorRevision(authority);
      return run(true, async (client) => {
        await authorizeRead(client, { ...value, subjectId: value.actorId }, revision);
        const holders = (
          await client.query(
            `SELECT subject_id, revision, roles FROM ${S}.suite_grant WHERE app_id = $1 AND roles <> '[]' ORDER BY subject_id LIMIT $2`,
            [value.appId, SUITE_ACCESS_PAGE + 1],
          )
        ).rows;
        const changes = (
          await client.query(
            `SELECT id, subject_id, actor_id, at, revision, before_roles, after_roles FROM ${S}.suite_grant_audit
            WHERE app_id = $1 ORDER BY at DESC, id DESC LIMIT $2`,
            [value.appId, SUITE_ACCESS_PAGE],
          )
        ).rows;
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
    listAccessChanges: async (input, authority, query) => {
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
      return run(true, async (client) => {
        await authorizeRead(client, { ...value, subjectId: value.actorId }, revision);
        const where = ['app_id = $1'],
          params: (string | number)[] = [value.appId];
        const and = (clause: (at: number) => string, ...values: (string | number)[]) => {
          where.push(clause(params.length + 1));
          params.push(...values);
        };
        if (query.actor !== undefined) and((n) => `actor_id = $${n}`, query.actor);
        if (query.from !== undefined) and((n) => `at >= $${n}`, query.from);
        if (query.to !== undefined) and((n) => `at < $${n}`, query.to);
        if (query.before) and((n) => `(at < $${n} OR (at = $${n} AND id < $${n + 1}))`, query.before.at, query.before.id);
        const rows = (
          await client.query(
            `SELECT id, subject_id, actor_id, at, revision, before_roles, after_roles FROM ${S}.suite_grant_audit
            WHERE ${where.join(' AND ')} ORDER BY at DESC, id DESC LIMIT $${params.length + 1}`,
            [...params, query.limit],
          )
        ).rows;
        return Object.freeze(rows.map(storedChange));
      });
    },
    listInvitations: async (input, authority, now = Date.now()) => {
      const value = captureTenantData(input);
      tenantRecord(value, ['appId', 'subjectId', 'actorId', 'declaredRoles', 'offset']);
      const revision = administratorRevision(authority);
      if (!Number.isSafeInteger(value.offset) || value.offset < 0 || value.offset > SUITE_INVITATIONS_MAX_OFFSET || !timestamp(now))
        return invalid();
      return run(true, async (client) => {
        const declared = await authorizeRead(client, value, revision),
          target = await readIn(client, value.subjectId, value.appId);
        const total = (
          await client.query(`SELECT count(*)::integer AS n FROM ${S}.suite_grant_invitation WHERE app_id = $1 AND subject_id = $2`, [
            value.appId,
            value.subjectId,
          ])
        ).rows[0].n as number;
        const rows = (
          await client.query(
            `SELECT id, roles, expected_revision, issuer_id, administrator_revision, issued_at, expires_at, consumed_at, revoked_at
            FROM ${S}.suite_grant_invitation WHERE app_id = $1 AND subject_id = $2 ORDER BY issued_at DESC, id DESC LIMIT $3 OFFSET $4`,
            [value.appId, value.subjectId, SUITE_INVITATIONS_PAGE, value.offset],
          )
        ).rows;
        const invitations: SuiteInvitationSummary[] = [];
        for (const row of rows) {
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
          // In the SQLite store's order: the issuer is read only where nothing before it decided.
          const status: SuiteInvitationStatus =
            row.consumed_at !== null
              ? 'consumed'
              : row.revoked_at !== null
                ? 'revoked'
                : now >= row.expires_at
                  ? 'expired'
                  : now < row.issued_at
                    ? 'not-yet-valid'
                    : !(await isAdministrator(client, row.issuer_id, value.appId, row.administrator_revision, declared))
                      ? 'issuer-changed'
                      : row.expected_revision !== target.revision
                        ? 'target-changed'
                        : !roles.length || roles.some((role) => !declared.includes(role))
                          ? 'roles-changed'
                          : 'pending';
          invitations.push({
            id: row.id,
            roles,
            expectedRevision: row.expected_revision,
            actorId: row.issuer_id,
            issuedAt: row.issued_at,
            expiresAt: row.expires_at,
            status,
            canRevoke: row.consumed_at === null && row.revoked_at === null && now >= row.issued_at,
          });
        }
        return { accountId: value.actorId, appId: value.appId, subjectId: value.subjectId, invitations, total, offset: value.offset };
      });
    },
    lookup: async (subjectId: string, appId: string) => {
      const { roles } = await read(subjectId, appId);
      return roles.length ? [...roles] : null;
    },
    deriveFromClaims: async (input, now = Date.now()) => {
      const value = captureTenantData(input);
      tenantRecord(value, ['appId', 'subjectId', 'provider', 'declaredRoles', 'roles']);
      if (!appName(value.provider)) return invalid();
      const actorId = `${PROVIDER_ACTOR}${value.provider}`;
      if (!identifier(value.subjectId) || !appName(value.appId)) return invalid();
      return run(true, async (client) => {
        const current = await readIn(client, value.subjectId, value.appId);
        const last = await lastActor(client, value.subjectId, value.appId);
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
        return changeIn(client, change, roles, now);
      });
    },
    change: async (input, authority) => {
      const value = captureTenantData(input);
      tenantRecord(value, grantFields);
      const roles = grantRoles(value);
      // The provider prefix says a grant was derived from claims: no person or operator may write under it.
      if (value.actorId.startsWith(PROVIDER_ACTOR)) return invalid();
      const revision = authority === undefined ? undefined : administratorRevision(authority);
      return run(true, async (client) => {
        // App-administrator callers recheck their grant under the same write lock as the target change.
        if (revision !== undefined && !(await isAdministrator(client, value.actorId, value.appId, revision))) {
          throw new Error('The App administrator grant changed or is unavailable.');
        }
        return changeIn(client, value, roles, Date.now());
      });
    },
    issueInvitation: async (input, authority, now = Date.now()) => {
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
      return run(true, async (client) => {
        if (!(await isAdministrator(client, value.actorId, value.appId, revision, value.declaredRoles))) return refuseInvitation();
        if ((await readIn(client, value.subjectId, value.appId)).revision !== value.expectedRevision) throw new SuiteGrantConflict();
        const id = randomUUID(),
          token = randomBytes(32).toString('base64url');
        await client.query(`INSERT INTO ${S}.suite_grant_invitation VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL, NULL)`, [
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
        ]);
        await invitationAudit(client, id, value.appId, value.subjectId, value.actorId, now, 'issue');
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
    acceptInvitation: async (input, now = Date.now()) => {
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
      return run(true, async (client) => {
        const row = (
          await client.query(`SELECT * FROM ${S}.suite_grant_invitation WHERE app_id = $1 AND subject_id = $2 AND token_hash = $3`, [
            value.appId,
            value.subjectId,
            tokenHash(value.token),
          ])
        ).rows[0];
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
          !(await isAdministrator(client, row.issuer_id, value.appId, row.administrator_revision, declared))
        )
          return refuseInvitation();
        let roles: string[];
        try {
          roles = rolesOf(JSON.parse(row.roles));
        } catch {
          return unavailable();
        }
        if (!roles.length || roles.some((role) => !declared.includes(role))) return refuseInvitation();
        const grant = await changeIn(
          client,
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
        await client.query(`UPDATE ${S}.suite_grant_invitation SET consumed_at = $1 WHERE id = $2`, [now, row.id]);
        await invitationAudit(client, row.id, value.appId, value.subjectId, value.subjectId, now, 'accept');
        return grant;
      });
    },
    revokeInvitation: async (input, authority, now = Date.now()) => {
      const value = captureTenantData(input);
      tenantRecord(value, ['appId', 'id', 'actorId']);
      if (!appName(value.appId) || !identifier(value.id) || !identifier(value.actorId) || !timestamp(now)) return invalid();
      const revision = administratorRevision(authority);
      await run(true, async (client) => {
        if (!(await isAdministrator(client, value.actorId, value.appId, revision))) return refuseInvitation();
        const row = (
          await client.query(
            `SELECT subject_id, issued_at, consumed_at, revoked_at FROM ${S}.suite_grant_invitation WHERE app_id = $1 AND id = $2`,
            [value.appId, value.id],
          )
        ).rows[0];
        if (!row || row.consumed_at !== null || row.revoked_at !== null) return refuseInvitation();
        if (!identifier(row.subject_id) || !timestamp(row.issued_at)) return unavailable();
        if (now < row.issued_at) return refuseInvitation();
        await client.query(`UPDATE ${S}.suite_grant_invitation SET revoked_at = $1 WHERE id = $2`, [now, value.id]);
        await invitationAudit(client, value.id, value.appId, row.subject_id, value.actorId, now, 'revoke');
      });
    },
  });
}

/* ---------- account preferences ---------- */

type PreferencesStore = ReturnType<typeof openSuitePreferencesStore>;

function preferencesStore(pool: PgPool, suiteId: string): Asynchronous<PreferencesStore> {
  const run = <T>(write: boolean, work: (client: PgQuery) => Promise<T>) => operation(pool, P, suiteId, write, work);
  const readIn = async (client: PgQuery, subjectId: string): Promise<ReturnType<PreferencesStore['read']>> => {
    const row = (await client.query(`SELECT default_app, revision FROM ${S}.suite_preference WHERE subject_id = $1`, [subjectId])).rows[0];
    if (!row) return Object.freeze({ defaultApp: null, revision: 0 });
    if (
      (row.default_app !== null && !preferenceRules.appName(row.default_app)) ||
      typeof row.revision !== 'number' ||
      !Number.isSafeInteger(row.revision) ||
      row.revision < 1
    )
      return preferenceRules.unavailable();
    return Object.freeze({ defaultApp: row.default_app as string | null, revision: row.revision });
  };
  return Object.freeze({
    read: async (subjectId: string) => {
      if (!preferenceRules.identifier(subjectId)) return preferenceRules.invalid();
      return run(false, (client) => readIn(client, subjectId));
    },
    change: async (input: Parameters<PreferencesStore['change']>[0]) => {
      const value = captureTenantData(input);
      tenantRecord(value, ['subjectId', 'defaultApp', 'expectedRevision']);
      if (
        !preferenceRules.identifier(value.subjectId) ||
        (value.defaultApp !== null && !preferenceRules.appName(value.defaultApp)) ||
        !Number.isSafeInteger(value.expectedRevision) ||
        value.expectedRevision < 0 ||
        value.expectedRevision >= Number.MAX_SAFE_INTEGER
      )
        return preferenceRules.invalid();
      return run(true, async (client) => {
        const previous = await readIn(client, value.subjectId);
        if (previous.revision !== value.expectedRevision) throw new preferenceRules.SuitePreferencesConflict();
        const revision = previous.revision + 1;
        await client.query(
          `INSERT INTO ${S}.suite_preference VALUES ($1, $2, $3)
          ON CONFLICT (subject_id) DO UPDATE SET default_app = excluded.default_app, revision = excluded.revision`,
          [value.subjectId, value.defaultApp, revision],
        );
        return revision;
      });
    },
  });
}

/* ---------- authority history ---------- */

type AuthorityStore = ReturnType<typeof openSuiteAuthorityStore>;

function authorityStore(pool: PgPool, suiteId: string): Asynchronous<AuthorityStore> {
  const run = <T>(write: boolean, work: (client: PgQuery) => Promise<T>) => operation(pool, A, suiteId, write, work);
  /** The App's last two distinct reports, newest first; a row whose text does not match its digest is unreadable. */
  const latest = async (client: PgQuery, appId: string) =>
    (
      await client.query(`SELECT recorded_at, sha256, report FROM ${S}.suite_authority WHERE app_id = $1 ORDER BY id DESC LIMIT 2`, [appId])
    ).rows.map((row) => {
      if (typeof row.report !== 'string' || typeof row.recorded_at !== 'number' || row.sha256 !== authorityRules.digest(row.report))
        return authorityRules.unavailable();
      return Object.freeze({ report: row.report as string, at: row.recorded_at as number });
    });
  return Object.freeze({
    record: async (appId: string, report: string, at = Date.now()) => {
      if (
        !authorityRules.appName(appId) ||
        typeof report !== 'string' ||
        report.length > authorityRules.MAX_REPORT ||
        !Number.isSafeInteger(at)
      )
        return authorityRules.invalid();
      await run(true, async (client) => {
        if ((await latest(client, appId))[0]?.report === report) return;
        // SQLite's INTEGER PRIMARY KEY is the next rowid; under the store's write lock, the next number is as certain here.
        await client.query(`INSERT INTO ${S}.suite_authority SELECT coalesce(max(id), 0) + 1, $1, $2, $3, $4 FROM ${S}.suite_authority`, [
          appId,
          at,
          authorityRules.digest(report),
          report,
        ]);
      });
    },
    previous: async (appId: string) => {
      if (!authorityRules.appName(appId)) return authorityRules.invalid();
      const [current, before] = await run(false, (client) => latest(client, appId));
      return before ? Object.freeze({ report: before.report, at: current.at }) : undefined;
    },
  });
}

/* ---------- provisioning and opening ---------- */

const suiteIdOf = (suiteId: string) => (grantRules.appName(suiteId) ? suiteId : grantRules.invalid());

/** Whether anything is named under a store's prefix in the runtime schema: a store, whole or not. */
const held = async (client: PgQuery, prefix: string): Promise<boolean> =>
  (
    await client.query(
      'SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND lower(c.relname) LIKE $2 LIMIT 1',
      [S, like(prefix)],
    )
  ).rows.length > 0;

/** One store's tables, created in the caller's maintenance transaction (which made the runtime schema) and attested before it commits. */
async function provisionIn(client: PgQuery, prefix: string, suiteId: string): Promise<void> {
  if (await held(client, prefix))
    return STORES[prefix].unavailable(`${STORES[prefix].name} already exists; provisioning never adopts or repairs one.`);
  for (const sql of DDL[prefix]) await client.query(sql);
  await client.query(`INSERT INTO ${S}.${prefix}_binding VALUES (1, $1, $2)`, [POSTGRES_SUITE_STORE_VERSION, suiteId]);
  await attest(client, prefix, suiteId);
}

/**
 * Explicit installation of one store, named by its prefix (the store registry provisions a store at a time). A
 * suite's start provisions all three together with provisionPostgresSuiteStores.
 */
export async function provisionPostgresSuiteStore(url: string, prefix: string, suiteId: string): Promise<void> {
  if (!POSTGRES_SUITE_PREFIXES.includes(prefix)) return grantRules.invalid();
  const id = suiteIdOf(suiteId);
  await withPostgresMaintenanceTransaction(url, async (client) => {
    await dedicated(client, STORES[prefix].unavailable);
    await provisionIn(client, prefix, id);
  });
}

/** All three stores in one transaction, into a database that holds none of them: never adopts or repairs one. */
export async function provisionPostgresSuiteStores(url: string, suiteId: string): Promise<void> {
  const id = suiteIdOf(suiteId);
  await withPostgresMaintenanceTransaction(url, async (client) => {
    await dedicated(client, grantRules.unavailable);
    for (const prefix of POSTGRES_SUITE_PREFIXES) await provisionIn(client, prefix, id);
  });
}

/** Which of the three stores the database holds: none (a new suite), all (an existing one), or a part, which is refused. */
export async function postgresSuiteStoresPresent(url: string): Promise<boolean> {
  const present = await withPostgresMaintenanceTransaction(url, async (client) => {
    let count = 0;
    for (const prefix of POSTGRES_SUITE_PREFIXES) if (await held(client, prefix)) count++;
    return count;
  });
  if (present === 0) return false;
  if (present === POSTGRES_SUITE_PREFIXES.length) return true;
  return grantRules.unavailable(
    "The suite's PostgreSQL database holds some of its grant, preference and authority stores but not all: restore the missing ones or start from an empty database.",
  );
}

interface PostgresSuiteStores {
  /** The stores' pool, for asking the server who it is (authStoreSeparation.ts); never for a store's rows. */
  readonly database: PgQuery;
  readonly grants: Asynchronous<GrantStore>;
  readonly preferences: Asynchronous<PreferencesStore>;
  readonly authority: Asynchronous<AuthorityStore>;
  close(): Promise<void>;
}

/** Open an existing, exactly recognized set of stores: never provisions, migrates or repairs. */
export async function openPostgresSuiteStores(url: string, suiteId: string): Promise<PostgresSuiteStores> {
  const id = suiteIdOf(suiteId);
  const pool = await openPool(url);
  try {
    const client = await pool.connect();
    let broken = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        await dedicated(client, grantRules.unavailable);
        for (const prefix of POSTGRES_SUITE_PREFIXES) await attest(client, prefix, id);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {
          broken = true;
        });
        throw error;
      }
    } finally {
      client.release(broken);
    }
  } catch (error) {
    await pool.end().catch(() => {});
    throw error;
  }
  let closed: Promise<void> | undefined;
  return Object.freeze({
    database: pool,
    grants: grantStore(pool, id),
    preferences: preferencesStore(pool, id),
    authority: authorityStore(pool, id),
    close: () => (closed ??= pool.end().catch(() => {})),
  });
}

/** One store opened alone, as the store registry reads a store at a time; the caller closes it. */
async function openOne<T extends object>(url: string, prefix: string, suiteId: string, make: (pool: PgPool, suiteId: string) => T) {
  const id = suiteIdOf(suiteId);
  const pool = await openPool(url);
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        await dedicated(client, STORES[prefix].unavailable);
        await attest(client, prefix, id);
      } finally {
        await client.query('ROLLBACK');
      }
    } finally {
      client.release();
    }
  } catch (error) {
    await pool.end().catch(() => {});
    throw error;
  }
  return Object.freeze({ ...make(pool, id), close: () => pool.end() });
}
export const openPostgresSuiteGrantStore = (url: string, suiteId: string) => openOne(url, G, suiteId, grantStore);
