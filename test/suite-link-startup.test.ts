import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { startConfiguredSuite } from '../packages/mistri/src/server/cli/suiteCommand.js';

test('suite catalog validation happens after child startup, before listening, and releases opened owners on failure', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'suite-link-startup-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const apps = [];
  for (const id of ['source', 'target']) {
    const home = join(directory, id);
    mkdirSync(home);
    const db = new DatabaseSync(join(home, 'business.db'));
    db.exec('CREATE TABLE note(id INTEGER PRIMARY KEY, body TEXT)');
    db.close();
    writeFileSync(
      join(home, 'app.json'),
      JSON.stringify({
        id,
        name: id,
        resources: { note: {} },
        auth: { store: join(home, 'auth.db'), providers: ['email'], roles: { reader: { read: true } } },
        views: {
          notes: { kind: 'list', from: 'note' },
          ...(id === 'source'
            ? {
                desk: {
                  kind: 'dashboard',
                  label: 'Desk',
                  sections: [{ kind: 'note', text: 'Missing', action: { label: 'Open', to: { app: 'missing', kind: 'home' } } }],
                },
              }
            : {}),
        },
        home: 'notes',
        nav: ['notes', ...(id === 'source' ? ['desk'] : [])],
      }),
    );
    writeFileSync(join(home, 'connections.json'), JSON.stringify({ connections: [{ name: 'data', url: join(home, 'business.db') }] }));
    apps.push({
      id,
      directory: home,
      config: join(home, 'connections.json'),
      mount: id === 'source' ? '/' : '/other',
      environment: { BETTER_AUTH_SECRET: 'SECRET' },
    });
  }
  const file = join(directory, 'suite.json');
  writeFileSync(file, JSON.stringify({ port, apps }));
  await assert.rejects(
    startConfiguredSuite(file, { SECRET: 'startup-link-secret-at-least-thirty-two-characters' }),
    /Unknown target App "missing"/,
  );
  for (const id of ['source', 'target']) {
    const auth = new DatabaseSync(join(directory, id, 'auth.db'), { readOnly: true });
    assert.ok(auth.prepare("SELECT name FROM sqlite_master WHERE name='user'").get(), 'both children opened before catalog validation');
    auth.close();
    const business = new DatabaseSync(join(directory, id, 'business.db'));
    business.exec('BEGIN EXCLUSIVE; ROLLBACK');
    business.close();
  }
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(port, '127.0.0.1', resolve);
  });
  await new Promise<void>((resolve) => listener.close(() => resolve()));
});
