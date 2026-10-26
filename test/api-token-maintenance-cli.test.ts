import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runApiTokenMaintenance } from '../packages/mistri/src/server/cli/apiTokenMaintenance.js';
import { parseTestApp } from './support/commandCatalog.js';

const id = '12345678-1234-4abc-8def-123456789abc';
const common = ['--app', '/operator/app', '--config', '/operator/config.json', '--store-id', id];
type Dependencies = NonNullable<Parameters<typeof runApiTokenMaintenance>[1]>;
function fixture() {
  const calls: unknown[][] = [];
  const app = {
    app: parseTestApp(
      {
        id: 'example',
        name: 'Example',
        resources: { item: {} },
        views: { items: { kind: 'list', from: 'item' } },
        home: 'items',
        auth: { store: '/operator/auth.sqlite' },
      },
      'fixture',
    ),
    path: '/operator/app/app.json',
    pages: [],
    sources: {},
  };
  const connections = [{ id: 'business', name: 'Business', url: '/operator/business.sqlite', source: 'argument' as const }];
  const context = Object.freeze({ path: '/operator/auth.sqlite', appId: 'example', exclusions: Object.freeze([]) });
  const evidence = Object.freeze({ connectionFor: () => 'business', writableConnection: () => true, transactionalConnection: () => true });
  const dependencies: Dependencies = {
    async loadConfig(path) {
      calls.push(['config', path]);
      return { path: path!, connections, services: [] };
    },
    async loadApp(path, options) {
      calls.push(['app', path, options]);
      return app;
    },
    async context(apps, config) {
      calls.push(['context', apps, config]);
      return context;
    },
    provision(path, owner) {
      calls.push(['provision', path, owner]);
      return Object.freeze({ migrated: false, version: 1, appId: owner.appId, storeId: owner.storeId });
    },
    inspect(path, owner) {
      calls.push(['inspect', path, owner]);
      return null;
    },
    revoke(path, owner, now) {
      calls.push(['revoke', path, owner, now]);
      return Object.freeze({ tokenId: owner.tokenId, version: '2' });
    },
    now() {
      calls.push(['clock']);
      return 1234;
    },
    async schema(app, config, capture) {
      calls.push(['schema', app, config]);
      capture?.(evidence);
      return { label: 'fixture', dialect: 'sqlite', readAt: '', tables: [], foreignKeys: [] };
    },
    issue(path, app, schema, options, now) {
      calls.push(['issue', path, app, schema, options, now]);
      return Object.freeze({ token: 'synthetic-secret', tokenId: options.tokenId!, version: '1' });
    },
    async pgContext() {
      calls.push(['pgContext']);
      return { appId: 'example', url: 'postgres://user:password@localhost:5432/auth', excludeConnections: [] };
    },
    async pgProvision(url, owner) {
      calls.push(['pgProvision', url, owner]);
      return { migrated: false, version: 1, appId: owner.appId, storeId: owner.storeId };
    },
    async pgInspect(url, owner) {
      calls.push(['pgInspect', url, owner]);
      return null;
    },
    async pgRevoke(url, owner, clock) {
      calls.push(['pgRevoke', url, owner, clock()]);
      return { tokenId: owner.tokenId, version: '2' };
    },
    async pgSchema(_app, _config, _exclusions, capture) {
      calls.push(['pgSchema']);
      capture?.(evidence);
      return { label: 'PG', dialect: 'postgres', readAt: '', tables: [], foreignKeys: [] };
    },
    async pgIssue(url, app, schema, options, clock) {
      calls.push(['pgIssue', url, app, schema, options, clock()]);
      return { token: 'synthetic-secret', tokenId: options.tokenId!, version: '1' };
    },
    async commands(file) {
      calls.push(['commands', file]);
      return {};
    },
    commandIssue(path, _app, _schema, registry, captured, options, now) {
      calls.push(['commandIssue', path, registry, captured, options, now]);
      return Object.freeze({ token: 'synthetic-secret', tokenId: options.tokenId!, version: '1' as const });
    },
    async pgCommandIssue(url, _app, _schema, registry, captured, options, clock) {
      calls.push(['pgCommandIssue', url, registry, captured, options, clock()]);
      return { token: 'synthetic-secret', tokenId: options.tokenId!, version: '1' as const };
    },
    async tenant(_app, _config, input, commands) {
      calls.push(['tenant', input, ...(commands ? [commands] : [])]);
      return Object.freeze({
        catalog: Object.freeze({ stage: 'read-validation-foundation' as const, operations: Object.freeze([]) }),
        tenant: Object.freeze({
          tenantId: input.tenantId,
          membershipId: 'membership',
          membershipVersion: '1',
          roles: Object.freeze(['reader']),
        }),
      });
    },
    tenantIssue(path, _app, _catalog, options, now) {
      calls.push(['tenantIssue', path, options, now]);
      return Object.freeze({ token: 'synthetic-secret', tokenId: options.tokenId!, version: '1' as const });
    },
    async pgTenantIssue(url, _app, _catalog, options, clock) {
      calls.push(['pgTenantIssue', url, options, clock()]);
      return { token: 'synthetic-secret', tokenId: options.tokenId!, version: '1' as const };
    },
  };
  return { dependencies, calls, app, connections, context };
}

test('private handler loads explicit snapshots then dispatches bounded maintenance with exact owner facts', async () => {
  for (const verb of ['provision', 'inspect', 'revoke']) {
    const f = fixture();
    const extra =
      verb === 'provision' ? [] : ['--token-id', id, ...(verb === 'revoke' ? ['--expected-version', '1', '--actor', 'operator'] : [])];
    const result = await runApiTokenMaintenance([verb, ...common, ...extra], f.dependencies);
    assert.equal(result.verb, verb);
    assert.ok(Object.isFrozen(result));
    assert.deepEqual(f.calls.slice(0, 3), [
      ['config', '/operator/config.json'],
      ['app', '/operator/app', { lock: 'enforce' }],
      ['context', [f.app], f.connections.map((connection) => ({ ...connection, source: 'config' }))],
    ]);
    const owner = { appId: 'example', storeId: id, exclusions: f.context.exclusions };
    assert.deepEqual(
      f.calls.slice(3),
      verb === 'provision'
        ? [['provision', f.context.path, owner]]
        : verb === 'inspect'
          ? [['inspect', f.context.path, { ...owner, tokenId: id }]]
          : [['clock'], ['revoke', f.context.path, { ...owner, tokenId: id, expectedVersion: '1', actorId: 'operator' }, 1234]],
    );
  }
});

test('malformed/mixed arguments refuse before any loader or clock', async () => {
  for (const argv of [
    ['provision', ...common, '--port', '1234'],
    ['issue', ...common],
  ]) {
    const f = fixture();
    await assert.rejects(runApiTokenMaintenance(argv, f.dependencies), { message: 'API token maintenance could not be completed.' });
    assert.deepEqual(f.calls, []);
  }
});

const issueArgs = [
  'issue',
  ...common,
  '--subject',
  'account',
  '--actor',
  'operator',
  '--role',
  'reader',
  '--label',
  'API',
  '--expires-at',
  '2030-01-01T00:00:00Z',
];
test('PostgreSQL routes provision/inspect/revoke through once-resolved context', async () => {
  for (const verb of ['provision', 'inspect', 'revoke']) {
    const f = fixture();
    f.app.app.auth!.store = 'postgres://user:password@localhost:5432/auth';
    const argv = [
      verb,
      ...common,
      ...(verb === 'provision' ? [] : ['--token-id', id]),
      ...(verb === 'revoke' ? ['--expected-version', '1', '--actor', 'operator'] : []),
    ];
    {
      const result = await runApiTokenMaintenance(argv, f.dependencies);
      assert.equal(result.verb, verb);
      assert.deepEqual(
        f.calls.map((call) => call[0]),
        ['config', 'app', 'pgContext', ...(verb === 'revoke' ? ['clock'] : []), 'pg' + verb[0].toUpperCase() + verb.slice(1)],
      );
      const call = f.calls.at(-1)!;
      assert.equal(call[1], 'postgres://user:password@localhost:5432/auth');
      assert.deepEqual(call[2], {
        appId: 'example',
        storeId: id,
        excludeConnections: [],
        ...(verb === 'provision' ? {} : { tokenId: id }),
        ...(verb === 'revoke' ? { expectedVersion: '1', actorId: 'operator' } : {}),
      });
    }
  }
});
test('PG issue awaits commit, uses fresh clock callback and refuses stale context before locator/native issuance', async () => {
  for (const changed of [false, true]) {
    const f = fixture();
    f.app.app.auth!.store = 'postgres://user:password@localhost:5432/auth';
    let contexts = 0,
      calls = 0,
      locator: string | undefined;
    const context = f.dependencies.pgContext;
    f.dependencies.pgContext = async (...args) => {
      const value = await context(...args);
      return ++contexts === 2 && changed ? { ...value, url: value.url + 'changed' } : value;
    };
    let finish: (() => void) | undefined;
    f.dependencies.pgIssue = async (_url, _app, _schema, options, clock) => {
      calls++;
      assert.equal(options.tokenId, locator);
      assert.equal(typeof clock, 'function');
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { token: 'committed-secret', tokenId: options.tokenId!, version: '1' };
    };
    const pending = runApiTokenMaintenance(issueArgs, f.dependencies, (id) => {
      locator = id;
    });
    if (changed) {
      await assert.rejects(pending);
      assert.equal(calls, 0);
      assert.equal(locator, undefined);
    } else {
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      while (!finish) await new Promise((resolve) => setImmediate(resolve));
      assert.equal(settled, false);
      finish();
      const result = await pending;
      assert.equal(result.verb, 'issue');
      assert.equal(calls, 1);
    }
  }
});
test('issue closes schema preflight, rechecks context and publishes one locator before owner with exact optional operations', async () => {
  for (const extra of [[], ['--deny-all-operations'], ['--operation', 'list:item']]) {
    const f = fixture();
    const locators: string[] = [];
    const result = await runApiTokenMaintenance([...issueArgs, ...extra], f.dependencies, (id) => {
      locators.push(id);
      f.calls.push(['locator']);
    });
    assert.equal(result.verb, 'issue');
    assert.equal(locators.length, 1);
    assert.match(locators[0], /^[0-9a-f-]{36}$/);
    assert.deepEqual(
      f.calls.map((call) => call[0]),
      ['config', 'app', 'context', 'schema', 'context', 'locator', 'clock', 'issue'],
    );
    const options = f.calls.at(-1)![4] as Record<string, unknown>;
    assert.equal(options.tokenId, locators[0]);
    if (!extra.length) assert.equal(Object.hasOwn(options, 'operations'), false);
    else assert.deepEqual(options.operations, extra[0] === '--operation' ? ['list:item'] : []);
  }
});
test('schema/context/locator failure cannot issue; uncertain owner is attempted once with retained locator', async () => {
  for (const stage of ['schema', 'context', 'locator', 'issue']) {
    const f = fixture();
    let issued = 0,
      announced = 0,
      contexts = 0;
    const context = f.dependencies.context;
    f.dependencies.context = async (...args) => {
      if (++contexts === 2 && stage === 'context') throw Error('stale');
      return context(...args);
    };
    if (stage === 'schema')
      f.dependencies.schema = async () => {
        throw Error('schema');
      };
    f.dependencies.issue = () => {
      issued++;
      throw Error('uncertain secret');
    };
    await assert.rejects(
      runApiTokenMaintenance(issueArgs, f.dependencies, () => {
        announced++;
        if (stage === 'locator') throw Error('output');
      }),
      { message: 'API token maintenance could not be completed.' },
    );
    assert.equal(issued, stage === 'issue' ? 1 : 0);
    assert.equal(announced, stage === 'issue' || stage === 'locator' ? 1 : 0);
  }
});

test('issue takes --commands exactly when the App exposes commands, loading the registry before the catalog read', async () => {
  const exposing = () => {
    const f = fixture();
    f.app.app.api = {
      version: 1,
      roles: ['reader'],
      publicSpec: false,
      resources: {},
      views: [],
      commands: [{ command: { id: 'change', version: 1, target: 'item', input: {} } }],
    } as never;
    return f;
  };
  const withCommands = [...issueArgs, '--commands', '/operator/commands.ts'];
  // Refused before any context, catalog or command module is read.
  for (const [f, argv] of [
    [fixture(), withCommands],
    [exposing(), issueArgs],
  ] as const) {
    await assert.rejects(runApiTokenMaintenance(argv, f.dependencies), { message: 'API token maintenance could not be completed.' });
    assert.deepEqual(
      f.calls.map((call) => call[0]),
      ['config', 'app'],
    );
  }
  for (const argv of [
    [...withCommands, '--commands', '/operator/other.ts'],
    ['provision', ...common, '--commands', '/operator/commands.ts'],
  ]) {
    const f = exposing();
    await assert.rejects(runApiTokenMaintenance(argv, f.dependencies));
    assert.deepEqual(f.calls, []);
  }
  {
    const f = exposing();
    const result = await runApiTokenMaintenance([...withCommands, '--operation', 'command:change'], f.dependencies, () => {
      f.calls.push(['locator']);
    });
    assert.equal(result.verb, 'issue');
    assert.deepEqual(
      f.calls.map((call) => call[0]),
      ['config', 'app', 'context', 'commands', 'schema', 'context', 'locator', 'clock', 'commandIssue'],
    );
    assert.deepEqual(f.calls[3], ['commands', '/operator/commands.ts']);
    const [, path, registry, captured, options] = f.calls.at(-1)! as [string, string, unknown, unknown, Record<string, unknown>];
    assert.equal(path, f.context.path);
    assert.deepEqual(registry, {});
    assert.equal((captured as { connectionFor(resource: string): string }).connectionFor('item'), 'business');
    assert.deepEqual(options.operations, ['command:change']);
  }
  {
    const f = exposing();
    f.app.app.auth!.store = 'postgres://user:password@localhost:5432/auth';
    const result = await runApiTokenMaintenance(withCommands, f.dependencies);
    assert.equal(result.verb, 'issue');
    assert.deepEqual(
      f.calls.map((call) => call[0]),
      ['config', 'app', 'pgContext', 'commands', 'pgSchema', 'pgContext', 'clock', 'pgCommandIssue'],
    );
  }
  // Revoke and its siblings never load command code, even for such an App.
  for (const verb of ['provision', 'inspect']) {
    const f = exposing();
    await runApiTokenMaintenance([verb, ...common, ...(verb === 'inspect' ? ['--token-id', id] : [])], f.dependencies);
    assert.equal(
      f.calls.some((call) => call[0] === 'commands'),
      false,
    );
  }
});

test('issue binds a tenant App token through --tenant and --policy only, and an all App never', async () => {
  const tenantApp = () => {
    const f = fixture();
    f.app.app.auth!.rows = 'tenant' as never;
    return f;
  };
  const bound = [...issueArgs, '--tenant', 'north', '--policy', '/operator/policy.mts'];
  // Refused before any context, catalog or policy module is read.
  for (const [f, argv] of [
    [fixture(), bound],
    [tenantApp(), issueArgs],
    [tenantApp(), [...issueArgs, '--tenant', 'north']],
    [tenantApp(), [...bound, '--commands', '/operator/commands.ts']],
  ] as const) {
    await assert.rejects(runApiTokenMaintenance(argv, f.dependencies), { message: 'API token maintenance could not be completed.' });
    assert.deepEqual(
      f.calls.map((call) => call[0]),
      ['config', 'app'],
      argv.join(' '),
    );
  }
  // The tenant selector's own grammar, before anything is loaded.
  for (const tenant of ['North', ' north', 'north/1', '']) {
    const f = tenantApp();
    await assert.rejects(runApiTokenMaintenance([...issueArgs, '--tenant', tenant, '--policy', '/p.mts'], f.dependencies));
    assert.deepEqual(f.calls, []);
  }
  {
    const f = tenantApp();
    const result = await runApiTokenMaintenance(bound, f.dependencies, () => {
      f.calls.push(['locator']);
    });
    assert.equal(result.verb, 'issue');
    assert.deepEqual(
      f.calls.map((call) => call[0]),
      ['config', 'app', 'context', 'tenant', 'context', 'locator', 'clock', 'tenantIssue'],
    );
    assert.deepEqual(f.calls[3], ['tenant', { policyFile: '/operator/policy.mts', tenantId: 'north', accountId: 'account' }]);
    const options = f.calls.at(-1)![2] as Record<string, unknown>;
    assert.deepEqual(options.tenant, { tenantId: 'north', membershipId: 'membership', membershipVersion: '1', roles: ['reader'] });
  }
  {
    // A tenant App that exposes commands: its registry is loaded first and
    // checked with the tenant catalog, never the ordinary command evidence.
    const f = tenantApp();
    f.app.app.api = {
      version: 1,
      roles: ['reader'],
      publicSpec: false,
      resources: {},
      views: [],
      commands: [{ command: { id: 'change', version: 1, target: 'item', input: {} } }],
    } as never;
    const result = await runApiTokenMaintenance([...bound, '--commands', '/operator/commands.ts'], f.dependencies);
    assert.equal(result.verb, 'issue');
    assert.deepEqual(
      f.calls.map((call) => call[0]),
      ['config', 'app', 'context', 'commands', 'tenant', 'context', 'clock', 'tenantIssue'],
    );
    assert.deepEqual(f.calls[4], ['tenant', { policyFile: '/operator/policy.mts', tenantId: 'north', accountId: 'account' }, {}]);
  }
  {
    const f = tenantApp();
    f.app.app.auth!.store = 'postgres://user:password@localhost:5432/auth';
    await runApiTokenMaintenance(bound, f.dependencies);
    assert.deepEqual(
      f.calls.map((call) => call[0]),
      ['config', 'app', 'pgContext', 'tenant', 'pgContext', 'clock', 'pgTenantIssue'],
    );
  }
});

test('failed load/context/owner errors never expose credentials and never retry mutation', async () => {
  for (const stage of ['loadConfig', 'loadApp', 'context', 'provision'] as const) {
    const f = fixture();
    let attempts = 0;
    f.dependencies[stage] = () => {
      attempts++;
      throw new Error('secret postgres://password@host');
    };
    await assert.rejects(runApiTokenMaintenance(['provision', ...common], f.dependencies), (error) => {
      assert.equal((error as Error).message, 'API token maintenance could not be completed.');
      assert.equal((error as Error).cause, undefined);
      return true;
    });
    assert.equal(attempts, 1);
    assert.equal(
      f.calls.some((call) => call[0] === 'provision'),
      false,
    );
  }
});
