import { spawn } from './spawned';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { loadApp } from '../../packages/mistri/src/server/app/apps.js';
import { createAppAuth } from '../../packages/mistri/src/server/auth/auth.js';
import { TransactionOperations } from '../../packages/engine/src/adapters/adapter.js';
import { provisionSqliteAssistant } from '../../packages/mistri/src/adapters/assistant/sqliteAssistant.js';
import {
  createSqliteTenantAdministration,
  provisionSqliteTenantStore,
  TENANT_TABLES,
} from '../../packages/mistri/src/server/tenant/tenantStore.js';
import {
  provisionSqliteTenantAdministrationJournal,
  ADMINISTRATION_JOURNAL_TABLES,
} from '../../packages/mistri/src/server/tenant/tenantAdministrationJournal.js';
import { ADMINISTRATION_OPERATIONS } from '../../packages/mistri/src/shared/tenantAdministration.js';
import type { TenantAccount } from './tenantServer.js';

export const administrationBinding = {
  appId: 'tenant-administration-proof',
  source: { id: 'business', connection: 'business-db' },
  storeId: 'administration-browser-store',
};
export const administrationPolicy = { id: 'browser-operators', version: 'v1', maxMembershipLifetimeMs: 3_600_000 };

const AUTH_SECRET = 'disposable-administration-browser-secret-at-least-thirty-two-characters';

/** Uses the same public CLI as tenant-startup-cli.test.ts. Accounts exist
 * before the operator policy names one, as in a real deployment: they are
 * signed up against an auth-only bootstrap over the very same native store,
 * so the single CLI launch reads a policy that already carries the operator's
 * real ID. The launch attests an explicitly provisioned, private, fresh
 * store. */
/** `assistant`: the App declares an assistant answered by a scripted model, and the target account is
 * already a reader of an existing North, so the spec starts at the switch rather than at the membership. */
export async function startTenantAdministration(options: { assistant?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-administration-browser-'));
  const appDirectory = join(directory, 'app');
  mkdirSync(appDirectory);
  const database = join(directory, 'business.db'),
    authDatabase = join(directory, 'auth.db');
  const config = join(directory, 'config.json'),
    policy = join(directory, 'policy.mjs');
  const appName = 'Tenant administration proof',
    appId = administrationBinding.appId;
  let child: ReturnType<typeof spawn> | undefined;
  let closed: Promise<unknown> | undefined;
  let stopping: Promise<void> | undefined;
  const stopHost = async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const force = setTimeout(() => child?.kill('SIGKILL'), 5000);
      try {
        await closed;
      } finally {
        clearTimeout(force);
      }
    }
  };
  const stop = () =>
    (stopping ??= (async () => {
      try {
        await stopHost();
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    })());
  try {
    const db = new DatabaseSync(database);
    try {
      db.exec(`CREATE TABLE private_item(id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL);
        INSERT INTO private_item VALUES ('north-item', 'north', 'Private north business row'),
          ('south-item', 'south', 'Private south business row')`);
    } finally {
      db.close();
    }
    provisionSqliteTenantStore(database, administrationBinding);
    provisionSqliteTenantAdministrationJournal(database, administrationBinding);
    writeFileSync(
      join(appDirectory, 'app.json'),
      JSON.stringify({
        id: appId,
        name: appName,
        auth: { store: authDatabase, signUp: 'open', rows: 'tenant', roles: { reader: { read: true }, manager: { read: true } } },
        sources: { business: { connection: administrationBinding.source.connection } },
        resources: { item: { physical: 'private_item', owner: 'tenant', fields: { read: ['id', 'name'] } } },
        views: { items: { kind: 'list', from: 'item', label: 'Items', show: ['name'] } },
        home: 'items',
        nav: ['items'],
        ...(options.assistant ? { assistant: {} } : {}),
      }),
    );
    const script = join(directory, 'assistant-script.json');
    if (options.assistant) {
      provisionSqliteAssistant(database);
      writeFileSync(script, JSON.stringify({ turns: [], otherwise: 'Hello from the scripted assistant.' }));
    }
    writeFileSync(
      config,
      JSON.stringify({ connections: [{ name: administrationBinding.source.connection, url: database, writable: true }] }),
    );
    const writePolicy = (accountId: string) =>
      writeFileSync(
        policy,
        `export default {
      kind: 'tenant', appId: ${JSON.stringify(appId)}, storeId: ${JSON.stringify(administrationBinding.storeId)},
      ownership: { item: { kind: 'tenant', column: 'tenant_id' } },
      resolveMembershipRows: () => ({ item: true }), resolveRows: () => ({ item: true }),
      administration: ${JSON.stringify({
        ...administrationPolicy,
        operators: [{ accountId, tenants: ['north', 'south'], operations: ADMINISTRATION_OPERATIONS, roles: ['manager', 'reader'] }],
      })}
    };`,
      );
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((done, reject) => reservation.close((error) => (error ? reject(error) : done())));
    const origin = `http://127.0.0.1:${port}`;
    const launch = async () => {
      child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          resolve('packages/mistri/src/server/index.ts'),
          '--app',
          appDirectory,
          '--config',
          config,
          '--policy',
          policy,
          '--port',
          String(port),
        ],
        {
          env: {
            ...process.env,
            DATABASE_URL: '',
            XDG_CONFIG_HOME: join(directory, 'xdg'),
            MISTRI_OPEN: '0',
            MISTRI_PUBLIC_URL: '',
            MISTRI_DIAGNOSTICS: '',
            BETTER_AUTH_SECRET: AUTH_SECRET,
            MISTRI_AUTH_ADMIN_EMAIL: '',
            MISTRI_AUTH_ADMIN_PASSWORD: '',
            ANTHROPIC_API_KEY: '',
            MISTRI_ASSISTANT_SCRIPT: options.assistant ? script : '',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      closed = once(child, 'close');
      let output = '';
      const append = (chunk: Buffer) => {
        output = (output + String(chunk)).slice(-32768);
      };
      child.stdout!.on('data', append);
      child.stderr!.on('data', append);
      for (let tries = 0; tries < 500; tries++) {
        if (output.includes('Listening on')) return;
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Administration CLI exited: ${output}`);
        await delay(50);
      }
      throw new Error(`Administration CLI startup timed out: ${output}`);
    };
    const signup = async (name: string): Promise<TenantAccount> => {
      const credentials = { name, email: `${name}@example.test`, password: `disposable-administration-${name}-password` };
      const response = await fetch(`${origin}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify(credentials),
        signal: AbortSignal.timeout(10_000),
      });
      const result = await response.json();
      if (response.status !== 200 || typeof result.user?.id !== 'string') throw new Error('Administration native signup failed');
      return { ...credentials, id: result.user.id };
    };
    /* The App's own sign-in routes over the App's own native store, mounted
       on nothing else: no business source, no policy, no tenant host. That is
       all a sign-up needs, and it is what keeps the whole CLI from having to
       boot a second time only to learn three account IDs. */
    const bootstrap = async () => {
      const loaded = await loadApp(join(appDirectory, 'app.json'));
      const previous = {
        secret: process.env.BETTER_AUTH_SECRET,
        email: process.env.MISTRI_AUTH_ADMIN_EMAIL,
        password: process.env.MISTRI_AUTH_ADMIN_PASSWORD,
      };
      Object.assign(process.env, { BETTER_AUTH_SECRET: AUTH_SECRET, MISTRI_AUTH_ADMIN_EMAIL: '', MISTRI_AUTH_ADMIN_PASSWORD: '' });
      let runtime;
      try {
        runtime = await createAppAuth(loaded, { baseURL: origin, trustedOrigins: [origin] });
      } finally {
        for (const [name, value] of [
          ['BETTER_AUTH_SECRET', previous.secret],
          ['MISTRI_AUTH_ADMIN_EMAIL', previous.email],
          ['MISTRI_AUTH_ADMIN_PASSWORD', previous.password],
        ] as const) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
      const host = createHttpServer((request, response) => {
        void runtime.handler(request, response).catch(() => response.destroy());
      });
      host.listen(port, '127.0.0.1');
      await once(host, 'listening');
      try {
        return { operator: await signup('operator'), target: await signup('target'), outsider: await signup('outsider') };
      } finally {
        host.closeAllConnections();
        await new Promise<void>((done) => host.close(() => done()));
        runtime.close();
      }
    };
    const accounts = await bootstrap();
    writePolicy(accounts.operator.id);
    if (options.assistant) {
      const db = new DatabaseSync(database);
      const operations = new TransactionOperations();
      db.exec('BEGIN IMMEDIATE');
      try {
        const admin = createSqliteTenantAdministration(db, operations, administrationBinding);
        await admin.putTenant({ tenantId: 'north', status: 'active', expectedVersion: null });
        await admin.putMembership({
          tenantId: 'north',
          accountId: accounts.target.id,
          membershipId: 'north-target',
          status: 'active',
          roles: ['reader'],
          validUntil: Date.now() + 3_600_000,
          expectedVersion: null,
        });
        await operations.finish();
        db.exec('COMMIT');
      } catch (error) {
        await operations.finish().catch(() => {});
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      } finally {
        db.close();
      }
    }
    await launch();
    return {
      origin,
      appId,
      appName,
      accounts,
      database,
      authDatabase,
      stop,
      snapshot: () => {
        const reader = new DatabaseSync(database, { readOnly: true });
        try {
          reader.exec('BEGIN');
          const rows = (table: string) => reader.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();
          // The audit columns live in the receipt row now; specs still read the receipt and its audit as two lists.
          const receiptRows = () =>
            reader
              .prepare(
                `SELECT id, actor_id, tenant_id, operation, operation_version, idempotency_key, fingerprint, result_json, request_id, completed_at FROM "${ADMINISTRATION_JOURNAL_TABLES.receipt}" ORDER BY rowid`,
              )
              .all();
          const auditRows = () =>
            reader
              .prepare(
                `SELECT id AS receipt_id, policy_id, policy_version, deployment, session_id, change_json FROM "${ADMINISTRATION_JOURNAL_TABLES.receipt}" ORDER BY rowid`,
              )
              .all();
          return {
            business: rows('private_item'),
            tenants: rows(TENANT_TABLES.tenant),
            memberships: rows(TENANT_TABLES.membership),
            receipts: receiptRows(),
            audit: auditRows(),
          };
        } finally {
          reader.close();
        }
      },
      nativeSessionId: (accountId: string) => {
        const reader = new DatabaseSync(authDatabase, { readOnly: true });
        try {
          // Exactly one signup and one browser login, with no API login helper.
          // Reading the signup response after SignIn reloads can race Chromium's
          // response-body eviction; the real native store is durable evidence.
          const sessions = reader.prepare('SELECT id FROM session WHERE userId = ? ORDER BY rowid').all(accountId);
          if (sessions.length !== 2 || typeof sessions[1].id !== 'string') throw new Error('Expected signup and browser login sessions');
          return sessions[1].id;
        } finally {
          reader.close();
        }
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
export type TenantAdministrationFixture = Awaited<ReturnType<typeof startTenantAdministration>>;
