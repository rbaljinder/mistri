import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Filter, QueryRequest } from '../packages/engine/src/adapters/adapter.js';
import { TransactionOutcomeUnknown } from '../packages/engine/src/adapters/adapter.js';
import { createConsoleApp, consoleInternalApp } from '../packages/mistri/src/server/console/app.js';
import { createConsoleCommands } from '../packages/mistri/src/server/console/commands.js';
import {
  createConsoleControlSource,
  type ConsoleAdmission,
  type ConsoleProof,
  type ConsoleRows,
  type ConsoleTargetService,
} from '../packages/mistri/src/server/console/controlSource.js';
import {
  matchFlagCapabilities,
  requiredFlagCapabilities,
  type FlagAuthorityCatalog,
  type FlagRoleCapabilities,
} from '../packages/mistri/src/server/flags/authority.js';
import { createFlagManagement } from '../packages/mistri/src/server/flags/management.js';
import {
  FlagManagementDenied,
  FlagRevisionConflict,
  type FlagStore,
  type FlagHistoryEntry,
} from '../packages/mistri/src/server/flags/store.js';
import { resolveResources, resolveViews } from '../packages/mistri/src/shared/app.js';

const catalog: FlagAuthorityCatalog = {
  flags: {
    visible: { type: 'boolean', default: false, safeValue: false, owner: 'release', tenantManaged: true },
    hidden: { type: 'boolean', default: false, safeValue: false, owner: 'secret', tenantManaged: true },
    trial: { type: 'string', default: 'a', safeValue: 'a', variants: ['a', 'b'], owner: 'release', tenantManaged: true },
  },
  roles: ['reader', 'killer', 'manager', 'experimentReader', 'admin'],
  audiences: {},
  experiments: {
    trial: {
      version: 'v1',
      weights: [
        { value: 'a', weight: 50 },
        { value: 'b', weight: 50 },
      ],
    },
  },
};
const roles: Record<string, FlagRoleCapabilities> = {
  reader: { realm: 'tenant', flags: [{ actions: ['view'], environments: ['production'], owners: ['release'] }] },
  killer: { realm: 'tenant', flags: [{ actions: ['killswitch'], environments: ['production'], owners: ['release'] }] },
  manager: { realm: 'tenant', flags: [{ actions: ['manage'], environments: ['production'], owners: ['release'] }] },
  experimentReader: { realm: 'tenant', experiments: [{ actions: ['view'], environments: ['production'], owners: ['release'] }] },
  admin: { realm: 'tenant' },
};
const eq = (column: string, value: string | number | boolean): Filter => ({ groups: [[{ column, op: '=', value }]] });
const query = (table = 'flags', extra: Partial<QueryRequest> = {}): QueryRequest => ({ table, limit: 25, offset: 0, ...extra });
function gate() {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
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

/** Authority fixture models owners, not Console: roles use the production
 * matcher and mutations use the real management service. Deferred reads and
 * the store's transaction fence expose actual races to the Console adapter. */
function fixture(granted = ['reader'], selectedTenant = 'tenant-a') {
  const state = {
    admitted: true,
    generation: 1,
    account: 'alice',
    tenant: 'tenant-a',
    active: true,
    roles: granted,
    revision: 0,
    commits: [] as FlagHistoryEntry[],
    reads: 0,
    changes: 0,
    readWait: undefined as ReturnType<typeof gate> | undefined,
    commitWait: undefined as ReturnType<typeof gate> | undefined,
    shellWait: undefined as ReturnType<typeof gate> | undefined,
    unknownOutcome: false,
    incomplete: false,
  };
  const generation = state.generation,
    account = state.account;
  const denied = () => {
    throw new FlagManagementDenied();
  };
  const shellCurrent = () => {
    if (!state.admitted || state.generation !== generation || state.account !== account) denied();
  };
  const admission: ConsoleAdmission = {
    admit: async () => {
      shellCurrent();
      return {
        assertCurrent: shellCurrent,
        reobserve: async () => {
          if (state.shellWait) await state.shellWait.wait();
          shellCurrent();
        },
      };
    },
  };
  const scope = { appId: 'shop', environment: 'production', tenantId: selectedTenant };
  const permitted = (flagId: string, operation: Parameters<ConsoleTargetService['authorize']>[1]) => {
    if (!state.active || state.account !== account || state.tenant !== selectedTenant || !Object.hasOwn(catalog.flags, flagId))
      return false;
    try {
      return matchFlagCapabilities(roles, state.roles, 'tenant', {
        scope,
        flagId,
        owner: catalog.flags[flagId].owner,
        requiredCapabilities: requiredFlagCapabilities(catalog, flagId, operation),
      });
    } catch {
      return false;
    }
  };
  const proof = (check: () => boolean): ConsoleProof => {
    const current = () => {
      if (!check()) denied();
    };
    return {
      assertCurrent: current,
      reobserve: async () => {
        await Promise.resolve();
        current();
      },
    };
  };
  const store: FlagStore = {
    binding: { suiteId: 'suite', deploymentId: 'deploy' },
    read: async () => ({ ...scope, revision: state.revision, overrides: {} }),
    history: async () => ({ entries: [], nextBeforeRevision: null }),
    close: async () => {},
    mutate: async (change, beforeCommit) => {
      if (state.commitWait) await state.commitWait.wait();
      if (change.expectedRevision !== state.revision) throw new FlagRevisionConflict();
      const before = { ...scope, revision: state.revision, overrides: {} };
      const entry: FlagHistoryEntry = {
        scope,
        flagId: change.flagId,
        operation: change.operation,
        actorId: change.actorId,
        reason: change.reason,
        revision: state.revision + 1,
        at: '2026-09-30T00:00:00.000Z',
        revertRevision: null,
        before,
        after: { ...before, revision: state.revision + 1 },
      };
      await beforeCommit();
      state.commits.push(entry);
      state.revision++;
      if (state.unknownOutcome) throw new TransactionOutcomeUnknown(new Error('lost acknowledgement'));
      return entry;
    },
  };
  const target: ConsoleTargetService = {
    ...scope,
    name: 'Shop',
    viewable: async () => {
      const visible = () => Object.keys(catalog.flags).some((id) => permitted(id, 'view') || permitted(id, 'experiment-view'));
      return visible() ? proof(visible) : null;
    },
    authorize: async (flagId, operation) => (permitted(flagId, operation) ? proof(() => permitted(flagId, operation)) : null),
    read: async <R extends keyof ConsoleRows>(resource: R, request: { flagId?: string; limit: number }) => {
      state.reads++;
      if (state.readWait) await state.readWait.wait();
      const ids = request.flagId ? [request.flagId] : Object.keys(catalog.flags);
      // Intentionally include a hidden candidate: the adapter's independent
      // per-record checks must still prevent its ID/count from escaping.
      const rows = ids.map((flagId) =>
        resource === 'flags'
          ? { flagId, owner: catalog.flags[flagId].owner, revision: 0, value: false, disabled: false, rawSecret: 'never expose' }
          : resource === 'history'
            ? { flagId, revision: 1, operation: 'kill', reason: 'incident', at: '2026-09-30', before: null, after: null }
            : {
                flagId,
                revision: 1,
                epoch: 'v1',
                method: 'Wilson/Newcombe',
                mature: 10,
                immature: 2,
                completeness: 'provisional',
                evidence: '{}',
              },
      );
      return { rows: rows as ConsoleRows[R][], complete: !state.incomplete };
    },
    change: async (input, consoleFence) => {
      state.changes++;
      const management = createFlagManagement({
        appId: scope.appId,
        environment: scope.environment,
        catalog,
        store,
        authorize: async (request) => {
          if (request.scope.tenantId !== selectedTenant || request.operation === 'decide') return null;
          const current = await target.authorize(request.flagId, request.operation);
          if (!current) return null;
          return {
            actorId: account,
            reobserve: async () => {
              await current.reobserve();
              await consoleFence();
              current.assertCurrent();
            },
          };
        },
      });
      return management.change(input);
    },
  };
  const source = createConsoleControlSource({ admission, targets: [target], selected: target, keySecret: Buffer.alloc(32, 7) });
  const commands = createConsoleCommands({ admission, target, flagId: 'visible' });
  return { state, admission, target, source, commands };
}

test('explicit private App uses existing DSL and read-only resource ceilings', async () => {
  const f = fixture(),
    app = createConsoleApp(),
    schema = await f.source.introspect();
  assert.deepEqual(consoleInternalApp, { id: 'mistri-console', internalApp: true, private: true, mountPath: '/_mistri/console' });
  assert.equal(app.auth?.public, undefined);
  assert.equal(app.auth?.roles?.admitted.write, false);
  assert.equal(app.auth?.roles?.admitted.flags, undefined);
  assert.deepEqual(resolveResources(app, schema).problems, []);
  // Feature flags, Operations, Analytics and the flags list.
  assert.deepEqual(Object.keys(resolveViews(app, schema)).sort(), ['analytics', 'flags', 'governance', 'operations', 'targets']);
  for (const method of [
    'update',
    'insert',
    'remove',
    'transaction',
    'commandTransaction',
    'runSql',
    'explainSql',
    'runView',
    'runBreakdown',
  ]) {
    assert.equal(method in f.source, false, method);
  }
});

test('Console admission and implicit admin grant no target visibility or totals', async () => {
  for (const granted of [[], ['admin'], ['killer']]) {
    const f = fixture(granted);
    assert.deepEqual((await f.source.query(query('targets'))).rows, []);
    assert.equal(await f.source.count('targets'), 0);
    assert.deepEqual((await f.source.query(query())).rows, []);
    assert.equal(f.state.reads, 0);
  }
});

test('authorized target rows, counts, detail and history exclude other owners', async () => {
  const f = fixture();
  const rows = (await f.source.query(query('flags', { orderBy: [{ column: 'flagId', direction: 'asc' }] }))).rows;
  assert.deepEqual(
    rows.map((row) => row.flagId),
    ['trial', 'visible'],
  );
  assert.equal(await f.source.count('flags'), 2);
  assert.equal(await f.source.count('flags', undefined, 1), 1);
  assert.equal(
    rows.some((row) => 'rawSecret' in row),
    false,
  );
  assert.equal(JSON.stringify(rows).includes('hidden'), false);
  assert.equal((await f.source.query(query('targets'))).rows.length, 1);
  assert.equal((await f.source.query(query('history', { filter: eq('flagId', 'visible') }))).rows.length, 1);
  const reads = f.state.reads;
  for (const table of ['flags', 'history', 'results'])
    await assert.rejects(f.source.query(query(table, { filter: eq('flagId', 'hidden') })));
  assert.equal(f.state.reads, reads, 'unauthorized exact IDs never reach the read service');
  const id = rows.find((row) => row.flagId === 'visible')!.id as string;
  assert.match(id, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await f.source.query(query('flags', { filter: eq('id', id), columns: ['flagId'] }))).rows[0].flagId, 'visible');
  const other = fixture(['reader'], 'tenant-b');
  other.state.tenant = 'tenant-b';
  const otherRows = (await other.source.query(query())).rows;
  assert.notEqual(otherRows.find((row) => row.flagId === 'visible')!.id, id);
  assert.deepEqual((await other.source.query(query('flags', { filter: eq('id', id) }))).rows, []);
});

test('results require experiment view independently; experiment-only target remains selectable', async () => {
  const f = fixture();
  await assert.rejects(f.source.query(query('results', { filter: eq('flagId', 'trial') })));
  f.state.roles = ['experimentReader'];
  assert.equal((await f.source.query(query('targets'))).rows.length, 1);
  assert.deepEqual((await f.source.query(query())).rows, []);
  assert.equal((await f.source.query(query('results', { filter: eq('flagId', 'trial') }))).rows[0].method, 'Wilson/Newcombe');
});

test('foreign tenant selection never confers membership', async () => {
  const f = fixture(['reader', 'killer'], 'tenant-foreign');
  assert.deepEqual((await f.source.query(query('targets'))).rows, []);
  await assert.rejects(f.source.query(query('history', { filter: eq('flagId', 'visible') })));
  await assert.rejects(f.commands.kill({ expectedRevision: 0, reason: 'incident' }));
  assert.equal(f.state.changes, 0);
});

test('held read responses are denied after target revocation, account, tenant or admission changes', async () => {
  for (const revoke of [
    (f: ReturnType<typeof fixture>) => {
      f.state.active = false;
    },
    (f: ReturnType<typeof fixture>) => {
      f.state.account = 'bob';
    },
    (f: ReturnType<typeof fixture>) => {
      f.state.tenant = 'tenant-b';
    },
    (f: ReturnType<typeof fixture>) => {
      f.state.admitted = false;
    },
    (f: ReturnType<typeof fixture>) => {
      f.state.generation++;
    },
  ]) {
    const f = fixture();
    f.state.readWait = gate();
    const pending = f.source.query(query());
    await f.state.readWait.entered;
    revoke(f);
    f.state.readWait.release();
    await assert.rejects(pending);
  }
});

test('final synchronous target fence catches revocation while Console observation awaits', async () => {
  const f = fixture();
  f.state.readWait = gate();
  const pending = f.source.query(query());
  await f.state.readWait.entered;
  f.state.shellWait = gate();
  f.state.readWait.release();
  await f.state.shellWait.entered;
  f.state.active = false;
  f.state.shellWait.release();
  await assert.rejects(pending);
});

test('closed read grammar refuses SQL, unknown resources/columns, unsupported filters and partial counts', async () => {
  const f = fixture();
  const invalid: unknown[] = [
    query('flag_state'),
    { ...query(), text: 'SELECT * FROM controls' },
    { ...query(), binary: true },
    query('flags', { columns: ['actorId'] }),
    query('flags', { filter: { groups: [[{ column: 'flagId', op: 'contains', value: 'v' }]] } }),
    query('flags', { filter: { groups: [[{ column: 'flagId', op: '=', other: 'owner' }]] } }),
    query('flags', { orderBy: [{ column: 'missing', direction: 'asc' }] }),
    query('history'),
    query('results'),
    query('flags', { limit: 101 }),
    query('flags', { offset: -1 }),
  ];
  for (const request of invalid) await assert.rejects(f.source.query(request as QueryRequest));
  assert.equal(f.state.reads, 0);
  f.state.incomplete = true;
  await assert.rejects(f.source.query(query()));
  await assert.rejects(f.source.count('flags'));
});

test('kill-only commands do not gain view/set/revert; replies contain no control values', async () => {
  const f = fixture(['killer']);
  assert.deepEqual(await f.commands.kill({ expectedRevision: 0, reason: 'incident' }), {
    flagId: 'visible',
    revision: 1,
    operation: 'kill',
  });
  await assert.rejects(f.commands.set({ expectedRevision: 1, reason: 'enable', override: { value: true } }));
  await assert.rejects(f.commands.revert({ expectedRevision: 1, reason: 'restore', revertRevision: 0 }));
  await assert.rejects(f.source.query(query('history', { filter: eq('flagId', 'visible') })));
  assert.equal(f.state.commits.length, 1);
});

test('command bodies cannot choose authority/scope; experiment changes require full management capabilities', async () => {
  const f = fixture(['manager']);
  for (const key of ['tenantId', 'appId', 'environment', 'flagId', 'roles', 'owner', 'actorId', 'capabilities', 'operation']) {
    await assert.rejects(f.commands.set({ expectedRevision: 0, reason: 'enable', override: { value: true }, [key]: 'forged' }));
  }
  assert.equal(f.state.changes, 0);
  const trial = createConsoleCommands({ admission: f.admission, target: f.target, flagId: 'trial' });
  await assert.rejects(trial.set({ expectedRevision: 0, reason: 'strip experiment', override: { value: 'a' } }));
  await assert.rejects(trial.revert({ expectedRevision: 0, reason: 'restore', revertRevision: 0 }));
  await f.commands.set({ expectedRevision: 0, reason: 'enable', override: { value: true } });
  assert.equal(f.state.commits.length, 1);
});

test('real management pre-commit fence rolls back held commands on target or Console revocation', async () => {
  for (const revoke of [
    (f: ReturnType<typeof fixture>) => {
      f.state.active = false;
    },
    (f: ReturnType<typeof fixture>) => {
      f.state.admitted = false;
    },
    (f: ReturnType<typeof fixture>) => {
      f.state.account = 'bob';
    },
  ]) {
    const f = fixture(['killer']);
    f.state.commitWait = gate();
    const pending = f.commands.kill({ expectedRevision: 0, reason: 'incident' });
    await f.state.commitWait.entered;
    revoke(f);
    f.state.commitWait.release();
    await assert.rejects(pending);
    assert.equal(f.state.commits.length, 0);
    assert.equal(f.state.revision, 0);
  }
});

test('CAS conflicts and unknown outcomes propagate once without retry or discarding input', async () => {
  const f = fixture(['killer']),
    input = { expectedRevision: 0, reason: 'incident' };
  f.state.revision = 1;
  await assert.rejects(f.commands.kill(input), FlagRevisionConflict);
  assert.deepEqual(input, { expectedRevision: 0, reason: 'incident' });
  assert.equal(f.state.changes, 1);
  assert.equal(f.state.commits.length, 0);
  f.state.revision = 0;
  f.state.unknownOutcome = true;
  await assert.rejects(f.commands.kill(input), TransactionOutcomeUnknown);
  assert.equal(f.state.changes, 2);
  assert.equal(f.state.commits.length, 1);
});

test('every new read and command repeats Console admission, including metadata/count', async () => {
  const f = fixture(['reader', 'killer']);
  await f.source.query(query());
  f.state.admitted = false;
  await assert.rejects(f.source.query(query()));
  await assert.rejects(f.source.count('targets'));
  await assert.rejects(f.source.introspect());
  await assert.rejects(f.commands.kill({ expectedRevision: 0, reason: 'incident' }));
  await f.source.close();
  f.state.admitted = true;
  await assert.rejects(f.source.query(query()));
});
