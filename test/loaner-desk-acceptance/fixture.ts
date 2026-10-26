/** Loaner Desk on a disposable SQLite file, using only public mistri helpers: the real seed, App,
 * commands and jobs module, a virtual return kiosk, and an administrator, a staff member and a viewer. */
import { mkdir, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { provisionStores } from '@mistriwork/mistri/maintenance';
import { createTestWorkspace, startService, startTestApp, type TestClient } from '@mistriwork/mistri/testing';
import { seed } from '../fixtures/databases/loaner-desk/seed.mjs';
import { createReturnKiosk } from './return-kiosk.ts';

/** The App under test. LOANER_DESK_APP points it at a changed copy: prove-red.mjs uses it to break one rule. */
export const appSource = process.env.LOANER_DESK_APP ?? fileURLToPath(new URL('../fixtures/apps/loaner-desk/', import.meta.url));
export const PASSWORD = 'loaner-desk-fixture-password';
const SECRET = 'loaner-desk-kiosk-test-key';

export async function createLoanerDeskFixture() {
  const workspace = await createTestWorkspace();
  try {
    // A copied App resolves `@mistriwork/mistri/app` the way an installed one does.
    await mkdir(workspace.path('node_modules/@mistriwork'), { recursive: true });
    await symlink(
      dirname(createRequire(import.meta.url).resolve('@mistriwork/mistri/package.json')),
      workspace.path('node_modules/@mistriwork/mistri'),
      'dir',
    );
    const app = await workspace.copy(appSource, 'app');
    const database = seed(workspace.path('data/loans.db'));
    // The kiosk's endpoint remembers each delivery while its window is open, in the integrations store.
    await provisionStores({ sqlite: database }, { only: ['integrations'] });
    let host: Awaited<ReturnType<typeof startTestApp>> | undefined;
    const kiosk = await startService(
      createReturnKiosk({ callbackUrl: () => `${host!.url}/api/inbound/kioskReturn`, secret: SECRET }),
      // The App checks each delivery's time against its own clock: the kiosk starts on the same one.
      { now: Date.now(), seed: 7 },
    );
    workspace.own(() => kiosk.close());
    host = await startTestApp({
      workspace,
      directory: app,
      config: `${database}.json`,
      args: ['--jobs', `${app}/jobs.ts`],
      environment: {
        KIOSK_CALLBACK_SECRET: SECRET,
        MISTRI_AUTH_ADMIN_EMAIL: 'admin@example.test',
        MISTRI_AUTH_ADMIN_PASSWORD: PASSWORD,
      },
    });
    const admin = host.client();
    await admin.signIn('admin@example.test', PASSWORD);
    // Accounts are made the way an administrator makes them: through the App's own accounts API.
    const people: Record<string, TestClient> = {};
    for (const role of ['staff', 'viewer'] as const) {
      const email = `${role}@example.test`;
      const made = await admin.request('/api/accounts', {
        method: 'POST',
        json: { app: 'loaner-desk', operation: 'create', name: `Desk ${role}`, email, roles: [role], password: PASSWORD },
      });
      if (made.status !== 200) throw new Error(`Creating the ${role} account answered ${made.status}: ${await made.text()}`);
      people[role] = host.client();
      await people[role].signIn(email, PASSWORD);
    }
    /** Read-only rows straight from the file, for what HTTP does not show (receipts) and for asserting nothing moved. */
    const rows = (sql: string, ...values: Array<string | number>) => {
      const db = new DatabaseSync(database, { readOnly: true });
      try {
        return db
          .prepare(sql)
          .all(...values)
          .map((row) => ({ ...row }));
      } finally {
        db.close();
      }
    };
    return {
      workspace,
      host,
      kiosk,
      database,
      rows,
      admin,
      staff: people.staff,
      viewer: people.viewer,
      anonymous: host.client(),
      close: () => workspace.close(),
    };
  } catch (error) {
    await workspace.close();
    throw error;
  }
}
export type LoanerDeskFixture = Awaited<ReturnType<typeof createLoanerDeskFixture>>;

/** Runs a command the way the App's own form does: prepare reads the revision, execute carries it. */
export async function runCommand(
  client: TestClient,
  command: 'checkoutEquipment' | 'returnEquipment',
  key: { id: string | number },
  input: Record<string, unknown>,
  idempotencyKey: string,
) {
  const prepared = await client.request('/api/commands/prepare', { method: 'POST', json: { command, commandVersion: 1, key } });
  if (prepared.status !== 200) return prepared;
  const { expectedVersion } = (await prepared.json()) as { expectedVersion: number };
  return client.request('/api/commands/execute', {
    method: 'POST',
    json: { command, commandVersion: 1, key, expectedVersion, idempotencyKey, input },
  });
}
