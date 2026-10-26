/** Isolated native Console host shared by transport and real-browser acceptance. */
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { parseAppConfig, signInOf } from '../../packages/mistri/src/shared/app.js';
import { normalizeFlagSnapshot, type FlagOverride } from '../../packages/mistri/src/shared/appFlags.js';
import { createAppAuth, createSuiteAppAuth } from '../../packages/mistri/src/server/auth/auth.js';
import { openSuiteGrantStore, provisionSuiteGrantStore } from '../../packages/mistri/src/server/auth/suiteGrantStore.js';
import { createFlagDeployment } from '../../packages/mistri/src/server/flags/deployment.js';
import { FlagRevisionConflict, type FlagStore, type FlagHistoryEntry } from '../../packages/mistri/src/server/flags/store.js';
import { TransactionOutcomeUnknown } from '../../packages/engine/src/adapters/adapter.js';
import { consoleIdentityRegistration, openSuiteConsole } from '../../packages/mistri/src/server/console/host.js';
import { attachDevClient } from '../../packages/engine/src/server/devclient.js';
import type { AppAuthRuntime } from '../../packages/mistri/src/server/auth/auth.js';
import type { ConsoleOperationsOwner } from '../../packages/mistri/src/server/console/operations.js';

function hold() {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
      enter = resolve;
    }),
    released = new Promise<void>((resolve) => {
      release = resolve;
    });
  return {
    entered,
    release,
    wait: async () => {
      enter();
      await released;
    },
  };
}
/** `operations` builds the Operations and Analytics owners; `auth` gives each App its own projection of the suite session, with the roles it declares. */
export type ConsoleOperationsBuilder = (input: {
  auth(appId: string, roles: readonly string[]): AppAuthRuntime;
  dir: string;
  /** The suite's grant ledger, for the Governance room's accounts. */
  grants: ReturnType<typeof openSuiteGrantStore>;
}) => Promise<readonly ConsoleOperationsOwner[]>;
export async function consoleHostFixture(
  t: { after(cleanup: () => Promise<void>): void },
  showcase = false,
  port = 0,
  operations?: ConsoleOperationsBuilder,
) {
  const dir = mkdtempSync(join(tmpdir(), 'tw-console-host-'));
  const secret = 'console-host-native-fixture-secret-longer-than-32-characters';
  const native = await createAppAuth(
    {
      path: join(dir, 'identity.ts'),
      dir,
      pages: [],
      sources: {},
      app: parseAppConfig(
        {
          id: 'suite',
          name: 'Suite',
          auth: { store: join(dir, 'identity.db'), signUp: 'open', roles: { user: { read: true } } },
          resources: { unused: {} },
          views: { home: { kind: 'list', from: 'unused' } },
          home: 'home',
        },
        'identity',
      ),
    },
    { baseURL: 'http://localhost:4111/tools', trustedOrigins: ['http://localhost:4111'], environment: { BETTER_AUTH_SECRET: secret } },
  );
  const db = new DatabaseSync(native.store),
    grantDb = new DatabaseSync(join(dir, 'grants.db'));
  provisionSuiteGrantStore(grantDb, 'suite');
  const grants = openSuiteGrantStore(grantDb, 'suite');
  const now = new Date().toISOString();
  for (const account of ['alice', 'bob']) {
    db.prepare('INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt,role,banned) VALUES(?,?,?,?,?,?,?,?)').run(
      account,
      account,
      `${account}@example.test`,
      1,
      now,
      now,
      'admin',
      0,
    );
    db.prepare('INSERT INTO session(id,token,userId,expiresAt,createdAt,updatedAt) VALUES(?,?,?,?,?,?)').run(
      account,
      account,
      account,
      new Date(Date.now() + 60_000).toISOString(),
      now,
      now,
    );
  }
  const cookie = (account: string) =>
    `mistri-suite.session_token=${encodeURIComponent(`${account}.${createHmac('sha256', secret).update(account).digest('base64')}`)}`;
  const registration = consoleIdentityRegistration('/tools');
  const suiteAuth = createSuiteAppAuth(native, {
    appId: registration.app.app.id,
    spec: signInOf(registration.app.app.auth)!,
    roles: ['admitted'],
    basePath: registration.basePath,
    suiteBase: '/tools',
    grant: grants.read,
  });
  const targetAuth = createSuiteAppAuth(native, {
    appId: 'shop',
    spec: signInOf(registration.app.app.auth)!,
    roles: ['reader', 'killer', 'manager'],
    basePath: '/tools/shop',
    suiteBase: '/tools',
    grant: grants.read,
  });
  const catalog = {
    flags: {
      ...(showcase
        ? Object.fromEntries(
            ['creditCheck', 'instantOffers', 'offerComparison', 'partnerOnboarding', 'smartRouting'].map((id) => [
              id,
              { type: 'boolean' as const, default: false, safeValue: false, owner: 'release' },
            ]),
          )
        : {}),
      feature: { type: 'boolean' as const, default: false, safeValue: false, owner: 'release' },
      secret: { type: 'boolean' as const, default: false, owner: 'private' },
    },
    roles: ['reader', 'killer', 'manager'],
    audiences: {
      readers: { roles: ['reader'] },
      managers: { roles: ['manager'] },
      northReaders: { roles: ['reader'], tenants: ['north'] },
    },
  };
  const state = {
    read: undefined as ReturnType<typeof hold> | undefined,
    reads: 0,
    revision: 0,
    commit: undefined as ReturnType<typeof hold> | undefined,
    entries: [] as FlagHistoryEntry[],
    overrides: (showcase
      ? {
          creditCheck: { value: true, rollout: 25 },
          instantOffers: { value: true, rollout: 75 },
          offerComparison: { value: true },
          partnerOnboarding: { disabled: true },
          smartRouting: { value: true, rollout: 10 },
        }
      : {}) as Record<string, FlagOverride>,
    unknown: false,
  };
  const store: FlagStore = {
    binding: { suiteId: 'suite', deploymentId: 'production' },
    read: async (scope) => {
      state.reads++;
      if (state.read) await state.read.wait();
      return normalizeFlagSnapshot({ ...scope, revision: state.revision, overrides: state.overrides }, catalog);
    },
    history: async (_scope, _catalog, query) => ({
      entries: state.entries.filter((row) => row.flagId === query.flagId).toReversed(),
      nextBeforeRevision: null,
    }),
    mutate: async (change, beforeCommit) => {
      if (state.commit) await state.commit.wait();
      if (change.expectedRevision !== state.revision) throw new FlagRevisionConflict();
      const before = normalizeFlagSnapshot({ ...change.scope, revision: state.revision, overrides: state.overrides }, catalog);
      const overrides = { ...state.overrides };
      if (change.operation === 'kill') overrides[change.flagId] = { ...overrides[change.flagId], disabled: true };
      else if (change.operation === 'set') overrides[change.flagId] = change.override;
      else delete overrides[change.flagId];
      const after = normalizeFlagSnapshot({ ...change.scope, revision: state.revision + 1, overrides }, catalog);
      await beforeCommit();
      const row: FlagHistoryEntry = {
        scope: change.scope,
        flagId: change.flagId,
        actorId: change.actorId,
        operation: change.operation,
        reason: change.reason,
        revision: after.revision,
        before,
        after,
        at: new Date().toISOString(),
        revertRevision: change.operation === 'revert' ? change.revertRevision : null,
      };
      state.overrides = overrides;
      state.revision++;
      state.entries.push(row);
      if (state.unknown) throw new TransactionOutcomeUnknown(new Error('acknowledgement lost'));
      return row;
    },
    close: async () => {},
  };
  const deployment = await createFlagDeployment(
    {
      suiteId: 'suite',
      deploymentId: 'production',
      environment: 'production',
      storeUrl: 'postgresql://operator@private.invalid/flags',
      targets: [
        {
          appId: 'shop',
          catalog,
          tenantApp: false,
          roles: {
            reader: { flags: [{ actions: ['view'], environments: ['production'], owners: ['release'] }] },
            killer: { flags: [{ actions: ['killswitch'], environments: ['production'], owners: ['release'] }] },
            manager: { flags: [{ actions: ['manage'], environments: ['production'], owners: ['release'] }] },
          },
          auth: targetAuth,
          assertCurrent() {},
        },
      ],
    },
    store,
  );
  const bound = { host: '127.0.0.1', port: 0 };
  const declared = new Map<string, readonly string[]>([
    ['shop', ['reader', 'killer', 'manager']],
    [registration.app.app.id, ['admitted']],
  ]);
  const opened: AppAuthRuntime[] = [];
  const owners = operations
    ? await operations({
        dir,
        grants,
        auth: (appId, roles) => {
          declared.set(appId, roles);
          const auth = createSuiteAppAuth(native, {
            appId,
            spec: signInOf(registration.app.app.auth)!,
            roles: [...roles],
            basePath: `/tools/${appId}`,
            suiteBase: '/tools',
            grant: grants.read,
          });
          opened.push(auth);
          return auth;
        },
      })
    : undefined;
  const consoleHost = await openSuiteConsole({
    registration,
    suiteBase: '/tools',
    suiteAuth,
    bound,
    ...(owners ? { operations: owners } : {}),
    targets: [{ target: deployment.target('shop'), auth: targetAuth, name: 'Shop', tenantApp: false, flags: catalog.flags }],
  });
  // In production composition createSuite owns this source renderer on its
  // shared listener. This fixture's only listener plays that same role.
  attachDevClient(consoleHost.server);
  await new Promise<void>((resolve) => consoleHost.server.listen(port, '127.0.0.1', resolve));
  bound.port = (consoleHost.server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${bound.port}`,
    base = origin + registration.basePath;
  t.after(async () => {
    await consoleHost.stop();
    await new Promise<void>((resolve) => consoleHost.server.close(() => resolve()));
    await consoleHost.close();
    await deployment.close();
    targetAuth.close();
    for (const auth of opened) auth.close();
    native.close();
    db.close();
    grantDb.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const grant = (appId: string, roles: string[], subjectId = 'alice') =>
    grants.change({
      subjectId,
      appId,
      roles,
      expectedRevision: grants.read(subjectId, appId).revision,
      actorId: 'operator',
      declaredRoles: [...(declared.get(appId) ?? [])],
    });
  const call = async (path: string, body?: unknown, account = 'alice', headers: Record<string, string> = {}) => {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { cookie: cookie(account), origin, 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { response, text, json: () => JSON.parse(text) };
  };
  return { consoleHost, grant, call, state, db, cookie, base, origin, registration };
}
