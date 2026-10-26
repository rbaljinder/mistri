/** Real native token authority composed with the ordinary mapped command writer. */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createAppAuth } from '../packages/mistri/src/server/auth/auth.js';
import { provisionSqliteApiTokenStore } from '../packages/mistri/src/server/auth/provisionSqliteApiTokenStore.js';
import { issueSqliteApiCommandToken, revokeSqliteApiToken } from '../packages/mistri/src/server/auth/sqliteApiTokenMaintenance.js';
import { captureAuthStoreExclusion } from '../packages/mistri/src/server/auth/authStoreSeparation.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { defineEvent, defineEventProjection } from '../packages/mistri/src/server/commands/businessEvents.js';
import { issueAppScopeCommandEvents } from '../packages/mistri/src/server/commands/businessCommandAccess.js';
import { provisionSqliteCommandEventStore, COMMAND_EVENT_TABLES } from '../packages/mistri/src/adapters/events/commandEventSchema.js';
import { shape, bool } from '../packages/mistri/src/server/commands/commandShapes.js';
import { migrateSqliteCommandJournal, COMMAND_JOURNAL_TABLES } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { createSqliteApiCommandOwner } from '../packages/mistri/src/server/api/sqliteApiCommandOwner.js';
import { refuse } from '../packages/mistri/src/server/commands/commandErrors.js';
import { ApiCommandUnauthenticated } from '../packages/mistri/src/server/api/sqliteApiCommandOwner.js';
import { parseApiCommandRoute } from '../packages/mistri/src/server/api/apiCommandRoute.js';
import { createSqliteApiCommandHttp } from '../packages/mistri/src/server/api/sqliteApiCommandHttp.js';
import { createSqliteApiReadOwner } from '../packages/mistri/src/server/api/sqliteApiReadOwner.js';
import { createAppMcpSession, sqliteAppMcpCommands, sqliteAppMcpReads } from '../packages/mistri/src/server/api/appMcpSession.js';
import { PassThrough } from 'node:stream';
import { parseTestApi, parseTestApp } from './support/commandCatalog.js';
import { createCommandFlags } from '../packages/mistri/src/server/commands/commandFlags.js';
import { normalizeFlagCatalog } from '../packages/mistri/src/shared/appFlags.js';

const storeId = 'c93c917b-e793-43a8-ab75-5c478b1d01f6';
const request = {
  command: 'change',
  commandVersion: 1,
  key: { id: 1 },
  expectedVersion: 0,
  input: {},
  idempotencyKey: 'owner-attempt-0000001',
};
const recovery = { command: request.command, commandVersion: 1, idempotencyKey: request.idempotencyKey };
async function fixture(
  t: TestContext,
  withEvents = false,
  wire?: 'internal' | 'api-v1',
  many = false,
  versionless = false,
  flags?: { enabled: boolean; captures: number; configured: boolean },
) {
  const directory = mkdtempSync(join(tmpdir(), 'tw-command-owner-'));
  const authPath = join(directory, 'auth.db'),
    businessPath = join(directory, 'business.db');
  const db = new DatabaseSync(businessPath);
  /* A target's non-null integer `version` column is its revision; a table that holds the number under another name has none declared,
     so its revision is a digest of the row. */
  const column = versionless ? 'revision' : 'version';
  db.exec(
    `CREATE TABLE physical_item(id INTEGER PRIMARY KEY,${column} INTEGER NOT NULL); INSERT INTO physical_item VALUES(1,0)${many ? ',(2,0)' : ''}`,
  );
  migrateSqliteCommandJournal(businessPath);
  const eventSource = { appId: 'owner', sourceId: 'business', storeId: 'app:owner' };
  if (withEvents) provisionSqliteCommandEventStore(businessPath, eventSource);
  const registry = new Registry();
  registry.add({ id: 'business', name: 'Business', url: businessPath, writable: true, source: 'config' });
  const app = parseTestApp(
    {
      id: 'owner',
      name: 'Owner',
      sources: { business: { connection: 'business', default: true } },
      resources: { item: { physical: 'physical_item', access: 'write' } },
      views: { items: { kind: 'list', from: 'item' } },
      home: 'items',
      auth: { store: authPath, roles: { operator: { read: true, commands: many ? ['change', 'batch'] : ['change'] } } },
    },
    'fixture',
  );
  app.api = parseTestApi(
    {
      version: 1,
      roles: ['operator'],
      resources: { item: { fields: ['id', column] } },
      commands: [
        { id: 'change', version: 1, target: 'item', input: {} },
        ...(many ? [{ id: 'batch', version: 1, target: 'item', input: {}, targets: 'many' as const }] : []),
      ],
    },
    ['operator'],
  )!;
  const control = { calls: 0, doors: [] as string[], afterWrite: async () => {}, refusal: undefined as (() => never) | undefined };
  const changed = defineEvent('item.changed', shape({ ok: bool() }));
  const commands = defineCommands({
    change: defineCommand({
      source: 'business',
      target: 'item',
      ...(flags ? { enabledBy: { flag: 'launch', is: true } } : {}),
      ...(withEvents ? { events: { changed: defineEventProjection(changed, (output: { ok: boolean }) => output) } } : {}),
      input: {},
      output: shape({ ok: bool() }),
      async handle(context) {
        control.calls++;
        control.doors.push(context.door);
        // Before the write, so a refusal leaves the record untouched.
        if (control.refusal) control.refusal();
        await context.tx.update({ table: 'item', key: { id: 1 }, values: { [column]: Number(context.record[column]) + 1 } });
        await control.afterWrite();
        return { ok: true };
      },
    }),
    // Opt-in: one handler over several ordered target records.
    ...(many
      ? {
          batch: defineCommand({
            source: 'business',
            target: 'item',
            targets: 'many',
            input: {},
            output: shape({ ok: bool() }),
            async handle(context) {
              for (const record of context.records ?? []) {
                await context.tx.update({
                  table: 'item',
                  key: { id: Number(record.id) },
                  values: { [column]: Number(record[column]) + 1 },
                });
              }
              return { ok: true };
            },
          }),
        }
      : {}),
  });
  const loaded = { app, path: join(directory, 'app.ts'), dir: directory, pages: [], sources: {} };
  const names = ['BETTER_AUTH_SECRET', 'MISTRI_AUTH_ADMIN_EMAIL', 'MISTRI_AUTH_ADMIN_PASSWORD'] as const;
  const prior = names.map((name) => [name, process.env[name]] as const);
  process.env.BETTER_AUTH_SECRET = 'synthetic-owner-secret-at-least-thirty-two-characters';
  delete process.env.MISTRI_AUTH_ADMIN_EMAIL;
  delete process.env.MISTRI_AUTH_ADMIN_PASSWORD;
  let auth;
  try {
    auth = await createAppAuth(loaded, { baseURL: 'http://127.0.0.1:1', trustedOrigins: ['http://127.0.0.1:1'] });
  } finally {
    for (const [name, value] of prior) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  const authDb = new DatabaseSync(authPath);
  let owner: Awaited<ReturnType<typeof createSqliteApiCommandOwner>> | undefined;
  t.after(async () => {
    await owner?.retire();
    auth.close();
    await registry.closeAll();
    db.close();
    authDb.close();
    rmSync(directory, { recursive: true, force: true });
  });
  for (const id of ['account', 'other'])
    authDb
      .prepare('INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt,role,banned) VALUES(?,?,?,1,?,?,?,0)')
      .run(id, id, `${id}@example.test`, '2026-01-01', '2026-01-01', 'operator');
  const exclusions = [captureAuthStoreExclusion(businessPath)];
  provisionSqliteApiTokenStore(authPath, { appId: app.id, storeId, exclusions });
  const resources = await loadAppRuntimeResources(registry, { ...app, api: { ...app.api, commands: [] } }, 'business');
  const evidence = { connectionFor: resources.connectionFor, writableConnection: () => true, transactionalConnection: () => true };
  const issue = (operations?: readonly string[], subjectId = 'account') =>
    issueSqliteApiCommandToken(
      authPath,
      app,
      resources.schema,
      commands,
      evidence,
      {
        storeId,
        exclusions,
        subjectId,
        actorId: 'account',
        roles: ['operator'],
        label: 'fixture',
        expiresAt: Date.now() + 60000,
        ...(operations ? { operations } : {}),
      },
      Date.now(),
    );
  const token = issue(),
    hosting = { appId: app.id, registry: commands, ...(withEvents ? { events: issueAppScopeCommandEvents(eventSource) } : {}) },
    host = { app: loaded, auth, pages: [] };
  owner = await createSqliteApiCommandOwner(registry, host, hosting, {
    ...(wire === 'api-v1' ? { wire, integers: 'decimal-string' as const } : wire ? { wire } : {}),
    ...(flags?.configured
      ? {
          captureFlags: (actor) => {
            flags.captures++;
            assert.equal(actor.id, 'account');
            assert.deepEqual(actor.roles, ['operator']);
            return createCommandFlags(
              normalizeFlagCatalog({ flags: { launch: { type: 'boolean', default: false, owner: 'team' } }, roles: [], audiences: {} }),
              { evaluate: () => ({ value: flags.enabled, reason: 'default', revision: 1, diagnostics: [] }) },
            );
          },
        }
      : {}),
  });
  return {
    owner,
    host,
    hosting,
    registry,
    token,
    issue,
    control,
    db,
    authDb,
    schema: resources.schema,
    evidence,
    revision: () => db.prepare(`SELECT ${column} AS revision FROM physical_item`).get()?.revision,
    receipts: () => db.prepare(`SELECT count(*) AS n FROM "${COMMAND_JOURNAL_TABLES.receipt}"`).get()!.n,
    revoke: () =>
      revokeSqliteApiToken(
        authPath,
        { appId: app.id, storeId, exclusions, tokenId: token.tokenId, expectedVersion: '1', actorId: 'account' },
        Date.now(),
      ),
  };
}

test('mapped native execution and recovery use account identity across rotation, never token identity', async (t) => {
  const f = await fixture(t);
  const denied = f.owner.consumeResult(await f.owner.execute(f.issue([]).token, request));
  assert.equal(denied.status, 403);
  assert.deepEqual(JSON.parse(denied.body), {
    type: 'urn:mistri:problem:forbidden',
    title: 'This command is not available to this account.',
    status: 403,
    code: 'forbidden',
    outcome: 'not_applied',
  });
  assert.equal(f.control.calls, 0);
  const handle = await f.owner.execute(f.token.token, request);
  assert.throws(() => f.owner.consumeResult({ ...handle }));
  const applied = JSON.parse(f.owner.consumeResult(handle).body);
  assert.equal(applied.status, 'applied');
  assert.equal(f.revision(), 1);
  assert.equal(f.receipts(), 1);
  assert.throws(() => f.owner.consumeResult(handle));
  const rotated = f.issue();
  f.revoke();
  f.db.exec('DELETE FROM physical_item');
  const recovered = JSON.parse(f.owner.consumeResult(await f.owner.recover(rotated.token, recovery)).body);
  assert.equal(recovered.receiptId, applied.receiptId);
  assert.equal(recovered.recovered, true);
  assert.equal(f.control.calls, 1);
  const absent = JSON.parse(f.owner.consumeResult(await f.owner.recover(f.issue(undefined, 'other').token, recovery)).body);
  assert.deepEqual(absent, { outcome: 'unknown', status: 'not_found' });
  const mismatch = f.owner.consumeResult(await f.owner.recover(rotated.token, { ...recovery, commandVersion: 2 }));
  assert.equal(mismatch.status, 410);
  assert.deepEqual(
    { ...JSON.parse(mismatch.body), title: undefined },
    {
      type: 'urn:mistri:problem:command_version_mismatch',
      title: undefined,
      status: 410,
      code: 'command_version_mismatch',
      outcome: 'unknown',
    },
  );
});

test("a handler is told its door: the App API's, or App MCP's when the MCP session says so", async (t) => {
  const f = await fixture(t);
  assert.equal(JSON.parse(f.owner.consumeResult(await f.owner.execute(f.token.token, request)).body).status, 'applied');
  const again = { ...request, expectedVersion: 1, idempotencyKey: 'owner-attempt-0000002' };
  assert.equal(JSON.parse(f.owner.consumeResult(await f.owner.execute(f.token.token, again, undefined, 'mcp')).body).status, 'applied');
  assert.deepEqual(f.control.doors, ['api', 'mcp']);
});

test('native API flags capture follows token authority once per request, fails closed and leaves recovery available', async (t) => {
  const flags = { enabled: false, captures: 0, configured: true };
  const f = await fixture(t, false, undefined, false, false, flags);
  assert.equal(f.owner.consumeResult(await f.owner.execute(f.issue([]).token, request)).status, 403);
  assert.equal(flags.captures, 0);
  assert.equal(f.owner.consumeResult(await f.owner.execute(f.token.token, request)).status, 403);
  assert.equal(
    f.owner.consumeResult(await f.owner.prepare(f.token.token, { command: 'change', commandVersion: 1, key: { id: 1 } })).status,
    403,
  );
  assert.equal(flags.captures, 2);
  assert.equal(f.control.calls, 0);
  flags.enabled = true;
  assert.equal(
    f.owner.consumeResult(await f.owner.prepare(f.token.token, { command: 'change', commandVersion: 1, key: { id: 1 } })).status,
    200,
  );
  const applied = JSON.parse(f.owner.consumeResult(await f.owner.execute(f.token.token, request)).body);
  flags.enabled = false;
  assert.equal(JSON.parse(f.owner.consumeResult(await f.owner.execute(f.token.token, request)).body).receiptId, applied.receiptId);
  const before = flags.captures;
  assert.equal(JSON.parse(f.owner.consumeResult(await f.owner.recover(f.token.token, recovery)).body).receiptId, applied.receiptId);
  assert.equal(flags.captures, before, 'receipt recovery requires no flag provider');
  f.revoke();
  await assert.rejects(f.owner.execute(f.token.token, request), ApiCommandUnauthenticated);
  assert.equal(flags.captures, before);
  assert.equal(f.control.calls, 1);
  const missing = await fixture(t, false, undefined, false, false, { ...flags, configured: false });
  assert.equal(missing.owner.consumeResult(await missing.owner.execute(missing.token.token, request)).status, 403);
  assert.equal(missing.control.calls, 0);
});

test('fresh final revocation rolls back writes while postcommit refusal never claims rollback', async (t) => {
  const f = await fixture(t);
  f.control.afterWrite = async () => {
    f.revoke();
  };
  await assert.rejects(f.owner.execute(f.token.token, request), { outcome: 'unknown' });
  assert.equal(f.revision(), 0);
  assert.equal(f.receipts(), 0);
  f.control.afterWrite = async () => {};
  const token = f.issue(),
    handle = await f.owner.execute(token.token, request);
  f.authDb.exec("UPDATE user SET banned=1 WHERE id='account'");
  assert.throws(() => f.owner.consumeResult(handle), { outcome: 'unknown' });
  assert.equal(f.revision(), 1);
  assert.equal(f.receipts(), 1);
});

test('cancel and retire drain an active writer; sibling cancellation is not owner retirement', async (t) => {
  const f = await fixture(t),
    controller = new AbortController();
  controller.abort();
  await assert.rejects(f.owner.execute(f.token.token, request, controller.signal));
  assert.equal(f.control.calls, 0);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  f.control.afterWrite = async () => {
    entered();
    await gate;
  };
  const work = f.owner.execute(f.token.token, request);
  const rejected = assert.rejects(work);
  await started;
  let done = false;
  const retired = f.owner.retire().then(() => {
    done = true;
  });
  await Promise.resolve();
  assert.equal(done, false);
  release();
  await rejected;
  await retired;
  assert.equal(f.revision(), 0);
  assert.equal(f.receipts(), 0);
});

test('deployment mutation invalidates buffered result without undoing committed business state', async (t) => {
  const f = await fixture(t),
    handle = await f.owner.execute(f.token.token, request);
  f.hosting.appId = 'replaced';
  assert.throws(() => f.owner.consumeResult(handle));
  assert.equal(f.revision(), 1);
});

test('active cancellation drains the writer lease and leaves the owner available to siblings', async (t) => {
  const f = await fixture(t),
    controller = new AbortController();
  let leases = 0;
  const lease = f.registry.lease.bind(f.registry);
  t.mock.method(f.registry, 'lease', (...args: Parameters<typeof lease>) => {
    leases++;
    const release = lease(...args);
    return () => {
      leases--;
      release();
    };
  });
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  f.control.afterWrite = async () => {
    entered();
    await gate;
  };
  let settled = false;
  const work = f.owner.execute(f.token.token, request, controller.signal);
  const rejected = assert.rejects(work).then(() => {
    settled = true;
  });
  await started;
  controller.abort();
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(leases, 1);
  release();
  await rejected;
  assert.equal(leases, 0);
  assert.equal(f.revision(), 0);
  assert.equal(f.receipts(), 0);
  f.control.afterWrite = async () => {};
  const result = JSON.parse(f.owner.consumeResult(await f.owner.execute(f.token.token, request)).body);
  assert.equal(result.status, 'applied');
  assert.equal(f.revision(), 1);
});

for (const change of ['demotion', 'expiry'] as const)
  test(`final native ${change} refuses and rolls back the pending command`, async (t) => {
    const f = await fixture(t);
    const now = Date.now();
    f.control.afterWrite = async () => {
      if (change === 'demotion') f.authDb.exec("UPDATE user SET role='removed' WHERE id='account'");
      else t.mock.method(Date, 'now', () => now + 120000);
    };
    await assert.rejects(f.owner.execute(f.token.token, request));
    assert.equal(f.revision(), 0);
    assert.equal(f.receipts(), 0);
  });

for (const change of ['refresh', 'ddl', 'expiry'] as const)
  test(`${change} invalidates command handoff without misreporting the committed outcome`, async (t) => {
    const f = await fixture(t),
      handle = await f.owner.execute(f.token.token, request);
    if (change === 'refresh') await f.registry.refresh('business');
    else if (change === 'ddl') f.db.exec('ALTER TABLE physical_item ADD COLUMN private_note TEXT');
    else {
      const now = Date.now();
      t.mock.method(Date, 'now', () => now + 120000);
    }
    assert.throws(() => f.owner.consumeResult(handle), { outcome: 'unknown' });
    assert.equal(f.revision(), 1);
    assert.equal(f.receipts(), 1);
  });

test('owner preserves genuine event scope and final refusal rolls back record, receipt and events together', async (t) => {
  const f = await fixture(t, true);
  f.control.afterWrite = async () => {
    f.revoke();
  };
  await assert.rejects(f.owner.execute(f.token.token, request));
  assert.equal(f.revision(), 0);
  assert.equal(f.receipts(), 0);
  assert.equal(f.db.prepare(`SELECT count(*) AS n FROM "${COMMAND_EVENT_TABLES.event}"`).get()!.n, 0);
  assert.equal(f.db.prepare(`SELECT count(*) AS n FROM "${COMMAND_JOURNAL_TABLES.receipt}" WHERE manifest_json IS NOT NULL`).get()!.n, 0);
  f.control.afterWrite = async () => {};
  const rotated = f.issue();
  const applied = JSON.parse(f.owner.consumeResult(await f.owner.execute(rotated.token, request)).body);
  assert.equal(applied.status, 'applied');
  assert.equal(f.db.prepare(`SELECT count(*) AS n FROM "${COMMAND_EVENT_TABLES.event}"`).get()!.n, 1);
  assert.equal(f.db.prepare(`SELECT count(*) AS n FROM "${COMMAND_JOURNAL_TABLES.receipt}" WHERE manifest_json IS NOT NULL`).get()!.n, 1);
  const recovered = JSON.parse(f.owner.consumeResult(await f.owner.recover(rotated.token, recovery)).body);
  assert.equal(recovered.receiptId, applied.receiptId);
  assert.equal(f.control.calls, 2);
});

const problemOf = (answer: { status: number; body: string }) => ({ status: answer.status, ...JSON.parse(answer.body) });

test('handler refusals keep their fixed code and field, and a one-target request is never told a key', async (t) => {
  const f = await fixture(t);
  f.control.refusal = () => refuse('ineligible_state', { field: 'reason', key: { id: 99 } });
  const foreign = problemOf(f.owner.consumeResult(await f.owner.execute(f.token.token, request)));
  // Refused inside the verified transaction and rolled back cleanly: nothing
  // committed, so the caller hears not_applied (revision/receipts checked below).
  assert.deepEqual(foreign, {
    status: 409,
    type: 'urn:mistri:problem:ineligible_state',
    title: 'This record is not eligible for this command.',
    code: 'ineligible_state',
    outcome: 'not_applied',
    field: 'reason',
  });
  // A refusal names a key only when the request listed several (design,
  // executor refusedKey): even the request's own single target is not echoed.
  f.control.refusal = () => refuse('ineligible_state', { key: { id: 1 } });
  const ownKey = problemOf(
    f.owner.consumeResult(await f.owner.execute(f.token.token, { ...request, idempotencyKey: 'owner-attempt-0000002' })),
  );
  assert.equal(ownKey.key, undefined);
  assert.equal(ownKey.code, 'ineligible_state');
  assert.equal(f.revision(), 0);
  assert.equal(f.receipts(), 0);
  assert.equal(f.control.calls, 2);
  // A handler's own sentence is for the App's reader; a bearer caller hears
  // the fixed problem, which carries no detail (api-command-openapi pins it).
  f.control.refusal = () => refuse('Only 0 h left on this balance.');
  const said = problemOf(
    f.owner.consumeResult(await f.owner.execute(f.token.token, { ...request, idempotencyKey: 'owner-attempt-0000003' })),
  );
  assert.deepEqual(said, {
    status: 409,
    type: 'urn:mistri:problem:ineligible_state',
    title: 'This record is not eligible for this command.',
    code: 'ineligible_state',
    outcome: 'not_applied',
  });
  assert.equal(f.revision(), 0);
  assert.equal(f.receipts(), 0);
});

test('input, revision, idempotency and exposure refusals map to the design statuses', async (t) => {
  const f = await fixture(t);
  const invalid = problemOf(f.owner.consumeResult(await f.owner.execute(f.token.token, { ...request, input: { extra: 1 } })));
  assert.equal(invalid.status, 422);
  assert.equal(invalid.code, 'invalid_input');
  assert.equal(invalid.outcome, 'not_applied');
  const stale = problemOf(
    f.owner.consumeResult(
      await f.owner.execute(f.token.token, { ...request, expectedVersion: 5, idempotencyKey: 'owner-attempt-0000003' }),
    ),
  );
  assert.equal(stale.status, 409);
  assert.equal(stale.code, 'stale_record');
  assert.equal(f.control.calls, 0);
  f.owner.consumeResult(await f.owner.execute(f.token.token, request));
  const conflict = problemOf(f.owner.consumeResult(await f.owner.execute(f.token.token, { ...request, expectedVersion: 1 })));
  assert.equal(conflict.status, 409);
  assert.equal(conflict.code, 'idempotency_conflict');
  const unexposed = problemOf(f.owner.consumeResult(await f.owner.execute(f.token.token, { ...request, command: 'missing' })));
  assert.equal(unexposed.status, 404);
  assert.equal(unexposed.code, 'not_found');
  assert.equal(f.revision(), 1);
  assert.equal(f.receipts(), 1);
  assert.equal(f.control.calls, 1);
});

test('a refusal is re-authorized at consume: revocation yields unknown, never the stale business answer', async (t) => {
  const f = await fixture(t);
  f.control.refusal = () => refuse('ineligible_state');
  const handle = await f.owner.execute(f.token.token, request);
  f.revoke();
  assert.throws(() => f.owner.consumeResult(handle), { outcome: 'unknown' });
  assert.throws(() => f.owner.consumeResult(handle));
});

test('a forged branded refusal cannot pick an unlisted code or a title of its own', async (t) => {
  const f = await fixture(t),
    brand = Symbol.for('mistri.businessCommandExecutionError');
  const forged = (code: string) => Object.assign(new Error('Leaked handler detail: Mara'), { [brand]: true, code, outcome: 'not_applied' });
  f.control.refusal = () => {
    throw forged('stale_account');
  };
  await assert.rejects(f.owner.execute(f.token.token, request), { outcome: 'unknown' });
  f.control.refusal = () => {
    throw forged('forbidden');
  };
  const spoofed = problemOf(
    f.owner.consumeResult(await f.owner.execute(f.token.token, { ...request, idempotencyKey: 'owner-attempt-0000004' })),
  );
  assert.equal(spoofed.title, 'This command is not available to this account.');
  assert.doesNotMatch(JSON.stringify(spoofed), /Mara|Leaked/);
  assert.equal(f.revision(), 0);
  assert.equal(f.receipts(), 0);
});

test('api-v1 wire: receipt envelopes, the replay header and a 404 unknown for an absent receipt', async (t) => {
  const f = await fixture(t, false, 'api-v1');
  const fresh = f.owner.consumeResult(await f.owner.execute(f.token.token, request));
  assert.equal(fresh.status, 200);
  assert.deepEqual(fresh.headers, {});
  const applied = JSON.parse(fresh.body);
  assert.deepEqual(Object.keys(applied).sort(), ['receipt', 'result']);
  assert.deepEqual(applied.result, { ok: true });
  assert.equal(applied.receipt.status, 'applied');
  assert.equal(applied.receipt.replayed, false);
  assert.equal(typeof applied.receipt.id, 'string');
  const replay = f.owner.consumeResult(await f.owner.execute(f.token.token, request));
  assert.deepEqual(replay.headers, { 'idempotent-replayed': 'true' });
  assert.deepEqual(JSON.parse(replay.body), { receipt: { ...applied.receipt, replayed: true }, result: { ok: true } });
  assert.equal(f.control.calls, 1);
  assert.equal(f.receipts(), 1);
  const recovered = JSON.parse(f.owner.consumeResult(await f.owner.recover(f.token.token, recovery)).body);
  assert.deepEqual(recovered, {
    receipt: { id: applied.receipt.id, status: 'applied', recovered: true },
    targets: [{ id: '1' }],
    result: { ok: true },
  });
  const absent = f.owner.consumeResult(await f.owner.recover(f.issue(undefined, 'other').token, recovery));
  assert.equal(absent.status, 404);
  assert.deepEqual(JSON.parse(absent.body), {
    type: 'urn:mistri:problem:not_found',
    title: 'The record was not found.',
    status: 404,
    code: 'not_found',
    outcome: 'unknown',
  });
});

test('an unusable credential is the one owner refusal a transport may answer as unauthenticated', async (t) => {
  const f = await fixture(t);
  for (const credential of ['not-a-token', '', undefined]) {
    await assert.rejects(f.owner.execute(credential, request), ApiCommandUnauthenticated);
    await assert.rejects(f.owner.recover(credential, recovery), ApiCommandUnauthenticated);
  }
  f.revoke();
  await assert.rejects(f.owner.execute(f.token.token, request), ApiCommandUnauthenticated);
  assert.equal(f.control.calls, 0);
  assert.equal(f.receipts(), 0);
});

test('an api-v1 owner maps a route to the envelope its own executor runs; an internal owner has no mapping', async (t) => {
  const f = await fixture(t, false, 'api-v1');
  const route = parseApiCommandRoute('/api/apps/owner/v1/item/1/commands/change/v1');
  const envelope = f.owner.map(route, { expectedVersion: 0, idempotencyKey: request.idempotencyKey }, {});
  assert.deepEqual(envelope, {
    command: 'change',
    commandVersion: 1,
    key: { id: '1' },
    expectedVersion: 0,
    idempotencyKey: request.idempotencyKey,
    input: {},
  });
  const applied = f.owner.consumeResult(await f.owner.execute(f.token.token, envelope));
  assert.equal(applied.status, 200);
  assert.equal(f.revision(), 1);
  assert.throws(() =>
    f.owner.map(
      parseApiCommandRoute('/api/apps/owner/v1/item/commands/change/v1'),
      { idempotencyKey: request.idempotencyKey },
      { targets: [], input: {} },
    ),
  );
  const internal = await fixture(t);
  assert.throws(() => internal.owner.map(route, { expectedVersion: 0, idempotencyKey: request.idempotencyKey }, {}), {
    outcome: 'unknown',
  });
});

test('the wire shape is a construction choice: anything but the two named shapes refuses', async (t) => {
  const f = await fixture(t);
  for (const options of [
    { wire: 'api-v2' },
    { wire: 1 },
    Object.defineProperty({}, 'wire', { enumerable: true, get: () => 'api-v1' }),
    new Proxy({}, {}),
    { wire: 'api-v1' },
    { wire: 'api-v1', integers: 'float' },
    { wire: 'internal', integers: 'number' },
  ]) {
    await assert.rejects(createSqliteApiCommandOwner(f.registry, f.host, f.hosting, options as never));
  }
});

/* Transport doubles: a real body stream and a response that records what the
   transport wrote. Authority, journal and writer are the fixture's genuine ones. */
function reply() {
  const headers: Record<string, unknown> = {};
  const value = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    status: 0,
    body: '',
    headers,
    setHeader(name: string, content: unknown) {
      headers[name.toLowerCase()] = content;
    },
    writeHead(status: number, extra: Record<string, unknown> = {}) {
      value.status = status;
      for (const [name, content] of Object.entries(extra)) headers[name.toLowerCase()] = content;
    },
    end(body: string) {
      value.body = body;
      value.writableEnded = true;
    },
  });
  return value;
}
type Transport = ReturnType<typeof createSqliteApiCommandHttp>;
async function call(http: Transport, method: string, url: string, headers: [string, string][], body?: string) {
  const all: [string, string][] = [['Host', '127.0.0.1:4111'], ...headers];
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(body)]), {
    url,
    method,
    rawHeaders: all.flat(),
    headers: Object.fromEntries(all.map(([name, content]) => [name.toLowerCase(), content])),
    socket: { remoteAddress: '127.0.0.1' },
    aborted: false,
  });
  const res = reply();
  const claimed = await http.handle(req as unknown as IncomingMessage, res as unknown as ServerResponse);
  return { claimed, status: res.status, headers: res.headers, body: res.body ? JSON.parse(res.body) : undefined };
}
function transport(t: TestContext, f: Awaited<ReturnType<typeof fixture>>) {
  const http = createSqliteApiCommandHttp(f.registry, f.host, f.hosting, {
    bound: { host: '127.0.0.1', port: 4111 },
    integers: 'decimal-string',
    requestsPerMinute: 1000,
  });
  t.after(() => http.retire());
  return http;
}
const commandPath = '/api/apps/owner/v1/item/1/commands/change/v1';
const receiptPath = `/api/apps/owner/v1/commands/change/v1/receipts/${request.idempotencyKey}`;

test('command transport: a bearer execute, its replay and normalized recovery through the api-v1 owner', async (t) => {
  const f = await fixture(t),
    http = transport(t, f);
  const bearer: [string, string] = ['Authorization', `Bearer ${f.token.token}`],
    key: [string, string] = ['Idempotency-Key', request.idempotencyKey];
  const fresh = await call(http, 'POST', commandPath, [bearer, ['If-Match', '"0"'], key], '{}');
  assert.equal(fresh.claimed, true);
  assert.equal(fresh.status, 200);
  assert.match(String(fresh.headers['content-type']), /^application\/json/);
  assert.equal(fresh.headers['cache-control'], 'no-store');
  assert.equal(fresh.body.receipt.replayed, false);
  assert.deepEqual(fresh.body.result, { ok: true });
  const replay = await call(http, 'POST', commandPath, [bearer, ['If-Match', '"0"'], key], '{}');
  assert.equal(replay.status, 200);
  assert.equal(replay.headers['idempotent-replayed'], 'true');
  const recovered = await call(http, 'GET', receiptPath, [bearer]);
  assert.equal(recovered.status, 200);
  assert.deepEqual(recovered.body, {
    receipt: { id: fresh.body.receipt.id, status: 'applied', recovered: true },
    targets: [{ id: '1' }],
    result: { ok: true },
  });
  assert.equal(f.control.calls, 1);
  assert.equal(f.revision(), 1);
  assert.equal(f.receipts(), 1);
});

test('command transport refusals are problem details with the design statuses; reads are not claimed', async (t) => {
  const f = await fixture(t),
    http = transport(t, f);
  const bearer: [string, string] = ['Authorization', `Bearer ${f.token.token}`],
    key: [string, string] = ['Idempotency-Key', request.idempotencyKey];
  const problem = async (method: string, url: string, headers: [string, string][], body?: string) => {
    const answer = await call(http, method, url, headers, body);
    assert.match(String(answer.headers['content-type']), /^application\/problem\+json/, `${method} ${url}`);
    assert.equal(answer.body.status, answer.status);
    return answer;
  };
  let answer = await problem('POST', commandPath, [['If-Match', '"0"'], key], '{}');
  assert.equal(answer.status, 401);
  assert.equal(answer.headers['www-authenticate'], 'Bearer');
  answer = await problem('POST', commandPath, [['Authorization', 'Bearer not-a-token'], ['If-Match', '"0"'], key], '{}');
  assert.equal(answer.status, 401);
  answer = await problem('POST', commandPath, [bearer, key], '{}');
  assert.equal(answer.status, 428);
  assert.equal(answer.body.code, 'precondition_required');
  // Refused before the owner had the request: no outcome is claimed.
  assert.equal('outcome' in answer.body, false);
  answer = await problem('POST', commandPath, [bearer, ['If-Match', '"0"']], '{}');
  assert.equal(answer.status, 400);
  assert.equal(answer.body.code, 'idempotency_key_required');
  answer = await problem('GET', commandPath, [bearer]);
  assert.equal(answer.status, 405);
  assert.equal(answer.headers.allow, 'POST');
  answer = await problem('POST', receiptPath, [bearer], '{}');
  assert.equal(answer.status, 405);
  assert.equal(answer.headers.allow, 'GET');
  answer = await problem('POST', '/api/apps/owner/v1/item/1/commands/change/v01', [bearer, ['If-Match', '"0"'], key], '{}');
  assert.equal(answer.status, 400);
  answer = await problem('POST', '/api/apps/owner/v1/item/1/commands/missing/v1', [bearer, ['If-Match', '"0"'], key], '{}');
  assert.equal(answer.status, 404);
  answer = await problem('POST', commandPath, [bearer, ['If-Match', '"0"'], key], '{not json');
  assert.equal(answer.status, 400);
  assert.equal(answer.body.code, 'invalid_request');
  answer = await problem('POST', commandPath, [bearer, ['If-Match', '"5"'], key], '{}');
  assert.equal(answer.status, 409);
  assert.equal(answer.body.code, 'stale_record');
  assert.equal('outcome' in answer.body, true);
  const unclaimed = await call(http, 'GET', '/api/apps/owner/v1/item', [bearer]);
  assert.equal(unclaimed.claimed, false);
  assert.equal(unclaimed.status, 0);
  assert.equal(f.control.calls, 0);
  assert.equal(f.receipts(), 0);
  assert.equal(f.revision(), 0);
});

test('command transport: a many-target body applies each ordered target once and recovers every key', async (t) => {
  const f = await fixture(t, false, undefined, true),
    http = transport(t, f);
  const bearer: [string, string] = ['Authorization', `Bearer ${f.token.token}`];
  const revisions = () =>
    f.db
      .prepare('SELECT id, version FROM physical_item ORDER BY id')
      .all()
      .map((row) => ({ ...row }));
  const batch = '/api/apps/owner/v1/item/commands/batch/v1';
  const body = (targets: unknown[]) => JSON.stringify({ targets, input: {} });
  // Keys in either spelling are accepted; recovery answers in the chosen form.
  const done = await call(
    http,
    'POST',
    batch,
    [bearer, ['Idempotency-Key', 'batch-attempt-000001']],
    body([
      { key: { id: '2' }, version: 0 },
      { key: { id: 1 }, version: 0 },
    ]),
  );
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.receipt.replayed, false);
  assert.deepEqual(revisions(), [
    { id: 1, version: 1 },
    { id: 2, version: 1 },
  ]);
  const recovered = await call(http, 'GET', '/api/apps/owner/v1/commands/batch/v1/receipts/batch-attempt-000001', [bearer]);
  assert.equal(recovered.status, 200);
  assert.deepEqual(recovered.body.targets, [{ id: '2' }, { id: '1' }]);
  // A stale revision on a two-target request names the target it is about.
  const stale = await call(
    http,
    'POST',
    batch,
    [bearer, ['Idempotency-Key', 'batch-attempt-000002']],
    body([
      { key: { id: 1 }, version: 0 },
      { key: { id: 2 }, version: 1 },
    ]),
  );
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'stale_record');
  assert.ok('key' in stale.body, JSON.stringify(stale.body));
  const duplicate = await call(
    http,
    'POST',
    batch,
    [bearer, ['Idempotency-Key', 'batch-attempt-000003']],
    body([
      { key: { id: 1 }, version: 1 },
      { key: { id: '1' }, version: 1 },
    ]),
  );
  assert.equal(duplicate.status, 422, JSON.stringify(duplicate.body));
  // A one-target command has no many-target route.
  const wrong = await call(
    http,
    'POST',
    '/api/apps/owner/v1/item/commands/change/v1',
    [bearer, ['Idempotency-Key', 'batch-attempt-000004']],
    body([{ key: { id: 1 }, version: 1 }]),
  );
  assert.equal(wrong.status, 404);
  assert.deepEqual(revisions(), [
    { id: 1, version: 1 },
    { id: 2, version: 1 },
  ]);
  assert.equal(f.receipts(), 1);
});

test('an api-v1 owner serves the composed document narrowed to what this token may call now', async (t) => {
  const f = await fixture(t, false, 'api-v1');
  const spec = async (token: string) => JSON.parse(f.owner.consumeResult(await f.owner.readSpec(token)).body);
  const full = await spec(f.token.token),
    paths = Object.keys(full.paths);
  assert.equal(full['x-mistri-document'], 'app-api');
  assert.ok(
    paths.some((path) => path.includes('/commands/change/')),
    JSON.stringify(paths),
  );
  assert.ok(
    paths.some((path) => !path.includes('/commands/')),
    JSON.stringify(paths),
  );
  const commandOnly = Object.keys((await spec(f.issue(['command:change']).token)).paths);
  assert.ok(commandOnly.length > 0 && commandOnly.every((path) => path.includes('/commands/')), JSON.stringify(commandOnly));
  const readOnly = Object.keys((await spec(f.issue(['list:item']).token)).paths);
  assert.ok(readOnly.length > 0 && readOnly.every((path) => !path.includes('/commands/')), JSON.stringify(readOnly));
  assert.deepEqual((await spec(f.issue([]).token)).paths, {});
  await assert.rejects(f.owner.readSpec('not-a-token'), ApiCommandUnauthenticated);
  // Like any answer, the document is re-authorized at consume.
  const handle = await f.owner.readSpec(f.token.token);
  f.revoke();
  assert.throws(() => f.owner.consumeResult(handle), { outcome: 'unknown' });
  const internal = await fixture(t);
  await assert.rejects(internal.owner.readSpec(internal.token.token), { outcome: 'unknown' });
  assert.equal(f.control.calls, 0);
  assert.equal(f.receipts(), 0);
});

test('command transport serves $openapi only for a command-exposing App, bearer-only and GET-only', async (t) => {
  const f = await fixture(t),
    http = transport(t, f);
  const bearer: [string, string] = ['Authorization', `Bearer ${f.token.token}`],
    specPath = '/api/apps/owner/v1/$openapi';
  const spec = await call(http, 'GET', specPath, [bearer]);
  assert.equal(spec.claimed, true);
  assert.equal(spec.status, 200);
  assert.match(String(spec.headers['content-type']), /^application\/json/);
  assert.equal(spec.body['x-mistri-document'], 'app-api');
  assert.ok(Object.keys(spec.body.paths).some((path) => path.includes('/commands/change/')));
  const unauthenticated = await call(http, 'GET', specPath, []);
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.headers['www-authenticate'], 'Bearer');
  const posted = await call(http, 'POST', specPath, [bearer], '{}');
  assert.equal(posted.status, 405);
  assert.equal(posted.headers.allow, 'GET');
  assert.equal((await call(http, 'GET', `${specPath}?x=1`, [bearer])).status, 400);
  assert.equal((await call(http, 'GET', '/api/apps/other/v1/$openapi', [bearer])).status, 404);
  assert.equal((await call(http, 'GET', '/api/apps/owner/v2/$openapi', [bearer])).status, 404);
  assert.equal(f.control.calls, 0);
});

test('a read owner serves the read half of a command-exposing App to command-issued tokens', async (t) => {
  const f = await fixture(t);
  const reader = await createSqliteApiReadOwner(f.registry, f.host, 'decimal-string');
  t.after(() => reader.retire());
  const item = reader.consumeResult(await reader.readItem(f.token.token, 'item:item', '1'));
  assert.equal(item.status, 200);
  assert.deepEqual(JSON.parse(item.body), { id: '1', version: '0' });
  const list = reader.consumeResult(await reader.readList(f.token.token, 'list:item', ''));
  assert.equal(list.status, 200);
  assert.equal(JSON.parse(list.body).items.length, 1);
  // A token scoped to the command alone observes no read operation here.
  await assert.rejects(reader.readItem(f.issue(['command:change']).token, 'item:item', '1'), { code: 'forbidden' });
  // The composed document is the command transport's, never a read-only half.
  await assert.rejects(reader.readSpec(f.token.token), { code: 'temporarily_unavailable' });
  // Currentness is still the real App: a changed command exposure retires reads.
  f.host.app.app.api!.commands = [];
  await assert.rejects(reader.readItem(f.token.token, 'item:item', '1'));
  assert.equal(f.control.calls, 0);
});

/* One App MCP session over scripted stdio-shaped streams; each line in, and
   every line the session wrote, parsed back. */
async function mcpSession(
  f: Awaited<ReturnType<typeof fixture>>,
  reader: Awaited<ReturnType<typeof createSqliteApiReadOwner>>,
  credential: string,
  messages: (Record<string, unknown> | string)[],
  withCommands = false,
) {
  const input = new PassThrough(),
    written: string[] = [];
  const session = createAppMcpSession({
    input,
    output: {
      write: (chunk: string) => {
        written.push(chunk);
        return true;
      },
    },
    credential,
    version: 'test',
    app: f.host.app.app,
    schema: f.schema,
    integers: 'decimal-string',
    deliver: sqliteAppMcpReads(reader),
    ...(withCommands ? { commands: { registry: f.hosting.registry, evidence: f.evidence, deliver: sqliteAppMcpCommands(f.owner) } } : {}),
  });
  for (const message of messages) input.write(`${typeof message === 'string' ? message : JSON.stringify(message)}\n`);
  input.end();
  await session.done;
  const text = written.join('');
  return {
    text,
    replies: text
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  };
}
const rpc = (id: number, method: string, params: Record<string, unknown> = {}) => ({ jsonrpc: '2.0', id, method, params });

test('App MCP session: narrowed discovery and calls through the read owner, one answer per request', async (t) => {
  const f = await fixture(t);
  const reader = await createSqliteApiReadOwner(f.registry, f.host, 'decimal-string');
  t.after(() => reader.retire());
  const first = await mcpSession(f, reader, f.token.token, [
    rpc(1, 'initialize', { protocolVersion: '2025-06-18' }),
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    rpc(2, 'tools/list'),
    rpc(3, 'ping'),
  ]);
  assert.deepEqual(
    first.replies.map((reply) => reply.id),
    [1, 2, 3],
  );
  assert.equal(first.replies[0].result.protocolVersion, '2025-06-18');
  assert.deepEqual(first.replies[0].result.capabilities, { tools: {} });
  const tools = first.replies[1].result.tools as { name: string; description: string }[];
  assert.equal(tools.length, 2);
  const get = tools.find((tool) => tool.name.startsWith('get_'))!.name,
    list = tools.find((tool) => tool.name.startsWith('list_'))!.name;
  assert.doesNotMatch(JSON.stringify(tools), /non-callable|bindings|eligibleRoles/);
  const calls = await mcpSession(f, reader, f.token.token, [
    rpc(4, 'tools/call', { name: get, arguments: { id: '1' } }),
    rpc(5, 'tools/call', { name: list, arguments: {} }),
    rpc(6, 'tools/call', { name: get, arguments: { id: '1', extra: 1 } }),
    rpc(7, 'tools/call', { name: 'get_missing', arguments: {} }),
    rpc(8, 'nonsense'),
    'not json',
  ]);
  const byId = new Map(calls.replies.map((reply) => [reply.id, reply]));
  assert.deepEqual(byId.get(4).result.structuredContent, { id: '1', version: '0' });
  assert.equal(byId.get(4).result.isError, false);
  assert.deepEqual(JSON.parse(byId.get(4).result.content[0].text), { id: '1', version: '0' });
  assert.equal(byId.get(5).result.structuredContent.items.length, 1);
  assert.equal(byId.get(6).result.isError, true);
  assert.match(byId.get(6).result.content[0].text, /arguments/);
  assert.equal(byId.get(7).result.content[0].text, 'No such tool.');
  assert.equal(byId.get(8).error.code, -32601);
  assert.equal(byId.get(null).error.code, -32700);
  // A token scoped to the command alone: nothing listed, the same call refused.
  const commandOnly = f.issue(['command:change']).token;
  const narrowed = await mcpSession(f, reader, commandOnly, [
    rpc(9, 'tools/list'),
    rpc(10, 'tools/call', { name: get, arguments: { id: '1' } }),
  ]);
  assert.deepEqual(narrowed.replies[0].result.tools, []);
  assert.deepEqual(JSON.parse(narrowed.replies[1].result.content[0].text), { error: { code: 'forbidden' } });
  // A listing is never permission: revoked between list and call, the call refuses.
  f.revoke();
  const revoked = await mcpSession(f, reader, f.token.token, [
    rpc(11, 'tools/call', { name: get, arguments: { id: '1' } }),
    rpc(12, 'tools/list'),
  ]);
  assert.deepEqual(JSON.parse(revoked.replies[0].result.content[0].text), { error: { code: 'unauthenticated' } });
  assert.equal(revoked.replies[1].error.code, -32603);
  for (const output of [first.text, calls.text, narrowed.text, revoked.text]) {
    assert.equal(output.includes(f.token.token) || output.includes(commandOnly), false);
  }
  assert.equal(f.control.calls, 0);
});

test('App MCP session: a call cancelled while it waits answers nothing, and later calls still answer', async (t) => {
  const f = await fixture(t);
  const reader = await createSqliteApiReadOwner(f.registry, f.host, 'decimal-string');
  t.after(() => reader.retire());
  const listed = await mcpSession(f, reader, f.token.token, [rpc(1, 'tools/list')]);
  const get = (listed.replies[0].result.tools as { name: string }[]).find((tool) => tool.name.startsWith('get_'))!.name;
  const session = await mcpSession(f, reader, f.token.token, [
    rpc(2, 'tools/list'),
    rpc(3, 'tools/call', { name: get, arguments: { id: '1' } }),
    { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 3 } },
    rpc(4, 'tools/call', { name: get, arguments: { id: '1' } }),
  ]);
  assert.deepEqual(
    session.replies.map((reply) => reply.id),
    [2, 4],
  );
  assert.equal(session.replies[1].result.isError, false);
});

test('App MCP command tools: listed with the reads, run once under an idempotency key, recovered, and refused as the API refuses', async (t) => {
  const f = await fixture(t, false, 'api-v1');
  const reader = await createSqliteApiReadOwner(f.registry, f.host, 'decimal-string');
  t.after(() => reader.retire());
  const listed = await mcpSession(f, reader, f.token.token, [rpc(1, 'tools/list')], true);
  const names = (listed.replies[0].result.tools as { name: string }[]).map((tool) => tool.name);
  const prepare = names.find((name) => name.startsWith('prepare_change_'))!;
  const run = names.find((name) => name.startsWith('run_change_'))!,
    recover = names.find((name) => name.startsWith('recover_change_'))!;
  assert.ok(
    run && recover && names.some((name) => name.startsWith('get_')) && names.some((name) => name.startsWith('list_')),
    JSON.stringify(names),
  );
  // A token scoped to the command alone lists only the command's tools.
  const commandOnly = f.issue(['command:change']).token;
  const scoped = (await mcpSession(f, reader, commandOnly, [rpc(2, 'tools/list')], true)).replies[0].result.tools as { name: string }[];
  assert.deepEqual(scoped.map((tool) => tool.name).sort(), [prepare, recover, run].sort());
  const key = 'mcp-attempt-0000001';
  const calls = await mcpSession(
    f,
    reader,
    f.token.token,
    [
      rpc(3, 'tools/call', { name: run, arguments: { key: { id: '1' }, version: 0, idempotencyKey: key, input: {} } }),
      rpc(4, 'tools/call', { name: run, arguments: { key: { id: '1' }, version: 0, idempotencyKey: key, input: {} } }),
      rpc(5, 'tools/call', { name: run, arguments: { key: { id: '1' }, version: 5, idempotencyKey: 'mcp-attempt-0000002', input: {} } }),
      rpc(6, 'tools/call', { name: recover, arguments: { idempotencyKey: key } }),
      rpc(7, 'tools/call', { name: recover, arguments: { idempotencyKey: 'mcp-attempt-unknown01' } }),
      rpc(8, 'tools/call', { name: run, arguments: { key: { id: '1' }, version: 1, input: {} } }),
    ],
    true,
  );
  const byId = new Map(calls.replies.map((reply) => [reply.id, reply.result]));
  assert.equal(byId.get(3).isError, false);
  assert.equal(byId.get(3).structuredContent.receipt.status, 'applied');
  assert.equal(byId.get(3).structuredContent.receipt.replayed, false);
  // The same key and request replay the receipt; the handler ran once.
  assert.equal(byId.get(4).structuredContent.receipt.replayed, true);
  assert.equal(byId.get(4).structuredContent.receipt.id, byId.get(3).structuredContent.receipt.id);
  assert.equal(f.control.calls, 1);
  assert.equal(f.revision(), 1);
  assert.equal(f.receipts(), 1);
  const stale = JSON.parse(byId.get(5).content[0].text);
  assert.equal(byId.get(5).isError, true);
  assert.equal(stale.code, 'stale_record');
  assert.equal(stale.outcome, 'not_applied');
  assert.deepEqual(byId.get(6).structuredContent.receipt, {
    id: byId.get(3).structuredContent.receipt.id,
    status: 'applied',
    recovered: true,
  });
  assert.deepEqual(byId.get(6).structuredContent.targets, [{ id: '1' }]);
  const absent = JSON.parse(byId.get(7).content[0].text);
  assert.equal(absent.code, 'not_found');
  assert.equal(absent.outcome, 'unknown');
  assert.equal(byId.get(8).content[0].text, 'The arguments do not match this tool.');
  assert.equal(f.control.calls, 1);
  for (const text of [listed.text, calls.text]) assert.equal(text.includes(f.token.token), false);
});

test('API preparation supplies an opaque revision without a declared version column and preserves stale-write checks', async (t) => {
  const f = await fixture(t, false, 'api-v1', false, true),
    http = transport(t, f);
  const bearer: [string, string] = ['Authorization', `Bearer ${f.token.token}`];
  const prepared = await call(http, 'GET', `${commandPath}/prepare`, [bearer]);
  assert.equal(prepared.status, 200);
  assert.deepEqual(Object.keys(prepared.body), ['version']);
  assert.equal(prepared.headers.etag, `"${prepared.body.version}"`);
  assert.equal(f.control.calls, 0);
  assert.equal(f.receipts(), 0);
  f.db.exec('UPDATE physical_item SET revision=9 WHERE id=1');
  const stale = await call(
    http,
    'POST',
    commandPath,
    [bearer, ['If-Match', String(prepared.headers.etag)], ['Idempotency-Key', request.idempotencyKey]],
    '{}',
  );
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'stale_record');
  assert.equal(f.control.calls, 0);
  assert.equal(f.receipts(), 0);
  const fresh = await call(http, 'GET', `${commandPath}/prepare`, [bearer]);
  assert.notEqual(fresh.body.version, prepared.body.version);
  const applied = await call(
    http,
    'POST',
    commandPath,
    [bearer, ['If-Match', String(fresh.headers.etag)], ['Idempotency-Key', request.idempotencyKey]],
    '{}',
  );
  assert.equal(applied.status, 200);
  assert.equal(f.control.calls, 1);
  assert.equal(f.revision(), 10);
  const denied = await call(http, 'GET', `${commandPath}/prepare`, [['Authorization', `Bearer ${f.issue([]).token}`]]);
  assert.equal(denied.status, 403);
  const missing = await call(http, 'GET', `${commandPath}/prepare`, []);
  assert.equal(missing.status, 401);
  const handle = await f.owner.prepare(f.token.token, { command: 'change', commandVersion: 1, key: { id: 1 } });
  f.revoke();
  assert.throws(() => f.owner.consumeResult(handle), { outcome: 'unknown' });
});

test('MCP prepares a versionless target through its command owner', async (t) => {
  const f = await fixture(t, false, 'api-v1', false, true);
  const reader = await createSqliteApiReadOwner(f.registry, f.host, 'decimal-string');
  t.after(() => reader.retire());
  const listed = await mcpSession(f, reader, f.token.token, [rpc(1, 'tools/list')], true);
  const tools = listed.replies[0].result.tools as { name: string; annotations: { readOnlyHint: boolean } }[];
  const prepare = tools.find((tool) => tool.name.startsWith('prepare_change_'))!;
  const run = tools.find((tool) => tool.name.startsWith('run_change_'))!;
  assert.equal(prepare.annotations.readOnlyHint, true);
  const prepared = await mcpSession(
    f,
    reader,
    f.token.token,
    [rpc(2, 'tools/call', { name: prepare.name, arguments: { key: { id: '1' } } })],
    true,
  );
  assert.equal(prepared.replies[0].result.isError, false);
  const version = prepared.replies[0].result.structuredContent.version;
  assert.equal(typeof version, 'number');
  assert.equal(f.control.calls, 0);
  assert.equal(f.receipts(), 0);
  const applied = await mcpSession(
    f,
    reader,
    f.token.token,
    [
      rpc(3, 'tools/call', {
        name: run.name,
        arguments: { key: { id: '1' }, version, idempotencyKey: 'mcp-versionless-00001', input: {} },
      }),
    ],
    true,
  );
  assert.equal(applied.replies[0].result.isError, false);
  assert.equal(f.control.calls, 1);
});
