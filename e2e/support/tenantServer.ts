import { spawn } from './spawned.js';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TenantProofKind } from '../../test/support/tenantProofModel.js';
import type { TenantEventsFixture } from '../../test/support/tenantAssignmentEvents.js';
import { parseTestApp } from '../../test/support/commandCatalog.js';

export const TENANT_APP_ID = 'tenant-workspace';
export const TENANT_APP_NAME = 'Tenant browser workspace';
export interface TenantAccount {
  name: string;
  email: string;
  password: string;
  id: string;
}
interface Ready {
  origin: string;
  accounts: { alice: TenantAccount; bob: TenantAccount; visitor: TenantAccount };
}
type Message = { type: 'ready'; value: Ready } | { type: 'reply'; id: number; error?: string };

/** A separate process owns Vite, native auth, both source handles and all test
 * data. Administration is IPC-only: there is no test authority on the HTTP host. */
export async function startTenantApp(
  options: {
    appId?: string;
    writable?: boolean;
    commandOnly?: boolean;
    southReadOnly?: boolean;
    parents?: boolean;
    tenantProof?: TenantProofKind;
    tenantAssignment?: boolean;
    tenantInventory?: boolean;
    tenantEvents?: TenantEventsFixture;
    platform?: boolean;
    /** The public intake App; `challenge` has it name a human check (Turnstile's stand-in), `choices` gives its form a
        choice read from each dealer's own table under `auth.public`. */
    intake?: boolean | { challenge?: true; choices?: true };
    support?: boolean;
    /** The tenant shell's own chrome: the header's New menu over the items, and a bell — Bob watches every item. Needs `writable`. */
    shell?: boolean;
    /** Provision live sync's change store and ask for live sync (the tenant proof only); 'unasked' provisions it under an App that does not ask. */
    live?: boolean | 'unasked';
    /** The Thread notes App (`tenantProof: 'thread'`, appId `tenant-thread-notes`): a discussion two people edit and write notes on. */
    notes?: boolean;
  } = {},
) {
  if (
    (options.platform || options.intake || options.support) &&
    (options.writable || options.commandOnly || options.southReadOnly || options.parents || options.tenantProof)
  )
    throw new Error('The platform realm, public intake and support fixtures are their own Apps');
  if ([options.platform, options.intake, options.support].filter(Boolean).length > 1)
    throw new Error('Choose one of the platform realm, public intake or support fixtures');
  if (options.writable && options.commandOnly) throw new Error('Choose either CRUD or command-only fixture authority');
  if (options.parents && !options.writable) throw new Error('Parent creation proof requires the CRUD fixture');
  if (options.shell && !options.writable) throw new Error('The shell fixture makes items, so it requires the CRUD fixture');
  if ((options.tenantAssignment || options.tenantInventory) && options.tenantProof !== 'ignition')
    throw new Error('Assignment/inventory require the Ignition proof');
  if (options.tenantEvents && (!options.tenantAssignment || options.tenantInventory))
    throw new Error('Events require the assignment-only fixture');
  const appId = options.appId ?? TENANT_APP_ID;
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-tenant-browser-'));
  let child: ReturnType<typeof spawn> | undefined;
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      try {
        if (child && child.exitCode === null && child.signalCode === null) {
          const closed = once(child, 'close');
          child.kill('SIGTERM');
          const force = setTimeout(() => child?.kill('SIGKILL'), 5000);
          try {
            await closed;
            if (child.signalCode) throw new Error('Tenant fixture exited before graceful shutdown completed.');
          } finally {
            clearTimeout(force);
          }
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    })());
  try {
    // The origin is part of the auth configuration, so the port is chosen before the
    // child listens; between closing this reservation and the child's listen another
    // owned suite can take it. That race is the parallel lane's, so lose it and retry.
    const launch = async (): Promise<Ready> => {
      const reservation = createServer();
      reservation.listen(0, '127.0.0.1');
      await once(reservation, 'listening');
      const port = (reservation.address() as { port: number }).port;
      await new Promise<void>((resolve, reject) => reservation.close((error) => (error ? reject(error) : resolve())));
      child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          fileURLToPath(import.meta.url),
          '--tenant-fixture-child',
          JSON.stringify({
            directory,
            appId,
            port,
            ...(options.platform ? { platform: true } : {}),
            ...(options.intake ? { intake: options.intake } : {}),
            ...(options.support ? { support: true } : {}),
            writable: options.writable === true,
            commandOnly: options.commandOnly === true,
            southReadOnly: options.southReadOnly === true,
            parents: options.parents === true,
            shell: options.shell === true,
            ...(options.tenantProof
              ? {
                  tenantProof: options.tenantProof,
                  tenantAssignment: options.tenantAssignment === true,
                  tenantInventory: options.tenantInventory === true,
                  ...(options.tenantEvents ? { tenantEvents: options.tenantEvents } : {}),
                  ...(options.live ? { live: options.live } : {}),
                  ...(options.notes ? { notes: true } : {}),
                }
              : {}),
          }),
        ],
        {
          env: {
            ...process.env,
            DATABASE_URL: '',
            XDG_CONFIG_HOME: join(directory, 'xdg'),
            MISTRI_OPEN: '0',
            BETTER_AUTH_SECRET: 'disposable-tenant-browser-fixture-secret-at-least-thirty-two-characters',
            MISTRI_AUTH_ADMIN_EMAIL: '',
            MISTRI_AUTH_ADMIN_PASSWORD: '',
          },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        },
      );
      const processChild = child;
      let log = '';
      const output = (chunk: Buffer) => {
        log = (log + String(chunk)).slice(-65536);
      };
      processChild.stdout!.on('data', output);
      processChild.stderr!.on('data', output);
      const ready = await new Promise<Ready>((resolve, reject) => {
        const timer = setTimeout(() => done(new Error(`Tenant fixture startup timed out${options.tenantEvents ? '' : `: ${log}`}`)), 25000);
        const message = (value: Message) => {
          if (value.type === 'ready') done(undefined, value.value);
        };
        const exited = () =>
          done(
            Object.assign(new Error(`Tenant fixture exited during startup${options.tenantEvents ? '' : `: ${log}`}`), {
              addressInUse: /EADDRINUSE/.test(log),
            }),
          );
        const done = (error?: Error, value?: Ready) => {
          clearTimeout(timer);
          processChild.off('message', message);
          processChild.off('exit', exited);
          processChild.off('error', done);
          if (error) reject(error);
          else resolve(value!);
        };
        processChild.on('message', message);
        processChild.once('exit', exited);
        processChild.once('error', done);
      });
      return ready;
    };
    let ready: Ready;
    for (let attempt = 1; ; attempt++) {
      try {
        ready = await launch();
        break;
      } catch (error) {
        if (attempt >= 3 || !(error as { addressInUse?: boolean }).addressInUse) throw error;
        // The lost attempt may have provisioned its stores already; the next one starts clean.
        rmSync(directory, { recursive: true, force: true });
        mkdirSync(directory);
      }
    }
    const processChild = child!;
    let next = 0;
    const administer = (
      payload:
        | { type: 'revoke' | 'shift'; accountId: string; tenantId: string }
        | { type: 'staff-state'; staffId: string; state: { active?: 0 | 1; role?: 'manager' | 'reviewer' | 'clerk' } },
    ) =>
      new Promise<void>((resolve, reject) => {
        const id = ++next;
        const timer = setTimeout(() => done(new Error('Tenant fixture administration timed out')), 10000);
        const message = (value: Message) => {
          if (value.type === 'reply' && value.id === id) done(value.error ? new Error(value.error) : undefined);
        };
        const exited = () => done(new Error('Tenant fixture exited during administration'));
        const done = (error?: Error) => {
          clearTimeout(timer);
          processChild.off('message', message);
          processChild.off('exit', exited);
          if (error) reject(error);
          else resolve();
        };
        processChild.on('message', message);
        processChild.once('exit', exited);
        processChild.send({ ...payload, id }, (error) => {
          if (error) done(error);
        });
      });
    return {
      ...ready,
      appId,
      appName: TENANT_APP_NAME,
      database: join(directory, 'business.db'),
      revoke: (accountId: string, tenantId: string) => administer({ type: 'revoke', accountId, tenantId }),
      shift: (accountId: string, tenantId: string) => administer({ type: 'shift', accountId, tenantId }),
      setStaffState: (staffId: string, state: { active?: 0 | 1; role?: 'manager' | 'reviewer' | 'clerk' }) => {
        if (!options.tenantAssignment && !options.tenantInventory) return Promise.reject(new Error('Not a staff fixture'));
        return administer({ type: 'staff-state', staffId, state });
      },
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
export type TenantAppFixture = Awaited<ReturnType<typeof startTenantApp>>;

async function serveFixture({
  directory,
  appId,
  port,
  writable = false,
  commandOnly = false,
  southReadOnly = false,
  parents = false,
  shell = false,
}: {
  directory: string;
  appId: string;
  port: number;
  writable?: boolean;
  commandOnly?: boolean;
  southReadOnly?: boolean;
  parents?: boolean;
  shell?: boolean;
}) {
  const { DatabaseSync } = await import('node:sqlite');
  const { TransactionOperations } = await import('../../packages/engine/src/adapters/adapter.js');
  const { createAppAuth } = await import('../../packages/mistri/src/server/auth/auth.js');
  const { parsePagesConfig } = await import('../../packages/engine/src/shared/page.js');
  const { defineAppTenantPolicy } = await import('../../packages/mistri/src/server/policy/appTenantPolicy.js');
  const { createTenantAuthenticatedHttpServer } = await import('../../packages/mistri/src/server/tenant/tenantAuthenticatedHttp.js');
  const { provisionSqliteTenantStore, createSqliteTenantAdministration } =
    await import('../../packages/mistri/src/server/tenant/tenantStore.js');
  const { defineCommand, defineCommands } = await import('../../packages/mistri/src/server/commands/businessCommands.js');
  const { migrateSqliteCommandJournal } = await import('../../packages/mistri/src/adapters/commands/commandJournal.js');
  const { provisionSqliteInbox } = await import('../../packages/mistri/src/adapters/inbox/sqliteInbox.js');
  const database = join(directory, 'business.db'),
    origin = `http://127.0.0.1:${port}`;
  const source = { id: 'business', connection: 'tenant-browser-business' };
  const binding = { appId, source, storeId: 'tenant-browser-store' };
  const writer = new DatabaseSync(database);
  let auth: Awaited<ReturnType<typeof createAppAuth>> | undefined;
  let owner: Awaited<ReturnType<typeof createTenantAuthenticatedHttpServer>> | undefined;
  let retiring: Promise<void> | undefined;
  const stop = () =>
    (retiring ??= (async () => {
      try {
        owner?.server.closeAllConnections();
        await owner?.retire();
      } finally {
        auth?.close();
        writer.close();
        process.disconnect?.();
      }
    })());
  try {
    // A hidden owner cannot be part of an App's readable complete primary key.
    // Keep opaque record keys distinct, but expose identical business IDs in
    // both tenants so list/filter/cache ownership is still exercised.
    writer.exec(`CREATE TABLE physical_item (
      id TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), tenant_id TEXT NOT NULL COLLATE BINARY,
      business_id TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
      UNIQUE(tenant_id, business_id));
      INSERT INTO physical_item VALUES
        ('north-1','north','shared-1','North item','open'),
        ('north-2','north','shared-2','North second item','closed'),
        ('south-1','south','shared-1','South item','open'),
        ('south-2','south','shared-2','South second item','closed');`);
    if (parents)
      writer.exec(`CREATE TABLE physical_parent (
        id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL COLLATE BINARY, name TEXT NOT NULL);
      INSERT INTO physical_parent VALUES ('north-parent','north','North parent'), ('south-parent','south','South parent');
      ALTER TABLE physical_item ADD COLUMN parent_id TEXT REFERENCES physical_parent(id);
      UPDATE physical_item SET parent_id = CASE tenant_id WHEN 'north' THEN 'north-parent' ELSE 'south-parent' END;`);
    /* Bob watches every item (his address is fixed by his sign-up below), so a write tells him in that tenant's inbox. */
    if (shell) {
      writer.exec(`ALTER TABLE physical_item ADD COLUMN watcher TEXT; UPDATE physical_item SET watcher = 'bob@example.test';`);
      provisionSqliteInbox(database);
    }
    provisionSqliteTenantStore(database, binding);
    if (commandOnly) {
      writer.exec('ALTER TABLE physical_item ADD COLUMN version INTEGER NOT NULL DEFAULT 0');
      // Explicit fresh-fixture provisioning, never enrollment-time migration of
      // an existing preview or an assumed older journal.
      migrateSqliteCommandJournal(database);
    }
    const transaction = async (work: (admin: ReturnType<typeof createSqliteTenantAdministration>) => Promise<void>) => {
      const operations = new TransactionOperations();
      writer.exec('BEGIN IMMEDIATE');
      try {
        await work(createSqliteTenantAdministration(writer, operations, binding));
        await operations.finish();
        writer.exec('COMMIT');
      } catch (error) {
        await operations.finish().catch(() => {});
        writer.exec('ROLLBACK');
        throw error;
      }
    };
    const fields = ['id', 'business_id', 'name', 'status', ...(commandOnly ? ['version'] : []), ...(parents ? ['parent_id'] : [])];
    const readable = [...fields, ...(shell ? ['watcher'] : [])];
    const pages = parents
      ? parsePagesConfig(
          {
            pages: [
              {
                id: 'parent-detail',
                label: 'Parent details',
                base: 'parent',
                listTabs: false,
                sections: [
                  { kind: 'fields', show: ['name'] },
                  {
                    kind: 'list',
                    title: 'Items',
                    from: 'item',
                    whose: 'parent_id',
                    show: ['business_id', 'name'],
                    create: { label: 'Add related item', show: ['business_id', 'name'] },
                  },
                ],
              },
            ],
          },
          'disposable parent page',
        )
      : [];
    // One declaration: the fixture App's reference and the registration take the same field list.
    const advanceInput = { reason: { type: 'text', max: 256 } } as const;
    const loaded = {
      path: join(directory, 'app.ts'),
      pages,
      sources: {},
      app: parseTestApp(
        {
          id: appId,
          name: TENANT_APP_NAME,
          auth: {
            store: join(directory, 'auth.db'),
            signUp: 'open',
            defaultRole: 'member',
            rows: 'tenant',
            roles: {
              member: { read: true, ...(writable ? { write: ['item'] } : {}), ...(commandOnly ? { commands: ['advance'] } : {}) },
              viewer: { read: true },
            },
          },
          sources: { business: { connection: source.connection } },
          resources: {
            item: {
              physical: 'physical_item',
              owner: 'tenant',
              ...(writable || commandOnly ? { access: 'write' as const } : {}),
              // Deletion is opt-in per resource; the writable proof exercises it.
              ...(writable ? { delete: true as const } : {}),
              // Command-only proof deliberately has no field rules on its footprint.
              ...(commandOnly ? {} : { fields: { read: readable, write: writable ? fields : [] } }),
              /* Its records are addressed by their business id, unique within a tenant, under the view `items`. */
              ...(shell ? { notify: [{ on: 'update', to: 'watcher', title: 'Renamed to {name}' }], address: 'business_id' } : {}),
              ...(commandOnly
                ? {
                    actions: {
                      advanceItem: {
                        label: 'Advance item',
                        command: {
                          id: 'advance',
                          version: 1,
                          target: 'item',
                          input: advanceInput,
                        },
                      },
                    },
                  }
                : {}),
            },
            ...(parents
              ? {
                  parent: {
                    physical: 'physical_parent',
                    owner: 'tenant',
                    ...(commandOnly ? {} : { fields: { read: ['id', 'name'], write: [] } }),
                  },
                }
              : {}),
          },
          views: {
            items: { kind: 'list', from: 'item', label: 'Items', show: fields, filters: ['status'], advancedFilters: true },
            ...(parents ? { parents: { kind: 'list', from: 'parent', label: 'Parents', show: ['id', 'name'] } } : {}),
          },
          home: 'items',
          nav: ['items', ...(parents ? ['parents'] : [])],
          ui: { shell: { placement: 'top', ...(shell ? { new: [{ view: 'items', icon: 'package' }] } : {}) } },
        },
        'disposable tenant browser fixture',
      ),
    };
    const result = (value: unknown): { itemId: string; version: number } => {
      if (!value || typeof value !== 'object') throw new Error('Invalid fixture command result');
      const data = value as Record<string, unknown>;
      if (typeof data.itemId !== 'string' || !Number.isSafeInteger(data.version) || Object.keys(data).length !== 2)
        throw new Error('Invalid fixture command result');
      return { itemId: data.itemId, version: data.version as number };
    };
    const registry = commandOnly
      ? defineCommands({
          advance: defineCommand({
            source: source.id,
            target: 'item',
            when: 'version = 0',
            input: advanceInput,
            output: { parse: result },
            async handle({ db, record: item }) {
              // Advancing is the revision itself, guarded on the one the item was read at.
              const { version } = await db.item.update(item, { version: Number(item.version) + 1 });
              return { itemId: String(item.id), version: Number(version) };
            },
          }),
        })
      : undefined;
    auth = await createAppAuth(loaded, { baseURL: origin, trustedOrigins: [origin] });
    owner = await createTenantAuthenticatedHttpServer({
      loaded,
      auth,
      browser: true,
      bound: { host: '127.0.0.1', port },
      enrollment: {
        policy: defineAppTenantPolicy({
          kind: 'tenant',
          appId,
          storeId: binding.storeId,
          ownership: {
            item: { kind: 'tenant', column: 'tenant_id' },
            ...(parents ? { parent: { kind: 'tenant' as const, column: 'tenant_id' } } : {}),
          },
          resolveMembershipRows: () => ({ item: true, ...(parents ? { parent: true } : {}) }),
          resolveRows: () => ({ item: true, ...(parents ? { parent: true } : {}) }),
          ...(writable ? { authorizeDeletedRecord: () => true } : {}),
          ...(registry
            ? { resultReferences: { advance: (value: unknown) => [{ table: 'item', key: { id: result(value).itemId } }] } }
            : {}),
        }),
        source: { ...source, existingPath: database },
        deployment: 'browser-generation',
        roles: ['member', 'viewer'],
        maxLifetimeMs: 300000,
        ...(registry ? { commands: { registry } } : {}),
      },
    });
    owner.server.listen(port, '127.0.0.1');
    await once(owner.server, 'listening');
    const signup = async (name: string): Promise<TenantAccount> => {
      const credentials = { name, email: `${name}@example.test`, password: `tenant-browser-${name}-password` };
      const response = await fetch(`${origin}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify(credentials),
        signal: AbortSignal.timeout(10000),
      });
      const body = await response.json();
      if (!response.ok || typeof body.user?.id !== 'string') throw new Error('Tenant fixture native signup failed');
      return { ...credentials, id: body.user.id };
    };
    const accounts = { alice: await signup('alice'), bob: await signup('bob'), visitor: await signup('visitor') };
    const grants = new Map<
      string,
      {
        tenantId: string;
        accountId: string;
        membershipId: string;
        status: 'active' | 'revoked';
        roles: string[];
        validUntil: number;
        expectedVersion: string | null;
      }
    >();
    await transaction(async (admin) => {
      for (const tenantId of ['north', 'south']) await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
      for (const [account, tenants] of [
        [accounts.alice, ['north', 'south']],
        [accounts.bob, ['north']],
      ] as const) {
        for (const tenantId of tenants) {
          const grant = {
            tenantId,
            accountId: account.id,
            membershipId: `${account.name}-${tenantId}`,
            status: 'active' as const,
            roles: [southReadOnly && tenantId === 'south' ? 'viewer' : 'member'],
            validUntil: Date.now() + 3600000,
            expectedVersion: null,
          };
          await admin.putMembership(grant);
          grants.set(`${account.id}:${tenantId}`, { ...grant, expectedVersion: '1' });
        }
      }
    });
    let controls = Promise.resolve();
    process.on('message', (input: { type: string; id: number; accountId: string; tenantId: string }) => {
      if (input.type !== 'revoke') return;
      controls = controls.then(async () => {
        try {
          const grant = grants.get(`${input.accountId}:${input.tenantId}`);
          if (!grant || grant.status !== 'active') throw new Error('Unknown or inactive fixture grant');
          await transaction((admin) => admin.putMembership({ ...grant, status: 'revoked' }));
          grant.status = 'revoked';
          grant.expectedVersion = '2';
          process.send?.({ type: 'reply', id: input.id });
        } catch {
          process.send?.({ type: 'reply', id: input.id, error: 'Tenant fixture revocation failed' });
        }
      });
    });
    // Keep the handler registered during async cleanup: signal-exit would
    // otherwise re-raise the signal after a once-handler removes itself.
    process.on('SIGTERM', () => {
      void controls.then(stop).catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    });
    process.send?.({ type: 'ready', value: { origin, accounts } });
  } catch (error) {
    await stop();
    throw error;
  }
}

if (process.argv[2] === '--tenant-fixture-child') {
  const input = JSON.parse(process.argv[3]);
  const started = input.support
    ? import('./tenantSupportFixture.js').then(({ serveSupportFixture }) => serveSupportFixture(input))
    : input.intake
      ? import('./tenantIntakeFixture.js').then(({ serveIntakeFixture }) => serveIntakeFixture(input))
      : input.platform
        ? import('./tenantPlatformFixture.js').then(({ servePlatformFixture }) => servePlatformFixture(input))
        : input.tenantProof
          ? import('../../test/support/tenantProofFixture.js').then(({ serveTenantProof }) => serveTenantProof(input))
          : serveFixture(input);
  void started.catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
