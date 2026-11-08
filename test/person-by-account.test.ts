/**
 * `auth.me.by: 'account'` outside a tenant App: the people table's column holds the account's id, not its email.
 * What that buys, and what is proved here: an email change keeps the person, an email another account takes
 * later does not reach the old person's row, and an account with no row is nobody (or is given one, with
 * `create`, found by its id the way an email-bound row is found by its email).
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';

const desk = (me: Record<string, unknown>, rows?: string) =>
  parseAppConfig(
    {
      id: 'desk',
      name: 'Desk',
      connection: 'desk',
      resources: { employee: {}, ticket: { access: 'write', segments: { mine: 'owner_id = me' } } },
      auth: {
        providers: ['email'],
        defaultRole: 'agent',
        me: { from: 'employee', column: 'account_id', by: 'account', ...me },
        ...(rows ? { rows } : {}),
        roles: { agent: { read: true, write: ['ticket'] } },
      },
      views: { tickets: { kind: 'list', from: 'ticket', tabs: ['mine'] } },
      home: 'tickets',
      nav: ['tickets'],
    },
    'desk',
  );

const SQL = `
  CREATE TABLE employee (id INTEGER PRIMARY KEY, account_id TEXT NOT NULL UNIQUE, email TEXT, full_name TEXT NOT NULL DEFAULT '');
  CREATE TABLE ticket (id INTEGER PRIMARY KEY, subject TEXT NOT NULL, owner_id INTEGER REFERENCES employee(id));
  INSERT INTO employee (account_id, email, full_name) VALUES ('account-ada', 'ada@example.test', 'Ada');
  INSERT INTO ticket (subject, owner_id) VALUES ('Ada''s ticket', 1), ('Nobody''s ticket', NULL);`;

async function served(
  manifest: ReturnType<typeof desk>,
  work: (ctx: {
    as: (who: Identity) => void;
    ask: (q: string) => Promise<string[]>;
    rows: (sql: string) => Array<Record<string, unknown>>;
  }) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-person-account-'));
  const path = join(directory, 'desk.db');
  const db = new DatabaseSync(path);
  db.exec(SQL);
  db.close();
  const registry = new Registry();
  registry.add({ id: 'desk', name: 'Desk', url: path, source: 'config', writable: true });
  let who: Identity = { id: 'account-ada', who: 'ada@example.test', role: 'agent' };
  const host: AppHost = {
    app: { path: '/desk/app.ts', app: manifest, pages: [], sources: {} },
    pages: [],
    auth: {
      spec: manifest.auth!,
      store: join(directory, 'sessions.db'),
      handler: async () => {},
      close: async () => {},
      session: async () => who,
    },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], pages: [] });
  try {
    server.listen(0, bound.host);
    await once(server, 'listening');
    bound.port = (server.address() as { port: number }).port;
    const ask = async (q: string) => {
      const res = await fetch(`http://${bound.host}:${bound.port}/api/run`, {
        method: 'POST',
        signal: AbortSignal.timeout(5_000),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app: 'desk', q }),
      });
      const body = (await res.json()) as { rows?: Array<Record<string, unknown>> };
      return (body.rows ?? []).map((row) => String(row.subject ?? row.full_name));
    };
    const rows = (sql: string) => {
      const check = new DatabaseSync(path);
      try {
        return check
          .prepare(sql)
          .all()
          .map((row) => ({ ...row }));
      } finally {
        check.close();
      }
    };
    await work({ as: (next) => void (who = next), ask, rows });
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    rmSync(directory, { recursive: true, force: true });
  }
}

test('by: account is for an App that is not a tenant App, and says what it is', () => {
  assert.equal(desk({}).auth?.me?.by, 'account');
  assert.throws(() => desk({ by: 'email' }), /"by" is 'account'/);
  assert.throws(() => desk({ by: 'account' }, 'tenant'), /not a tenant App/);
});

test('an email change keeps the person: `me` is found by the account, not the address', { timeout: 20_000 }, async () => {
  await served(desk({}), async ({ as, ask }) => {
    assert.deepEqual(await ask('ticket owner_id = me'), ["Ada's ticket"]);
    as({ id: 'account-ada', who: 'ada.renamed@example.test', role: 'agent' });
    assert.deepEqual(await ask('ticket owner_id = me'), ["Ada's ticket"]);
  });
});

test('a recycled email does not inherit the old person; the old row names an account that is not theirs', { timeout: 20_000 }, async () => {
  await served(desk({}), async ({ as, ask }) => {
    as({ id: 'account-eve', who: 'ada@example.test', role: 'agent' });
    assert.deepEqual(await ask('ticket owner_id = me'), []);
  });
});

test('an account with no row is nobody without create, and is given one by its id with it', { timeout: 20_000 }, async () => {
  await served(desk({}), async ({ as, ask, rows }) => {
    as({ id: 'account-new', who: 'new@example.test', role: 'agent' });
    assert.deepEqual(await ask('ticket owner_id = me'), []);
    await ask('employee');
    assert.deepEqual(
      rows('SELECT account_id FROM employee ORDER BY id').map((row) => row.account_id),
      ['account-ada'],
    );
  });
  await served(desk({ create: { name: 'full_name' } }), async ({ as, ask, rows }) => {
    as({ id: 'account-new', who: 'new@example.test', role: 'agent', name: 'New Person' });
    await ask('employee');
    await ask('employee');
    assert.deepEqual(
      rows('SELECT account_id, full_name FROM employee ORDER BY id'),
      [
        { account_id: 'account-ada', full_name: 'Ada' },
        { account_id: 'account-new', full_name: 'New Person' },
      ],
      'one row, keyed by the account',
    );
    // The recycled address gets a row of its own account's, and the first person's stays theirs.
    as({ id: 'account-eve', who: 'ada@example.test', role: 'agent', name: 'Eve' });
    await ask('employee');
    assert.deepEqual(
      rows('SELECT account_id FROM employee ORDER BY id').map((row) => row.account_id),
      ['account-ada', 'account-new', 'account-eve'],
    );
    assert.deepEqual(await ask('ticket owner_id = me'), []);
  });
});
