/**
 * A fixed action granted without write (`roles.<role>.actions`) under a row
 * policy (field report R3): an action that stamps `me` was refused for an
 * account whose address was not yet proven, as "The change is unavailable…",
 * with nothing on the server's terminal even with diagnostics on, and a change
 * that was no granted action was blamed on the row policy. Each now says its
 * rule to the person and to the operator.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { policyServer } from './support/policyServer.js';

const APP = {
  id: 'spoke',
  name: 'Spoke',
  auth: {
    signUp: 'open',
    defaultRole: 'mechanic',
    rows: 'policy',
    me: { from: 'staff', column: 'email' },
    roles: { admin: { read: true, write: true }, mechanic: { read: true, actions: { job: ['start'] } } },
  },
  resources: {
    job: {
      access: 'write',
      actions: { start: { label: 'Start', set: { status: 'working', started_by: { auto: 'me' } }, when: 'status = open' } },
    },
    staff: {},
  },
  views: { jobs: { kind: 'list', from: 'job' } },
  home: 'jobs',
  nav: ['jobs'],
};
const POLICY = `export default { appId: 'spoke', resolveRows() {
  return { job: { groups: [[{ column: 'bench', op: '=', value: 1 }]] }, staff: true };
} };`;
const SQL = `CREATE TABLE staff(id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL);
  CREATE TABLE job(id INTEGER PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', bench INTEGER NOT NULL,
    started_by INTEGER REFERENCES staff(id));
  INSERT INTO staff VALUES (1, 'Mo', 'mo@example.org');
  INSERT INTO job VALUES (1, 'Tune', 'open', 1, NULL), (2, 'Brakes', 'open', 1, NULL);`;
const START = { status: 'working', started_by: 'me' };

test(
  'a granted action under a row policy runs, and each refusal of it says why, to the person and the terminal',
  { timeout: 60_000 },
  async (t) => {
    const server = await policyServer(t, { app: APP, policy: POLICY, sql: SQL });

    // Someone who signed themselves up and has not proven the address is no `me` yet: said so, not "unavailable".
    const stranger = await server.signUp('stranger');
    const unproven = await server.api('update', { table: 'job', key: { id: 1 }, values: START }, stranger);
    assert.equal(unproven.body.outcome, 'rejected', JSON.stringify(unproven.body));
    assert.match(unproven.body.message, /This action records who made it, and no proven account is signed in/);
    assert.match(server.log(), /POST \/api\/update refused \(400 validation_failed\): This action records who made it/);

    // The owner's mechanic is proven (R2) and is Mo's staff row: the action runs and stamps the row.
    const owner = await server.owner();
    const made = await server.call(
      '/api/accounts',
      { app: 'spoke', operation: 'create', name: 'Mo', email: 'mo@example.org', roles: ['mechanic'], password: 'mo-fixture-password-1' },
      owner,
    );
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const mo = await server.signIn('mo@example.org', 'mo-fixture-password-1');
    const started = await server.api('update', { table: 'job', key: { id: 1 }, values: START }, mo);
    assert.equal(started.status, 200, JSON.stringify(started.body) + server.log());
    assert.equal(started.body.applied.started_by, 1);

    // A change that is no granted action is the grant's refusal, not the policy's alone.
    const edit = await server.api('update', { table: 'job', key: { id: 2 }, values: { title: 'Renamed' } }, mo);
    assert.equal(edit.status, 403, JSON.stringify(edit.body));
    assert.match(edit.body.message, /This change is not one of the actions this account may run on this "job" record now/);
    assert.match(server.log(), /refused \(403 forbidden\): This change is not one of the actions/);
  },
);
