import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scratch } from './support/scratch.js';
import { VALIDATE, validating } from './support/validation.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(root, 'packages/mistri/src/server/index.ts');
const appId = 'scoped-update-cli';

function fixture(t: TestContext, role: 'user' | 'inactive' = 'user') {
  const { directory } = scratch(t, 'tablewalk-scoped-update-cli-');
  const app = join(directory, 'app');
  mkdirSync(app);
  const config = join(directory, 'mistri.json');
  const authStore = join(directory, 'sessions.db');
  const policyFile = join(directory, 'policy.mjs');
  const events = join(directory, 'events');
  const data = join(directory, 'operations.db');
  const stock = join(directory, 'inventory.db');
  for (const [file, table] of [
    [data, 'physical_ticket'],
    [stock, 'physical_asset'],
  ]) {
    const db = new DatabaseSync(file);
    try {
      db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, desk INTEGER NOT NULL, name TEXT NOT NULL);
        INSERT INTO ${table} VALUES (1, 1, 'Visible'), (2, 2, 'Hidden');`);
    } finally {
      db.close();
    }
  }
  const connections = [
    { name: 'ops', url: data, writable: true },
    { name: 'stock', url: stock, writable: true },
    // Open sign-up needs something to prove an address with (open-sign-up-unproven); development mail is enough.
    { name: 'mail', kind: 'email', url: 'log:', from: 'Policy <no-reply@example.test>' },
  ];
  const saveConfig = (value: unknown = connections) => writeFileSync(config, JSON.stringify({ connections: value }));
  saveConfig();
  const updateApp = {
    id: appId,
    name: 'Scoped Updates CLI',
    auth: {
      store: authStore,
      signUp: 'open',
      defaultRole: 'user',
      rows: 'policy',
      roles: { user: { read: true }, [role]: { read: true, write: true } },
    },
    sources: {
      operations: { connection: 'ops', default: true },
      inventory: { connection: 'stock' },
    },
    resources: {
      ticket: { physical: 'physical_ticket', access: 'write', fields: { read: ['id', 'desk', 'name'], write: ['name'] } },
      'inventory.asset': { physical: 'physical_asset', access: 'write', fields: { read: ['id', 'desk', 'name'], write: ['name'] } },
    },
    views: { ticket: { kind: 'list', from: 'ticket' }, asset: { kind: 'list', from: 'inventory.asset' } },
    home: 'ticket',
    nav: ['ticket', 'asset'],
  };
  writeFileSync(join(app, 'app.json'), JSON.stringify(updateApp));
  const adapterUrl = JSON.stringify(pathToFileURL(join(root, 'packages/engine/src/adapters/sqlite.ts')).href);
  const policy = (patch = '') => `
    import { appendFileSync } from 'node:fs';
    import { SqliteAdapter } from ${adapterUrl};
    const record = event => appendFileSync(${JSON.stringify(events)}, event + '\\n');
    record('policy.loaded');
    const scoped = SqliteAdapter.prototype.scopeTransaction;
    SqliteAdapter.prototype.scopeTransaction = function (rows, run) {
      record(Object.values(rows).every(rule => rule === false) ? 'scoped.preflight' : 'scoped.request');
      return scoped.call(this, rows, run);
    };
    for (const method of ['transaction', 'update', 'insert', 'remove', 'commandTransaction']) {
      SqliteAdapter.prototype[method] = async function () {
        record('ordinary.' + method); throw new Error('private-unscoped-fallback');
      };
    }
    ${patch}
    export default { appId: ${JSON.stringify(appId)}, resolveRows() {
      record('resolver'); throw new Error('check must not resolve a principal');
    } };
  `;
  writeFileSync(policyFile, policy());
  const trace = () => (existsSync(events) ? readFileSync(events, 'utf8').trim().split('\n') : []);
  const env = {
    ...process.env,
    DATABASE_URL: '',
    MISTRI_OPEN: '0',
    MISTRI_PUBLIC_URL: '',
    BETTER_AUTH_SECRET: '',
    MISTRI_AUTH_ADMIN_EMAIL: '',
    MISTRI_AUTH_ADMIN_PASSWORD: '',
    MISTRI_DIAGNOSTICS: '',
    XDG_CONFIG_HOME: join(directory, 'xdg'),
  };
  const check = () =>
    new Promise<{ code: number; stdout: string; stderr: string }>((done, reject) => {
      execFile(
        process.execPath,
        ['--import', 'tsx', entry, '--config', config, '--app', app, '--policy', policyFile],
        { cwd: root, env: validating([VALIDATE], env).env, timeout: 15_000, killSignal: 'SIGKILL' },
        (error, stdout, stderr) => {
          if (error?.killed) {
            reject(new Error(`Update CLI timed out\n${stdout}\n${stderr}`));
            return;
          }
          done({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr });
        },
      );
    });
  return { directory, authStore, policyFile, policy, data, stock, connections, saveConfig, trace, check };
}

for (const existingAuth of [false, true]) {
  test(
    `scoped update CLI: valid updateApp checks all writers without mutations (${existingAuth ? 'existing' : 'absent'} auth)`,
    { timeout: 20_000 },
    async (t) => {
      const f = fixture(t);
      if (existingAuth) {
        const db = new DatabaseSync(f.authStore);
        try {
          db.exec("CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('unchanged');");
        } finally {
          db.close();
        }
      }
      const beforeAuth = existingAuth ? readFileSync(f.authStore) : undefined;
      const before = [f.data, f.stock].map((file) => readFileSync(file));
      f.saveConfig([{ name: 'unrelated', url: join(f.directory, 'unavailable.db') }, ...f.connections]);
      const result = await f.check();
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /Scoped Updates CLI: ok/);
      assert.deepEqual(
        f.trace(),
        ['policy.loaded', 'scoped.preflight', 'scoped.preflight'],
        'every granted source must attest scoped transaction capability without invoking the resolver',
      );
      assert.deepEqual(
        [f.data, f.stock].map((file) => readFileSync(file)),
        before,
      );
      if (beforeAuth) assert.deepEqual(readFileSync(f.authStore), beforeAuth);
      else assert.equal(existsSync(f.authStore), false);
      assert.doesNotMatch(result.stdout + result.stderr, /Listening on|signs people in|created the admin|private-unscoped-fallback/);
    },
  );
}

for (const role of ['user', 'inactive'] as const) {
  for (const fault of ['read-only source', 'missing scoped capability', 'unavailable secondary source'] as const) {
    test(`scoped update CLI: ${role} grants validate before refusing ${fault}`, { timeout: 30_000 }, async (t) => {
      const f = fixture(t, role);
      const before = [f.data, f.stock].map((file) => readFileSync(file));
      const valid = await f.check();
      assert.equal(valid.code, 0, valid.stdout + valid.stderr);
      assert.match(valid.stdout, /Scoped Updates CLI: ok/);
      assert.deepEqual(f.trace(), ['policy.loaded', 'scoped.preflight', 'scoped.preflight']);
      const beforeEvents = f.trace().length;
      if (fault === 'missing scoped capability') {
        writeFileSync(f.policyFile, f.policy('SqliteAdapter.prototype.scopeTransaction = undefined;'));
      } else {
        f.saveConfig(
          f.connections.map((connection) =>
            connection.name !== 'stock'
              ? connection
              : {
                  ...connection,
                  ...(fault === 'read-only source' ? { writable: false } : { url: join(f.directory, 'missing-stock.db') }),
                },
          ),
        );
      }
      const invalid = await f.check();
      assert.equal(invalid.code, 1, invalid.stdout + invalid.stderr);
      // The source refused, not the policy module: said as the App's own error (field report S1).
      assert.match(invalid.stderr, /App error: /);
      assert.doesNotMatch(invalid.stdout + invalid.stderr, /Scoped Updates CLI: ok|Listening on|private-unscoped-fallback/);
      assert.equal(f.trace()[beforeEvents], 'policy.loaded', 'failure must reach policy/source validation');
      assert.ok(
        f.trace().every((event) => ['policy.loaded', 'scoped.preflight'].includes(event)),
        'startup must never resolve principals or fall back to ordinary writes',
      );
      assert.deepEqual(
        [f.data, f.stock].map((file) => readFileSync(file)),
        before,
      );
      assert.equal(existsSync(f.authStore), false);
    });
  }
}
