/**
 * A connection written as `${VAR}` in mistri.json opens through its expansion, and so must the stores kept beside
 * it. A field report's App named its database that way: `migrate stores up` provisioned the stores (it resolves the
 * connection), but the command host located them by the raw text, turned `${VAR}` into a SQLite path, and `mistri
 * check` failed with "declares events, but source has no event store" for every App whose commands record events.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { storeTargetOf } from '../packages/mistri/src/server/commands/appCommandEvents.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { bootstrapApp, mistri } from './support/bootstrapApp.js';

test('a command App whose connection is ${VAR} migrates its stores and passes check', (t) => {
  const { dir, app, config, db } = bootstrapApp(t);
  const written = JSON.parse(readFileSync(config, 'utf8')) as { connections: { url: string }[] };
  written.connections[0].url = '${TABLEWALK_TEST_DESK_DB}';
  writeFileSync(config, JSON.stringify(written));
  const env = { XDG_CONFIG_HOME: join(dir, '.config'), TABLEWALK_TEST_DESK_DB: db };

  const up = mistri(['migrate', 'up', '--app', '.', '--jobs', 'jobs.mjs'], app, env);
  assert.equal(up.code, 0, up.said);
  /* Before: exit 4, `Command "close" declares events, but source "desk" has no event store`. */
  const run = mistri(['check', '--app', '.', '--jobs', 'jobs.mjs'], app, env);
  assert.equal(run.code, 0, run.said);
});

test('a store target refuses a reference nobody expanded', () => {
  assert.throws(() => storeTargetOf('${DESK_DB}'), /unexpanded/);
  assert.deepEqual(storeTargetOf('sqlite:///tmp/x.db'), { sqlite: '/tmp/x.db' });
});

test('openableUrlOf is the URL a connection opens: expanded, and as written when untrusted', () => {
  const registry = new Registry({ environment: { DESK_DB: '/tmp/desk.db' } });
  const trusted = registry.add({ name: 'desk', url: '${DESK_DB}', source: 'config' });
  const untrusted = registry.add({ name: 'typed', url: '${DESK_DB}', source: 'config' }, { untrusted: true });
  assert.equal(registry.openableUrlOf(trusted.id), '/tmp/desk.db');
  assert.equal(registry.openableUrlOf(untrusted.id), '${DESK_DB}');
  assert.equal(registry.openableUrlOf('nobody'), undefined);
});
