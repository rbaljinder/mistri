import { physicalBindings } from '../../packages/mistri/src/shared/app.js';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TransactionOperations } from '../../packages/engine/src/adapters/adapter.js';
import { migrateSqliteCommandJournal } from '../../packages/mistri/src/adapters/commands/commandJournal.js';
import { provisionSqliteLiveChange } from '../../packages/mistri/src/adapters/live/sqliteLiveChange.js';
import { provisionSqliteRecordHistory } from '../../packages/mistri/src/adapters/history/sqliteRecordHistory.js';
import { provisionSqliteCommandEventStore } from '../../packages/mistri/src/adapters/events/commandEventSchema.js';
import { readSqliteReadCatalog } from '../../packages/engine/src/adapters/scoped/sqliteScopeCatalog.js';
import { createAppAuth } from '../../packages/mistri/src/server/auth/auth.js';
import { appProblems, loadApp } from '../../packages/mistri/src/server/app/apps.js';
import { appResourceCatalog } from '../../packages/mistri/src/server/app/appResources.js';
import { captureTenantOwnership } from '../../packages/mistri/src/server/tenant/tenantOwnership.js';
import { tenantAuthoringSchema } from '../../packages/mistri/src/server/tenant/tenantVisibleFields.js';
import { defineAppTenantPolicy } from '../../packages/mistri/src/server/policy/appTenantPolicy.js';
import { defineCommand, defineCommands } from '../../packages/mistri/src/server/commands/businessCommands.js';
import { refuse } from '../../packages/mistri/src/server/commands/businessCommandExecution.js';
import { createTenantAuthenticatedHttpServer } from '../../packages/mistri/src/server/tenant/tenantAuthenticatedHttp.js';
import { provisionSqliteTenantStore, createSqliteTenantAdministration } from '../../packages/mistri/src/server/tenant/tenantStore.js';
import { tenantProofModel, type TenantProofKind } from './tenantProofModel.js';
import { assignmentResources, assignmentResult, seedTenantAssignment, tenantAssignmentCommands } from './tenantAssignmentFixture.js';
import { tenantAssignmentModel, tenantAssignmentRows } from './tenantAssignmentModel.js';
import {
  failFirstTenantEventInsert,
  tenantAssignmentEventApp,
  tenantAssignmentEventCommands,
  type TenantEventsFixture,
} from './tenantAssignmentEvents.js';
import { inventoryResources, inventoryResult, seedTenantInventory, tenantInventoryCommands } from './tenantInventoryFixture.js';
import { tenantInventoryModel } from './tenantInventoryModel.js';

/** A disposable test owner, not a second tenant engine or a production seeder. */
export async function serveTenantProof({
  directory,
  appId,
  port,
  tenantProof,
  tenantAssignment = false,
  tenantInventory = false,
  tenantEvents = false,
  live = false,
  notes = false,
}: {
  directory: string;
  appId: string;
  port: number;
  tenantProof: TenantProofKind;
  tenantAssignment?: boolean;
  tenantInventory?: boolean;
  tenantEvents?: TenantEventsFixture;
  /** Provision live sync's store and ask for it; 'unasked' provisions the store under an App that does not ask. */
  live?: boolean | 'unasked';
  /** The Thread notes App: two people in one tenant edit a discussion and write notes on it; live sync and record history are provisioned. */
  notes?: boolean;
}) {
  const model = tenantProofModel(tenantProof);
  if (tenantEvents && (!tenantAssignment || tenantInventory)) throw new Error('Events require the assignment-only fixture');
  tenantAssignment ||= tenantInventory;
  if (tenantAssignment && tenantProof !== 'ignition') throw new Error('Assignment requires Ignition');
  if (notes && (tenantProof !== 'thread' || tenantAssignment)) throw new Error('Notes require the plain Thread proof');
  if (notes) live = true;
  if (
    appId !==
    (notes
      ? 'tenant-thread-notes'
      : tenantInventory
        ? tenantInventoryModel.appId
        : tenantAssignment
          ? tenantAssignmentModel.appId
          : `tenant-${tenantProof}`)
  )
    throw new Error('Mismatched proof App');
  const baseTables = [model.unit, model.work, model.target, model.event];
  const tables = [...baseTables, ...(tenantAssignment ? assignmentResources : []), ...(tenantInventory ? inventoryResources : [])];
  const { unitForeignKey: unitFk, workForeignKey: workFk, targetForeignKey: targetFk } = model;
  const database = join(directory, 'business.db'),
    origin = `http://127.0.0.1:${port}`;
  if (existsSync(database) || existsSync(join(directory, 'auth.db'))) throw new Error('Proof requires fresh stores');
  const db = new DatabaseSync(database);
  let auth: Awaited<ReturnType<typeof createAppAuth>> | undefined;
  let host: Awaited<ReturnType<typeof createTenantAuthenticatedHttpServer>> | undefined;
  let bootstrap: Server | undefined;
  let restoreEventFault: (() => void) | undefined;
  const closeBootstrap = async () => {
    if (!bootstrap?.listening) return;
    bootstrap.closeAllConnections();
    await new Promise<void>((resolve, reject) => bootstrap!.close((error) => (error ? reject(error) : resolve())));
  };
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      try {
        await closeBootstrap();
        host?.server.closeAllConnections();
        await host?.retire();
      } finally {
        restoreEventFault?.();
        auth?.close();
        db.close();
        process.disconnect?.();
      }
    })());
  try {
    // Interpolated identifiers are exclusively from the closed model above.
    // Every row key is opaque across tenants; local business IDs deliberately repeat.
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE physical_${model.unit} (id TEXT PRIMARY KEY NOT NULL,
        tenant_id TEXT COLLATE BINARY NOT NULL, business_id TEXT NOT NULL, name TEXT NOT NULL,
        UNIQUE(tenant_id,business_id));
      CREATE TABLE physical_${model.work} (id TEXT PRIMARY KEY NOT NULL DEFAULT(lower(hex(randomblob(16)))),
        tenant_id TEXT COLLATE BINARY NOT NULL, ${unitFk} TEXT NOT NULL REFERENCES physical_${model.unit}(id),
        business_id TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', UNIQUE(tenant_id,business_id));
      CREATE TABLE physical_${model.target} (id TEXT PRIMARY KEY NOT NULL,
        tenant_id TEXT COLLATE BINARY NOT NULL, ${unitFk} TEXT NOT NULL REFERENCES physical_${model.unit}(id),
        ${workFk} TEXT NOT NULL REFERENCES physical_${model.work}(id), business_id TEXT NOT NULL,
        name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', version INTEGER NOT NULL DEFAULT 0,
        UNIQUE(tenant_id,business_id));
      CREATE TABLE physical_${model.event} (id TEXT PRIMARY KEY NOT NULL DEFAULT(lower(hex(randomblob(16)))),
        tenant_id TEXT COLLATE BINARY NOT NULL, ${unitFk} TEXT NOT NULL REFERENCES physical_${model.unit}(id),
        ${targetFk} TEXT NOT NULL REFERENCES physical_${model.target}(id), name TEXT NOT NULL, body TEXT NOT NULL, created_at ${notes ? 'TIMESTAMP' : 'TEXT'} NOT NULL);`);
    for (const [tenant, hidden] of [
      ['northstar', false],
      ['northstar', true],
      ['riverview', false],
    ] as const) {
      const suffix = hidden ? '-other' : '',
        prefix = tenant === 'northstar' ? 'Northstar' : 'Riverview';
      const unit = `${tenant}-${hidden ? 'other' : 'main'}`,
        work = `${tenant}${suffix}-work`,
        target = `${tenant}${suffix}-target`;
      db.prepare(`INSERT INTO physical_${model.unit} VALUES (?,?,?,?)`).run(
        unit,
        tenant,
        hidden ? 'UNIT-002' : 'UNIT-001',
        `${prefix} ${hidden ? 'hidden unit' : 'main unit'}`,
      );
      db.prepare(`INSERT INTO physical_${model.work} VALUES (?,?,?,?,?,?)`).run(
        work,
        tenant,
        unit,
        hidden ? 'WORK-002' : 'WORK-001',
        `${prefix} ${hidden ? 'hidden work' : 'work'}`,
        'open',
      );
      db.prepare(`INSERT INTO physical_${model.target} VALUES (?,?,?,?,?,?,?,?)`).run(
        target,
        tenant,
        unit,
        work,
        hidden ? 'TARGET-002' : 'TARGET-001',
        `${prefix} ${hidden ? 'hidden target' : 'target'}`,
        'open',
        0,
      );
      db.prepare(`INSERT INTO physical_${model.event} VALUES (?,?,?,?,?,?,?)`).run(
        `${tenant}${suffix}-event`,
        tenant,
        unit,
        target,
        'Seed update',
        `${prefix} ${hidden ? 'hidden seed' : 'seed'}`,
        '2026-09-01T10:00:00.000Z',
      );
    }
    if (tenantAssignment) seedTenantAssignment(db);
    if (tenantInventory) seedTenantInventory(db);
    const source = { id: 'business', connection: 'tenant-proof' },
      binding = { appId, source, storeId: 'cross-app-proof' };
    provisionSqliteTenantStore(database, binding);
    migrateSqliteCommandJournal(database);
    if (live) provisionSqliteLiveChange(database);
    if (notes) provisionSqliteRecordHistory(database);
    if (tenantEvents && tenantEvents !== 'missing-store') {
      provisionSqliteCommandEventStore(database, { appId, storeId: binding.storeId, sourceId: source.id });
    }
    const transaction = async (run: (admin: ReturnType<typeof createSqliteTenantAdministration>) => Promise<void>) => {
      const operations = new TransactionOperations();
      db.exec('BEGIN IMMEDIATE');
      try {
        await run(createSqliteTenantAdministration(db, operations, binding));
        await operations.finish();
        db.exec('COMMIT');
      } catch (error) {
        await operations.finish().catch(() => {});
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
    };
    const output = (value: unknown): { targetId: string; eventId: string; version: number; message: string } => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid proof result');
      const data = value as Record<string, unknown>;
      if (
        Object.keys(data).length !== 4 ||
        typeof data.targetId !== 'string' ||
        !data.targetId ||
        typeof data.eventId !== 'string' ||
        !/^[0-9a-f]{32}$/.test(data.eventId) ||
        !Number.isSafeInteger(data.version) ||
        (data.version as number) < 1 ||
        data.message !== 'Update recorded.'
      )
        throw new Error('Invalid proof result');
      return { targetId: data.targetId, eventId: data.eventId, version: data.version as number, message: data.message };
    };
    const proofCommand = defineCommand({
      // The App's reference as the App serves it, its declaration written again: a required body of at most 500 characters.
      target: model.target,
      input: { body: { type: 'textarea', max: 500 } },
      source: source.id,
      read: baseTables,
      write: [model.event],
      when: 'status = open',
      validate: (input) => ({ body: String(input.body) }),
      output: { parse: output },
      async handle({ db, record: target, now }, input) {
        const parentId = target[workFk],
          unitId = target[unitFk];
        if (typeof parentId !== 'string' || typeof unitId !== 'string') refuse('forbidden');
        const work = await db[model.work].find({ id: parentId });
        if (!work || work[unitFk] !== unitId) refuse('forbidden');
        const { version } = await db[model.target].update(target, { status: 'done' });
        const inserted = await db[model.event].insert({
          [unitFk]: unitId,
          [targetFk]: target.id,
          name: 'Update recorded',
          body: input.body,
          created_at: now().toISOString(),
        });
        return output({ targetId: target.id, eventId: inserted.id, version, message: 'Update recorded.' });
      },
    });
    // A note on a discussion, as many as anyone writes: it leaves the discussion as it is.
    const noteCommand = defineCommand({
      target: model.target,
      input: { body: { type: 'textarea', max: 4000 } },
      source: source.id,
      read: baseTables,
      write: [model.event],
      validate: (input) => ({ body: String(input.body) }),
      async handle({ db, record: target, now }, input) {
        const unitId = target[unitFk];
        if (typeof unitId !== 'string') refuse('forbidden');
        await db[model.event].insert({
          [unitFk]: unitId,
          [targetFk]: target.id,
          name: 'Note',
          body: input.body,
          created_at: now().toISOString(),
        });
      },
    });
    // Another person's change to the discussion, as a command: its revision is the commands' alone.
    const renameCommand = defineCommand({
      target: model.target,
      input: { name: { type: 'text', max: 200 }, status: { type: 'text', max: 40, optional: true } },
      source: source.id,
      read: baseTables,
      validate: (input) => ({ name: String(input.name), ...(input.status ? { status: String(input.status) } : {}) }),
      async handle({ db, record: target }, input) {
        await db[model.target].update(target, input.status ? { name: input.name, status: input.status } : { name: input.name });
      },
    });
    const fromDisk = await loadApp(
      resolve(
        `test/fixtures/apps/tenant-${tenantProof}${notes ? '/notes' : tenantInventory ? '/inventory' : tenantAssignment ? '/assignment' : ''}`,
      ),
      {
        commands: defineCommands({
          ...(notes ? { addNote: noteCommand, renameDiscussion: renameCommand } : {}),
          ...(tenantAssignment ? tenantAssignmentCommands({}) : {}),
          ...(tenantInventory ? tenantInventoryCommands({}) : {}),
          [model.command]: proofCommand,
        }),
      },
    );
    const authored = tenantEvents ? tenantAssignmentEventApp(fromDisk) : fromDisk;
    /* A run that provisions live sync's store is one whose App asks for it, unless it says otherwise: live sync is an App's choice. */
    const loaded = {
      ...authored,
      app: {
        ...authored.app,
        ...(live === true ? { live: true as const } : {}),
        auth: { ...authored.app.auth!, store: join(directory, 'auth.db') },
      },
    };
    db.exec('BEGIN');
    try {
      const physical = readSqliteReadCatalog(db).schema;
      const catalog = appResourceCatalog(physical, physicalBindings(loaded.app, 'business'));
      const owned = captureTenantOwnership({
        appId,
        source,
        physicalSchema: physical,
        schema: catalog.schema,
        resources: Object.fromEntries(tables.map((table) => [table, catalog.toPhysical(table)])),
        ownership: Object.fromEntries(tables.map((table) => [table, { kind: 'tenant' as const, column: 'tenant_id' }])),
      });
      const problems = appProblems(loaded, tenantAuthoringSchema(owned));
      if (problems.length) throw new Error(`Invalid proof authoring: ${problems.join('; ')}`);
    } finally {
      db.exec('COMMIT');
    }
    const signup = async (name: string) => {
      const credentials = { name, email: `${name}@example.test`, password: `tenant-proof-${name}-password` };
      const response = await fetch(`${origin}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify(credentials),
        signal: AbortSignal.timeout(10000),
      });
      const data = await response.json();
      if (!response.ok || typeof data.user?.id !== 'string') throw new Error('Proof signup failed');
      return { ...credentials, id: data.user.id as string };
    };
    const signupAccounts = async () => ({
      member: await signup('member'),
      manager: await signup('manager'),
      viewer: await signup('viewer'),
    });
    let accounts: Awaited<ReturnType<typeof signupAccounts>> | undefined;
    if (tenantAssignment) {
      // Provision through native auth before capturing immutable actor bindings.
      // This temporary listener serves no App data and grants no membership.
      auth = await createAppAuth(loaded, { baseURL: origin, trustedOrigins: [origin] });
      const nativeAuth = auth;
      bootstrap = createServer((req, res) => {
        if (!req.url?.startsWith('/api/auth/')) {
          res.writeHead(404);
          res.end();
          return;
        }
        void nativeAuth.handler(req, res).catch(() => {
          res.destroy();
        });
      });
      bootstrap.listen(port, '127.0.0.1');
      await once(bootstrap, 'listening');
      accounts = await signupAccounts();
      await closeBootstrap();
    }
    const staffAccounts = accounts
      ? { [accounts.manager.id]: [tenantAssignmentRows.north.manager, tenantAssignmentRows.south.manager] }
      : undefined;
    const registry = defineCommands({
      ...(staffAccounts ? (tenantEvents ? tenantAssignmentEventCommands(staffAccounts) : tenantAssignmentCommands(staffAccounts)) : {}),
      ...(tenantInventory && staffAccounts ? tenantInventoryCommands(staffAccounts) : {}),
      ...(notes ? { addNote: noteCommand, renameDiscussion: renameCommand } : {}),
      [model.command]: proofCommand,
    });
    // Fixed, version-bound synthetic grants: roles never imply all locations or
    // projects. The IPC edit advances membership version before selecting v2.
    const unitGrants = Object.freeze(
      Object.fromEntries(
        ['northstar', 'riverview'].flatMap((tenant) =>
          ['member', 'manager', 'viewer'].map((role) => [
            `${role}:${tenant}`,
            Object.freeze({
              '1': Object.freeze(role === 'manager' && tenant === 'northstar' ? [`${tenant}-main`, `${tenant}-other`] : [`${tenant}-main`]),
              '2': Object.freeze(tenant === 'northstar' ? [`${tenant}-other`] : []),
            }),
          ]),
        ),
      ),
    );
    const staffGrants = Object.freeze(
      Object.fromEntries(
        ['northstar', 'riverview'].flatMap((tenant) =>
          ['member', 'manager', 'viewer'].map((role) => [
            `${role}:${tenant}`,
            Object.freeze({
              '1': Object.freeze([`${tenant}-main`]),
              '2': Object.freeze(tenant === 'northstar' ? [`${tenant}-other`] : []),
            }),
          ]),
        ),
      ),
    );
    const policy = defineAppTenantPolicy({
      kind: 'tenant',
      appId,
      storeId: binding.storeId,
      ownership: Object.fromEntries(tables.map((table) => [table, { kind: 'tenant' as const, column: 'tenant_id' }])),
      resolveMembershipRows: (principal) => {
        const versions = unitGrants[principal.membershipId];
        const units = versions?.[principal.membershipVersion as '1' | '2'];
        if (!units?.length) return Object.fromEntries(tables.map((table) => [table, false]));
        return Object.fromEntries(
          tables.map((table) => {
            const allowed =
              table === 'review_staff' ? staffGrants[principal.membershipId]?.[principal.membershipVersion as '1' | '2'] : units;
            return [
              table,
              !allowed?.length
                ? false
                : {
                    groups: [
                      [
                        {
                          column: table === model.unit ? 'id' : unitFk,
                          op: 'in',
                          value: [...allowed],
                        },
                      ],
                    ],
                    binary: [table === model.unit ? 'id' : unitFk],
                  },
            ];
          }),
        );
      },
      resolveRows: () =>
        Object.fromEntries(
          tables.map((table) => [table, table === 'review_staff' ? { groups: [[{ column: 'active', op: '=', value: 1 }]] } : true]),
        ),
      authorizeDeletedRecord: () => true,
      resultReferences: {
        // A note and a rename answer with nothing: the page that sent them reads the discussion again.
        ...(notes ? { addNote: () => [], renameDiscussion: () => [] } : {}),
        ...(tenantInventory
          ? Object.fromEntries(
              (['reserve', 'release'] as const).map((mode) => [
                mode === 'reserve' ? 'reserveVehicle' : 'releaseReservation',
                (result: unknown) => {
                  const value = inventoryResult(mode, result);
                  return [
                    { table: 'vehicle', key: { id: value.vehicleId } },
                    { table: 'vehicle_reservation', key: { id: value.reservationId } },
                    { table: 'availability_history', key: { id: value.historyId } },
                    { table: 'lead', key: { id: value.leadId } },
                    { table: 'review_staff', key: { id: value.managerId } },
                  ];
                },
              ]),
            )
          : {}),
        ...(tenantAssignment
          ? {
              assignReviewer: (result: unknown) => {
                const value = assignmentResult(result);
                return [
                  { table: 'loan_application', key: { id: value.applicationId } },
                  { table: 'assignment_history', key: { id: value.assignmentId } },
                  { table: 'review_staff', key: { id: value.reviewerId } },
                  { table: 'review_staff', key: { id: value.managerId } },
                ];
              },
            }
          : {}),
        [model.command]: (result) => {
          const value = output(result);
          return [
            { table: model.target, key: { id: value.targetId } },
            { table: model.event, key: { id: value.eventId } },
          ];
        },
      },
    });
    auth ??= await createAppAuth(loaded, { baseURL: origin, trustedOrigins: [origin] });
    host = await createTenantAuthenticatedHttpServer({
      loaded,
      auth,
      browser: true,
      bound: { host: '127.0.0.1', port },
      enrollment: {
        policy,
        source: { ...source, existingPath: database },
        deployment: 'cross-app-proof-generation',
        roles: ['member', 'manager', 'viewer'],
        maxLifetimeMs: 300000,
        commands: { registry },
      },
    });
    host.server.listen(port, '127.0.0.1');
    await once(host.server, 'listening');
    const { member, manager, viewer } = accounts ?? (await signupAccounts());
    const grants = new Map<
      string,
      {
        tenantId: string;
        accountId: string;
        membershipId: string;
        status: 'active' | 'revoked';
        roles: string[];
        validUntil: number;
        expectedVersion: string;
      }
    >();
    await transaction(async (admin) => {
      for (const tenantId of ['northstar', 'riverview']) {
        await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
        for (const account of [member, manager, viewer]) {
          if (account === viewer && tenantId === 'riverview') continue;
          const grant = {
            tenantId,
            accountId: account.id,
            membershipId: `${account.name}:${tenantId}`,
            status: 'active' as const,
            roles: [account.name],
            validUntil: Date.now() + 3600000,
            expectedVersion: null,
          };
          await admin.putMembership(grant);
          grants.set(`${account.id}:${tenantId}`, { ...grant, expectedVersion: '1' });
        }
      }
    });
    let controls = Promise.resolve();
    process.on(
      'message',
      (input: {
        type: string;
        id: number;
        accountId: string;
        tenantId: string;
        staffId?: string;
        state?: { active?: 0 | 1; role?: 'manager' | 'reviewer' | 'clerk' };
      }) => {
        if (input.type !== 'revoke' && input.type !== 'shift' && input.type !== 'staff-state') return;
        controls = controls.then(async () => {
          try {
            if (input.type === 'staff-state') {
              const state = input.state;
              if (
                !tenantAssignment ||
                typeof input.staffId !== 'string' ||
                !state ||
                !Object.keys(state).length ||
                Object.keys(state).some((key) => key !== 'active' && key !== 'role') ||
                (state.active !== undefined && state.active !== 0 && state.active !== 1) ||
                (state.role !== undefined && !['manager', 'reviewer', 'clerk'].includes(state.role))
              )
                throw new Error('Invalid staff edit');
              await transaction(async () => {
                const changed = db
                  .prepare('UPDATE physical_review_staff SET active=COALESCE(?,active),role=COALESCE(?,role) WHERE id=?')
                  .run(state.active ?? null, state.role ?? null, input.staffId!);
                if (changed.changes !== 1) throw new Error('Unknown staff');
              });
              process.send?.({ type: 'reply', id: input.id });
              return;
            }
            const grant = grants.get(`${input.accountId}:${input.tenantId}`);
            if (!grant || grant.status !== 'active' || (input.type === 'shift' && grant.expectedVersion !== '1'))
              throw new Error('Invalid fixture edit');
            const status = input.type === 'revoke' ? ('revoked' as const) : ('active' as const);
            await transaction((admin) => admin.putMembership({ ...grant, status }));
            grant.status = status;
            grant.expectedVersion = String(Number(grant.expectedVersion) + 1);
            process.send?.({ type: 'reply', id: input.id });
          } catch {
            process.send?.({ type: 'reply', id: input.id, error: 'Tenant proof administration failed' });
          }
        });
      },
    );
    if (tenantEvents === 'insert-failure') restoreEventFault = failFirstTenantEventInsert();
    // Keep the handler registered during async cleanup: signal-exit would
    // otherwise re-raise the signal after a once-handler removes itself.
    process.on('SIGTERM', () => {
      void controls.then(stop).catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    });
    // Reuse the established isolated-process fixture transport; aliases are
    // translated to semantic roles by startTenantProof, not platform code.
    process.send?.({ type: 'ready', value: { origin, accounts: { alice: member, bob: manager, visitor: viewer } } });
  } catch (error) {
    await stop();
    throw error;
  }
}
