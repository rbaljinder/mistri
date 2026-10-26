import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { Refusal, TransactionOutcomeUnknown, type Adapter } from '../packages/engine/src/adapters/adapter.js';
import {
  COMMAND_JOURNAL_TABLES,
  CommandTransactionFailure,
  migrateSqliteCommandJournal,
} from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { AppAccessDenied } from '../packages/mistri/src/server/app/appAccess.js';
import {
  createAppPolicyContext,
  type AppPolicyContext,
  type AppPolicyContextOptions,
} from '../packages/mistri/src/server/policy/appPolicyContext.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import {
  BusinessCommandExecutionError,
  type BusinessCommandResult,
} from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import {
  defineCommand,
  type BusinessCommandActor,
  type BusinessCommandContext,
} from '../packages/mistri/src/server/commands/businessCommands.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import { commandsOf } from '../packages/mistri/src/server/stores/commandStores.js';

interface Request {
  cookie?: string;
  body?: unknown;
}
type Options = AppPolicyContextOptions<Request>;
const owner = 'private-command-owner';
const signedIn: Request = { cookie: 'manager-session' };
const request = (overrides: Record<string, unknown> = {}) => ({
  command: 'assign',
  commandVersion: 1,
  key: { id: 1 },
  expectedVersion: 0,
  idempotencyKey: 'policy-command-request',
  input: { assignee: 'Ada' },
  ...overrides,
});
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function commandError(code: string, outcome = 'not_applied') {
  return (error: unknown) => {
    assert.ok(error instanceof BusinessCommandExecutionError);
    assert.equal(error.code, code);
    assert.equal(error.outcome, outcome);
    return true;
  };
}

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-policy-command-'));
  const path = join(directory, 'commands.db');
  const db = new DatabaseSync(path);
  const registry = new Registry();
  t.after(async () => {
    try {
      await registry.closeAll();
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  db.exec(`
    CREATE TABLE physical_loan (id INTEGER PRIMARY KEY, desk INTEGER NOT NULL,
      version INTEGER NOT NULL, assignee TEXT NOT NULL);
    CREATE TABLE physical_note (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
    INSERT INTO physical_loan VALUES (1, 1, 0, 'Unassigned'), (2, 2, 0, 'Hidden');
    INSERT INTO physical_note VALUES (1, 'Original');
  `);
  await migrateSqliteCommandJournal(path);
  registry.add({ id: owner, name: 'Command context fixture', url: path, writable: true, source: 'config' });
  const app = parseAppConfig(
    {
      id: 'command-policy',
      name: 'Command policy',
      sources: { operations: { connection: owner } },
      resources: { loan: { physical: 'physical_loan', access: 'write' }, note: { physical: 'physical_note', access: 'write' } },
      auth: { roles: { manager: { read: true, write: ['note'], commands: ['assign'] }, viewer: { read: true } } },
      views: { loans: { kind: 'list', from: 'loan' } },
      home: 'loans',
    },
    'policy command fixture',
  );
  const loaded = await loadAppRuntimeResources(registry, app, owner);
  // Hold stable facade objects so capture tests can replace their capabilities.
  const anchor = loaded.forConnection(owner);
  const resources = {
    ...loaded,
    forConnection: (connection: string): Adapter => {
      assert.equal(connection, owner);
      return anchor;
    },
  };
  const control = {
    calls: 0,
    writable: true,
    actors: [] as BusinessCommandActor[],
    handle: undefined as ((context: BusinessCommandContext) => Promise<void>) | undefined,
  };
  // The declaration parses; `validate` is the rule left, captured at registration like every callback.
  const input = {
    fields: { assignee: { label: 'Assignee', type: 'text' } } as const,
    validate(value: { assignee: string }) {
      assert.ok(value && typeof value === 'object' && typeof value.assignee === 'string');
      return { assignee: value.assignee };
    },
  };
  const output = {
    parse(value: unknown) {
      const result = value as { id: number; version: number };
      assert.ok(result && Number.isSafeInteger(result.id) && Number.isSafeInteger(result.version));
      return { id: result.id, version: result.version };
    },
  };
  const assign = async (context: BusinessCommandContext, value: { assignee: string }) => {
    control.calls++;
    control.actors.push(context.actor);
    assert.ok(Object.isFrozen(context.actor));
    assert.ok(Object.isFrozen(context.actor.roles));
    assert.deepEqual(Reflect.ownKeys(context.tx).sort(), ['count', 'insert', 'query', 'remove', 'update']);
    assert.ok(!Reflect.ownKeys(context).some((key) => ['journal', 'authorize', 'binding'].includes(String(key))));
    if (control.handle) await control.handle(context);
    // The assignee is read again after the hook; the revision is the one the platform checked.
    const id = Number(context.record!.id),
      version = Number(context.record!.version);
    const current = await context.tx.query({
      table: 'loan',
      columns: ['assignee'],
      limit: 1,
      offset: 0,
      filter: { groups: [[{ column: 'id', op: '=', value: id }]] },
    });
    await context.tx.update({
      table: 'loan',
      key: { id },
      expected: { version, assignee: String(current.rows[0].assignee) },
      values: { assignee: value.assignee, version: version + 1 },
    });
    return { id, version: version + 1 };
  };
  // A replacement registration differs only in its handler, so capture tests can swap one in.
  const define = (handle: typeof assign | (() => never) = assign) =>
    defineCommand({
      source: 'operations',
      target: 'loan',
      read: ['loan'],
      write: ['loan'],
      input: input.fields,
      validate: input.validate,
      output,
      handle,
    });
  const command = define();
  const commands = {
    registry: { assign: command },
    writableConnection: (connection: string) => connection === owner && control.writable,
    resultReferences: { assign: (result: unknown) => [{ table: 'loan', key: { id: (result as { id: number }).id } }] },
  };
  const identities = new Map<string, Identity>([
    ['manager-session', { id: 'verified-manager', who: 'manager@example.test', role: 'manager' }],
    ['other-session', { id: 'other-manager', who: 'other@example.test', role: 'manager' }],
    ['viewer-session', { id: 'viewer', who: 'viewer@example.test', role: 'viewer' }],
  ]);
  const rows: Record<string, RowScope[string]> = { loan: { groups: [[{ column: 'desk', op: '=', value: 1 }]] }, note: true };
  const options: Options = {
    app,
    resources,
    commands,
    sourceConnections: new Map([['operations', owner]]),
    verifySession: async (req) => identities.get(req.cookie ?? '') ?? null,
    resolveRows: () => rows,
  };
  const issue = (extra: Partial<Options> = {}) => createAppPolicyContext({ ...options, ...extra });
  const loan = () => ({ ...db.prepare('SELECT * FROM physical_loan WHERE id = 1').get()! });
  const receipts = () => db.prepare(`SELECT * FROM ${COMMAND_JOURNAL_TABLES.receipt}`).all();
  return { options, issue, commands, control, identities, rows, resources, anchor, db, loan, receipts, input, output, define };
}

test('omitting commands preserves issuer and context own keys', async (t) => {
  const f = await fixture(t);
  const issuer = f.issue({ commands: undefined });
  assert.deepEqual(Reflect.ownKeys(issuer).sort(), ['retire', 'withAccount', 'withContext', 'withPublicContext', 'withService']);
  await issuer.withContext(signedIn, async (context) => {
    assert.deepEqual(Reflect.ownKeys(context).sort(), [
      'data',
      'principal',
      'readsAt',
      'schema',
      'sources',
      'transaction',
      'trial',
      'writeFields',
    ]);
    assert.equal(Object.hasOwn(context, 'commands'), false);
  });
});

test('commands expose frozen availability/prepare/execute/status bound to verified principal and preserve generic grants', async (t) => {
  const f = await fixture(t);
  const issuer = f.issue();
  assert.deepEqual(Reflect.ownKeys(issuer).sort(), ['retire', 'withAccount', 'withContext', 'withPublicContext', 'withService']);
  const applied = await issuer.withContext(
    { ...signedIn, body: { actor: { id: 'forged', appId: 'other', roles: ['admin'] } } },
    async (context) => {
      assert.deepEqual(Reflect.ownKeys(context).sort(), [
        'commands',
        'data',
        'principal',
        'readsAt',
        'schema',
        'sources',
        'transaction',
        'trial',
        'writeFields',
      ]);
      assert.deepEqual(Reflect.ownKeys(context.commands!).sort(), ['availability', 'execute', 'prepare', 'status']);
      assert.ok(Object.isFrozen(context.commands));
      const { execute, status } = context.commands!;
      assert.deepEqual(await status(request()), { status: 'not_found', outcome: 'unknown' });
      assert.equal(f.control.calls, 0);
      const result = await execute(request(), { requestId: 'trusted-request' });
      assert.deepEqual(await status(request()), { ...result, replayed: true });
      return result;
    },
  );
  assert.equal(applied.status, 'applied');
  assert.deepEqual(applied.result, { id: 1, version: 1 });
  assert.deepEqual(f.control.actors, [
    { id: 'verified-manager', appId: 'command-policy', roles: ['manager'], email: 'manager@example.test' },
  ]);
  assert.equal(f.receipts()[0].actor_id, 'verified-manager');
  assert.equal(f.receipts()[0].request_id, 'trusted-request');
  assert.equal(f.control.calls, 1);
  await assert.rejects(
    issuer.withContext(signedIn, async (context) => {
      await assert.rejects(context.data.update!({ table: 'loan', key: { id: 1 }, values: { assignee: 'Bypass' } }), Refusal);
    }),
    Refusal,
  );
  assert.equal(f.loan().assignee, 'Ada');
});

test('session verification precedes command exposure and ignores body identity', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.issue().withContext({ body: { id: 'verified-manager', role: 'manager' } }, async () => {
      assert.fail('Unverified callback');
    }),
    Refusal,
  );
  assert.equal(f.control.calls, 0);
});

for (const mode of ['execute', 'status'] as const) {
  test(`${mode} uses fresh verified grants and exact actor receipt ownership`, async (t) => {
    const f = await fixture(t);
    const issuer = f.issue();
    await issuer.withContext(signedIn, (context) => context.commands!.execute(request()));
    assert.deepEqual(await issuer.withContext({ cookie: 'other-session' }, (context) => context.commands!.status(request())), {
      status: 'not_found',
      outcome: 'unknown',
    });
    f.identities.set('manager-session', { id: 'verified-manager', who: 'manager@example.test', role: 'viewer' });
    await assert.rejects(
      issuer.withContext(signedIn, (context) => context.commands![mode](request())),
      commandError('forbidden', 'unknown'),
    );
    assert.equal(f.control.calls, 1);
  });

  test(`${mode} refuses actor injection in the exact request envelope`, async (t) => {
    const f = await fixture(t);
    await assert.rejects(
      f.issue().withContext(signedIn, (context) => context.commands![mode](request({ actor: { id: 'forged' } }))),
      commandError('invalid_input', 'unknown'),
    );
    assert.equal(f.control.calls, 0);
  });

  test(`${mode} retained methods expire on callback completion and issuer retirement`, async (t) => {
    const f = await fixture(t);
    const issuer = f.issue();
    let retained!: NonNullable<AppPolicyContext['commands']>;
    await issuer.withContext(signedIn, async (context) => {
      retained = context.commands!;
    });
    await assert.rejects(retained[mode](request()), Refusal);
    await assert.rejects(
      issuer.withContext(signedIn, async (context) => {
        issuer.retire();
        await assert.rejects(context.commands![mode](request()), Refusal);
      }),
      Refusal,
    );
    assert.equal(f.control.calls, 0);
  });

  test(`${mode} caught and unawaited failures still reject their invocation`, async (t) => {
    const f = await fixture(t);
    for (const caught of [false, true]) {
      await assert.rejects(
        f.issue().withContext(signedIn, async (context) => {
          const operation = context.commands![mode]({});
          if (caught) await operation.catch(() => {});
          return 'must not succeed';
        }),
        commandError('invalid_input', 'unknown'),
      );
    }
  });
}

test('issuer captures command registry, validators, result extractors, writability callback and source methods', async (t) => {
  const f = await fixture(t);
  const issuer = f.issue();
  const replaced = () => {
    throw new Error('Replaced deployment function');
  };
  f.commands.registry.assign = f.define(replaced);
  f.commands.resultReferences.assign = replaced;
  f.commands.writableConnection = replaced;
  f.input.validate = replaced;
  f.output.parse = replaced;
  f.anchor.scopeCommandTransaction = replaced;
  f.resources.forConnection = replaced;
  f.options.verifySession = replaced;
  f.options.resolveRows = replaced;
  f.options.commands = { ...f.commands, registry: {} };
  const applied = await issuer.withContext(signedIn, (context) => context.commands!.execute(request()));
  assert.equal(applied.status, 'applied');
  assert.equal(f.control.calls, 1);
  assert.equal(f.loan().assignee, 'Ada');
});

test('command invocation captures row scope before caller mutation and rechecks rows for later receipts', async (t) => {
  const f = await fixture(t);
  const issuer = f.issue();
  const first = await issuer.withContext(signedIn, async (context) => {
    f.rows.loan = false;
    return context.commands!.execute(request());
  });
  assert.equal(first.status, 'applied');
  for (const mode of ['execute', 'status'] as const) {
    await assert.rejects(
      issuer.withContext(signedIn, (context) => context.commands![mode](request())),
      commandError('forbidden', 'unknown'),
    );
  }
  assert.equal(f.control.calls, 1);
});

test('command cancellation uses caller signal and cannot override executor mode or server clock', async (t) => {
  const f = await fixture(t);
  const issuer = f.issue();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    issuer.withContext(signedIn, (context) => context.commands!.execute(request(), { signal: controller.signal })),
    commandError('cancelled', 'unknown'),
  );
  const extra = {
    requestId: 'safe-options',
    statusOnly: true,
    actor: { id: 'forged' },
    now: () => {
      throw new Error('Caller clock must not execute');
    },
  };
  const result = await issuer.withContext(signedIn, (context) => context.commands!.execute(request(), extra));
  assert.equal(result.status, 'applied');
  assert.equal(f.control.calls, 1);
});

for (const mode of ['execute', 'status'] as const) {
  for (const retire of [false, true]) {
    test(`${mode} drains accepted completion after callback settlement${retire ? ' and retirement' : ''}`, async (t) => {
      const f = await fixture(t);
      const committed = gate();
      const held = gate();
      const original = commandsOf(f.anchor).scopeCommandTransaction!.bind(f.anchor);
      f.anchor.scopeCommandTransaction = async (scope, run) => {
        const result = await original(scope, run);
        committed.release();
        await held.promise;
        return result;
      };
      const issuer = f.issue();
      let operation!: ReturnType<NonNullable<AppPolicyContext['commands']>[typeof mode]>;
      let settled = false;
      const pending = issuer.withContext(signedIn, async (context) => {
        operation = context.commands![mode](request());
        await Promise.race([committed.promise, operation]);
        return 'finished';
      });
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      try {
        await Promise.race([committed.promise, pending]);
        await turn();
        assert.equal(settled, false);
        if (retire) issuer.retire();
      } finally {
        held.release();
      }
      await operation;
      assert.equal(await pending, 'finished');
      assert.equal(f.control.calls, mode === 'execute' ? 1 : 0);
    });
  }
}

test('callback settlement refuses an accepted command still before commit and drains its rollback', async (t) => {
  const f = await fixture(t);
  const entered = gate();
  const held = gate();
  f.control.handle = async () => {
    entered.release();
    await held.promise;
  };
  const issuer = f.issue();
  let operation!: Promise<BusinessCommandResult>;
  const pending = issuer.withContext(signedIn, async (context) => {
    operation = context.commands!.execute(request());
    await entered.promise;
  });
  const rejected = assert.rejects(pending, commandError('forbidden'));
  try {
    await entered.promise;
    await turn();
  } finally {
    held.release();
  }
  await assert.rejects(operation, commandError('forbidden'));
  await rejected;
  assert.equal(f.loan().assignee, 'Unassigned');
  assert.equal(f.receipts().length, 0);
});

for (const stage of ['handler', 'result extractor'] as const) {
  test(`retirement from fresh command ${stage} after proven receipt absence confirms rollback`, async (t) => {
    const f = await fixture(t);
    let issuer!: ReturnType<typeof f.issue>;
    if (stage === 'handler')
      f.control.handle = async () => {
        issuer.retire();
      };
    else {
      const extract = f.commands.resultReferences.assign;
      f.commands.resultReferences.assign = (result) => {
        issuer.retire();
        return extract(result);
      };
    }
    issuer = f.issue();
    await assert.rejects(
      issuer.withContext(signedIn, (context) => context.commands!.execute(request())),
      commandError('forbidden'),
    );
    assert.equal(f.control.calls, 1);
    assert.equal(f.loan().assignee, 'Unassigned');
    assert.equal(f.receipts().length, 0);
  });
}

for (const mode of ['execute', 'status'] as const) {
  test(`${mode} retirement from saved result extractor preserves unknown over caught callback denial`, async (t) => {
    const f = await fixture(t);
    let issuer!: ReturnType<typeof f.issue>;
    let retire = false;
    const extract = f.commands.resultReferences.assign;
    f.commands.resultReferences.assign = (result) => {
      if (retire) issuer.retire();
      return extract(result);
    };
    issuer = f.issue();
    await issuer.withContext(signedIn, (context) => context.commands!.execute(request()));
    retire = true;
    await assert.rejects(
      issuer.withContext(signedIn, async (context) => {
        await assert.rejects(context.commands![mode](request()), commandError('forbidden', 'unknown'));
        throw new AppAccessDenied();
      }),
      commandError('forbidden', 'unknown'),
    );
    assert.equal(f.control.calls, 1);
    assert.equal(f.loan().assignee, 'Ada');
    assert.equal(f.receipts().length, 1);
  });
}

for (const after of ['caught', 'callback refusal', 'retirement refusal', 'earlier refusal'] as const) {
  test(`command unknown outcome takes precedence over ${after}`, async (t) => {
    const f = await fixture(t);
    const original = commandsOf(f.anchor).scopeCommandTransaction!.bind(f.anchor);
    f.anchor.scopeCommandTransaction = async (scope, run) => {
      await original(scope, run);
      throw new CommandTransactionFailure(new Error('Commit acknowledgement lost'), 'unknown');
    };
    const issuer = f.issue();
    await assert.rejects(
      issuer.withContext(signedIn, async (context) => {
        if (after === 'earlier refusal') await context.transaction('absent', async () => {}).catch(() => {});
        await assert.rejects(context.commands!.execute(request()), commandError('temporarily_unavailable', 'unknown'));
        if (after === 'retirement refusal') {
          issuer.retire();
          await context.commands!.status(request()).catch(() => {});
        }
        if (after !== 'caught') throw new Refusal('Callback failure');
      }),
      commandError('temporarily_unavailable', 'unknown'),
    );
    assert.equal(f.loan().assignee, 'Ada');
    assert.equal(f.receipts().length, 1);
  });
}

for (const failure of [
  new TransactionOutcomeUnknown(new Error('Unknown generic write')),
  new CommandTransactionFailure(new Error('Unknown journal write'), 'unknown'),
  new BusinessCommandExecutionError('temporarily_unavailable', 'unknown'),
]) {
  test(`tracker preserves ${failure.name} across callback and lifecycle failures`, async (t) => {
    const f = await fixture(t);
    f.anchor.scopeTransaction = async () => {
      throw failure;
    };
    const issuer = f.issue();
    await assert.rejects(
      issuer.withContext(signedIn, async (context) => {
        await assert.rejects(
          context.transaction('operations', async () => {}),
          (error) => error === failure,
        );
        issuer.retire();
        await context.commands!.execute(request()).catch(() => {});
        throw new Refusal('Must not hide uncertainty');
      }),
      (error) => error === failure,
    );
  });
}
