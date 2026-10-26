/**
 * A fixed action granted without write (`roles.<role>.actions`) under a row
 * policy: admitted by the policy's own scoped writer exactly as an ordinary
 * App admits it — the action's `set` word for word, its reason, its `when` on
 * the stored row, the stamps the server's — and only on a row the policy
 * gives the principal, before the write and after it. Nothing the browser
 * sends widens it into an edit or moves it onto another account's rows.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { loadHttpAppPolicy } from '../packages/mistri/src/server/policy/appPolicyHttp.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';

const appId = 'desk-runs';
const owner = 'desk-runs-db';
const SUBMIT = { label: 'Submit for review', set: { status: 'review' }, when: 'status = draft' };
const APPROVE = {
  label: 'Approve payroll',
  set: { status: 'approved', approved_by: { auto: 'me' }, approved_at: { auto: 'now' } },
  reason: 'note',
  when: 'status = review',
};
// Moves the run to the other desk: the policy's writer must refuse the row it would leave behind.
const HAND_OVER = { label: 'Hand to desk two', set: { desk: 2 } };
const REOPEN = { label: 'Reopen', set: { status: 'draft' }, when: 'status = review' };
// A machine whose `review` state has its own stamp column (review_at): the move to it stamps the moment itself.
const MACHINE = {
  column: 'status',
  states: { draft: { on: { submit: 'review' } }, review: { on: { approve: 'approved' } }, approved: { final: true } },
};
const manifest = (rows: 'policy' | 'tenant' = 'policy', machine = false) => ({
  id: appId,
  name: 'Desk runs',
  sources: { main: { connection: owner, default: true } },
  resources: {
    run: machine
      ? { access: 'write', machine: MACHINE }
      : { access: 'write', actions: { submit: SUBMIT, approve: APPROVE, handOver: HAND_OVER, reopen: REOPEN } },
  },
  auth: {
    rows,
    roles: {
      manager: { read: true, actions: { run: machine ? ['submit', 'approve'] : ['submit', 'approve', 'handOver'] } },
      clerk: { read: true },
    },
  },
  views: { runs: { kind: 'list', from: 'run' } },
  home: 'runs',
  nav: ['runs'],
});

test('a fixed-action grant loads under a row policy and is still refused in a tenant App', () => {
  assert.doesNotThrow(() => parseAppConfig(manifest(), 'desk runs'));
  assert.throws(
    () => parseAppConfig(manifest('tenant'), 'desk runs'),
    /"actions" grants fixed actions without write, which is not supported with "rows": "tenant"/,
  );
});

async function fixture(t: TestContext, machine = false) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-action-grants-policy-'));
  const file = join(directory, 'runs.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE run (id INTEGER PRIMARY KEY, desk INTEGER NOT NULL, title TEXT NOT NULL, gross INTEGER NOT NULL,
      status TEXT NOT NULL, approved_by TEXT, approved_at TIMESTAMP, note TEXT, review_at TIMESTAMP);
    INSERT INTO run (desk, title, gross, status) VALUES
      (1, 'September', 1000, 'draft'), (1, 'August', 900, 'review'), (2, 'Other desk', 700, 'draft'), (2, 'Other review', 600, 'review');`);
  const registry = new Registry();
  registry.add({ id: owner, name: owner, url: file, source: 'config', writable: true });
  const app = parseAppConfig(manifest('policy', machine), 'desk runs');
  const control = { identity: { id: 'desk-one', who: 'ada@example.test', role: 'manager' } as Identity };
  const host: AppHost = {
    app: { app, path: join(directory, 'app.ts'), pages: [], sources: {} },
    pages: [],
    auth: {
      spec: app.auth!,
      store: join(directory, 'auth.db'),
      close() {},
      handler: async () => {},
      session: async () => control.identity,
    },
  };
  const policyFile = join(directory, 'policy.mjs');
  writeFileSync(
    policyFile,
    `export default { appId: ${JSON.stringify(appId)},
    resolveRows(principal) { return { run: { groups: [[{ column: 'desk', op: '=', value: principal.id === 'desk-two' ? 2 : 1 }]] } }; } };`,
  );
  const policy = await loadHttpAppPolicy({ app, registry, file: policyFile, verifySession: async () => control.identity });
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], policy });
  server.listen(0, bound.host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  t.after(async () => {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await policy.retire();
    await registry.closeAll();
    clearJournal();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const call = async (method: 'GET' | 'POST', path: string, body?: object) => {
    const response = await fetch(`http://${bound.host}:${address.port}${path}?app=${appId}`, {
      method,
      signal: AbortSignal.timeout(5000),
      headers: { 'content-type': 'application/json', 'x-mistri-account': control.identity.id },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  const update = (id: number, values: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    call('POST', '/api/update', { table: 'run', key: { id }, values, ...extra });
  const row = (id: number) => ({
    ...db.prepare('SELECT desk, status, gross, title, approved_by, approved_at, note, review_at FROM run WHERE id = ?').get(id),
  });
  return { call, update, row, control };
}

test('under a row policy the grant is offered, admitted exactly and stamped by the server', async (t) => {
  const { call, update, row } = await fixture(t);
  const served = await call('GET', '/api/app');
  assert.deepEqual(served.body.app.grantedActions, { run: ['submit', 'approve', 'handOver'] });
  assert.deepEqual(served.body.app.writableTables, [], 'the role writes no table');

  const submitted = await update(1, { status: 'review' });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  assert.equal(row(1).status, 'review');

  const approved = await update(2, { status: 'approved', approved_by: 'me', approved_at: 'now', note: 'Checked every line.' });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const stored = row(2);
  assert.equal(stored.status, 'approved');
  assert.equal(stored.approved_by, 'ada@example.test', 'the verified session, never the word or the body');
  assert.match(String(stored.approved_at), /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
});

test('under a row policy a forged body is refused whole, and nothing near the action is written', async (t) => {
  const { update, row } = await fixture(t);
  for (const [values, extra] of [
    [{ status: 'review', gross: 1 }, {}], // another column beside the action's
    [{ status: 'approved' }, {}], // a value no granted action sets
    [{ gross: 1 }, {}], // an edit
    [{ status: 'draft' }, {}], // Reopen is the resource's, not the role's
    [{ status: 'approved', approved_by: 'mallory@example.test', approved_at: 'now', note: 'ok' }, {}], // a person the caller chose
    [{ status: 'approved', approved_by: 'me', approved_at: '1999-01-01 00:00:00', note: 'ok' }, {}], // a moment the caller chose
    [{ status: 'approved', approved_by: 'me', approved_at: 'now' }, {}], // the reason the action asks for
    [{ status: 'review' }, { restore: true }], // a field the route does not take
    [{ status: 'review' }, { role: 'manager', roles: ['clerk'] }],
  ] as const) {
    const answer = await update(1, values, extra);
    assert.equal(answer.status, 403, `${JSON.stringify(values)} ${answer.status}`);
  }
  // The action's `when` is judged on the stored row: September is a draft, so the role is not granted it now (403).
  assert.equal((await update(1, { status: 'approved', approved_by: 'me', approved_at: 'now', note: 'ok' })).status, 403);
  assert.deepEqual(row(1), {
    desk: 1,
    status: 'draft',
    gross: 1000,
    title: 'September',
    approved_by: null,
    approved_at: null,
    note: null,
    review_at: null,
  });
});

test('the row policy narrows which rows a granted action may touch, before the write and after it', async (t) => {
  const { update, row, control, call } = await fixture(t);
  // Another desk's run is not this principal's: the same exact action is refused, as a hidden row.
  assert.equal((await update(3, { status: 'review' })).status, 403);
  assert.equal((await update(4, { status: 'approved', approved_by: 'me', approved_at: 'now', note: 'ok' })).status, 403);
  assert.deepEqual([row(3).status, row(4).status], ['draft', 'review']);
  // A granted action whose result leaves the principal's rows is refused by the policy's writer and rolled back.
  const handed = await update(1, { desk: 2 });
  assert.notEqual(handed.status, 200, JSON.stringify(handed.body));
  assert.equal(row(1).desk, 1);
  // The other desk's manager runs the same grant on their own rows, and only theirs.
  control.identity = { id: 'desk-two', who: 'bo@example.test', role: 'manager' };
  assert.equal((await update(3, { status: 'review' })).status, 200);
  assert.equal((await update(1, { status: 'review' })).status, 403);
  assert.deepEqual([row(1).status, row(3).status], ['draft', 'review']);
  // A role without the grant is offered nothing and refused the same body.
  control.identity = { id: 'desk-one', who: 'cy@example.test', role: 'clerk' };
  assert.equal((await call('GET', '/api/app')).body.app.grantedActions, undefined);
  assert.equal((await update(1, { status: 'review' })).status, 403);
  assert.equal(row(1).status, 'draft');
});

test("under a row policy a granted verb's own stamp is written with it, and no other column rides along", async (t) => {
  const { update, row } = await fixture(t, true);
  // The server adds review_at beside the move; the grant must count it as the verb's own.
  const submitted = await update(1, { status: 'review' });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  assert.equal(row(1).status, 'review');
  assert.match(String(row(1).review_at), /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/, 'the stamp is written by the server');
  // A caller naming the stamp, or any other column, still widens nothing.
  for (const values of [
    { status: 'review', review_at: '1999-01-01 00:00:00' },
    { status: 'review', gross: 1 },
  ]) {
    const answer = await update(3, values);
    assert.equal(answer.status, 403, JSON.stringify(values));
  }
  assert.deepEqual([row(3).status, row(3).review_at, row(3).gross], ['draft', null, 700]);
});
