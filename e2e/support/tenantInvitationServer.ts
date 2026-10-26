import { spawn } from './spawned.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { TENANT_TABLES } from '../../packages/mistri/src/server/tenant/tenantStore.js';
import { ADMINISTRATION_JOURNAL_TABLES } from '../../packages/mistri/src/server/tenant/tenantAdministrationJournal.js';
import { INVITATION_TABLES } from '../../packages/mistri/src/server/tenant/tenantInvitationStore.js';
import type { TenantAccount } from './tenantServer.js';

export const invitationBinding = {
  appId: 'tenant-invitation-proof',
  source: { id: 'business', connection: 'business-db' },
  storeId: 'invitation-browser-store',
};
export const invitationAppName = 'Tenant invitation proof';
interface Ready {
  origin: string;
  accounts: { operator: TenantAccount; target: TenantAccount; outsider: TenantAccount };
}

/** Dedicated private child: no public CLI activation, test HTTP routes, or
 * inherited deployment credentials. Native account IDs arrive over owned IPC. */
export async function startTenantInvitations(options: { administration?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-invitation-browser-'));
  const database = join(directory, 'business.db'),
    authDatabase = join(directory, 'auth.db');
  let child: ReturnType<typeof spawn> | undefined, closed: Promise<unknown> | undefined;
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      try {
        if (child && child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM');
          const force = setTimeout(() => child?.kill('SIGKILL'), 10_000);
          try {
            await closed;
          } finally {
            clearTimeout(force);
          }
        } else await closed;
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    })());
  try {
    const environment: NodeJS.ProcessEnv = {};
    for (const name of ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL']) {
      if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
    child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(new URL('./tenant-invitation-fixture/server.ts', import.meta.url)),
        JSON.stringify({ directory, administration: options.administration === true }),
      ],
      {
        cwd: fileURLToPath(new URL('../../', import.meta.url)),
        env: {
          ...environment,
          XDG_CONFIG_HOME: join(directory, 'xdg'),
          MISTRI_OPEN: '0',
          BETTER_AUTH_SECRET: 'disposable-invitation-browser-secret-at-least-thirty-two-characters',
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    );
    const ownedChild = child;
    closed = new Promise<void>((resolve) => ownedChild.once('close', () => resolve()));
    let output = '';
    const append = (chunk: Buffer) => {
      output = (output + String(chunk)).slice(-32_768);
    };
    ownedChild.stdout!.on('data', append);
    ownedChild.stderr!.on('data', append);
    const ready = await new Promise<Ready>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Invitation fixture startup timed out')), 30_000);
      const finish = (error?: Error, value?: Ready) => {
        clearTimeout(timer);
        ownedChild.off('message', message);
        ownedChild.off('exit', exited);
        ownedChild.off('error', failed);
        if (error) reject(error);
        else resolve(value!);
      };
      const message = (value: unknown) => {
        if (!value || typeof value !== 'object') return;
        const data = value as { type?: string; value?: Ready };
        if (data.type === 'ready' && data.value) finish(undefined, data.value);
        if (data.type === 'failed') finish(new Error('Invitation fixture startup failed'));
      };
      // Captured output is bounded and stays private; never print possible auth diagnostics.
      const exited = () => finish(new Error(`Invitation fixture exited during startup (${output.length} diagnostic characters retained)`));
      const failed = () => finish(new Error('Invitation fixture process failed'));
      ownedChild.on('message', message);
      ownedChild.once('exit', exited);
      ownedChild.once('error', failed);
    });
    return {
      ...ready,
      appId: invitationBinding.appId,
      appName: invitationAppName,
      database,
      authDatabase,
      stop,
      snapshot: () => {
        const db = new DatabaseSync(database, { readOnly: true });
        try {
          db.exec('BEGIN');
          const rows = (table: string) => db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();
          // The audit columns live in the receipt row now; specs still read them as their own list.
          const auditRows = () =>
            db
              .prepare(
                `SELECT id AS receipt_id, policy_id, policy_version, deployment, session_id, change_json FROM "${ADMINISTRATION_JOURNAL_TABLES.receipt}" ORDER BY rowid`,
              )
              .all();
          return {
            business: rows('private_item'),
            tenants: rows(TENANT_TABLES.tenant),
            memberships: rows(TENANT_TABLES.membership),
            invitations: rows(INVITATION_TABLES.invitation),
            receipts: rows(ADMINISTRATION_JOURNAL_TABLES.receipt),
            audit: auditRows(),
          };
        } finally {
          db.close();
        }
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
export type TenantInvitationFixture = Awaited<ReturnType<typeof startTenantInvitations>>;
