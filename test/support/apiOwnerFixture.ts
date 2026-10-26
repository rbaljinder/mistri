/**
 * The App API's engine owners, composed in process over databases a test owns:
 * one or more business connections, a separate native auth store with its
 * token extension, and issued tokens. One shape for both engines, so a test
 * can say what a request answers without saying how each owner hands it over
 * (SQLite buffers a handle, PostgreSQL sends inside its native handoff).
 *
 * PostgreSQL databases are made beside TABLEWALK_TEST_PG and dropped after
 * (uuidPostgresDatabase), so a file using this runs in the parallel lane.
 */
import type { TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Registry } from '../../packages/engine/src/server/connections.js';
import { createAppAuth } from '../../packages/mistri/src/server/auth/auth.js';
import { provisionSqliteApiTokenStore } from '../../packages/mistri/src/server/auth/provisionSqliteApiTokenStore.js';
import { issueSqliteApiCommandToken, issueSqliteApiToken } from '../../packages/mistri/src/server/auth/sqliteApiTokenMaintenance.js';
import { provisionPostgresApiTokenStore } from '../../packages/mistri/src/server/auth/provisionPostgresApiTokenStore.js';
import { issuePostgresApiCommandToken, issuePostgresApiToken } from '../../packages/mistri/src/server/auth/postgresApiTokenMaintenance.js';
import { captureAuthStoreExclusion } from '../../packages/mistri/src/server/auth/authStoreSeparation.js';
import { migratePostgresAuthStore } from '../../packages/mistri/src/adapters/auth/postgresAuthStore.js';
import { migrateSqliteCommandJournal } from '../../packages/mistri/src/adapters/commands/commandJournal.js';
import { migratePostgresCommandJournal } from '../../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import { provisionStores } from '../../packages/mistri/src/server/maintenance.js';
import { appCommandEventStore } from '../../packages/mistri/src/server/commands/appCommandEvents.js';
import { issueAppScopeCommandEvents } from '../../packages/mistri/src/server/commands/businessCommandAccess.js';
import type { BusinessCommandRegistry } from '../../packages/mistri/src/server/commands/businessCommands.js';
import { loadAppRuntimeResources } from '../../packages/mistri/src/server/app/appRuntimeResources.js';
import { createSqliteApiReadOwner } from '../../packages/mistri/src/server/api/sqliteApiReadOwner.js';
import { createSqliteApiCommandOwner } from '../../packages/mistri/src/server/api/sqliteApiCommandOwner.js';
import { createPostgresApiReadOwner } from '../../packages/mistri/src/server/api/postgresApiReadOwner.js';
import { createPostgresApiCommandOwner } from '../../packages/mistri/src/server/api/postgresApiCommandOwner.js';
import { ApiReadFailure } from '../../packages/mistri/src/server/api/apiReadFailure.js';
import { isBusinessCommandExecutionError } from '../../packages/mistri/src/server/commands/commandErrors.js';
import { pgClient, uuidPostgresDatabase } from './tenantDialects.js';
import { parseTestApp } from './commandCatalog.js';
import type { AppDef } from '../../packages/mistri/src/shared/app.js';

export type Engine = 'sqlite' | 'postgres';
export interface Answer {
  status: number;
  body: string;
  headers?: Readonly<Record<string, string>>;
}
/** What an owner said: an answer, or the refusal code it threw (no body is written for those). */
export type Said = Answer | { refused: string };

export interface OwnerFixtureInput {
  engine: Engine;
  /** The App literal; `store` is the auth store to name in `auth.store`. Inline command contracts are lifted (parseTestApp). */
  app: (store: string) => Record<string, unknown>;
  /** Each business connection, by registry id: its tables and rows (this engine's SQL), whether it writes, and its stores. */
  connections: Record<string, { sql: string; writable?: boolean; journal?: boolean; events?: { sourceId: string } }>;
  commands?: BusinessCommandRegistry;
  /** Native accounts: id → role list as stored (`a,b`). */
  accounts: Record<string, string>;
  /** The App-scope event source the command host issues, when its commands emit. */
  events?: { sourceId: string };
}

const SECRET = 'synthetic-api-owner-fixture-secret-at-least-thirty-two-characters';

export async function apiOwnerFixture(t: TestContext, input: OwnerFixtureInput) {
  const directory = mkdtempSync(join(tmpdir(), 'tw-api-owner-'));
  const drops: (() => Promise<void>)[] = [];
  const registry = new Registry();
  const retire: (() => Promise<unknown>)[] = [];
  let close = () => {};
  t.after(async () => {
    for (const owner of retire.reverse()) await owner().catch(() => {});
    close();
    await registry.closeAll().catch(() => {});
    for (const drop of drops) await drop().catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  });
  const postgres = input.engine === 'postgres';
  const database = async (name: string) => {
    if (!postgres) return join(directory, `${name}.db`);
    const owned = await uuidPostgresDatabase(`tw_api_${name.replace(/[^a-z0-9_]/g, '_').slice(0, 12)}`);
    drops.push(owned.drop);
    return owned.url;
  };
  const urls: Record<string, string> = {};
  for (const [id, connection] of Object.entries(input.connections)) {
    const url = await database(id);
    urls[id] = url;
    if (postgres) {
      const client = await pgClient(url);
      try {
        await client.query(connection.sql);
      } finally {
        await client.end();
      }
      if (connection.journal || connection.events) await migratePostgresCommandJournal(url);
      if (connection.events) await provisionStores({ postgres: url }, { app: { id: appIdOf(input), source: connection.events.sourceId } });
    } else {
      const db = new DatabaseSync(url);
      try {
        db.exec(connection.sql);
      } finally {
        db.close();
      }
      if (connection.journal || connection.events) migrateSqliteCommandJournal(url);
      if (connection.events) await provisionStores({ sqlite: url }, { app: { id: appIdOf(input), source: connection.events.sourceId } });
    }
  }
  const store = await database('auth');
  if (postgres) {
    await migratePostgresAuthStore(store);
    const client = await pgClient(store);
    try {
      for (const [id, roles] of Object.entries(input.accounts)) {
        await client.query(
          `INSERT INTO mistri.auth_user(id,name,email,"emailVerified","createdAt","updatedAt",role,banned)
           VALUES($1,$1,$2,true,now(),now(),$3,false)`,
          [id, `${id}@example.test`, roles],
        );
      }
    } finally {
      await client.end();
    }
  }
  const app: AppDef = parseTestApp(input.app(store), 'fixture');
  const loaded = { app, path: join(directory, 'app.ts'), dir: directory, pages: [], sources: {} };
  const names = ['BETTER_AUTH_SECRET', 'MISTRI_AUTH_ADMIN_EMAIL', 'MISTRI_AUTH_ADMIN_PASSWORD'] as const;
  const prior = names.map((name) => [name, process.env[name]] as const);
  process.env.BETTER_AUTH_SECRET = SECRET;
  delete process.env.MISTRI_AUTH_ADMIN_EMAIL;
  delete process.env.MISTRI_AUTH_ADMIN_PASSWORD;
  let auth: Awaited<ReturnType<typeof createAppAuth>>;
  try {
    auth = await createAppAuth(loaded, { baseURL: 'http://127.0.0.1:1', trustedOrigins: ['http://127.0.0.1:1'] });
  } finally {
    for (const [name, value] of prior) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  close = () => auth.close();
  if (!postgres) {
    const accounts = new DatabaseSync(store);
    try {
      for (const [id, roles] of Object.entries(input.accounts))
        accounts
          .prepare('INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt,role,banned) VALUES(?,?,?,1,?,?,?,0)')
          .run(id, id, `${id}@example.test`, '2026-01-01', '2026-01-01', roles);
    } finally {
      accounts.close();
    }
  }
  for (const [id, connection] of Object.entries(input.connections))
    registry.add({ id, name: id, url: urls[id], writable: connection.writable === true, source: 'config' });
  const entry = Object.keys(input.connections)[0];
  const home = app.sources ? (Object.values(app.sources).find((source) => source.default)?.connection ?? entry) : entry;
  const resources = await loadAppRuntimeResources(registry, { ...app, api: app.api && { ...app.api, commands: [] } }, home);
  const evidence = { connectionFor: resources.connectionFor, writableConnection: () => true, transactionalConnection: () => true };
  const storeId = randomUUID();
  const exclusions = postgres ? [] : Object.values(urls).map((path) => captureAuthStoreExclusion(path));
  const excludeConnections = Object.entries(urls).map(([name, url]) => ({ name, url, source: 'session' as const }));
  if (postgres) await provisionPostgresApiTokenStore(store, { appId: app.id, storeId, excludeConnections });
  else provisionSqliteApiTokenStore(store, { appId: app.id, storeId, exclusions });
  /** A token for `subject` with its roles, narrowed to `operations` when given. */
  const issue = async (subject: string, roles: readonly string[], operations?: readonly string[]): Promise<string> => {
    const options = {
      storeId,
      subjectId: subject,
      actorId: subject,
      roles: [...roles],
      label: subject,
      expiresAt: Date.now() + 600000,
      ...(operations ? { operations } : {}),
    };
    if (postgres) {
      const issued = input.commands
        ? await issuePostgresApiCommandToken(
            store,
            app,
            resources.schema,
            input.commands,
            evidence,
            { ...options, excludeConnections },
            Date.now,
          )
        : await issuePostgresApiToken(store, app, resources.schema, { ...options, excludeConnections }, Date.now);
      return issued.token;
    }
    const issued = input.commands
      ? issueSqliteApiCommandToken(store, app, resources.schema, input.commands, evidence, { ...options, exclusions }, Date.now())
      : issueSqliteApiToken(store, app, resources.schema, { ...options, exclusions }, Date.now());
    return issued.token;
  };
  const host = { app: loaded, auth, pages: [] };
  const hosting = input.commands
    ? {
        appId: app.id,
        registry: input.commands,
        ...(input.events ? { events: issueAppScopeCommandEvents(appCommandEventStore(app.id, input.events.sourceId)) } : {}),
      }
    : undefined;
  return { app, host, hosting, registry, urls, store, resources, evidence, issue, retire, directory };
}

function appIdOf(input: OwnerFixtureInput): string {
  return String(input.app('').id);
}

const caught = (error: unknown): Said => {
  if (error instanceof ApiReadFailure) return { refused: error.code };
  if (isBusinessCommandExecutionError(error)) return { refused: `${error.code}/${error.outcome}` };
  if (error instanceof Error && error.name === 'ApiCommandUnauthenticated') return { refused: 'unauthenticated' };
  throw error;
};

/** The read owner, as one call per request on either engine. */
export async function readOwner(f: Awaited<ReturnType<typeof apiOwnerFixture>>, engine: Engine, integers: 'decimal-string' | 'number') {
  const commands = f.hosting?.registry;
  if (engine === 'sqlite') {
    const owner = await createSqliteApiReadOwner(f.registry, f.host, integers, commands);
    f.retire.push(() => owner.retire());
    const take = async (handle: Promise<object>): Promise<Said> => {
      try {
        return owner.consumeResult(await handle);
      } catch (error) {
        return caught(error);
      }
    };
    return {
      owner,
      item: (token: string, operation: string, key: string) => take(owner.readItem(token, operation, key)),
      list: (token: string, operation: string, query: string) => take(owner.readList(token, operation, query)),
      spec: (token: string) => take(owner.readSpec(token)),
      tools: (token: string) => take(owner.readTools(token)),
      events: (token: string, query: string) => take(owner.readEvents(token, query)),
      asyncapi: (token: string) => take(owner.readAsyncApi(token)),
    };
  }
  const owner = await createPostgresApiReadOwner(f.registry, f.host, integers, commands);
  f.retire.push(() => owner.retire());
  type Send = Parameters<typeof owner.readSpec>[1];
  const take = async (run: (send: Send) => Promise<unknown>): Promise<Said> => {
    let sent: Answer | undefined;
    try {
      await run((response) => {
        sent = { status: response.status, body: response.body };
      });
    } catch (error) {
      return caught(error);
    }
    return sent ?? { refused: 'unsent' };
  };
  return {
    owner,
    item: (token: string, operation: string, key: string) => take((send) => owner.readItem(token, operation, key, send)),
    list: (token: string, operation: string, query: string) => take((send) => owner.readList(token, operation, query, send)),
    spec: (token: string) => take((send) => owner.readSpec(token, send)),
    tools: (token: string) => take((send) => owner.readTools(token, send)),
    events: (token: string, query: string) => take((send) => owner.readEvents(token, query, send)),
    asyncapi: (token: string) => take((send) => owner.readAsyncApi(token, send)),
  };
}

/** The command owner (api-v1 wire), as one call per request on either engine. */
export async function commandOwner(f: Awaited<ReturnType<typeof apiOwnerFixture>>, engine: Engine, integers: 'decimal-string' | 'number') {
  const wire = { wire: 'api-v1' as const, integers };
  if (engine === 'sqlite') {
    const owner = await createSqliteApiCommandOwner(f.registry, f.host, f.hosting!, wire);
    f.retire.push(() => owner.retire());
    const take = async (handle: Promise<object>): Promise<Said> => {
      try {
        return owner.consumeResult(await handle);
      } catch (error) {
        return caught(error);
      }
    };
    return {
      owner,
      execute: (token: string, request: unknown) => take(owner.execute(token, request)),
      prepare: (token: string, request: unknown) => take(owner.prepare(token, request)),
      recover: (token: string, request: unknown) => take(owner.recover(token, request)),
      spec: (token: string) => take(owner.readSpec(token)),
      tools: (token: string) => take(owner.readTools(token)),
    };
  }
  const owner = await createPostgresApiCommandOwner(f.registry, f.host, f.hosting!, wire);
  f.retire.push(() => owner.retire());
  type Send = Parameters<typeof owner.readSpec>[1];
  const take = async (run: (send: Send) => Promise<unknown>): Promise<Said> => {
    let sent: Answer | undefined;
    try {
      await run((answer) => {
        sent = { status: answer.status, body: answer.body, headers: answer.headers };
      });
    } catch (error) {
      return caught(error);
    }
    return sent ?? { refused: 'unsent' };
  };
  return {
    owner,
    execute: (token: string, request: unknown) => take((send) => owner.execute(token, request, send)),
    prepare: (token: string, request: unknown) => take((send) => owner.prepare(token, request, send)),
    recover: (token: string, request: unknown) => take((send) => owner.recover(token, request, send)),
    spec: (token: string) => take((send) => owner.readSpec(token, send)),
    tools: (token: string) => take((send) => owner.readTools(token, send)),
  };
}

/** The body of an answer, or a failure naming what was said instead. */
export function bodyOf(said: Said): string {
  if ('refused' in said) throw new Error(`The owner refused: ${said.refused}`);
  return said.body;
}
