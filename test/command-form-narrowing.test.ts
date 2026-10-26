/**
 * Skill run: the scaffold narrows a request's tenant to the chosen unit's (`form.fields.tenant_id.where`), and every
 * command that moved a request — whose only input was a vendor — was refused `400 invalid_input` on tenant_id with no
 * reason: the narrowing was judged on every write, reading the tenant inside a command that does not read tenants.
 * A write that sets neither the reference nor what narrows it is not judged by it; one that does and breaks it is
 * refused with the pairing said.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandEnvelope } from '../packages/mistri/src/server/testing/appRequests.js';
import { policyServer, sourceUrl } from './support/policyServer.js';

const SQL = `CREATE TABLE unit(id INTEGER PRIMARY KEY, number TEXT NOT NULL);
  CREATE TABLE tenant(id INTEGER PRIMARY KEY, unit_id INTEGER NOT NULL REFERENCES unit(id), name TEXT NOT NULL);
  CREATE TABLE request(id INTEGER PRIMARY KEY, title TEXT NOT NULL, unit_id INTEGER NOT NULL REFERENCES unit(id),
    tenant_id INTEGER REFERENCES tenant(id), status TEXT NOT NULL DEFAULT 'open');
  INSERT INTO unit VALUES (1, '101'), (2, '102');
  INSERT INTO tenant VALUES (1, 1, 'Ana'), (2, 2, 'Ben');
  INSERT INTO request VALUES (1, 'Leak', 1, 1, 'open');`;
/* Under a row policy, as the skill run's App was: its commands' writes are held to the App's every rule. */
const POLICY = `export default { appId: 'desk', resultReferences: { assign: () => [], misfile: () => [] }, resolveRows() { return { request: true, unit: true, tenant: true }; } };`;
const COMMANDS = `import { defineCommand, defineCommands } from ${sourceUrl('packages/mistri/src/server/commands/businessCommands.ts')};
export default defineCommands({
  // Moves the request and reads nothing else: tenants are not its business.
  assign: defineCommand({ source: 'main', target: 'request', write: ['request'],
    async handle({ db, record }) { await db.request.update(record, { status: 'assigned' }); return {}; } }),
  // Sets the tenant to one of another unit: the narrowing refuses it, and says why.
  misfile: defineCommand({ source: 'main', target: 'request', read: ['tenant'], write: ['request'],
    async handle({ db, record }) { await db.request.update(record, { tenant_id: 2 }); return {}; } }),
});`;

test("a command is judged by a form's narrowing only where it sets it, and a refusal says the pairing", { timeout: 60_000 }, async (t) => {
  const server = await policyServer(t, {
    app: {
      id: 'desk',
      name: 'Desk',
      auth: { signUp: 'open', defaultRole: 'clerk', rows: 'policy', roles: { clerk: { read: true, commands: ['assign', 'misfile'] } } },
      resources: {
        request: {
          access: 'write',
          form: { show: ['title', 'unit_id', 'tenant_id'], fields: { tenant_id: { where: { unit_id: 'unit_id' } } } },
          actions: { assign: { label: 'Assign', command: 'assign' }, misfile: { label: 'Misfile', command: 'misfile' } },
        },
        unit: {},
        tenant: {},
      },
      views: { requests: { kind: 'list', from: 'request' } },
      home: 'requests',
      nav: ['requests'],
    },
    sql: SQL,
    commands: COMMANDS,
    policy: POLICY,
  });
  const clerk = await server.signUp('clerk');
  const run = async (command: string) => {
    const prepared = await server.api('commands/prepare', { command, commandVersion: 1, key: { id: 1 } }, clerk);
    assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
    return server.api(
      'commands/execute',
      commandEnvelope({ command, commandVersion: 1, key: { id: 1 }, expectedVersion: prepared.body.expectedVersion, input: {} }),
      clerk,
    );
  };
  const assigned = await run('assign');
  assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
  const misfiled = await run('misfile');
  assert.equal(misfiled.status, 400, JSON.stringify(misfiled.body));
  assert.equal(misfiled.body.code, 'invalid_input');
  assert.equal(misfiled.body.field, 'tenant_id');
  assert.match(misfiled.body.message, /Choose one whose unit_id is this record's unit_id/);
  assert.doesNotMatch(JSON.stringify(misfiled.body), /Ben|102/);
});
