/* Each deployment's sign-in store (config "auth": { "<app id>": { "store" } }): laid over the App's `auth.store`
   before the definition is parsed, so the deployment's file wins and the App's own store is the fallback. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { authStoreFrom, parseDeploymentAuth } from '../packages/mistri/src/server/app/deploymentAuth.js';
import { assertDeploymentAuthNamesApps, deploymentAuthOf } from '../packages/mistri/src/server/cli/apps.js';

const definition = (auth?: Record<string, unknown>) => ({
  id: 'bank',
  name: 'Retail Banking',
  resources: { account: { physical: 'account' } },
  views: { accounts: { kind: 'list', from: 'account', label: 'Accounts' } },
  home: 'accounts',
  nav: ['accounts'],
  ...(auth ? { auth } : {}),
});
function appDirectory(auth?: Record<string, unknown>) {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-deployment-auth-'));
  writeFileSync(join(directory, 'app.json'), JSON.stringify(definition(auth)));
  return directory;
}
const FILE = '/etc/deploy/north.json';
const deploying = (raw: unknown) => ({ file: FILE, apps: parseDeploymentAuth(raw, FILE) });

test('the config is read by App id, a relative file from its own directory, a URL or a ${NAME} as written', () => {
  assert.deepEqual(parseDeploymentAuth(undefined, FILE), {});
  assert.deepEqual(parseDeploymentAuth({ bank: { store: ' ${MISTRI_AUTH_STORE} ' } }, FILE), { bank: { store: '${MISTRI_AUTH_STORE}' } });
  assert.deepEqual(parseDeploymentAuth({ bank: { store: 'postgres://db/auth' } }, FILE), { bank: { store: 'postgres://db/auth' } });
  assert.deepEqual(parseDeploymentAuth({ bank: { store: '/var/lib/auth.db' } }, FILE), { bank: { store: '/var/lib/auth.db' } });
  assert.deepEqual(parseDeploymentAuth({ bank: { store: 'auth/north.db' } }, FILE), { bank: { store: '/etc/deploy/auth/north.db' } });
});

test('an invalid value is refused, naming the entry and what it takes', () => {
  assert.throws(() => parseDeploymentAuth([], FILE), /north\.json: "auth" must name each App's sign-in store by its id/);
  assert.throws(() => parseDeploymentAuth({ bank: 'auth.db' }, FILE), /"auth\.bank" must be an object with "store"/);
  assert.throws(() => parseDeploymentAuth({ bank: { store: 'a.db', roles: {} } }, FILE), /"auth\.bank" has no "roles"\. It takes: store\./);
  assert.throws(
    () => parseDeploymentAuth({ bank: { store: '  ' } }, FILE),
    /"auth\.bank"\.store must be a postgres:\/\/ URL, a \$\{NAME\}/,
  );
  assert.throws(() => parseDeploymentAuth({ bank: { store: 5 } }, FILE), /"auth\.bank"\.store must be/);
  assert.throws(
    () => deploymentAuthOf({ configPath: FILE, auth: { bank: {} } }),
    /north\.json: "auth\.bank"\.store must be/,
    'a start reads it through the same parse',
  );
});

test("the deployment's store wins over the App's auth.store", async () => {
  const directory = appDirectory({ providers: ['email'], store: '${APP_AUTH_STORE}' });
  try {
    const loaded = await loadApp(directory, { deploymentAuth: deploying({ bank: { store: 'postgres://db/north-auth' } }) });
    assert.equal(loaded.app.auth?.store, 'postgres://db/north-auth');
    assert.deepEqual(loaded.app.auth?.providers, ['email'], 'the rest of auth is the App’s own');
    assert.equal(authStoreFrom(loaded), `"auth.bank" in ${FILE}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("without an entry for the App, the App's own auth.store is used", async () => {
  const directory = appDirectory({ providers: ['email'], store: '${APP_AUTH_STORE}' });
  try {
    const bare = await loadApp(directory);
    assert.equal(bare.app.auth?.store, '${APP_AUTH_STORE}');
    assert.equal(authStoreFrom(bare), "the App's auth.store");
    const elsewhere = await loadApp(directory, { deploymentAuth: deploying({}) });
    assert.equal(elsewhere.app.auth?.store, '${APP_AUTH_STORE}');
    assert.equal(authStoreFrom(elsewhere), "the App's auth.store");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an App that writes no store gets the deployment’s, and with neither the default is said as such', async () => {
  const directory = appDirectory({ providers: ['email'] });
  try {
    const kept = await loadApp(directory, { deploymentAuth: deploying({ bank: { store: 'auth/north.db' } }) });
    assert.equal(kept.app.auth?.store, '/etc/deploy/auth/north.db');
    assert.equal(authStoreFrom(await loadApp(directory)), undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a store for an App nobody signs in to, or for an App the server does not serve, is refused', async () => {
  const directory = appDirectory();
  try {
    await assert.rejects(
      loadApp(directory, { deploymentAuth: deploying({ bank: { store: 'postgres://db/auth' } }) }),
      /north\.json: "auth\.bank"\.store places the sign-in store of an App nobody signs in to: "bank" declares no "auth"/,
    );
    const loaded = await loadApp(directory);
    assert.throws(
      () => assertDeploymentAuthNamesApps(deploying({ banc: { store: 'postgres://db/auth' } }), [loaded]),
      /north\.json: "auth\.banc" names no App this server serves \("bank"\)\. Key each sign-in store by the App's id\./,
    );
    assert.doesNotThrow(() => assertDeploymentAuthNamesApps(undefined, [loaded]));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
