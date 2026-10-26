import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TransactionOperations } from '../../packages/engine/src/adapters/adapter.js';
import { migrateSqliteCommandJournal } from '../../packages/mistri/src/adapters/commands/commandJournal.js';
import { createAppAuth } from '../../packages/mistri/src/server/auth/auth.js';
import { defineCommand, defineCommands } from '../../packages/mistri/src/server/commands/businessCommands.js';
import { defineChallenges } from '../../packages/mistri/src/server/commands/challenges.js';
import { shape, text } from '../../packages/mistri/src/server/commands/commandShapes.js';
import { turnstile, turnstileStub } from '../../packs/challenge-turnstile/src/index.js';
import { defineAppTenantPolicy } from '../../packages/mistri/src/server/policy/appTenantPolicy.js';
import { createTenantAuthenticatedHttpServer } from '../../packages/mistri/src/server/tenant/tenantAuthenticatedHttp.js';
import { createSqliteTenantAdministration, provisionSqliteTenantStore } from '../../packages/mistri/src/server/tenant/tenantStore.js';
import type { TenantAccount } from './tenantServer.js';
import { INTAKE_ADDRESSES } from './tenantIntakeAddresses.js';
import { parseTestApp } from '../../test/support/commandCatalog.js';

/**
 * Public intake's browser fixture, run in tenantServer.ts's child process like
 * the other tenant proofs: a lender (the platform realm) above two dealers,
 * over genuine native auth, with one public form. Each dealer's profile row
 * holds its intake address; the form lands in the dealer whose address its
 * link carries, and anything else with the lender's triage. Alice is north's
 * staff, Bob the lender's manager; nobody needs an account to apply.
 */
export async function serveIntakeFixture({
  directory,
  appId,
  port,
  intake,
}: {
  directory: string;
  appId: string;
  port: number;
  intake?: true | { challenge?: true; choices?: true };
}) {
  const guarded = typeof intake === 'object' && intake.challenge === true;
  /* Each dealer's own makes, opened to visitors (`auth.public`): the quote form offers the rows of the dealer its
     link places it with (tenantPublicChoices.ts). */
  const choices = typeof intake === 'object' && intake.choices === true;
  const database = join(directory, 'business.db'),
    origin = `http://127.0.0.1:${port}`;
  const source = { id: 'business', connection: 'tenant-intake-business' };
  const binding = { appId, source, storeId: 'tenant-intake-store' };
  const writer = new DatabaseSync(database);
  let auth: Awaited<ReturnType<typeof createAppAuth>> | undefined;
  let owner: Awaited<ReturnType<typeof createTenantAuthenticatedHttpServer>> | undefined;
  let stub: Awaited<ReturnType<typeof turnstileStub>> | undefined;
  let retiring: Promise<void> | undefined;
  const stop = () =>
    (retiring ??= (async () => {
      try {
        owner?.server.closeAllConnections();
        await owner?.retire();
      } finally {
        auth?.close();
        await stub?.close();
        writer.close();
        process.disconnect?.();
      }
    })());
  try {
    writer.exec(`PRAGMA foreign_keys = ON;
      CREATE TABLE dealer (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, intake_address TEXT);
      CREATE TABLE lead (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES dealer(id), reference TEXT NOT NULL,
        name TEXT NOT NULL);
      CREATE TABLE intake_submission (id TEXT PRIMARY KEY NOT NULL, reference TEXT NOT NULL, name TEXT NOT NULL);
      INSERT INTO dealer VALUES ('north', 'North Motors', '${INTAKE_ADDRESSES.north}'), ('south', 'South Auto', '${INTAKE_ADDRESSES.south}');`);
    if (choices)
      writer.exec(`ALTER TABLE dealer ADD COLUMN public_address TEXT;
        UPDATE dealer SET public_address = id || '-public-AAAAAAAAAAAAAAAA';
        ALTER TABLE lead ADD COLUMN make_id TEXT;
        CREATE TABLE make (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES dealer(id), name TEXT NOT NULL);
        INSERT INTO make VALUES ('n-ford', 'north', 'Ford'), ('n-kia', 'north', 'Kia'), ('s-fiat', 'south', 'Fiat');`);
    provisionSqliteTenantStore(database, binding);
    // Explicit fresh-fixture provisioning, never enrollment-time migration.
    migrateSqliteCommandJournal(database);
    const input = { name: { label: 'Full name', type: 'text', max: 80 } } as const;
    const quoteInput = { ...input, make: { label: 'Make', type: 'choice', from: 'make', labelColumn: 'name' } } as const;
    const loaded = {
      path: join(directory, 'app.ts'),
      pages: [],
      sources: {},
      app: parseTestApp(
        {
          id: appId,
          name: 'Lender desk',
          auth: {
            store: join(directory, 'auth.db'),
            signUp: 'open',
            rows: 'tenant',
            tenancy: { label: 'Dealer', profile: 'dealer', platform: { label: 'Lender' } },
            roles: { staff: { realm: 'tenant', read: true }, manager: { realm: 'platform', read: true } },
            ...(guarded ? { challenge: 'verifyHuman' } : {}),
            ...(choices ? { public: { read: ['make'] } } : {}),
          },
          sources: { business: { connection: source.connection } },
          resources: {
            dealer: { owner: 'platform' },
            lead: { access: 'write', owner: 'tenant' },
            intake_submission: { access: 'write', owner: 'platform' },
            ...(choices ? { make: { owner: 'tenant' } } : {}),
          },
          views: {
            leads: { kind: 'list', from: 'lead', label: 'Leads', show: ['reference', 'name'] },
            triage: { kind: 'list', from: 'intake_submission', label: 'Triage', show: ['reference', 'name'] },
            apply: {
              kind: 'form',
              label: 'Apply for financing',
              public: true,
              command: { id: 'apply', version: 1, input },
              done: { title: 'Application received', description: 'Keep this reference.' },
            },
            ...(choices
              ? {
                  quote: {
                    kind: 'form',
                    label: 'Ask for a quote',
                    public: true,
                    command: { id: 'quote', version: 1, input: quoteInput },
                    done: { title: 'Quote requested', description: 'Keep this reference.' },
                  },
                }
              : {}),
          },
          home: [{ view: 'apply', signedOut: true }, { view: 'leads' }],
          nav: [
            { id: 'desk', label: 'Desk', realm: 'tenant', children: ['leads'] },
            { id: 'underwriting', label: 'Underwriting', realm: 'platform', children: ['triage'] },
          ],
          ui: { shell: { placement: 'top' } },
        },
        'disposable public intake fixture',
      ),
      /* The App's human check, at Turnstile's local stand-in: its widget hands the form a person's token issued on
         the page's host, good once. One check for the App, whichever dealer's link the visitor came by. */
      ...(guarded
        ? {
            challenges: defineChallenges({
              verifyHuman: turnstile({
                siteKey: 'intake-site-key',
                secret: 'stub-secret',
                verifyUrl: (stub = await turnstileStub({ people: ['person', 'spec-person'], hostname: '127.0.0.1' })).verifyUrl,
                scriptUrl: stub.scriptUrl,
              }),
            }),
          }
        : {}),
    };
    const registry = defineCommands({
      apply: defineCommand({
        targets: 'none',
        source: source.id,
        target: 'lead',
        write: ['intake_submission'],
        public: true,
        input,
        // A public form answers its receipt and nothing else (forms/savedFormChecks.ts), so the shape says so.
        output: shape({ reference: text() }),
        async handle({ db, intake }, value) {
          // One reference shape wherever it lands: the answer says nothing about where.
          const reference = `IGN-${String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')}`;
          if (intake === 'tenant') await db.lead.insert({ id: randomUUID(), reference, name: value.name });
          else await db.intake_submission.insert({ id: randomUUID(), reference, name: value.name });
          return { reference };
        },
      }),
      ...(choices
        ? {
            quote: defineCommand({
              targets: 'none',
              source: source.id,
              target: 'lead',
              write: ['intake_submission'],
              read: ['make'],
              public: true,
              input: quoteInput,
              output: shape({ reference: text() }),
              async handle({ db, intake }, value) {
                const reference = `IGN-${String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')}`;
                if (intake === 'tenant')
                  await db.lead.insert({ id: randomUUID(), reference, name: value.name, make_id: String(value.make) });
                else await db.intake_submission.insert({ id: randomUUID(), reference, name: value.name });
                return { reference };
              },
            }),
          }
        : {}),
    });
    auth = await createAppAuth(loaded, { baseURL: origin, trustedOrigins: [origin] });
    const everything = { dealer: true, lead: true, intake_submission: true, ...(choices ? { make: true } : {}) };
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
            dealer: { kind: 'platform' },
            lead: { kind: 'tenant', column: 'tenant_id' },
            intake_submission: { kind: 'platform' },
            ...(choices ? { make: { kind: 'tenant' as const, column: 'tenant_id' } } : {}),
          },
          resolveMembershipRows: () => ({ lead: true, ...(choices ? { make: true } : {}) }),
          resolveRows: () => ({ lead: true, ...(choices ? { make: true } : {}) }),
          resolvePlatformRows: () => everything,
          resultReferences: { apply: () => [], ...(choices ? { quote: () => [] } : {}) },
          intake: { address: 'intake_address' },
          ...(choices ? { public: { address: 'public_address' }, resolvePublicRows: () => ({ make: true }) } : {}),
        }),
        source: { ...source, existingPath: database },
        deployment: 'intake-generation',
        roles: ['staff', 'manager'],
        maxLifetimeMs: 300000,
        commands: { registry },
      },
    });
    owner.server.listen(port, '127.0.0.1');
    await once(owner.server, 'listening');
    const signup = async (name: string): Promise<TenantAccount> => {
      const credentials = { name, email: `${name}@example.test`, password: `tenant-intake-${name}-password` };
      const response = await fetch(`${origin}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify(credentials),
        signal: AbortSignal.timeout(10000),
      });
      const body = await response.json();
      if (!response.ok || typeof body.user?.id !== 'string') throw new Error('Intake fixture native signup failed');
      return { ...credentials, id: body.user.id };
    };
    const accounts = { alice: await signup('alice'), bob: await signup('bob'), visitor: await signup('visitor') };
    const operations = new TransactionOperations();
    writer.exec('BEGIN IMMEDIATE');
    try {
      const admin = createSqliteTenantAdministration(writer, operations, binding);
      const grant = { status: 'active' as const, validUntil: Date.now() + 3600000, expectedVersion: null };
      for (const tenantId of ['north', 'south']) await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
      await admin.putMembership({
        ...grant,
        tenantId: 'north',
        accountId: accounts.alice.id,
        membershipId: 'alice-north',
        roles: ['staff'],
      });
      await admin.putPlatform({ status: 'active', expectedVersion: null });
      await admin.putPlatformMembership({ ...grant, accountId: accounts.bob.id, membershipId: 'bob-platform', roles: ['manager'] });
      await operations.finish();
      writer.exec('COMMIT');
    } catch (error) {
      await operations.finish().catch(() => {});
      writer.exec('ROLLBACK');
      throw error;
    }
    // Keep the handler registered during async cleanup: signal-exit would
    // otherwise re-raise the signal after a once-handler removes itself.
    process.on('SIGTERM', () => {
      void stop().catch((error) => {
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
