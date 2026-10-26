/** Account-backed Forecourt shortlists stay scoped to the verified actor. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Registry } from '../packages/engine/src/server/connections.js';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { createAppPolicyDeployment, type AppPolicyDeployment } from '../packages/mistri/src/server/policy/appPolicyDeployment.js';
import { acquireAppPolicyResources } from '../packages/mistri/src/server/policy/appPolicyResources.js';
import policy from '../test/fixtures/apps/forecourt/policy.ts';
import commands from '../test/fixtures/apps/forecourt/commands.ts';

const shopperA = { id: 'shopper-a', appId: 'forecourt', roles: ['shopper'] };
const shopperB = { id: 'shopper-b', appId: 'forecourt', roles: ['shopper'] };
const staff = { id: 'staff-one', appId: 'forecourt', roles: ['staff'] };

test('Forecourt: shortlist commands are account-scoped, durable and replayable', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-forecourt-shortlist-'));
  const file = join(directory, 'market.db');
  let registry = new Registry();
  let deployment: AppPolicyDeployment<typeof shopperA | null> | undefined;
  t.after(async () => {
    await deployment?.retire();
    await registry.closeAll();
    rmSync(directory, { recursive: true, force: true });
  });
  execFileSync(process.execPath, ['--import', 'tsx', 'test/fixtures/databases/forecourt/seed.mjs', file], { stdio: 'pipe' });
  const loaded = await loadApp('test/fixtures/apps/forecourt');
  const bind = async () => {
    registry.add({ id: 'forecourt', name: 'forecourt', url: file, writable: true, source: 'config' });
    return createAppPolicyDeployment<typeof shopperA | null>({
      app: loaded.app,
      policy,
      acquire: (app) => acquireAppPolicyResources(registry, app),
      verifySession: async (actor) => actor && { id: actor.id, who: `${actor.id}@example.test`, role: actor.roles.join(',') },
      commands: { registry: commands, writableConnection: () => true },
    });
  };
  deployment = await bind();
  const execute = (actor: typeof shopperA, request: unknown) =>
    deployment!.withContext(actor, (context) => context.commands!.execute(request));
  const read = (actor: typeof shopperA, table: string) =>
    deployment!.withContext(actor, async (context) => {
      return context.data.query({ table, limit: 20, offset: 0 });
    });
  const rows = (sql: string) => {
    const db = new DatabaseSync(file);
    try {
      return db.prepare(sql).all();
    } finally {
      db.close();
    }
  };
  const prepare = (actor: typeof shopperA, command: string, key: { id: number }) =>
    deployment!.withContext(actor, (context) => context.commands!.prepare({ command, commandVersion: 1, key })) as Promise<{
      expectedVersion: number;
    }>;
  const save = async (actor: typeof shopperA, key: string) =>
    execute(actor, {
      command: 'saveVehicle',
      commandVersion: 1,
      key: { id: 1 },
      expectedVersion: (await prepare(actor, 'saveVehicle', { id: 1 })).expectedVersion,
      idempotencyKey: key,
      input: {},
    });
  const remove = async (actor: typeof shopperA, id: number, key: string) =>
    execute(actor, {
      command: 'removeSavedVehicle',
      commandVersion: 1,
      key: { id },
      expectedVersion: (await prepare(actor, 'removeSavedVehicle', { id })).expectedVersion,
      idempotencyKey: key,
      input: {},
    });

  const first = await save(shopperA, 'shortlist-save-a-0001');
  assert.equal(first.status, 'applied');
  assert.equal(first.replayed, false);
  assert.equal((await save(shopperA, 'shortlist-save-a-0001')).replayed, true);
  const savedA = rows("SELECT id, account_id, vehicle_id, active FROM saved_vehicle WHERE account_id = 'shopper-a'");
  assert.deepEqual(
    savedA.map((row) => ({ ...row })),
    [{ id: savedA[0].id, account_id: 'shopper-a', vehicle_id: 1, active: 1 }],
  );
  const savedId = Number(savedA[0].id);

  assert.deepEqual(
    (await read(shopperA, 'saved_vehicle')).rows.map((row) => row.account_id),
    ['shopper-a'],
  );
  assert.equal((await read(shopperB, 'saved_vehicle')).rows.length, 0);
  await assert.rejects(remove(shopperB, savedId, 'shortlist-remove-b-0001'));
  assert.equal(rows(`SELECT active FROM saved_vehicle WHERE id = ${savedId}`)[0].active, 1);
  await deployment.submitPublicForm!('inquire', {
    submission: 'anonymous-inquiry-0001',
    input: { stock_ref: 'FC-1001', name: 'Visitor', email: 'shopper-a@example.test', message: 'Public inquiry' },
  });
  assert.equal((await read(shopperA, 'inquiry')).rows.length, 0, 'matching contact email does not claim an anonymous inquiry');
  await assert.rejects(
    deployment.withContext(null, async (context) => context.data.query({ table: 'saved_vehicle', limit: 20, offset: 0 })),
    /denied|access|scope/i,
    'anonymous visitors have no shortlist rows',
  );

  const removed = await remove(shopperA, savedId, 'shortlist-remove-a-0001');
  assert.equal(removed.status, 'applied');
  assert.equal(rows(`SELECT active FROM saved_vehicle WHERE id = ${savedId}`)[0].active, 0);
  await save(shopperA, 'shortlist-save-a-0002');
  assert.equal(rows(`SELECT count(*) AS n FROM saved_vehicle WHERE account_id = 'shopper-a'`)[0].n, 1, 'save reactivates the archived row');
  assert.equal(rows(`SELECT active FROM saved_vehicle WHERE id = ${savedId}`)[0].active, 1);

  const staffSave = await save(staff, 'shortlist-save-staff-0001');
  assert.equal(staffSave.status, 'applied');
  assert.deepEqual(
    (await read(staff, 'saved_vehicle')).rows.map((row) => row.account_id),
    ['staff-one'],
  );
  assert.equal((await read(shopperA, 'saved_vehicle')).rows.length, 1, 'staff shortlist is not visible to shopper A');

  const inquiryRequest = {
    command: 'sendVehicleInquiry',
    commandVersion: 1,
    key: { id: 1 },
    expectedVersion: (await prepare(shopperA, 'sendVehicleInquiry', { id: 1 })).expectedVersion,
    idempotencyKey: 'account-inquiry-0001',
    input: { name: 'Shopper A', email: 'shopper-a@example.test', message: 'Account inquiry' },
  };
  await execute(shopperA, inquiryRequest);
  const ownedInquiries = (await read(shopperA, 'inquiry')).rows;
  assert.equal(ownedInquiries.length, 1);
  assert.equal(ownedInquiries[0].account_id, shopperA.id);
  assert.equal((await read(shopperB, 'inquiry')).rows.length, 0);
  await assert.rejects(read(shopperA, 'inquiry_activity'), /denied|access|scope/i, 'staff notes remain private');
  const forged = {
    ...inquiryRequest,
    idempotencyKey: 'account-inquiry-forged',
    input: { ...inquiryRequest.input, account_id: shopperB.id },
  };
  await assert.rejects(execute(shopperA, forged));

  await deployment.retire();
  await registry.closeAll();
  registry = new Registry();
  deployment = await bind();
  assert.deepEqual(
    (await read(shopperA, 'saved_vehicle')).rows.map((row) => row.vehicle_id),
    [1],
  );
  assert.equal((await save(shopperA, 'shortlist-save-a-0001')).replayed, true, 'save receipt survives restart');
  assert.equal((await execute(shopperA, inquiryRequest)).replayed, true, 'owned inquiry receipt survives restart');
  assert.equal((await read(shopperA, 'inquiry')).rows.length, 1);
});
