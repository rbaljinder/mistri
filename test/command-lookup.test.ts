/**
 * Lookup: what a command reads from its App's other sources before its
 * transaction opens — here an HTTP connection, through egress and its
 * description. The result reaches the handler; a missing row refuses by its
 * own code; a role that cannot read the looked-up resource is forbidden
 * before anything is asked; a lookup that fails refuses a first attempt,
 * temporarily_unavailable and not applied, while a replay still answers its
 * receipt; and the rules an App is held to (a declared source; not a
 * row-policy App; in a tenant App, global resources only).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { draftDescription } from '../packages/engine/src/adapters/http/httpDescription.js';
import { readOpenApi } from '../packages/engine/src/adapters/http/openapi.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { bindBusinessCommands } from '../packages/mistri/src/server/commands/businessCommandAccess.js';
import { BusinessCommandExecutionError, executeBusinessCommand } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { BusinessCommandDefinitionError, defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { commandLookupProblem } from '../packages/mistri/src/server/commands/commandLookupRules.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { httpConnectionOf } from '../packages/engine/src/server/httpConnection.js';
import { parseAppConfig, type AppDef } from '../packages/mistri/src/shared/app.js';
import { startFakeRest } from './support/fakeRest.js';

const spec = JSON.parse(readFileSync(new URL('./fixtures/http/openapi.json', import.meta.url), 'utf8'));
const staff = { id: 'account-a', appId: 'shop', roles: ['staff'] };
const clerk = { id: 'account-b', appId: 'shop', roles: ['clerk'] };
const refusal =
  (code: string, outcome = 'not_applied') =>
  (error: unknown) => {
    assert.ok(error instanceof BusinessCommandExecutionError, String(error));
    assert.deepEqual([error.code, error.outcome], [code, outcome]);
    return true;
  };

const app = () =>
  parseAppConfig(
    {
      id: 'shop',
      name: 'Shop',
      sources: { shop: { connection: 'private-db', default: true }, desk: { connection: 'desk-api' } },
      resources: { vehicle: { access: 'write' }, 'desk.contacts': {} },
      auth: { roles: { staff: { read: true, commands: ['assignContact'] }, clerk: { read: ['vehicle'], commands: ['assignContact'] } } },
      views: { vehicles: { kind: 'list', from: 'vehicle' } },
      home: 'vehicles',
    },
    'lookup fixture',
  );

const assignContact = defineCommand({
  source: 'shop',
  target: 'vehicle',
  input: {},
  sources: { desk: ['contacts'] },
  output: { parse: (value: unknown) => value as { contact: string; leads: string[] } },
  async lookup({ sources, record }) {
    const contact = await sources.desk.contacts.get(String(record!.contact_ref));
    const leads = await sources.desk.contacts.where({ status: 'lead' }).limit(3);
    return { name: contact.name, leads: leads.map((row) => row.id) };
  },
  async handle({ db, record, lookup }) {
    const { name, leads } = lookup as { name: string; leads: string[] };
    await db.vehicle.update(record!, { contact_name: name });
    return { contact: name, leads };
  },
});

async function fixture(
  run: (f: {
    db: DatabaseSync;
    api: Awaited<ReturnType<typeof startFakeRest>>;
    execute: (key: number, who?: typeof staff, request?: Record<string, unknown>) => Promise<{ result: unknown; replayed: boolean }>;
  }) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-command-lookup-'));
  const path = join(directory, 'shop.db');
  const db = new DatabaseSync(path);
  const api = await startFakeRest();
  const registry = new Registry();
  try {
    db.exec(`CREATE TABLE vehicle (id INTEGER PRIMARY KEY, contact_ref TEXT NOT NULL, contact_name TEXT, version INTEGER NOT NULL DEFAULT 0);
      INSERT INTO vehicle VALUES (1, 'c-01', NULL, 0), (2, 'c-99', NULL, 0), (3, 'c-02', NULL, 0);`);
    migrateSqliteCommandJournal(path);
    registry.add({ id: 'private-db', name: 'Shop', url: path, writable: true, source: 'config' });
    const http = httpConnectionOf(
      { name: 'Desk', kind: 'http', url: `${api.origin}/v1`, insecure: true, description: draftDescription(readOpenApi(spec)) },
      join(directory, 'config.json'),
    )!;
    registry.add({ id: 'desk-api', name: 'Desk', url: `${api.origin}/v1`, writable: false, source: 'config', http });
    const loaded = app();
    const resources = await loadAppRuntimeResources(registry, loaded, 'private-db');
    const binding = bindBusinessCommands({
      app: loaded,
      registry: defineCommands({ assignContact }),
      resources,
      writableConnection: (id) => id === 'private-db',
    });
    let n = 0;
    const execute = async (key: number, who = staff, request: Record<string, unknown> = {}) => {
      const answer = await executeBusinessCommand(binding, who, {
        command: 'assignContact',
        commandVersion: 1,
        key: { id: key },
        expectedVersion: 0,
        idempotencyKey: `lookup-request-${String(++n).padStart(4, '0')}`,
        input: {},
        ...request,
      });
      return { result: answer.result, replayed: answer.replayed };
    };
    await run({ db, api, execute });
  } finally {
    await registry.closeAll();
    await api.close().catch(() => {});
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test('lookup reads the API before the transaction, and the handler writes with what it read', async () => {
  await fixture(async (f) => {
    assert.deepEqual(await f.execute(1), { result: { contact: 'Contact 1', leads: ['c-01', 'c-04', 'c-07'] }, replayed: false });
    assert.equal(f.db.prepare('SELECT contact_name FROM vehicle WHERE id = 1').get()!.contact_name, 'Contact 1');
    assert.deepEqual(
      f.api.seen.map((seen) => [seen.method, seen.path]),
      [
        ['GET', '/v1/contacts/c-01'],
        ['GET', '/v1/contacts'],
      ],
    );
    assert.deepEqual(f.api.seen[1].query.getAll('status'), ['lead']);
  });
});

test('a row the API does not have refuses by its own code, and a role that cannot read it is forbidden before anything is asked', async () => {
  await fixture(async (f) => {
    await assert.rejects(f.execute(2), refusal('not_found'));
    assert.equal(f.db.prepare('SELECT version FROM vehicle WHERE id = 2').get()!.version, 0);
    const asked = f.api.seen.length;
    await assert.rejects(f.execute(1, clerk), refusal('forbidden'));
    assert.equal(f.api.seen.length, asked, 'the clerk reads no desk contact, so none was asked for');
  });
});

test('a lookup that fails refuses a first attempt, not applied; the replay of one that committed still answers its receipt', async () => {
  await fixture(async (f) => {
    const first = await f.execute(1, staff, { idempotencyKey: 'lookup-kept-receipt' });
    await f.api.close();
    const replay = await f.execute(1, staff, { idempotencyKey: 'lookup-kept-receipt' });
    assert.deepEqual(replay, { result: first.result, replayed: true });
    await assert.rejects(f.execute(3), refusal('temporarily_unavailable'));
    assert.equal(f.db.prepare('SELECT contact_name FROM vehicle WHERE id = 3').get()!.contact_name, null);
  });
});

test('an App is held to its lookups: a declared source, never a row-policy App, and in a tenant App only global resources', () => {
  const declared = app();
  assert.equal(commandLookupProblem(declared, 'assignContact', { desk: ['contacts'] }), undefined);
  assert.match(
    commandLookupProblem(declared, 'assignContact', { crm: ['contacts'] })!,
    /looks up source "crm", which the App does not declare/,
  );
  const policy = { ...declared, auth: { ...declared.auth!, rows: 'policy' } } as AppDef;
  assert.match(commandLookupProblem(policy, 'assignContact', { desk: ['contacts'] })!, /row-policy App .* does not do yet/);
  const tenant = (owner: string) =>
    ({
      ...declared,
      auth: { ...declared.auth!, rows: 'tenant' },
      resources: { ...declared.resources, 'desk.contacts': { ...declared.resources!['desk.contacts'], owner } },
    }) as AppDef;
  assert.equal(commandLookupProblem(tenant('global'), 'assignContact', { desk: ['contacts'] }), undefined);
  assert.match(
    commandLookupProblem(tenant('tenant'), 'assignContact', { desk: ['contacts'] })!,
    /"desk\.contacts", which is "owner": "tenant"\. A tenant App's command looks up only resources every tenant reads, "owner": "global"/,
  );
  assert.match(commandLookupProblem(tenant('platform'), 'assignContact', { desk: ['contacts'] })!, /"owner": "platform"/);
});

test('the binding asks the same question, so startup and mistri check refuse a lookup the App cannot run', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-command-lookup-'));
  const path = join(directory, 'shop.db');
  const db = new DatabaseSync(path);
  const api = await startFakeRest();
  const registry = new Registry();
  try {
    db.exec(
      'CREATE TABLE vehicle (id INTEGER PRIMARY KEY, contact_ref TEXT NOT NULL, contact_name TEXT, version INTEGER NOT NULL DEFAULT 0);',
    );
    migrateSqliteCommandJournal(path);
    registry.add({ id: 'private-db', name: 'Shop', url: path, writable: true, source: 'config' });
    registry.add({
      id: 'desk-api',
      name: 'Desk',
      url: `${api.origin}/v1`,
      writable: false,
      source: 'config',
      http: httpConnectionOf(
        { name: 'Desk', kind: 'http', url: `${api.origin}/v1`, insecure: true, description: draftDescription(readOpenApi(spec)) },
        join(directory, 'config.json'),
      )!,
    });
    const loaded = app();
    const resources = await loadAppRuntimeResources(registry, loaded, 'private-db');
    const { version: _version, ...definition } = assignContact;
    const bind = (sources: Record<string, string[]>) =>
      bindBusinessCommands({
        app: loaded,
        resources,
        writableConnection: () => true,
        registry: defineCommands({ assignContact: defineCommand({ ...definition, sources }) }),
      });
    assert.throws(
      () => bind({ crm: ['contacts'] }),
      (error: unknown) =>
        error instanceof BusinessCommandDefinitionError && /looks up source "crm", which the App does not declare/.test(error.message),
    );
    assert.throws(() => bind({ desk: ['tickets'] }), BusinessCommandDefinitionError, "desk.tickets is outside the App's resource ceiling");
    assert.ok(bind({ desk: ['contacts'] }));
  } finally {
    await registry.closeAll();
    await api.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
