import { parseTestApp } from './support/commandCatalog.js';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { refuse } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { bindHttpBusinessCommands } from '../packages/mistri/src/server/commands/businessCommandLoader.js';

/* Loans whose reviewer changes only through the `assign` command. A file of
   loan codes and reviewer names runs `assign` once per row, on the loan its
   code finds, prepared and executed exactly as the action's own would be. */
const sessions: Record<string, Identity> = {
  manager: { id: 'account-manager', who: 'manager@example.test', role: 'manager' },
  viewer: { id: 'account-viewer', who: 'viewer@example.test', role: 'viewer' },
};
const assignInput = { reviewer: { label: 'Reviewer', type: 'reference', from: 'reviewer', by: 'id', labelColumn: 'name' } } as const;
const assignRef = { id: 'assign', version: 1, target: 'loan', input: assignInput };

function definition(
  resource: object = {
    access: 'write',
    import: { command: assignRef, match: ['code'] },
    actions: { assign: { label: 'Assign', command: assignRef } },
  },
) {
  return parseTestApp(
    {
      id: 'loans',
      name: 'Loans',
      sources: { lending: { connection: 'loan-db' } },
      resources: { loan: resource, reviewer: { recordLabel: 'name' } },
      auth: { roles: { manager: { read: true, commands: ['assign'] }, viewer: { read: true } } },
      views: { loans: { kind: 'list', from: 'loan', query: 'open = 1' } },
      home: 'loans',
      nav: ['loans'],
    },
    'command import fixture',
  );
}

async function fixture(
  run: (f: {
    post: (body: object, who?: string) => Promise<{ status: number; body: any }>;
    db: DatabaseSync;
    calls: string[];
    registry: Registry;
    host: AppHost;
    commands: ReturnType<typeof defineCommands>;
  }) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-import-commands-'));
  const file = join(directory, 'loans.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE loan(id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, open INTEGER NOT NULL DEFAULT 1,
      version INTEGER NOT NULL DEFAULT 0, reviewer INTEGER REFERENCES reviewer(id));
    CREATE TABLE reviewer(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO reviewer VALUES (1, 'Ada'), (2, 'Grace'), (3, 'Grace');
    INSERT INTO loan(code, open) VALUES ('L-1', 1), ('L-2', 1), ('L-3', 1), ('L-9', 0);`);
  migrateSqliteCommandJournal(file);
  const registry = new Registry();
  registry.add({ id: 'loan-db', name: 'Loans', url: file, writable: true, source: 'config' });
  const app = definition();
  const calls: string[] = [];
  const commands = defineCommands({
    assign: defineCommand({
      target: 'loan',
      input: assignInput,
      source: 'lending',
      read: ['reviewer'],
      output: { parse: (value: unknown) => value as { version: number } },
      async handle({ db: tx, record }, input) {
        calls.push(`${record.code}:${input.reviewer}`);
        if (record.code === 'L-3') refuse('L-3 is with the underwriters; it cannot change hands today.');
        const { version } = await tx.loan.update(record, { reviewer: Number(input.reviewer) });
        return { version: Number(version) };
      },
    }),
  });
  const host: AppHost = {
    app: { app, path: '/private/loans/app.ts', pages: [], sources: {} },
    pages: [],
    auth: {
      spec: app.auth!,
      store: '/private/loans/auth.db',
      close() {},
      handler: async () => {},
      session: async (req: { headers: { cookie?: string } }) => sessions[req.headers.cookie?.replace(/^session=/, '') ?? ''] ?? null,
    },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], commands: { appId: 'loans', registry: commands } });
  server.listen(0, bound.host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://${bound.host}:${address.port}`;
  try {
    await run({
      db,
      calls,
      registry,
      host,
      commands,
      post: async (body, who = 'manager') => {
        const response = await fetch(`${base}/api/import?app=loans`, {
          method: 'POST',
          signal: AbortSignal.timeout(10_000),
          headers: { 'content-type': 'application/json', cookie: `session=${who}` },
          body: JSON.stringify(body),
        });
        return { status: response.status, body: await response.json() };
      },
    });
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

const reviewers = (db: DatabaseSync) =>
  db
    .prepare('SELECT code, reviewer, version FROM loan ORDER BY code')
    .all()
    .map((row) => ({ ...row }));
const sheet = (lines: string[], extra: object = {}) => ({
  table: 'loan',
  view: 'loans',
  csv: ['Loan,Reviewer', ...lines].join('\n'),
  mapping: ['code', 'reviewer'],
  mode: 'check',
  ...extra,
});

test("a command import checks each row against its record and the command's input without running it", async () => {
  await fixture(async ({ post, db, calls }) => {
    const checked = await post(sheet(['L-1,Ada', 'L-2,Grace', 'L-9,Ada', 'L-404,Ada', 'L-1,Ada', ',Ada']));
    assert.equal(checked.status, 200, JSON.stringify(checked.body));
    assert.equal(checked.body.outcome, 'checked');
    assert.equal(checked.body.ready, 1);
    const said = Object.fromEntries(
      checked.body.refused.map((r: any) => [r.row, r.problems.map((p: any) => `${p.field ?? ''}: ${p.message}`).join(' | ')]),
    );
    assert.match(said[2], /^Reviewer: "Grace" could name 2 records of reviewer/);
    // The list's own question narrows where a row lands: a closed loan is not on it.
    assert.match(said[3], /^: No record in this list has Code L-9\.$/);
    assert.match(said[4], /^: No record in this list has Code L-404\.$/);
    assert.match(said[5], /finds the same record as row 1/);
    assert.match(said[6], /^Code: A value is required\.$/);
    assert.equal(Object.hasOwn(checked.body, 'undo'), false);
    assert.deepEqual(calls, [], 'a check never runs the command');
    assert.equal(
      reviewers(db).every((row) => row.reviewer === null),
      true,
    );
  });
});

test("a committed command import runs the command per row, and a refusal is that row's alone", async () => {
  await fixture(async ({ post, db, calls }) => {
    const run = await post(sheet(['L-1,Ada', 'L-2,2', 'L-3,Ada'], { mode: 'commit' }));
    assert.equal(run.status, 200, JSON.stringify(run.body));
    assert.equal(run.body.outcome, 'partial');
    assert.equal(run.body.applied, 2);
    assert.deepEqual(
      run.body.refused.map((r: any) => [r.row, r.problems[0].message]),
      [[3, 'L-3 is with the underwriters; it cannot change hands today.']],
    );
    assert.deepEqual(calls, ['L-1:1', 'L-2:2', 'L-3:1']);
    assert.deepEqual(reviewers(db).slice(0, 3), [
      { code: 'L-1', reviewer: 1, version: 1 },
      { code: 'L-2', reviewer: 2, version: 1 },
      { code: 'L-3', reviewer: null, version: 0 },
    ]);
  });
});

test('a reader not granted the command is not offered its import, and the server refuses it', async () => {
  await fixture(async ({ post, calls }) => {
    const refused = await post(sheet(['L-1,Ada'], { mode: 'commit' }), 'viewer');
    assert.equal(refused.status, 404);
    assert.deepEqual(calls, []);
  });
});

test('a plain import of rows a command writes is refused when the commands bind', async () => {
  await fixture(async ({ registry, commands }) => {
    const plain = definition({ access: 'write', import: true, actions: { assign: { label: 'Assign', command: assignRef } } });
    const writes = defineCommands({
      assign: defineCommand({
        target: 'loan',
        input: assignInput,
        source: 'lending',
        read: ['reviewer'],
        write: ['loan'],
        output: { parse: (value: unknown) => value as { version: number } },
        handle: () => ({ version: 1 }),
      }),
    });
    const resources = await loadAppRuntimeResources(registry, plain, 'loan-db');
    assert.throws(
      () => bindHttpBusinessCommands(plain, writes, resources, () => true),
      /resources "loan" imports rows into "loan", which command "assign" writes\. .*import: \{ command, match/,
    );
    assert.ok(commands.assign);
  });
});
