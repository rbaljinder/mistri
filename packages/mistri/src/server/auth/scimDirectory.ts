/**
 * SCIM 2.0 provisioning (scimConfig.ts says what a directory is): Microsoft
 * Entra, Okta or any SCIM client creates, updates, deactivates and deletes
 * the people of an App at `<App>/api/auth/scim/v2/`.
 *
 * The protocol is @better-auth/scim 1.7.2's, its tables declared in the
 * store's own layout (identityStore.ts). Each config entry is one of its
 * connections, the entry's name its id and provisioning domain, the entry's
 * tokens its static bearer credentials. What a change means here is
 * mistri's, in the plugin's own transaction:
 *
 *   - Who it reaches (resolveUser): an address in its provider's domains, or
 *     409. An existing account with a verified address is linked; one whose
 *     address was never verified loses what it held first, as a sign-in that
 *     claims it does (identityRoles.ts); anyone else gets a new account with
 *     no password, who signs in through the provider.
 *   - What it gives (projection): the roles its `roles` map gives from the
 *     person's groups. The listed roles are the directory's to set and clear;
 *     every other role stays as an administrator set it. A row in the account
 *     trail says so, by `scim:<name>`.
 *   - Whether the account works (identity): a platform directory that has
 *     deactivated or deleted a person bans the account with its own marker,
 *     ends its sessions and revokes its API tokens and OAuth grants; one that
 *     reactivates it lifts only a ban it set, after revoking again, so a
 *     token from before the deactivation never comes back. An administrator's
 *     ban stays.
 *   - A tenant's own directory never touches the global account: its people
 *     are that tenant's members, written once the plugin's transaction has
 *     committed (tenantAdministration.ts `directory`), and the response waits
 *     for them. A member row that cannot be written is a 503 the directory
 *     retries; the reconcile is idempotent.
 *
 * Routed before Better Auth's own handler (auth.ts), as the back-channel
 * logout is: a directory sends no cookie and no Origin. Each connection may
 * make 600 requests a minute, counted where the deployment's sign-in state is.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { rolesOf } from '../../shared/accountAdministration.js';
import { SQLITE_API_TOKEN_TABLES } from '../../adapters/auth/sqliteApiTokenLayout.js';
import { runtimeTable } from '@mistriwork/engine/shared/runtimeTables.js';
import type { PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import { expandEnvReferences } from '@mistriwork/engine/server/auth/credentials.js';
import { domainOf } from './identityProviders.js';
import type { FederatedProviderConfig } from './identityConfig.js';
import { SCIM_TOKEN_MINIMUM, type ScimDirectoryConfig } from './scimConfig.js';
import { signInState } from './signInState.js';

/** The ban reason a directory's deactivation writes, and the only one its reactivation lifts. */
const SCIM_BAN_PREFIX = 'mistri:scim:';
/** A SCIM request is a user or a group with its members: a megabyte is far past either. */
const MAX_BODY = 1024 * 1024;
const PER_MINUTE = 600;
const ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';
const SCOPES = ['scim.users.read', 'scim.users.write', 'scim.groups.read', 'scim.groups.write'] as const;

interface Where {
  field: string;
  value: unknown;
  operator?: string;
}
/** The slice of Better Auth's adapter the reconciles use, inside the plugin's transaction. */
interface Database {
  findOne(query: { model: string; where: Where[] }): Promise<Record<string, unknown> | null>;
  findMany(query: { model: string; where: Where[] }): Promise<Array<Record<string, unknown>>>;
  update?(query: { model: string; where: Where[]; update: Record<string, unknown> }): Promise<unknown>;
  create?(query: { model: string; data: Record<string, unknown> }): Promise<unknown>;
  deleteMany?(query: { model: string; where: Where[] }): Promise<unknown>;
}
interface Source {
  connectionId: string;
  active: boolean;
}

/** What one request's reconciles leave for after its commit. */
interface Pending {
  /** Tenant member rows, by directory and account: the last word wins, as a retried transaction says it again. */
  readonly members: Map<string, { directory: string; accountId: string; roles: readonly string[] | null }>;
  /** Accounts linked although their address was never verified: what they held goes, in the transaction. */
  readonly unproven: Set<string>;
}

/** A tenant's member rows, as the tenant owner writes them (tenantAdministration.ts). */
type TenantDirectoryApply = (directory: string, accountId: string, roles: readonly string[] | null) => Promise<unknown>;

interface ScimProvisioning {
  /** The Better Auth plugin. */
  readonly plugin: unknown;
  /** Each tenant directory's name and its tenant, for the tenant owner to bind. */
  readonly tenants: Readonly<Record<string, string>>;
  /** The tenant owner's member writer; until it is bound, a tenant directory's change is a 503. */
  bind(apply: TenantDirectoryApply): void;
  /** Kept for the App's auth runtime, where the tenant host finds it. */
  register(runtime: object): void;
  /** One request under `/api/auth/scim/`. */
  serve(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

/** The directories that provision each auth runtime's App, where any do. */
const provisioned = new WeakMap<object, ScimProvisioning>();
/** Each SCIM directory of a tenant's own provider that provisions this runtime's App: its name and the tenant. */
export function appTenantDirectories(runtime: object): Readonly<Record<string, string>> {
  return provisioned.get(runtime)?.tenants ?? {};
}
/** The tenant owner's member writer, bound once it is open (tenantAuthenticatedHttp.ts). */
export function bindTenantDirectories(runtime: object, apply: TenantDirectoryApply): void {
  const found = provisioned.get(runtime);
  if (!found) throw new Error('No SCIM directory provisions this App.');
  found.bind(apply);
}

/** The account's live API tokens and OAuth grants, revoked: on the file in the caller's transaction, on PostgreSQL on its own connection. */
function scimTokenRevoker(store: { file?: DatabaseSync; pool?: PgQuery }) {
  return async (accountId: string, by: string, now = Date.now()): Promise<void> => {
    if (store.file) {
      const db = store.file;
      const t = SQLITE_API_TOKEN_TABLES;
      // A store that never provisioned API tokens has none to revoke.
      if (!db.prepare(`SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?`).get(t.meta)) return;
      const live = db
        .prepare(`SELECT token_id, version, created_at FROM main."${t.token}"
          WHERE subject_kind = 'account' AND subject_id = ? COLLATE BINARY AND revoked_at IS NULL`)
        .all(accountId);
      const revoke = db.prepare(`UPDATE main."${t.token}" SET version = ?, revoked_at = ?, revoked_by = ?
        WHERE token_id = ? COLLATE BINARY AND version = ? COLLATE BINARY AND revoked_at IS NULL`);
      for (const row of live) {
        // The version is decimal text past 2^53; a revocation is one step on it.
        revoke.run(
          String(BigInt(String(row.version)) + 1n),
          Math.max(Number(row.created_at), now),
          by,
          String(row.token_id),
          String(row.version),
        );
      }
      db.prepare(
        `UPDATE main."${t.grant}" SET revoked_at = CASE WHEN created_at > ? THEN created_at ELSE ? END WHERE subject = ? COLLATE BINARY AND revoked_at IS NULL`,
      ).run(now, now, accountId);
      return;
    }
    if (!store.pool) return;
    const present = (
      await store.pool.query(`SELECT to_regclass($1) IS NOT NULL AS present`, [runtimeTable('postgres', 'auth_api_token_meta')])
    ).rows[0];
    if (!present?.present) return;
    await store.pool.query(
      `UPDATE ${runtimeTable('postgres', 'auth_api_token')} SET version = (version::numeric + 1)::text, revoked_at = GREATEST(created_at, $2::bigint), revoked_by = $3
        WHERE subject_kind = 'account' AND subject_id = $1 AND revoked_at IS NULL`,
      [accountId, now, by],
    );
    await store.pool.query(
      `UPDATE ${runtimeTable('postgres', 'auth_oauth_grant')} SET revoked_at = GREATEST(created_at, $2::bigint) WHERE subject = $1 AND revoked_at IS NULL`,
      [accountId, now],
    );
  };
}

export async function scimProvisioning(
  /** The directories that provision this App, with their providers (scimConfig.ts scimEntriesFor). */
  entries: ReadonlyArray<{ directory: ScimDirectoryConfig; provider: FederatedProviderConfig }>,
  /** The App: its file names a refusal, its name the startup line. */
  loaded: { path: string; app: { name: string } },
  options: {
    environment: NodeJS.ProcessEnv;
    baseURL: string;
    APIError: new (status: string, body: { code: string; message: string }) => Error;
    /** Better Auth's current endpoint context: the acting connection is on it. */
    current: () => object | undefined;
    /** The auth store the API tokens live in: the file, or the PostgreSQL pool. */
    store: { file?: DatabaseSync; database: unknown };
  },
  /** Better Auth's own fetch handler, once the instance exists. */
  handler: () => (request: Request) => Promise<Response>,
): Promise<ScimProvisioning> {
  const { APIError } = options;
  const where = loaded.path;
  const revoke = scimTokenRevoker(options.store.file ? { file: options.store.file } : { pool: options.store.database as PgQuery });
  /* Imported through a variable, as Better Auth is (auth.ts): the package is optional, and its absence is one sentence. */
  const scim = await (async () => {
    try {
      const specifier = '@better-auth/scim';
      return ((await import(specifier)) as { scim: (o: Record<string, unknown>) => unknown }).scim;
    } catch {
      throw new Error(
        `${where}: a SCIM directory needs the @better-auth/scim package. Install it with: npm install @better-auth/scim@1.7.2`,
      );
    }
  })();
  /* Every token now, so a missing or short one refuses startup rather than the directory's first request. */
  const credentials = entries.map(({ directory }) => ({
    directory,
    tokens: directory.tokens.map((reference) => {
      let token: string;
      try {
        token = expandEnvReferences(reference, options.environment);
      } catch {
        throw new Error(
          `${where}: the SCIM directory "${directory.name}" authenticates with ${reference}, which is not set. Export it, at least ${SCIM_TOKEN_MINIMUM} characters.`,
        );
      }
      if (token.trim().length < SCIM_TOKEN_MINIMUM) {
        throw new Error(
          `${where}: the SCIM directory "${directory.name}" authenticates with ${reference}, which is shorter than ${SCIM_TOKEN_MINIMUM} characters. Generate one: \`openssl rand -base64 32\`.`,
        );
      }
      return token;
    }),
  }));
  const byName = new Map(entries.map((entry) => [entry.directory.name, entry]));
  const platform = new Set(entries.filter(({ provider }) => provider.tenant === undefined).map(({ directory }) => directory.name));
  const tenants = Object.fromEntries(
    entries.flatMap(({ directory, provider }) => (provider.tenant !== undefined ? [[directory.name, provider.tenant] as const] : [])),
  );
  /* Which connection a bearer is, compared by digest so the comparison is constant-time and length-blind: the rate limit's key. */
  const digest = (value: string) => createHash('sha256').update(value).digest();
  const digests = credentials.flatMap(({ directory, tokens }) => tokens.map((token) => ({ name: directory.name, digest: digest(token) })));
  const connectionOf = (authorization: string | undefined): string | undefined => {
    const presented = /^Bearer\s+(\S+)\s*$/i.exec(authorization ?? '')?.[1];
    if (!presented) return undefined;
    const given = digest(presented);
    let found: string | undefined;
    for (const known of digests) if (timingSafeEqual(known.digest, given)) found ??= known.name;
    return found;
  };

  const pending = new AsyncLocalStorage<Pending>();
  const pendingNow = (): Pending => {
    const found = pending.getStore();
    if (!found) throw new Error('A SCIM change ran outside a SCIM request.');
    return found;
  };
  const refuse = (status: 'CONFLICT' | 'BAD_REQUEST', detail: string, scimType?: string): never => {
    throw new APIError(status, {
      schemas: [ERROR_SCHEMA],
      status: status === 'CONFLICT' ? '409' : '400',
      detail,
      ...(scimType ? { scimType } : {}),
    } as unknown as { code: string; message: string });
  };
  const fence = (name: string, email: unknown) => {
    const domains = byName.get(name)?.provider.domains ?? [];
    if (typeof email !== 'string' || !domains.includes(domainOf(email))) {
      refuse('CONFLICT', `The SCIM directory "${name}" provisions only addresses in its provider's domains.`, 'invalidValue');
    }
  };
  const acting = (): string | undefined => {
    const ctx = options.current() as { context?: { scimConnection?: { id?: unknown } } } | undefined;
    const id = ctx?.context?.scimConnection?.id;
    return typeof id === 'string' ? id : undefined;
  };
  const audit = async (
    database: Database,
    name: string,
    user: Record<string, unknown>,
    action: 'create' | 'setRoles' | 'deactivate' | 'reactivate',
    before: Record<string, unknown> | null,
    after: Record<string, unknown>,
  ) => {
    await database.create!({
      model: 'accountAudit',
      data: {
        createdAt: new Date(),
        action,
        actorId: `scim:${name}`,
        actorEmail: name,
        principal: `scim:${name}`,
        targetId: String(user.id),
        targetEmail: String(user.email ?? ''),
        before: before === null ? null : JSON.stringify(before),
        after: JSON.stringify(after),
      },
    });
  };

  const plugin = scim({
    connections: credentials.map(({ directory, tokens }) => ({
      id: directory.name,
      credentials: tokens.map((token, index) => ({ type: 'bearer', id: `${directory.name}-${index}`, token, scopes: [...SCOPES] })),
    })),
    // Entra's provisioning service still sends the classic group schema marker on POST /Groups.
    compatibility: { microsoftEntra: { acceptLegacyGroupSchema: true } },
    identity: {
      resolveUser: async (
        input: { connectionId: string; resource: { primaryEmail: string } },
        context: { database: Database },
      ): Promise<{ action: 'create' } | { action: 'link'; userId: string; profile: 'manage' | 'preserve' }> => {
        fence(input.connectionId, input.resource.primaryEmail);
        const existing = await context.database.findOne({
          model: 'user',
          where: [{ field: 'email', value: input.resource.primaryEmail.toLowerCase() }],
        });
        if (!existing) return { action: 'create' };
        if (existing.emailVerified !== true && existing.emailVerified !== 1) pendingNow().unproven.add(String(existing.id));
        // A tenant's directory links a global account without managing it: its name and address stay the account's own.
        return { action: 'link', userId: String(existing.id), profile: platform.has(input.connectionId) ? 'manage' : 'preserve' };
      },
      reconcileUser: async (state: { userId: string; sources: readonly Source[] }, context: { database: Database }) => {
        const database = context.database;
        const unproven = pendingNow().unproven;
        if (unproven.delete(state.userId)) {
          /* Linked although its address was never proven: what it held was never proven to be its owner's (identityRoles.ts). */
          await database.deleteMany!({ model: 'account', where: [{ field: 'userId', value: state.userId }] });
          await database.deleteMany!({ model: 'session', where: [{ field: 'userId', value: state.userId }] });
          console.log(
            'mistri: a SCIM directory claimed an account whose address was never verified; its earlier sign-in methods and sessions were ended.',
          );
        }
        const by = acting();
        const own = state.sources.filter((source) => platform.has(source.connectionId));
        // Only a platform directory's people, or one it has just deleted, are this account's to ban.
        if (!own.length && !(by && platform.has(by))) return;
        const user = await database.findOne({ model: 'user', where: [{ field: 'id', value: state.userId }] });
        if (!user) return;
        const name = by && platform.has(by) ? by : own[0].connectionId;
        const banned = user.banned === true || user.banned === 1;
        const reason = typeof user.banReason === 'string' ? user.banReason : '';
        if (!own.some((source) => source.active)) {
          /* The ban refuses every session and token at once (nativeAccountObservation.ts); the revocation keeps it so after a reactivation. */
          await revoke(state.userId, `scim:${name}`);
          await database.deleteMany!({ model: 'session', where: [{ field: 'userId', value: state.userId }] });
          if (banned) return;
          await database.update!({
            model: 'user',
            where: [{ field: 'id', value: state.userId }],
            update: { banned: true, banReason: `${SCIM_BAN_PREFIX}${name}`, banExpires: null },
          });
          await audit(database, name, user, 'deactivate', { active: true }, { active: false });
          return;
        }
        if (!banned || !reason.startsWith(SCIM_BAN_PREFIX)) return;
        // Anything issued before the ban stays revoked: revoked again, then the ban lifts.
        await revoke(state.userId, `scim:${name}`);
        await database.update!({
          model: 'user',
          where: [{ field: 'id', value: state.userId }],
          update: { banned: false, banReason: null, banExpires: null },
        });
        await audit(database, name, user, 'reactivate', { active: false }, { active: true });
      },
    },
    projection: {
      roles: {
        map: (input: { provisioningDomainId: string; source: { displayName: string } }) => {
          const roles = byName.get(input.provisioningDomainId)?.directory.roles ?? {};
          return Object.keys(roles).filter((role) => roles[role].includes(input.source.displayName));
        },
        exists: (input: { provisioningDomainId: string; role: string }) =>
          Object.hasOwn(byName.get(input.provisioningDomainId)?.directory.roles ?? {}, input.role),
      },
      reconcileUser: async (
        input: { provisioningDomainId: string; userId: string; active: boolean; grants: ReadonlyArray<{ role: string }> },
        context: { database: Database },
      ) => {
        const name = input.provisioningDomainId;
        const entry = byName.get(name);
        if (!entry) return;
        const database = context.database;
        const user = await database.findOne({ model: 'user', where: [{ field: 'id', value: input.userId }] });
        if (!user) return;
        // A managed profile's address may have just changed: it stays in the domains, or nothing commits.
        fence(name, user.email);
        const granted = [...new Set(input.grants.map((grant) => grant.role))].sort();
        if (entry.provider.tenant !== undefined) {
          pendingNow().members.set(`${name}\n${input.userId}`, {
            directory: name,
            accountId: input.userId,
            roles: input.active && granted.length ? granted : null,
          });
          return;
        }
        const owned = Object.keys(entry.directory.roles ?? {});
        const current = rolesOf(typeof user.role === 'string' ? user.role : undefined);
        const next = [...new Set([...current.filter((role) => !owned.includes(role)), ...granted])];
        if (next.length === current.length && next.every((role) => current.includes(role))) return;
        await database.update!({ model: 'user', where: [{ field: 'id', value: input.userId }], update: { role: next.join(',') } });
        await audit(database, name, user, 'setRoles', { roles: current }, { roles: next });
      },
    },
  });

  /* What each directory's administrator registers: printed once, at startup. */
  for (const { directory } of entries) {
    console.log(
      `mistri: SCIM directory "${directory.name}" for "${loaded.app.name}": ${new URL(options.baseURL).href.replace(/\/$/, '')}/api/auth/scim/v2`,
    );
  }
  let apply: TenantDirectoryApply | undefined;
  const answer = (res: ServerResponse, status: number, detail: string, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/scim+json', 'cache-control': 'no-store', ...headers });
    res.end(JSON.stringify({ schemas: [ERROR_SCHEMA], status: String(status), detail }));
  };
  const provisioning: ScimProvisioning = Object.freeze({
    plugin,
    tenants: Object.freeze(tenants),
    bind: (given: TenantDirectoryApply) => {
      apply = given;
    },
    register: (runtime: object) => {
      provisioned.set(runtime, provisioning);
    },
    serve: async (req: IncomingMessage, res: ServerResponse) => {
      const connection = connectionOf(req.headers.authorization);
      const { allowed, retryAfter } = await signInState.consume(`scim:${connection ?? '-'}`, { window: 60, max: PER_MINUTE });
      if (!allowed) return answer(res, 429, 'Too many requests.', { 'retry-after': String(retryAfter ?? 60) });
      const method = (req.method ?? 'GET').toUpperCase();
      let body: Buffer | undefined;
      if (method !== 'GET' && method !== 'HEAD') {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += (chunk as Buffer).length;
          if (size > MAX_BODY) return answer(res, 413, 'The request is too large.');
          chunks.push(chunk as Buffer);
        }
        body = Buffer.concat(chunks);
      }
      const url = new URL(req.url ?? '/', new URL(options.baseURL).origin);
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        for (const one of Array.isArray(value) ? value : value === undefined ? [] : [value]) headers.append(name, one);
      }
      const request = new Request(url, { method, headers, ...(body ? { body: new Uint8Array(body) } : {}) });
      const work: Pending = { members: new Map(), unproven: new Set() };
      const response = await pending.run(work, () => handler()(request));
      if (response.ok && work.members.size) {
        try {
          if (!apply) throw new Error('no tenant owner is bound');
          for (const member of work.members.values()) await apply(member.directory, member.accountId, member.roles);
        } catch (error) {
          console.error(`mistri: ${where}: a SCIM directory's tenant membership could not be written: ${(error as Error).message}`);
          // The directory retries a 5xx; its next attempt writes the same rows.
          return answer(res, 503, 'The membership could not be written. Try again.', { 'retry-after': '5' });
        }
      }
      const answered: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        if (key !== 'set-cookie') answered[key] = value;
      });
      res.writeHead(response.status, answered);
      res.end(Buffer.from(await response.arrayBuffer()));
    },
  });
  return provisioning;
}
