import { action, fields, listView, page, related } from '@mistriwork/mistri/app';
import assert from 'node:assert/strict';
import {
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { AppConfig } from '../packages/mistri/schema/app.js';
import { loadApp, type LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import { createAppAuth } from '../packages/mistri/src/server/auth/auth.js';
import type { ConnectionConfig } from '../packages/engine/src/server/connections.js';
import {
  prepareTenantStartup,
  TenantStartupError,
  watchTenantStartup,
  type TenantStartupOptions,
} from '../packages/mistri/src/server/tenant/tenantStartup.js';
import { provisionSqliteTenantStore, TENANT_TABLES as tables } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { TenantStoreOfAnotherApp } from '../packages/mistri/src/server/tenant/tenantStoreContract.js';
import { refusalReasons, startupReport } from '../packages/engine/src/shared/refusal.js';
import { parseTestApp } from './support/commandCatalog.js';

const policyModule = `
import { writeFileSync } from 'node:fs';
writeFileSync(new URL('./policy-imported', import.meta.url), 'imported');
function unexpected() {
  writeFileSync(new URL('./callback-executed', import.meta.url), 'executed');
  throw new Error('PRIVATE_CALLBACK_SECRET');
}
export default {
  kind: 'tenant', appId: 'app', storeId: 'private-store',
  ownership: { item: { kind: 'tenant', column: 'tenant_id' } },
  resolveMembershipRows: unexpected, resolveRows: unexpected,
  authorizeDeletedRecord: unexpected
};
`;

function execute(path: string, sql: string) {
  const db = new DatabaseSync(path);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

function snapshot(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const schema = db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY name').all();
    const rows = schema
      .filter((entry) => entry.type === 'table')
      .map((entry) => ({
        table: entry.name,
        rows: db.prepare(`SELECT * FROM "${String(entry.name).replaceAll('"', '""')}" ORDER BY rowid`).all(),
      }));
    return { schema, rows };
  } finally {
    db.close();
  }
}

function fixture(t: TestContext, writable = false, format: 'ts' | 'json' = 'json') {
  const dir = mkdtempSync(join(tmpdir(), 'tablewalk-tenant-startup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'business.db'),
    authPath = join(dir, 'auth.db');
  execute(
    path,
    `PRAGMA journal_mode=WAL;
    CREATE TABLE db_item(id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, name TEXT NOT NULL);
    INSERT INTO db_item VALUES ('n', 'north', 'North'), ('s', 'south', 'South');`,
  );
  provisionSqliteTenantStore(path, {
    appId: 'app',
    source: { id: 'business', connection: 'business-db' },
    storeId: 'private-store',
  });
  execute(
    path,
    `INSERT INTO "${tables.tenant}" VALUES ('north', 'active', '1', 'tenant'), ('south', 'active', '1', 'tenant');
    INSERT INTO "${tables.membership}" VALUES ('north-alice', 'north', 'alice', 'active', '1', '["editor"]', 10000, 'member', NULL, NULL, NULL);`,
  );
  const manifest = {
    id: 'app',
    name: 'Tenant startup fixture',
    auth: { store: './auth.db', rows: 'tenant', roles: { editor: { read: true, ...(writable ? { write: true } : {}) } } },
    sources: { business: { connection: 'business-db' } },
    resources: {
      item: {
        physical: 'db_item',
        owner: 'tenant',
        ...(writable ? { access: 'write' } : {}),
        fields: { read: ['id', 'name'], ...(writable ? { write: ['id', 'name'] } : {}) },
      },
    },
    views: { items: listView('Items', 'item') },
    home: 'items',
  } satisfies AppConfig;
  const appPath = join(dir, `app.${format}`);
  writeFileSync(appPath, format === 'ts' ? `export default ${JSON.stringify(manifest)};` : JSON.stringify(manifest));
  const loaded: LoadedApp = { path: appPath, app: parseTestApp(manifest, appPath), pages: [], sources: {} };
  const connection: ConnectionConfig = {
    id: 'business-db',
    name: 'Business database',
    url: path,
    source: 'config',
    ...(writable ? { writable: true } : {}),
  };
  const policyFile = join(dir, 'policy.mjs');
  writeFileSync(policyFile, policyModule);
  const options: TenantStartupOptions = { loaded, connections: [connection], policyFile };
  const untouched = () => {
    for (const suffix of ['', '-wal', '-shm', '-journal']) assert.equal(existsSync(authPath + suffix), false);
    assert.equal(existsSync(join(dir, 'callback-executed')), false, 'startup must not execute policy callbacks');
  };
  const reject = async (patch: Partial<TenantStartupOptions> = {}, message?: RegExp) => {
    const before = readFileSync(path);
    await assert.rejects(prepareTenantStartup({ ...options, ...patch }), (error) => {
      assert.ok(error instanceof TenantStartupError);
      assert.equal(error.name, 'TenantStartupError');
      /* A wrapped failure carries its cause for the operator's own terminal;
         what the message says is still only the stage, checked below. */
      if (message) assert.match(error.message, message);
      else {
        assert.match(error.message, /^Tenant startup could not validate /);
        assert.doesNotMatch(error.message, /PRIVATE_|tablewalk-tenant-startup-|business\.db|policy\.mjs/);
      }
      return true;
    });
    assert.deepEqual(readFileSync(path), before, 'failed startup must not repair or mutate storage');
    untouched();
  };
  return { dir, path, authPath, appPath, loaded, connection, policyFile, options, untouched, reject };
}

test('public startup refuses a send on a channel no integration provides before source or auth provisioning', async (t) => {
  const f = fixture(t, true),
    commandsFile = join(f.dir, 'effects.mjs');
  writeFileSync(
    commandsFile,
    `
import { defineCommand, defineCommands } from ${JSON.stringify(new URL('../packages/mistri/src/server/commands/businessCommands.ts', import.meta.url).href)};
import { send } from ${JSON.stringify(new URL('../packages/mistri/src/server/commands/commandEffects.ts', import.meta.url).href)};
export default defineCommands({ change: defineCommand({ targets: 'none', source: 'business', target: 'item', read: ['item'], write: ['item'],
  input: {}, output: { parse: value => value },
  effects: { text: send('sms', value => ({ to: value.phone, text: value.label, consent: true })) },
  handle() { throw new Error('PRIVATE_CALLBACK_SECRET'); }
}) });
`,
  );
  writeFileSync(
    f.policyFile,
    policyModule.replace(
      'authorizeDeletedRecord: unexpected',
      'authorizeDeletedRecord: unexpected, resultReferences: { change: unexpected }',
    ),
  );
  // A tenant host delivers effects now; a message on a channel no listed integration provides would be one nothing sends.
  await f.reject({ commandsFile }, /sends on channel "sms", which no integration the App lists provides/);
});

test('command preflight names a missing result extractor without executing policy or handlers', async (t) => {
  const f = fixture(t, true),
    commandsFile = join(f.dir, 'commands.mjs');
  writeFileSync(
    commandsFile,
    `
import { defineCommand, defineCommands } from ${JSON.stringify(new URL('../packages/mistri/src/server/commands/businessCommands.ts', import.meta.url).href)};
export default defineCommands({ change: defineCommand({ targets: 'none', source: 'business', target: 'item', read: ['item'], write: ['item'],
  input: {}, output: { parse: value => value },
  handle() { throw new Error('PRIVATE_CALLBACK_SECRET'); }
}) });`,
  );
  await f.reject({ commandsFile }, /resultReferences.*Missing: change/);
  // Why it is needed, and the shape to write.
  await f.reject(
    { commandsFile },
    /each checked to be one the caller may read.*For example: resultReferences: \{ change: \(\) => \[\] \}\./,
  );
});

test('command preflight diagnoses a policy registry without a commands module', async (t) => {
  const f = fixture(t, true);
  writeFileSync(
    f.policyFile,
    policyModule.replace(
      'authorizeDeletedRecord: unexpected',
      'authorizeDeletedRecord: unexpected, resultReferences: { change: unexpected }',
    ),
  );
  await f.reject({}, /resultReferences but no --commands registry/);
});

/* An App that asks for commands and was started without them refused inside
   enrollment, where refusals name only a stage — so a grant or an action naming
   a command looked like a deployment that could not be validated, with nothing
   to fix. Both are authoring, and both say so now. */
test('startup names a command a role was granted when no registry was loaded', async (t) => {
  const f = fixture(t, true);
  const manifest: AppConfig = JSON.parse(readFileSync(f.appPath, 'utf8'));
  (manifest.auth!.roles!.editor as { commands?: string[] }).commands = ['change'];
  writeFileSync(f.appPath, JSON.stringify(manifest));
  await f.reject(
    { loaded: await loadApp(f.appPath) },
    /no --commands registry was loaded[\s\S]*Granted to a role: "change" \(role "editor"\)/,
  );
});

test('loading names an action command when no registry is available', async (t) => {
  const f = fixture(t, true);
  const manifest: AppConfig = JSON.parse(readFileSync(f.appPath, 'utf8'));
  manifest.resources!.item.actions = { change: action('Change', { command: 'change' }) };
  writeFileSync(f.appPath, JSON.stringify(manifest));
  await assert.rejects(loadApp(f.appPath), /names the command "change".*no commands module is loaded/);
  f.untouched();
});

test('startup discovers executable commands beside the App and names an undeclared grant', async (t) => {
  const f = fixture(t, true),
    commandsFile = join(f.dir, 'commands.mjs');
  writeFileSync(
    commandsFile,
    `
import { defineCommand, defineCommands } from ${JSON.stringify(new URL('../packages/mistri/src/server/commands/businessCommands.ts', import.meta.url).href)};
export default defineCommands({ change: defineCommand({ targets: 'none', source: 'business', target: 'item', read: ['item'], write: ['item'],
  input: {}, output: { parse: value => value },
  handle() { throw new Error('PRIVATE_CALLBACK_SECRET'); }
}) });`,
  );
  const manifest: AppConfig = JSON.parse(readFileSync(f.appPath, 'utf8'));
  (manifest.auth!.roles!.editor as { commands?: string[] }).commands = ['nope'];
  writeFileSync(f.appPath, JSON.stringify(manifest));
  const loaded = await loadApp(f.appPath);
  // Discovery satisfies the jobs prerequisite; a missing jobs module gets its
  // own diagnostic rather than demanding a redundant --commands flag.
  await f.reject({ loaded, jobsFile: join(f.dir, 'missing-jobs.mjs') }, /The jobs module could not be loaded/);
  await f.reject({ loaded }, /registry does not declare: "nope" \(role "editor"\)[\s\S]*Registered: "change"/);
});

test('command preflight refuses editable command revisions without executing callbacks', async (t) => {
  const f = fixture(t, true),
    commandsFile = join(f.dir, 'commands.mjs');
  writeFileSync(
    f.policyFile,
    policyModule.replace(
      'authorizeDeletedRecord: unexpected',
      'authorizeDeletedRecord: unexpected, resultReferences: { change: unexpected }',
    ),
  );
  // Ordinary columns may be edited alongside commands; the command's
  // explicit revision column must not be editable through the form.
  execute(f.path, 'ALTER TABLE db_item ADD COLUMN version INTEGER NOT NULL DEFAULT 0');
  const manifest = JSON.parse(readFileSync(f.appPath, 'utf8'));
  manifest.resources.item.fields = { read: ['id', 'name', 'version'], write: ['id', 'name', 'version'] };
  manifest.auth.roles.editor.fields = { item: { read: ['id', 'name', 'version'], write: ['id', 'name', 'version'] } };
  const loaded = { ...f.loaded, app: parseTestApp(manifest, f.appPath) };
  writeFileSync(
    commandsFile,
    `
import { defineCommand, defineCommands } from ${JSON.stringify(new URL('../packages/mistri/src/server/commands/businessCommands.ts', import.meta.url).href)};
export default defineCommands({ change: defineCommand({ source: 'business', target: 'item', read: ['item'], write: ['item'],
  input: {}, output: { parse: value => value },
  handle() { throw new Error('PRIVATE_CALLBACK_SECRET'); }
}) });`,
  );
  await f.reject({ loaded, commandsFile }, /Command "change" keeps its revision in "version".*\[command-and-edit\]/);
});

test('a tenant App whose look ships font files starts (T1: `fonts` was a key the tenant start did not take)', async (t) => {
  const f = fixture(t);
  const loaded = await loadApp(f.appPath);
  const fonts = { files: { 'face-0123456789ab.woff2': Buffer.from('wOF2') }, sources: {} };
  const { enrollment } = await prepareTenantStartup({ ...f.options, loaded: { ...loaded, fonts } as LoadedApp });
  assert.equal(enrollment.policy.kind, 'tenant');
});

for (const format of ['ts', 'json'] as const)
  for (const writable of [false, true]) {
    test(`${format} normalized App prepares ${writable ? 'writable' : 'read-only'} enrollment without auth creation or callbacks`, async (t) => {
      const f = fixture(t, writable, format),
        before = snapshot(f.path);
      const loaded = await loadApp(f.appPath);
      assert.equal(loaded.app.sources?.business.default, true);
      const result = await prepareTenantStartup({ ...f.options, loaded });
      const { enrollment: prepared, authStoreExclusion } = result;
      const info = statSync(f.path);
      assert.deepEqual(authStoreExclusion, { path: realpathSync(f.path), device: info.dev, inode: info.ino });
      assert.ok(Object.isFrozen(result));
      assert.ok(Object.isFrozen(authStoreExclusion));
      assert.deepEqual(prepared.source, { id: 'business', connection: 'business-db', existingPath: realpathSync(f.path) });
      assert.deepEqual(prepared.roles, ['editor']);
      assert.equal(prepared.policy.kind, 'tenant');
      assert.equal(prepared.policy.appId, 'app');
      assert.equal(prepared.policy.storeId, 'private-store');
      assert.equal(prepared.maxLifetimeMs, 300000);
      assert.match(prepared.deployment, /^[0-9a-f-]{36}$/);
      assert.equal(prepared.commands, undefined);
      for (const value of [prepared, prepared.source, prepared.roles, prepared.policy]) assert.ok(Object.isFrozen(value));
      assert.equal(existsSync(join(f.dir, 'policy-imported')), true);
      assert.deepEqual(snapshot(f.path), before);
      f.untouched();
      execute(f.path, 'BEGIN EXCLUSIVE; ROLLBACK');
      const { enrollment: again } = await prepareTenantStartup({ ...f.options, loaded });
      assert.notEqual(again.deployment, prepared.deployment);
      f.untouched();
    });
  }

for (const surface of ['New', 'related'] as const) {
  for (const authoring of ['valid', 'missing required name', 'unknown form column', 'explicit owner read'] as const) {
    test(`startup validates ${surface} form against managed ownership: ${authoring}`, async (t) => {
      const f = fixture(t, true);
      const manifest: AppConfig = JSON.parse(readFileSync(f.appPath, 'utf8'));
      // Ownership alone must hide the managed column, including for command
      // Apps that cannot declare field rules on their resource footprint.
      delete manifest.resources!.item.fields;
      const show = authoring === 'missing required name' ? ['id'] : ['id', 'name'];
      if (authoring === 'unknown form column') show.push('unknown_column');
      const columns = authoring === 'explicit owner read' ? ['id', 'name', 'tenant_id'] : ['id', 'name'];
      let physical = 'db_item';
      if (surface === 'New') {
        manifest.resources!.item.form = { show };
        manifest.views = { items: listView('Items', 'item', { show: columns }) };
        manifest.nav = ['items'];
      } else {
        physical = 'db_child';
        execute(
          f.path,
          `PRAGMA foreign_keys=ON;
          CREATE TABLE db_child(id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL,
            parent_id TEXT NOT NULL REFERENCES db_item(id), name TEXT NOT NULL);
          INSERT INTO db_child VALUES ('child-n', 'north', 'n', 'North child'), ('child-s', 'south', 's', 'South child');`,
        );
        manifest.resources = {
          item: { physical: 'db_item', owner: 'tenant' },
          child: { physical: 'db_child', owner: 'tenant', access: 'write' },
        };
        manifest.views = { parents: listView('Parents', 'item', { show: ['id', 'name'] }) };
        manifest.home = 'parents';
        manifest.nav = ['parents'];
        manifest.pages = {
          'parent-items': page('item', [
            fields(['id', 'name']),
            related('Children', 'child', 'parent_id', {
              show: columns,
              create: { label: 'Add child', show },
            }),
          ]),
        };
        writeFileSync(
          f.policyFile,
          policyModule.replace(
            "ownership: { item: { kind: 'tenant', column: 'tenant_id' } }",
            "ownership: { item: { kind: 'tenant', column: 'tenant_id' }, child: { kind: 'tenant', column: 'tenant_id' } }",
          ),
        );
      }
      writeFileSync(f.appPath, JSON.stringify(manifest));
      const loaded = await loadApp(f.appPath),
        before = snapshot(f.path),
        bytes = readFileSync(f.path);
      const db = new DatabaseSync(f.path, { readOnly: true });
      try {
        const owner = db
          .prepare(`PRAGMA table_info(${physical})`)
          .all()
          .find((column) => column.name === 'tenant_id');
        assert.ok(owner);
        assert.equal(owner.notnull, 1);
        assert.equal(owner.dflt_value, null, 'managed ownership must not need a physical default');
      } finally {
        db.close();
      }
      if (authoring === 'valid') {
        const { enrollment } = await prepareTenantStartup({ ...f.options, loaded });
        assert.equal(enrollment.policy.kind, 'tenant');
        assert.deepEqual(enrollment.source, {
          id: 'business',
          connection: 'business-db',
          existingPath: realpathSync(f.path),
        });
        assert.equal(existsSync(join(f.dir, 'policy-imported')), true);
      } else {
        await f.reject({ loaded });
      }
      assert.deepEqual(snapshot(f.path), before, 'authoring validation must preserve schema and all stored rows');
      assert.deepEqual(readFileSync(f.path), bytes, 'authoring validation must not modify the business store');
      f.untouched();
    });
  }
}

test('an authoring refusal names the problems it found, and the realm that found them', async (t) => {
  /* mistri check exists to say what is wrong. It used to compute the problems
     and throw them away, leaving one sentence about the stage, so a one-line
     App fault took a throwaway script to find. */
  const f = fixture(t);
  const manifest: AppConfig = JSON.parse(readFileSync(f.appPath, 'utf8'));
  manifest.views = { items: listView('Items', 'item', { show: ['id', 'no_such_column'] }) };
  writeFileSync(f.appPath, JSON.stringify(manifest));
  const loaded = await loadApp(f.appPath);
  await assert.rejects(prepareTenantStartup({ ...f.options, loaded }), (error) => {
    assert.ok(error instanceof TenantStartupError);
    assert.match(error.message, /^Tenant startup could not validate the authored resource and page definitions:/);
    // The realm whose catalog judged it, then the line an author can act on.
    assert.match(error.message, /tenant realm: .*no_such_column/);
    // Still nothing about where the deployment's files live.
    assert.doesNotMatch(error.message, /PRIVATE_|tablewalk-tenant-startup-|business\.db|policy\.mjs/);
    return true;
  });
  f.untouched();
});

test('a table in the database the App does not declare is named, with what to do', async (t) => {
  /* A database migrated one version past the code: the new table has no owner, and startup said only
     "could not validate the attested ownership", so it was found by dropping tables one at a time. */
  const f = fixture(t);
  execute(f.path, 'CREATE TABLE ticket_watcher(id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL);');
  await assert.rejects(prepareTenantStartup(f.options), (error) => {
    assert.ok(error instanceof TenantStartupError);
    assert.match(error.message, /^Tenant startup could not validate the attested ownership of the authored resources:/);
    assert.match(error.message, /"ticket_watcher"/);
    assert.match(error.message, /ownership/);
    assert.doesNotMatch(error.message, /PRIVATE_|tablewalk-tenant-startup-|business\.db|policy\.mjs/);
    return true;
  });
  f.untouched();
});

for (const authoring of ['ordinary name', 'unknown column', 'explicit owner read'] as const) {
  test(`startup validates record fields against managed ownership: ${authoring}`, async (t) => {
    const f = fixture(t);
    const manifest: AppConfig = JSON.parse(readFileSync(f.appPath, 'utf8'));
    delete manifest.resources!.item.fields;
    const show = ['name'];
    if (authoring === 'unknown column') show.push('unknown_column');
    if (authoring === 'explicit owner read') show.push('tenant_id');
    manifest.pages = { 'item-details': page('item', [fields(show)]) };
    writeFileSync(f.appPath, JSON.stringify(manifest));
    const loaded = await loadApp(f.appPath),
      before = snapshot(f.path),
      bytes = readFileSync(f.path);
    if (authoring === 'ordinary name') {
      const { enrollment } = await prepareTenantStartup({ ...f.options, loaded });
      assert.equal(enrollment.policy.kind, 'tenant');
      assert.deepEqual(enrollment.source, {
        id: 'business',
        connection: 'business-db',
        existingPath: realpathSync(f.path),
      });
      assert.equal(existsSync(join(f.dir, 'policy-imported')), true);
    } else {
      await f.reject({ loaded });
    }
    assert.deepEqual(snapshot(f.path), before, 'record-field validation must preserve schema and all stored rows');
    assert.deepEqual(readFileSync(f.path), bytes, 'record-field validation must not modify the business store');
    f.untouched();
  });
}

test('connection name matching and SQLite-prefixed source symlinks retain the canonical enrollment binding', async (t) => {
  const f = fixture(t),
    alias = join(f.dir, 'alias.db');
  symlinkSync(f.path, alias);
  const { enrollment: result } = await prepareTenantStartup({
    ...f.options,
    connections: [
      { ...f.connection, id: 'other-id', name: 'business-db', url: `sqlite:${alias}`, rows: true, schemas: [], writable: false },
    ],
  });
  assert.deepEqual(result.source, { id: 'business', connection: 'business-db', existingPath: realpathSync(f.path) });
  f.untouched();
});

for (const timing of ['after preparation', 'during auth imports'])
  for (const aliasKind of ['symlink', 'hardlink']) {
    test(`auth refuses ${aliasKind} replacement ${timing} using the captured startup exclusion`, async (t) => {
      const f = fixture(t),
        safeAuth = join(f.dir, 'safe-auth.db'),
        alias = join(f.dir, 'auth-alias.db');
      execute(safeAuth, 'CREATE TABLE sentinel(id TEXT PRIMARY KEY);');
      symlinkSync(safeAuth, alias);
      const loaded = { ...f.loaded, app: { ...f.loaded.app, auth: { ...f.loaded.app.auth!, store: alias } } };
      const prepared = await prepareTenantStartup({ ...f.options, loaded });
      const before = readFileSync(f.path),
        authBefore = readFileSync(safeAuth),
        dataBefore = snapshot(f.path);
      const replaceAlias = () => {
        unlinkSync(alias);
        (aliasKind === 'symlink' ? symlinkSync : linkSync)(f.path, alias);
      };
      // Supply a fixture secret so the post-import fence cannot pass because of
      // an unrelated missing-secret error. Restore the host environment afterward.
      const previousSecret = process.env.BETTER_AUTH_SECRET;
      process.env.BETTER_AUTH_SECRET = 'tenant-startup-test-secret-at-least-thirty-two-characters';
      t.after(() => {
        if (previousSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
        else process.env.BETTER_AUTH_SECRET = previousSecret;
      });
      if (timing === 'after preparation') replaceAlias();
      const pending = createAppAuth(loaded, {
        baseURL: 'http://127.0.0.1:4711',
        trustedOrigins: ['http://127.0.0.1:4711'],
        excludeStore: prepared.authStoreExclusion,
      });
      if (timing === 'during auth imports') replaceAlias();
      await assert.rejects(
        pending.then((runtime) => {
          runtime.close();
          return runtime;
        }),
        {
          message: 'Authentication storage must remain separate from the captured business database and its SQLite sidecars.',
        },
      );
      assert.deepEqual(readFileSync(f.path), before, 'auth must not migrate the business database');
      assert.deepEqual(snapshot(f.path), dataBefore);
      assert.deepEqual(readFileSync(safeAuth), authBefore, 'auth must not migrate the original alias target');
      f.untouched();
    });
  }

for (const suffix of ['-wal', '-shm', '-journal']) {
  test(`auth resolves its base symlink before refusing a business database at real-login.db${suffix}`, async (t) => {
    const f = fixture(t),
      realLogin = join(f.dir, 'real-login.db'),
      business = realLogin + suffix;
    execute(realLogin, 'CREATE TABLE sentinel(id TEXT PRIMARY KEY);');
    copyFileSync(f.path, business);
    const connections = [{ ...f.connection, url: business }];
    const prepared = await prepareTenantStartup({ ...f.options, connections });
    const before = readFileSync(business),
      authBefore = readFileSync(realLogin),
      dataBefore = snapshot(business);
    symlinkSync(realLogin, f.authPath);
    assert.equal(realpathSync(f.authPath), realpathSync(realLogin));
    assert.equal(existsSync(f.authPath + suffix), false, 'only the canonical auth base has the colliding sidecar');
    await assert.rejects(prepareTenantStartup({ ...f.options, connections }), {
      name: 'TenantStartupError',
      message: 'Tenant startup could not validate the SQLite source and separate authentication store.',
    });
    await assert.rejects(
      createAppAuth(f.loaded, {
        baseURL: 'http://127.0.0.1:4711',
        trustedOrigins: ['http://127.0.0.1:4711'],
        excludeStore: prepared.authStoreExclusion,
      }).then((runtime) => {
        runtime.close();
        return runtime;
      }),
      {
        message: 'Authentication storage must remain separate from the captured business database and its SQLite sidecars.',
      },
    );
    assert.deepEqual(readFileSync(business), before, 'auth must not overwrite the business database as a sidecar');
    assert.deepEqual(snapshot(business), dataBefore);
    assert.deepEqual(readFileSync(realLogin), authBefore, 'auth must refuse before migrating its canonical target');
    assert.equal(readlinkSync(f.authPath), realLogin);
    assert.equal(existsSync(join(f.dir, 'callback-executed')), false);
  });
}

for (const reason of ['missing', 'mismatched', 'extra', 'rows:false', 'schemas']) {
  test(`startup refuses ${reason} connections before policy import`, async (t) => {
    const f = fixture(t);
    let connections = [f.connection];
    if (reason === 'missing') connections = [];
    if (reason === 'mismatched') connections = [{ ...f.connection, id: 'other', name: 'Other' }];
    if (reason === 'extra') connections.push({ ...f.connection, id: 'extra', name: 'Extra' });
    if (reason === 'rows:false') connections = [{ ...f.connection, rows: false }];
    if (reason === 'schemas') connections = [{ ...f.connection, schemas: ['main'] }];
    await f.reject({ connections }, /exactly one matching, row-readable SQLite connection/);
    assert.equal(existsSync(join(f.dir, 'policy-imported')), false);
  });
}

for (const writable of [undefined, false])
  for (const reason of ['write grants', 'commands']) {
    test(`startup refuses read-only (${writable}) ${reason} before module import`, async (t) => {
      const f = fixture(t, reason === 'write grants');
      const commandsFile = join(f.dir, 'commands.mjs');
      writeFileSync(
        commandsFile,
        `import { writeFileSync } from 'node:fs';
      writeFileSync(new URL('./command-imported', import.meta.url), 'imported');
      throw new Error('PRIVATE_COMMAND_SECRET');`,
      );
      await f.reject(
        { connections: [{ ...f.connection, writable }], ...(reason === 'commands' ? { commandsFile } : {}) },
        /require writable: true/,
      );
      assert.equal(existsSync(join(f.dir, 'policy-imported')), false);
      assert.equal(existsSync(join(f.dir, 'command-imported')), false);
    });
  }

for (const reason of ['missing', 'directory', 'not SQLite', 'memory', 'file URI', 'postgres', 'mysql']) {
  test(`startup refuses ${reason} SQLite source without creating storage`, async (t) => {
    const f = fixture(t),
      absent = join(f.dir, 'missing.db'),
      invalid = join(f.dir, 'invalid.db');
    writeFileSync(invalid, 'PRIVATE_NOT_SQLITE');
    const urls: Record<string, string> = {
      missing: absent,
      directory: f.dir,
      'not SQLite': invalid,
      memory: ':memory:',
      'file URI': `file:${f.path}`,
      postgres: 'postgres://test:PRIVATE_PASSWORD@127.0.0.1:1/db',
      mysql: 'mysql://test:PRIVATE_PASSWORD@127.0.0.1:1/db',
    };
    await f.reject({ connections: [{ ...f.connection, url: urls[reason] }] });
    assert.equal(existsSync(absent), false);
    assert.equal(readFileSync(invalid, 'utf8'), 'PRIVATE_NOT_SQLITE');
    assert.equal(existsSync(join(f.dir, 'policy-imported')), false);
  });
}

for (const reason of [
  'same file',
  'symlink',
  'hardlink',
  'business-wal',
  'business-shm',
  'business-journal',
  'parent alias-wal',
  'parent alias-shm',
  'parent alias-journal',
  'auth-wal',
  'auth-shm',
  'auth-journal',
  'sidecar symlink',
  'sidecar hardlink',
]) {
  test(`startup refuses auth ${reason} collision before policy import`, async (t) => {
    const f = fixture(t);
    let store = f.path;
    if (reason === 'symlink' || reason === 'hardlink') {
      store = join(f.dir, 'auth-alias.db');
      (reason === 'symlink' ? symlinkSync : linkSync)(f.path, store);
    } else if (reason.startsWith('business-')) {
      store = realpathSync(f.path) + '-' + reason.slice('business-'.length);
    } else if (reason.startsWith('parent alias-')) {
      const alias = join(f.dir, 'parent-alias');
      symlinkSync(f.dir, alias, 'dir');
      store = join(alias, 'business.db-' + reason.slice('parent alias-'.length));
    } else if (reason.startsWith('auth-')) {
      store = join(f.dir, 'other-auth.db');
      linkSync(f.path, store + '-' + reason.slice('auth-'.length));
    } else if (reason.startsWith('sidecar ')) {
      store = join(f.dir, 'other-auth.db');
      writeFileSync(f.path + '-journal', 'PRIVATE_SIDECAR');
      (reason === 'sidecar symlink' ? symlinkSync : linkSync)(f.path + '-journal', store + '-wal');
    }
    const loaded = { ...f.loaded, app: { ...f.loaded.app, auth: { ...f.loaded.app.auth!, store } } };
    await f.reject({ loaded });
    assert.equal(existsSync(join(f.dir, 'policy-imported')), false);
    if (reason.startsWith('sidecar ')) assert.equal(readFileSync(store + '-wal', 'utf8'), 'PRIVATE_SIDECAR');
  });
}

for (const suffix of ['-wal', '-shm', '-journal']) {
  test(`startup refuses dangling auth symlink to absent business ${suffix} before policy import`, async (t) => {
    const f = fixture(t),
      target = realpathSync(f.path) + suffix;
    assert.equal(existsSync(target), false, 'collision target must be absent');
    symlinkSync(target, f.authPath);
    assert.ok(lstatSync(f.authPath).isSymbolicLink());
    assert.equal(existsSync(f.authPath), false, 'auth symlink must be dangling');
    await f.reject({}, /could not validate the SQLite source and separate authentication store/);
    assert.equal(existsSync(join(f.dir, 'policy-imported')), false);
    assert.equal(existsSync(target), false, 'startup must not create the symlink target');
    assert.ok(lstatSync(f.authPath).isSymbolicLink());
    assert.equal(readlinkSync(f.authPath), target, 'startup must preserve the dangling symlink');
  });
}

for (const reason of ['missing', 'incompatible schema', 'wrong app', 'wrong source', 'wrong store']) {
  test(`startup refuses ${reason} tenant storage without provisioning or repair`, async (t) => {
    const f = fixture(t);
    if (reason === 'missing')
      execute(f.path, `DROP TABLE "${tables.membership}"; DROP TABLE "${tables.tenant}"; DROP TABLE "${tables.meta}";`);
    if (reason === 'incompatible schema') execute(f.path, `ALTER TABLE "${tables.membership}" ADD COLUMN unexpected TEXT`);
    if (reason === 'wrong app') execute(f.path, `UPDATE "${tables.meta}" SET app_id = 'other'`);
    if (reason === 'wrong source') execute(f.path, `UPDATE "${tables.meta}" SET source_id = 'other'`);
    if (reason === 'wrong store') execute(f.path, `UPDATE "${tables.meta}" SET store_id = 'other'`);
    await f.reject();
    assert.equal(existsSync(join(f.dir, 'policy-imported')), true, 'must reach enrollment attestation');
  });
}

test("one database holds one tenant App: a second App's provisioning and startup say so, and share nothing", async (t) => {
  const f = fixture(t);
  const other = { appId: 'other-app', source: { id: 'business', connection: 'business-db' }, storeId: 'other-store' };
  const before = readFileSync(f.path);
  assert.throws(
    () => provisionSqliteTenantStore(f.path, other),
    (error: Error) =>
      error instanceof TenantStoreOfAnotherApp &&
      /belongs to the tenant App "app", not "other-app"\. A database holds one tenant App/.test(error.message),
  );
  assert.deepEqual(readFileSync(f.path), before, "the first App's store is left as it was");
  // The App started over another's store: the stage, as ever, and the reason among what the operator is told under it.
  execute(f.path, `UPDATE "${tables.meta}" SET app_id = 'other-app'`);
  await assert.rejects(
    prepareTenantStartup(f.options),
    (error: Error) =>
      error instanceof TenantStartupError &&
      error.message.startsWith('Tenant startup could not validate ') &&
      refusalReasons(error).some((reason) =>
        /belongs to the tenant App "other-app", not "app"\. A database holds one tenant App/.test(reason),
      ),
  );
});

for (const reason of ['missing file', 'wrong kind', 'wrong app', 'wrong store', 'wrong owner', 'missing resolver', 'throws']) {
  test(`startup refuses policy ${reason} with a safe error and no auth creation`, async (t) => {
    const f = fixture(t);
    let policyFile = f.policyFile,
      source = policyModule;
    if (reason === 'missing file') policyFile = join(f.dir, 'absent-policy.mjs');
    if (reason === 'wrong kind') source = source.replace("kind: 'tenant', appId", "kind: 'row', appId");
    if (reason === 'wrong app') source = source.replace("appId: 'app'", "appId: 'other'");
    if (reason === 'wrong store') source = source.replace("storeId: 'private-store'", "storeId: 'other'");
    if (reason === 'wrong owner') source = source.replace("column: 'tenant_id'", "column: 'missing'");
    if (reason === 'missing resolver') source = source.replace('resolveRows: unexpected,', '');
    if (reason === 'throws') source = `throw new Error('PRIVATE_POLICY_SECRET');`;
    writeFileSync(f.policyFile, source);
    await f.reject({ policyFile });
    if (reason === 'missing file') assert.equal(existsSync(policyFile), false);
    else if (reason !== 'throws') assert.equal(existsSync(join(f.dir, 'policy-imported')), true, 'must validate the supplied policy');
  });
}

async function watcherFixture(t: TestContext) {
  const f = fixture(t),
    appDir = join(f.dir, 'app'),
    configDir = join(f.dir, 'config');
  mkdirSync(appDir);
  mkdirSync(configDir);
  const code = join(appDir, 'app.ts'),
    dependency = join(appDir, 'resources.ts'),
    feature = join(appDir, 'features', 'inventory.ts');
  const configPath = join(configDir, 'connections.json'),
    commandsFile = join(f.dir, 'commands.mjs');
  writeFileSync(code, 'export default {};');
  writeFileSync(dependency, 'export const resources = {};');
  mkdirSync(join(appDir, 'features'));
  writeFileSync(feature, 'export const inventory = {};');
  writeFileSync(configPath, '{}');
  writeFileSync(commandsFile, 'export default {};');
  // Let fixture creation events settle before subscribing to macOS directory watches.
  await delay(200);
  let calls = 0,
    notify!: () => void;
  const changed = new Promise<void>((resolve) => {
    notify = resolve;
  });
  const close = watchTenantStartup(
    { loaded: { ...f.loaded, path: code, dir: appDir }, policyFile: f.policyFile, commandsFile, configPath },
    () => {
      calls++;
      notify();
    },
  );
  t.after(close);
  await delay(100);
  const waitForChange = async () => {
    const controller = new AbortController();
    try {
      await Promise.race([
        changed,
        delay(2000, undefined, { signal: controller.signal }).then(() => {
          assert.fail('watcher did not report the file change');
        }),
      ]);
    } finally {
      controller.abort();
    }
  };
  return { ...f, appDir, code, dependency, feature, configPath, commandsFile, close, waitForChange, calls: () => calls };
}

for (const reason of ['code edit', 'feature edit', 'atomic replacement', 'config', 'policy', 'commands']) {
  test(`tenant startup watcher invalidates once for ${reason}`, async (t) => {
    const f = await watcherFixture(t);
    if (reason === 'code edit') writeFileSync(f.dependency, 'export const resources = { changed: true };');
    if (reason === 'feature edit') writeFileSync(f.feature, 'export const inventory = { changed: true };');
    if (reason === 'atomic replacement') {
      const replacement = join(f.appDir, 'replacement.tmp');
      writeFileSync(replacement, 'export default { changed: true };');
      renameSync(replacement, f.code);
    }
    if (reason === 'config') writeFileSync(f.configPath, '{"connections":[]}');
    if (reason === 'policy') writeFileSync(f.policyFile, 'export default {};');
    if (reason === 'commands') writeFileSync(f.commandsFile, 'export default { changed: true };');
    await f.waitForChange();
    writeFileSync(f.dependency, 'export const resources = { changedAgain: true };');
    writeFileSync(f.configPath, '{}');
    await delay(300);
    assert.equal(f.calls(), 1, 'invalidation must close every watcher before invoking the callback');
  });
}

test("tenant startup watcher ignores mistri dev's own state folder", async (t) => {
  const f = await watcherFixture(t),
    folder = join(f.appDir, '.mistri');
  mkdirSync(join(folder, 'config'), { recursive: true });
  // What every dev start writes: its record, rewritten, and the accounts' store beside it.
  writeFileSync(join(folder, 'dev.json'), '{"secret":"x"}\n');
  writeFileSync(join(folder, 'dev.json'), '{"secret":"y"}\n');
  writeFileSync(join(folder, 'config', 'settings.json'), '{}');
  await delay(300);
  assert.equal(f.calls(), 0);
  // An App edit still restarts.
  writeFileSync(f.code, 'export default { changed: true };');
  await f.waitForChange();
});

test('tenant startup watcher ignores SQLite/auth traffic and close stops future invalidation', async (t) => {
  const f = await watcherFixture(t),
    auth = join(f.appDir, 'auth.db');
  execute(auth, 'PRAGMA journal_mode=WAL; CREATE TABLE account(id TEXT PRIMARY KEY);');
  execute(auth, "INSERT INTO account VALUES ('alice')");
  for (const suffix of ['-wal', '-shm', '-journal']) writeFileSync(auth + suffix, 'sidecar traffic');
  await delay(300);
  assert.equal(f.calls(), 0);
  f.close();
  f.close();
  writeFileSync(f.code, 'export default { changed: true };');
  writeFileSync(f.policyFile, 'export default {};');
  writeFileSync(f.commandsFile, 'export default {};');
  writeFileSync(f.configPath, '{"changed":true}');
  await delay(300);
  assert.equal(f.calls(), 0);
});

test('tenant preparation captures independent source and auth environments before acquisition', async (t) => {
  const first = fixture(t),
    second = fixture(t);
  const pending = [first, second].map((f) => {
    const environment = { DATABASE_URL: f.path, AUTH_STORE: f.authPath };
    const options = {
      ...f.options,
      loaded: { ...f.loaded, app: { ...f.loaded.app, auth: { ...f.loaded.app.auth!, store: '${AUTH_STORE}' } } },
      connections: [{ ...f.connection, url: '${DATABASE_URL}' }],
    };
    const prepared = prepareTenantStartup(options, environment);
    environment.DATABASE_URL = '/not-the-captured-business.db';
    environment.AUTH_STORE = f.path;
    return { f, options, prepared };
  });
  for (const { f, options, prepared } of pending) {
    const result = await prepared;
    assert.equal(result.enrollment.source.existingPath, realpathSync(f.path));
    assert.equal(result.authStoreExclusion?.path, realpathSync(f.path));
    f.untouched();
    await assert.rejects(
      prepareTenantStartup(options, { DATABASE_URL: f.path, AUTH_STORE: f.path }),
      TenantStartupError,
      'auth separation must use this deployment environment, not the process defaults',
    );
  }
});

test("a tenant start's recorded reason reaches the operator's terminal, not only its fixed sentence", async (t) => {
  const f = fixture(t, true);
  const error = await prepareTenantStartup({ ...f.options, loaded: { ...f.loaded, notAKey: true } as unknown as LoadedApp }).then(
    () => assert.fail('a loaded App with a key the tenant start does not take must refuse'),
    (error: unknown) => error,
  );
  // Said where the operator reads it (every startup print goes through startupReport), naming the key.
  const said = startupReport(error);
  assert.match(said, /notAKey/, said);
  assert.doesNotMatch(String((error as Error).message), /notAKey/, 'the fixed sentence itself stays fixed');
});
