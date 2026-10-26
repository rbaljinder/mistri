/** A fresh public submission becomes staff work without granting generic writes. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Registry } from '../packages/engine/src/server/connections.js';
import { appProblems, loadApp } from '../packages/mistri/src/server/app/apps.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { createAppPolicyDeployment, type AppPolicyDeployment } from '../packages/mistri/src/server/policy/appPolicyDeployment.js';
import { acquireAppPolicyResources } from '../packages/mistri/src/server/policy/appPolicyResources.js';
import { validateBusinessCommandReferences } from '../packages/mistri/src/server/commands/businessCommandLoader.js';
import policy from '../test/fixtures/apps/forecourt/policy.ts';
import commands from '../test/fixtures/apps/forecourt/commands.ts';

const staff = { id: 'staff-one', appId: 'forecourt', roles: ['staff'] };
const otherStaff = { id: 'staff-two', appId: 'forecourt', roles: ['staff'] };
const shopper = { id: 'shopper-one', appId: 'forecourt', roles: ['shopper'] };

test('Forecourt: public intake, staff reply and closure are durable, authorized and atomic', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-forecourt-workflow-'));
  const file = join(directory, 'market.db');
  let registry = new Registry();
  let deployment: AppPolicyDeployment<typeof staff | null> | undefined;
  t.after(async () => {
    await deployment?.retire();
    await registry.closeAll();
    rmSync(directory, { recursive: true, force: true });
  });
  execFileSync(process.execPath, ['--import', 'tsx', 'test/fixtures/databases/forecourt/seed.mjs', file], { stdio: 'pipe' });
  const loaded = await loadApp('test/fixtures/apps/forecourt');
  const bind = async () => {
    registry.add({ id: 'forecourt', name: 'forecourt', url: file, writable: true, source: 'config' });
    const resources = await loadAppRuntimeResources(registry, loaded.app, 'forecourt');
    assert.deepEqual(appProblems(loaded, resources.schema), []);
    validateBusinessCommandReferences(loaded.app, commands, resources);
    return createAppPolicyDeployment<typeof staff | null>({
      app: loaded.app,
      policy,
      acquire: (app) => acquireAppPolicyResources(registry, app),
      verifySession: async (actor) => actor && { id: actor.id, who: `${actor.id}@example.test`, role: actor.roles.join(',') },
      commands: { registry: commands, writableConnection: () => true },
    });
  };
  deployment = await bind();
  const execute = (actor: typeof staff, request: unknown) =>
    deployment!.withContext(actor, (context) => context.commands!.execute(request));
  const rows = (sql: string) => {
    const db = new DatabaseSync(file);
    try {
      return db.prepare(sql).all();
    } finally {
      db.close();
    }
  };
  const exec = (sql: string) => {
    const db = new DatabaseSync(file);
    try {
      db.exec(sql);
    } finally {
      db.close();
    }
  };
  const inquiry = await deployment.submitPublicForm!('inquire', {
    submission: 'forecourt-new-inquiry',
    input: { stock_ref: 'FC-1001', name: 'New shopper', email: 'shopper@example.test', message: 'Could I arrange a test drive?' },
  });
  assert.equal(inquiry.status, 'applied');
  const [{ id }] = rows("SELECT id FROM inquiry WHERE name = 'New shopper'");
  const request = (command: string, expectedVersion: number, idempotencyKey: string) => ({
    command,
    commandVersion: 1,
    key: { id },
    expectedVersion,
    idempotencyKey,
    input: { note: command === 'closeInquiry' ? 'Test drive completed; no further questions.' : 'Confirmed a test drive by email.' },
  });
  const revision = async (command: string) =>
    (
      (await deployment!.withContext(staff, (context) => context.commands!.prepare({ command, commandVersion: 1, key: { id } }))) as {
        expectedVersion: number;
      }
    ).expectedVersion;
  const initialVersion = await revision('recordInquiryReply');
  const reply = request('recordInquiryReply', initialVersion, 'forecourt-record-reply');
  const forbidden = (error: unknown) => (error as { code?: string }).code === 'forbidden';
  await assert.rejects(execute(shopper, reply), forbidden);
  await deployment.withContext(null, async (context) => {
    assert.equal(context.commands, undefined);
  });
  assert.equal(rows('SELECT count(*) AS n FROM inquiry_activity')[0].n, 0);
  const first = await execute(staff, reply);
  assert.equal(first.status, 'applied');
  assert.equal((await execute(staff, reply)).replayed, true);
  assert.deepEqual(
    rows(`SELECT status, version FROM inquiry WHERE id = ${id}`).map((row) => ({ ...row })),
    [{ status: 'replied', version: 1 }],
  );
  assert.equal(rows('SELECT actor_id FROM inquiry_activity')[0].actor_id, staff.id);
  assert.equal(rows('SELECT count(*) AS n FROM inquiry_activity')[0].n, 1);
  await assert.rejects(
    execute(otherStaff, request('closeInquiry', initialVersion, 'forecourt-stale-close')),
    (error: unknown) => (error as { code?: string }).code === 'stale_record',
  );
  const repliedVersion = await revision('closeInquiry');
  // A failure after the status update must roll back the entire workflow.
  exec("CREATE TRIGGER fail_history BEFORE INSERT ON inquiry_activity BEGIN SELECT RAISE(ABORT, 'fixture history failure'); END");
  await assert.rejects(execute(staff, request('closeInquiry', repliedVersion, 'forecourt-failed-close')));
  assert.equal(rows(`SELECT status FROM inquiry WHERE id = ${id}`)[0].status, 'replied');
  exec('DROP TRIGGER fail_history');
  await execute(otherStaff, request('closeInquiry', repliedVersion, 'forecourt-close-inquiry'));
  await deployment.retire();
  await registry.closeAll();
  registry = new Registry();
  deployment = await bind();
  assert.equal((await execute(staff, reply)).replayed, true, 'the original receipt survives restart');
  assert.deepEqual(
    rows(`SELECT status, version FROM inquiry WHERE id = ${id}`).map((row) => ({ ...row })),
    [{ status: 'closed', version: 2 }],
  );
  assert.deepEqual(
    rows('SELECT actor_id FROM inquiry_activity ORDER BY id').map((row) => row.actor_id),
    [staff.id, otherStaff.id],
  );
  await assert.rejects(
    async () => execute(staff, request('recordInquiryReply', await revision('recordInquiryReply'), 'forecourt-closed-reply')),
    (error: unknown) => (error as { code?: string }).code === 'ineligible_state',
  );
  assert.equal(rows('SELECT count(*) AS n FROM inquiry_activity')[0].n, 2);
});
