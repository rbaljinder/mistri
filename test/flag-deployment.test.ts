import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { normalizeFlagCatalog, normalizeFlagSnapshot } from '../packages/mistri/src/shared/appFlags.js';
import { createAppAuth } from '../packages/mistri/src/server/auth/auth.js';
import {
  createFlagDeployment,
  openFlagDeployment,
  FlagDeploymentRetired,
  type FlagControlSession,
} from '../packages/mistri/src/server/flags/deployment.js';
import { FlagManagementDenied, FlagStoreUnavailable, type FlagStore } from '../packages/mistri/src/server/flags/store.js';

const catalog = normalizeFlagCatalog({
  flags: { feature: { type: 'boolean', default: false, owner: 'product' } },
  roles: ['reader'],
  audiences: {},
});
const roles = { reader: { flags: [{ actions: ['view'] as const, environments: ['production'], owners: ['product'] }] } };
async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'tablewalk-flag-deployment-')),
    secret = 'flag-deployment-fixture-secret-at-least-thirty-two-characters';
  const auth = await createAppAuth(
    {
      path: join(dir, 'app.ts'),
      dir,
      sources: {},
      pages: [],
      app: parseAppConfig(
        {
          id: 'target',
          name: 'Target',
          auth: { store: 'auth.db', signUp: 'open', roles: { reader: { read: true } } },
          resources: { item: {} },
          views: { items: { kind: 'list', from: 'item' } },
          home: 'items',
        },
        'flags',
      ),
    },
    { baseURL: 'http://localhost:4111', trustedOrigins: ['http://localhost:4111'], environment: { BETTER_AUTH_SECRET: secret } },
  );
  const db = new DatabaseSync(auth.store);
  t.after(() => {
    auth.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const now = new Date().toISOString();
  db.prepare('INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt,role,banned) VALUES(?,?,?,?,?,?,?,?)').run(
    'subject',
    'Flag User',
    'flags@example.test',
    1,
    now,
    now,
    'reader',
    0,
  );
  db.prepare('INSERT INTO session(id,token,userId,expiresAt,createdAt,updatedAt) VALUES(?,?,?,?,?,?)').run(
    'session',
    'token',
    'subject',
    new Date(Date.now() + 60_000).toISOString(),
    now,
    now,
  );
  const signature = createHmac('sha256', secret).update('token').digest('base64');
  const req = { headers: { cookie: `mistri-target.session_token=${encodeURIComponent(`token.${signature}`)}` } } as IncomingMessage;
  let closed = 0;
  const store: FlagStore = {
    binding: { suiteId: 'suite', deploymentId: 'deployment' },
    read: async (scope) => normalizeFlagSnapshot({ ...scope, revision: 0, overrides: {} }, catalog),
    history: async () => ({ entries: [], nextBeforeRevision: null }),
    mutate: async () => {
      throw new Error('unexpected mutation');
    },
    close: async () => {
      closed++;
    },
  };
  const options = {
    suiteId: 'suite',
    deploymentId: 'deployment',
    environment: 'production',
    storeUrl: 'postgresql://operator@control/flags',
    targets: [{ appId: 'target', catalog, roles, tenantApp: false, auth, assertCurrent() {} }],
  };
  return { options, store, req, db, closed: () => closed };
}

test('deployment refuses ambient/incomplete URLs and invalid declarations before acquisition', async (t) => {
  const f = await fixture(t);
  for (const storeUrl of [
    '',
    'postgresql:///flags',
    'postgresql://control/flags',
    'postgresql://operator@control',
    '${FLAGS_URL}',
    'sqlite:flags.db',
    'postgresql://operator@control/flags?user=',
    'postgresql://operator@control/flags#x',
  ])
    assert.throws(() => createFlagDeployment({ ...f.options, storeUrl }, f.store), FlagStoreUnavailable);
  assert.throws(() => createFlagDeployment({ ...f.options, targets: [f.options.targets[0], f.options.targets[0]] }, f.store));
  assert.throws(() =>
    createFlagDeployment({ ...f.options, targets: [{ ...f.options.targets[0], roles: { reader: { flags: [] } } }] }, f.store),
  );
  await assert.rejects(
    openFlagDeployment({ ...f.options, targets: [{ ...f.options.targets[0], auth: { ...f.options.targets[0].auth } }] }),
  );
  assert.equal(f.closed(), 0, 'invalid startup has not acquired store ownership');
});

test('environment/catalog/roles are captured before startup awaits; borrowed native auth stays open', async (t) => {
  const f = await fixture(t);
  const input = {
    ...f.options,
    targets: f.options.targets.map((target) => ({
      ...target,
      roles: { reader: { flags: [{ actions: ['view'] as const, environments: ['production'], owners: ['product'] }] } },
    })),
  };
  const pending = createFlagDeployment(input, f.store);
  input.environment = 'staging';
  input.targets[0].roles.reader.flags[0].environments[0] = 'staging';
  const deployment = await pending;
  const row = await deployment.target('target').withRequest(
    f.req,
    'subject',
    () => {},
    (session) => session.get({ tenantId: null, flagId: 'feature' }),
  );
  assert.equal(row.environment, 'production');
  await deployment.close();
  await deployment.close();
  assert.equal(f.closed(), 1);
  assert.throws(() => deployment.target('target'), FlagDeploymentRetired);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM session').get()!.n, 1);
});

test('retirement stops new admission and drains held request/read before store close; leaked sessions deny', async (t) => {
  const f = await fixture(t);
  let release!: () => void, entered!: () => void, escaped: FlagControlSession | undefined;
  const held = new Promise<void>((resolve) => {
      release = resolve;
    }),
    seen = new Promise<void>((resolve) => {
      entered = resolve;
    });
  const deployment = await createFlagDeployment(f.options, {
    ...f.store,
    read: async (...args) => {
      entered();
      await held;
      return f.store.read(...args);
    },
  });
  const target = deployment.target('target');
  const pending = target.withRequest(
    f.req,
    'subject',
    () => {},
    (session) => {
      escaped = session;
      return session.get({ tenantId: null, flagId: 'feature' });
    },
  );
  const refused = assert.rejects(pending);
  await seen;
  const closing = deployment.close();
  assert.equal(f.closed(), 0);
  await assert.rejects(
    target.withRequest(
      f.req,
      'subject',
      () => {},
      async () => {},
    ),
    FlagDeploymentRetired,
  );
  release();
  await refused;
  await closing;
  assert.equal(f.closed(), 1);
  await assert.rejects(escaped!.get({ tenantId: null, flagId: 'feature' }));
});

test('store binding mismatch closes the acquired adapter; foreign target and account are refused', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    createFlagDeployment(f.options, { ...f.store, binding: { suiteId: 'foreign', deploymentId: 'deployment' } }),
    FlagStoreUnavailable,
  );
  assert.equal(f.closed(), 1);
  const deployment = await createFlagDeployment(f.options, f.store);
  assert.throws(() => deployment.target('other'), FlagManagementDenied);
  await assert.rejects(
    deployment.target('target').withRequest(
      f.req,
      'other',
      () => {},
      async () => {},
    ),
  );
  await deployment.close();
});

test('request lifetime drains operations even if a trusted callback forgets to await one', async (t) => {
  const f = await fixture(t);
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => {
      release = resolve;
    }),
    seen = new Promise<void>((resolve) => {
      entered = resolve;
    });
  const deployment = await createFlagDeployment(f.options, {
    ...f.store,
    read: async (...args) => {
      entered();
      await held;
      return f.store.read(...args);
    },
  });
  const pending = deployment.target('target').withRequest(
    f.req,
    'subject',
    () => {},
    async (session) => {
      void session.get({ tenantId: null, flagId: 'feature' });
      await seen;
    },
  );
  await seen;
  const closing = deployment.close();
  assert.equal(f.closed(), 0);
  release();
  await pending;
  await closing;
  assert.equal(f.closed(), 1);
});

test('trusted composed mutation fence is validated and bounded by the active request at the store commit guard', async (t) => {
  const f = await fixture(t);
  let active = true,
    mutations = 0,
    fences = 0;
  const deployment = await createFlagDeployment(
    {
      ...f.options,
      targets: [
        {
          ...f.options.targets[0],
          roles: { reader: { flags: [{ actions: ['manage'], environments: ['production'], owners: ['product'] }] } },
        },
      ],
    },
    {
      ...f.store,
      async mutate(_change, guard) {
        mutations++;
        await guard!();
        throw new Error('A retired composed request reached commit.');
      },
    },
  );
  t.after(() => deployment.close());
  const target = deployment.target('target'),
    input = {
      tenantId: null,
      flagId: 'feature',
      operation: 'set' as const,
      expectedRevision: 0,
      reason: 'Composed Console edit',
      override: { value: true },
    };
  const current = () => {
    if (!active) throw new FlagManagementDenied();
  };
  await assert.rejects(
    target.withRequest(f.req, 'subject', current, (session) => session.change(input, {} as () => Promise<void>)),
    FlagManagementDenied,
  );
  assert.equal(mutations, 0);
  await assert.rejects(
    target.withRequest(f.req, 'subject', current, (session) =>
      session.change(input, async () => {
        fences++;
        if (fences === 2) {
          await Promise.resolve();
          active = false;
        }
      }),
    ),
    FlagManagementDenied,
  );
  assert.equal(mutations, 1);
  assert.equal(fences, 2);
});
