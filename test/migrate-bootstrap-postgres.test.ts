/**
 * The bootstrap plan on PostgreSQL (docs/bootstrap-plan.md, decision D4): a `postgres://` `auth.store` is a phase of
 * the plan, and the stores step makes it, where it was a `node -e` call to migratePostgresAuthStore. Two databases
 * this file alone owns, named by UUIDs and dropped afterwards. Runs only with TABLEWALK_TEST_PG.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uuidPostgresDatabase } from './support/tenantDialects.js';
import { mistri } from './support/bootstrapApp.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
const drops: Array<() => Promise<void>> = [];
let dir = '';
let env: NodeJS.ProcessEnv = {};

before(async () => {
  if (!LIVE) return;
  const business = await uuidPostgresDatabase('bootstrap_business');
  drops.push(business.drop);
  const store = await uuidPostgresDatabase('bootstrap_auth');
  drops.push(store.drop);
  dir = mkdtempSync(join(tmpdir(), 'mistri-bootstrap-pg-'));
  mkdirSync(join(dir, 'migrations'));
  /* Both URLs by reference: the files hold no password. */
  env = { BOOTSTRAP_DB: business.url, BOOTSTRAP_AUTH: store.url, XDG_CONFIG_HOME: join(dir, '.config') };
  writeFileSync(
    join(dir, 'mistri.json'),
    JSON.stringify({ connections: [{ name: 'desk', url: '${BOOTSTRAP_DB}', writable: true, migrations: { dir: 'migrations' } }] }),
  );
  writeFileSync(join(dir, 'migrations', 'V1__item.sql'), 'CREATE TABLE item (id serial PRIMARY KEY, title text NOT NULL);\n');
  writeFileSync(
    join(dir, 'app.json'),
    JSON.stringify({
      id: 'desk',
      name: 'Desk',
      connection: 'desk',
      resources: { item: { access: 'write' } },
      auth: { store: '${BOOTSTRAP_AUTH}', roles: { admin: { read: true, write: true } } },
      views: { items: { kind: 'list', from: 'item', show: ['title'] } },
      home: 'items',
      nav: ['items'],
    }),
  );
});

after(async () => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  for (const drop of drops) await drop();
});

test(
  'a postgres:// auth.store is a phase of the plan, and the stores step makes it',
  { skip: !LIVE && 'TABLEWALK_TEST_PG is not set' },
  () => {
    const plan = mistri(['migrate', 'status', '--app', '.'], dir, env);
    assert.equal(plan.code, 2, plan.said);
    assert.match(plan.stdout, /3 sign-in store\s+pending\s+auth\.store on PostgreSQL: up makes its tables/);
    assert.doesNotMatch(plan.said, /postgres(ql)?:\/\//, 'a store URL is never said');

    /* The stores step alone (what a deploy's migrate step runs) makes it too. */
    const stores = mistri(['migrate', 'stores', 'up', '--app', '.'], dir, env);
    assert.equal(stores.code, 0, stores.said);
    assert.match(stores.stdout, /auth\.store: sign-in store provisioned/);

    const again = mistri(['migrate', 'status', '--app', '.'], dir, env);
    assert.match(again.stdout, /3 sign-in store\s+done\s+auth\.store on PostgreSQL/);
    assert.match(again.stdout, /1 migrations\s+pending\s+V1__item\.sql/);
  },
);
