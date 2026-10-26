/**
 * `me.<table>.<column>`, the signed-in person's memberships,
 * end to end in a single App: `team_id in (me.team_member.team_id)` is the
 * tickets of the reader's own teams, read per request through the request's
 * own reader — a list, a view, a count and an export alike — so another
 * team's rows are never theirs, a role that may not read the memberships is
 * refused rather than read around, and a person with no memberships, or no
 * row, matches nothing.
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
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { parseAppConfig, resolveViews, withRollups } from '../packages/mistri/src/shared/app.js';

const connection = 'me-sets-connection';
const appId = 'me-sets';
const MINE = 'team_id in (me.team_member.team_id)';
const DESK = {
  id: appId,
  name: 'Desk',
  connection,
  resources: { employee: {}, team: {}, team_member: {}, ticket: { segments: { my_teams: MINE } } },
  auth: {
    providers: ['email'],
    defaultRole: 'agent',
    me: { from: 'employee', column: 'email' },
    roles: {
      agent: { read: true, export: ['ticket'] },
      // Reads the tickets and nothing of who is in which team.
      outsider: { read: ['employee', 'ticket'] },
    },
  },
  views: {
    tickets: { kind: 'list', from: 'ticket', label: 'Tickets', tabs: ['my_teams', { label: 'All' }] },
  },
  home: 'tickets',
  nav: ['tickets'],
};

test("a list, a view, a count and an export read the reader's own teams, and no one else's", { timeout: 20_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-app-me-sets-'));
  const previous = process.env.XDG_CONFIG_HOME;
  const path = join(directory, 'desk.db');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE employee (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL);
    CREATE TABLE team (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE team_member (id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employee(id),
      team_id INTEGER NOT NULL REFERENCES team(id));
    CREATE TABLE ticket (id INTEGER PRIMARY KEY, subject TEXT NOT NULL, team_id INTEGER REFERENCES team(id));
    INSERT INTO employee VALUES (1, 'Bo', 'bo@example.test'), (2, 'Ada', 'ada@example.test'), (3, 'Cy', 'cy@example.test');
    INSERT INTO team VALUES (10, 'Network'), (20, 'Hardware'), (30, 'Facilities');
    INSERT INTO team_member VALUES (1, 2, 10), (2, 2, 20), (3, 1, 30);
    INSERT INTO ticket VALUES (1, 'VPN', 10), (2, 'Laptop', 20), (3, 'Door', 30), (4, 'Printer', NULL);
  `);
  db.close();
  clearJournal(connection);
  const registry = new Registry();
  registry.add({ id: connection, name: 'Desk', url: path, source: 'config' });
  const manifest = parseAppConfig(DESK, 'me sets fixture');
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
  process.env.XDG_CONFIG_HOME = directory;
  try {
    server.listen(0, bound.host);
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const post = async (route: string, body: Record<string, unknown>) => {
      const response = await fetch(`http://${bound.host}:${address.port}${route}`, {
        signal: AbortSignal.timeout(5_000),
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'identity' },
        body: JSON.stringify({ app: appId, ...body }),
      });
      const text = await response.text();
      return { status: response.status, text, body: response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : undefined };
    };
    const ids = async (q: string) => {
      const { body, text } = await post('/api/run', { q, exactCount: true });
      assert.deepEqual(body.errors, [], `${q}: ${text}`);
      return (body.rows as Array<{ id: number }>).map((row) => row.id).sort();
    };

    // Ada is in Network and Hardware; Bo in Facilities.
    assert.deepEqual(await ids(`ticket ${MINE}`), [1, 2]);
    assert.deepEqual(await ids(`ticket team_id in me.team_member.team_id`), [1, 2], 'the brackets are optional, as for any list');
    assert.deepEqual(await ids(`ticket team_id not in (me.team_member.team_id)`), [3]);
    const viewed = await post('/api/view/run', { view: { id: 'v', name: '', base: 'ticket', columns: [{ path: 'id' }] }, query: MINE });
    assert.deepEqual((viewed.body.rows as Array<{ id: number }>).map((row) => row.id).sort(), [1, 2]);
    const counted = await post('/api/breakdown', { text: `ticket ${MINE} count` });
    assert.deepEqual(counted.body.rows, [{ count: 2 }]);
    const exported = await post('/api/export', { q: `ticket ${MINE}`, format: 'json' });
    assert.equal(exported.status, 200, exported.text);
    assert.deepEqual((JSON.parse(exported.text) as Array<{ id: number }>).map((row) => row.id).sort(), [1, 2]);
    /* A tab names the segment, whose text says no `me` of its own: the list and its export still read as Ada. */
    assert.deepEqual(await ids('ticket my_teams'), [1, 2]);
    const named = await post('/api/export', { q: 'ticket my_teams', format: 'json' });
    assert.equal(named.status, 200, named.text);
    assert.deepEqual((JSON.parse(named.text) as Array<{ id: number }>).map((row) => row.id).sort(), [1, 2]);

    // Bo, per request: his own team, never Ada's.
    who = { id: 'account-bo', who: 'bo@example.test', role: 'agent' };
    assert.deepEqual(await ids(`ticket ${MINE}`), [3]);
    // Cy has a row and no team, and someone with no row has neither: nothing is theirs, and nothing fails.
    who = { id: 'account-cy', who: 'cy@example.test', role: 'agent' };
    assert.deepEqual(await ids(`ticket ${MINE}`), []);
    who = { id: 'account-new', who: 'new@example.test', role: 'agent' };
    assert.deepEqual(await ids(`ticket ${MINE}`), []);

    // A role that may not read who is in which team is told so, never answered from rows it cannot read.
    who = { id: 'account-out', who: 'ada@example.test', role: 'outsider' };
    const refused = await post('/api/run', { q: `ticket ${MINE}` });
    assert.match(refused.body.errors?.[0]?.message ?? '', /me\.team_member\.team_id: "team_member" is not a resource this reader reads/);
    // The word is no text, and a set is asked with in.
    who = { id: 'account-ada', who: 'ada@example.test', role: 'agent' };
    const compared = await post('/api/run', { q: 'ticket team_id = me.team_member.team_id' });
    assert.match(compared.body.errors?.[0]?.message ?? '', /is a set of values: ask it with in/);
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    clearJournal(connection);
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a membership is judged against the catalog as the App loads: a table people are in, one link to them, one kind', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-app-me-sets-catalog-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(join(directory, 'desk.db'));
  db.exec(`CREATE TABLE employee (id INTEGER PRIMARY KEY, email TEXT NOT NULL);
    CREATE TABLE team (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE team_member (id INTEGER PRIMARY KEY, employee_id INTEGER REFERENCES employee(id), mentor_id INTEGER REFERENCES employee(id),
      team_id INTEGER REFERENCES team(id), role TEXT);
    CREATE TABLE seat (id INTEGER PRIMARY KEY, employee_id INTEGER REFERENCES employee(id), team_id INTEGER REFERENCES team(id));
    CREATE TABLE ticket (id INTEGER PRIMARY KEY, subject TEXT, team_id INTEGER REFERENCES team(id));`);
  db.close();
  const adapter = new SqliteAdapter(join(directory, 'desk.db'), 'desk');
  t.after(() => adapter.close());
  const schema = await adapter.introspect();
  // The view's own standing query: a segment that does not read is left out of the catalog before a view meets it, so the
  // person-aware reading of `me.<table>.<column>` that says why is the view's, not a tab's.
  const tab = (query: string) => {
    const app = parseAppConfig(
      {
        ...DESK,
        resources: { ...DESK.resources, seat: {} },
        views: { tickets: { kind: 'list', from: 'ticket', label: 'Tickets', query } },
      },
      'me.ts',
    );
    return resolveViews(app, withRollups(app, schema)).tickets.error ?? '';
  };

  // Two columns point at people: which rows are the reader's is not one answer.
  assert.match(tab(MINE), /"employee_id" and "mentor_id" of team_member each point at employee/);
  assert.match(tab('team_id in (me.team.id)'), /no column of team points at employee/);
  assert.match(tab('team_id in (me.squad.team_id)'), /"squad" is not a resource this reader reads/);
  assert.match(tab('subject in (me.seat.team_id)'), /"subject" is TEXT, and me\.seat\.team_id holds number values/);
  assert.equal(tab('team_id in (me.seat.team_id)'), '');
});
