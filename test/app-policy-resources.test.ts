import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { acquireAppPolicyResources } from '../packages/mistri/src/server/policy/appPolicyResources.js';
import { createAppPolicyDeployment, loadAppPolicyDeployment } from '../packages/mistri/src/server/policy/appPolicyDeployment.js';
import { AppRowPolicyDefinitionError, defineAppRowPolicy } from '../packages/mistri/src/server/policy/appRowPolicy.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { AppAccessDenied } from '../packages/mistri/src/server/app/appAccess.js';
import { parseAppConfig, resourceCeiling } from '../packages/mistri/src/shared/app.js';
import { setCeilings } from './support/appCeilings.js';

const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-policy-acquisition-'));
  const registry = new Registry();
  t.after(async () => {
    await registry.closeAll();
    rmSync(directory, { recursive: true, force: true });
  });
  const app = parseAppConfig(
    {
      id: 'policy',
      name: 'Policy',
      sources: { operations: { connection: 'ops', default: true }, inventory: { connection: 'stock' } },
      resources: { note: {}, 'inventory.note': {} },
      auth: { providers: ['email'], roles: { reader: { read: true, write: false } } },
      views: { notes: { kind: 'list', from: 'note', label: 'Notes' } },
      home: 'notes',
      nav: ['notes'],
    },
    'policy fixture',
  );
  for (const owner of ['ops', 'stock']) {
    const file = join(directory, `${owner}.db`);
    const db = new DatabaseSync(file);
    db.exec(
      "CREATE TABLE note(id INTEGER PRIMARY KEY, name TEXT, desk INTEGER); INSERT INTO note VALUES(1, 'Visible', 1),(2, 'Hidden', 2)",
    );
    db.close();
    registry.add({ id: owner, name: owner, url: file, source: 'config', writable: false });
  }
  const held = new Set<string>();
  const released: string[] = [];
  const lease = registry.lease.bind(registry);
  registry.lease = (owner) => {
    assert.ok(!held.has(owner));
    held.add(owner);
    const cleanup = lease(owner);
    return () => {
      assert.ok(held.delete(owner));
      released.push(owner);
      cleanup();
    };
  };
  return { directory, registry, app, held, released };
}

test('registry policy acquisition takes every lease before opening and releases only its own leases once', async (t) => {
  const f = fixture(t);
  const open = f.registry.open.bind(f.registry);
  f.registry.open = (owner) => {
    assert.deepEqual([...f.held], ['ops', 'stock']);
    return open(owner);
  };
  const acquired = await acquireAppPolicyResources(f.registry, f.app);
  assert.deepEqual(
    [...acquired.sourceConnections],
    [
      ['operations', 'ops'],
      ['inventory', 'stock'],
    ],
  );
  assert.equal(acquired.resources.connectionFor('inventory.note'), 'stock');
  await acquired.release();
  await acquired.release();
  assert.deepEqual(f.released, ['stock', 'ops']);
  // Releasing a deployment lease does not close the host's adapter.
  assert.equal(await (await open('ops')).adapter.count('note'), 2);
});

test('failed source waits for every open before releasing, and errors omit private driver details', async (t) => {
  const f = fixture(t);
  const pending = gate();
  const open = f.registry.open.bind(f.registry);
  f.registry.open = async (owner) => {
    if (owner === 'ops') throw new Error('postgres://private-password@secret-host');
    await pending.promise;
    assert.deepEqual([...f.held], ['ops', 'stock']);
    return open(owner);
  };
  const acquiring = acquireAppPolicyResources(f.registry, f.app);
  const failure = assert.rejects(acquiring, (error) => {
    assert.ok(error instanceof AppRowPolicyDefinitionError);
    assert.doesNotMatch(String(error), /private-password|secret-host/);
    return true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.released, []);
  pending.resolve();
  await failure;
  assert.deepEqual(f.released, ['stock', 'ops']);
});

test('synchronous partial lease failure cleans up earlier acquisitions', async (t) => {
  const f = fixture(t);
  const lease = f.registry.lease.bind(f.registry);
  f.registry.lease = (owner) => {
    if (owner === 'stock') throw new Error('private lease failure');
    return lease(owner);
  };
  await assert.rejects(acquireAppPolicyResources(f.registry, f.app), AppRowPolicyDefinitionError);
  assert.deepEqual(f.released, ['ops']);
});

test('cleanup attempts all releases even when one throws', async (t) => {
  const f = fixture(t);
  const lease = f.registry.lease.bind(f.registry);
  f.registry.lease = (owner) => {
    const cleanup = lease(owner);
    return () => {
      cleanup();
      if (owner === 'stock') throw new Error('private cleanup');
    };
  };
  const acquired = await acquireAppPolicyResources(f.registry, f.app);
  assert.throws(() => acquired.release(), AppRowPolicyDefinitionError);
  await acquired.release();
  assert.deepEqual(f.released, ['stock', 'ops']);
});

for (const changed of ['url', 'name', 'writable', 'rows', 'schemas'] as const) {
  test(`configuration ${changed} changes during acquisition refuse and release both sources`, async (t) => {
    const f = fixture(t);
    const open = f.registry.open.bind(f.registry);
    f.registry.open = async (owner) => {
      const opened = await open(owner);
      if (owner === 'stock')
        Object.assign(f.registry.configOf('stock')!, {
          [changed]: changed === 'writable' ? true : changed === 'rows' ? false : changed === 'schemas' ? ['other'] : 'changed',
        });
      return opened;
    };
    await assert.rejects(acquireAppPolicyResources(f.registry, f.app), AppRowPolicyDefinitionError);
    assert.deepEqual(f.released, ['stock', 'ops']);
  });
}

test('definition mutation during acquisition cannot redirect its source map', async (t) => {
  const f = fixture(t);
  const pending = gate();
  const open = f.registry.open.bind(f.registry);
  f.registry.open = async (owner) => {
    await pending.promise;
    return open(owner);
  };
  const acquiring = acquireAppPolicyResources(f.registry, f.app);
  f.app.sources!.inventory.connection = 'ops';
  pending.resolve();
  const acquired = await acquiring;
  assert.equal(acquired.sourceConnections.get('inventory'), 'stock');
  await acquired.release();
});

test('unknown, duplicate and missing source declarations refuse without opening', async (t) => {
  for (const kind of ['unknown', 'duplicate', 'missing'] as const) {
    const f = fixture(t);
    if (kind === 'unknown') f.app.sources!.inventory.connection = 'absent';
    if (kind === 'duplicate') f.app.sources!.inventory.connection = 'ops';
    if (kind === 'missing') delete f.app.sources;
    f.registry.open = async () => {
      throw new Error('must not open');
    };
    await assert.rejects(acquireAppPolicyResources(f.registry, f.app), AppRowPolicyDefinitionError);
    assert.deepEqual(f.released, []);
  }
});

test('real registry acquisition integrates verified row reads with deployment retirement', async (t) => {
  const f = fixture(t);
  const deployment = await createAppPolicyDeployment({
    app: f.app,
    policy: defineAppRowPolicy({
      appId: 'policy',
      resolveRows: () => ({
        note: { groups: [[{ column: 'desk', op: '=', value: 1 }]] },
        'inventory.note': false,
      }),
    }),
    verifySession: async () => ({ id: 'reader', who: 'Reader', role: 'reader' }),
    acquire: (app) => acquireAppPolicyResources(f.registry, app),
  });
  await deployment.withContext({}, async (context) => {
    assert.equal(await context.data.count('note'), 1);
    assert.equal(await context.data.count('inventory.note'), 0);
  });
  assert.deepEqual(f.released, []);
  await deployment.retire();
  assert.deepEqual(f.released, ['stock', 'ops']);
});

test('explicit module loader creates a leased deployment without installing public routes', async (t) => {
  const f = fixture(t);
  const file = join(f.directory, 'private-policy.mjs');
  writeFileSync(file, "export default { appId: 'policy', resolveRows: () => ({ note: true }) };");
  const deployed = await loadAppPolicyDeployment({
    app: f.app,
    file,
    verifySession: async () => ({ id: 'reader', who: 'Reader', role: 'reader' }),
    acquire: (app) => acquireAppPolicyResources(f.registry, app),
  });
  await deployed.withContext({}, async (context) => {
    assert.equal(await context.data.count('note'), 2);
  });
  await deployed.retire();
  assert.deepEqual(f.released, ['stock', 'ops']);
});

test('bad or wrong-App module never acquires source leases', async (t) => {
  const f = fixture(t);
  for (const source of ["throw new Error('private module secret');", "export default { appId: 'other', resolveRows: () => ({}) };"]) {
    const file = join(f.directory, `policy-${source.length}.mjs`);
    writeFileSync(file, source);
    await assert.rejects(
      loadAppPolicyDeployment({
        app: f.app,
        file,
        verifySession: async () => null,
        acquire: async () => {
          assert.fail('Invalid module must not acquire sources');
        },
      }),
      AppRowPolicyDefinitionError,
    );
  }
  assert.deepEqual(f.released, []);
});

test('deployment loading captures App and provider/verifier identities before importing the module', async (t) => {
  const f = fixture(t);
  const file = join(f.directory, 'captured-policy.mjs');
  writeFileSync(file, "export default { appId: 'policy', resolveRows: () => ({ note: true }) };");
  const options = {
    app: f.app,
    file,
    verifySession: async () => ({ id: 'reader', who: 'Reader', role: 'reader' }),
    acquire: (app: typeof f.app) => {
      assert.ok(Object.isFrozen(app));
      assert.deepEqual(resourceCeiling(app).read, ['note', 'inventory.note']);
      return acquireAppPolicyResources(f.registry, app);
    },
  };
  const loading = loadAppPolicyDeployment(options);
  setCeilings(options.app, []);
  options.file = join(f.directory, 'missing-module.mjs');
  options.verifySession = async () => {
    throw new Error('replacement verifier');
  };
  options.acquire = async () => {
    throw new Error('replacement provider');
  };
  const deployed = await loading;
  await deployed.withContext({}, async (context) => {
    assert.equal(context.principal.id, 'reader');
    assert.equal(await context.data.count('note'), 2);
  });
  await deployed.retire();
});

for (const asynchronous of [false, true]) {
  test(`resolver output reflection faults stay private (${asynchronous ? 'async' : 'sync'})`, async (t) => {
    const f = fixture(t);
    const secret = 'private-policy-reflection-secret';
    const rows = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error(secret);
        },
      },
    );
    const deployment = await createAppPolicyDeployment({
      app: f.app,
      policy: defineAppRowPolicy({ appId: 'policy', resolveRows: () => (asynchronous ? Promise.resolve(rows) : rows) }),
      verifySession: async () => ({ id: 'reader', who: 'Reader', role: 'reader' }),
      acquire: (app) => acquireAppPolicyResources(f.registry, app),
    });
    await assert.rejects(
      deployment.withContext({}, async () => {
        assert.fail('Invalid resolver result must refuse');
      }),
      (error) => {
        assert.ok(error instanceof AppAccessDenied);
        assert.equal(error.cause, undefined);
        assert.ok(!error.stack?.includes(secret));
        return true;
      },
    );
    await deployment.retire();
  });
}
