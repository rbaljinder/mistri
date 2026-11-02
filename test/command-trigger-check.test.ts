/**
 * `[command-trigger]` (commandTriggerChecks.ts): `mistri check` names each command of a row-policy App whose writes
 * fire a trigger the policy cannot bound — the refusal a field report met only when a person pressed the button.
 * The findings from triggers as each engine reads them, then the check itself over a real App on SQLite, and on
 * PostgreSQL when TABLEWALK_TEST_PG is set.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { migratePostgresCommandJournal } from '../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import { readSqliteTrigger } from '../packages/engine/src/adapters/scoped/sqliteTriggers.js';
import type { BusinessCommandRegistry } from '../packages/mistri/src/server/commands/businessCommands.js';
import { commandTriggerFindings, triggersAt } from '../packages/mistri/src/server/commands/commandTriggerChecks.js';
import type { AppDef } from '../packages/mistri/src/shared/app.js';
import type { Adapter } from '../packages/engine/src/adapters/adapter.js';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import type { RuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { scratch } from './support/scratch.js';
import { LIVE_PG, sourceUrl } from './support/policyServer.js';
import { pgClient, uuidPostgresDatabase } from './support/tenantDialects.js';
import { VALIDATE, validating } from './support/validation.js';

const trigger = (sql: string) => readSqliteTrigger(/TRIGGER (\w+)/.exec(sql)![1], sql, new Set());
const TRIGGERS = new Map([
  [
    'account',
    [
      trigger(
        "CREATE TRIGGER example_validation_only BEFORE UPDATE OF posted_minor ON account WHEN NEW.posted_minor < 0 BEGIN SELECT RAISE(ABORT, 'Negative customer balance'); END",
      ),
    ],
  ],
  [
    'account_note',
    [trigger('CREATE TRIGGER count_notes AFTER INSERT ON account_note BEGIN INSERT INTO note_count VALUES (NEW.account_id, 1); END')],
  ],
  [
    'ledger',
    ['INSERT', 'UPDATE', 'DELETE'].map((event) =>
      trigger(`CREATE TRIGGER post_${event} AFTER ${event} ON ledger BEGIN DELETE FROM note_count; END`),
    ),
  ],
]);
/** A logical name, `main.ledger`, to the table's triggers. */
const at = (logical: string) => TRIGGERS.get(logical.slice(logical.indexOf('.') + 1));
const commands = {
  restrict: { source: 'main', target: 'account', write: ['account'] },
  note: { source: 'main', target: 'account', write: ['account_note'] },
  post: { source: 'main', target: 'account', write: ['ledger'] },
} as unknown as BusinessCommandRegistry;

test('a command whose writes fire a writing trigger is named, a validation-only trigger is not, and only under a row scope', () => {
  const policy = { auth: { rows: 'policy' } } as unknown as AppDef;
  const { problems, warnings } = commandTriggerFindings(policy, commands, at);
  // Every write to the ledger fires one: the command cannot run, whatever its handler writes there.
  assert.equal(problems.length, 1);
  assert.match(
    problems[0],
    /^command "post" writes "ledger", which has the triggers "post_INSERT" \(it writes rows\), .* \[command-trigger\]: under the row policy, every insert, update and delete of "ledger" fires one and is refused with 403\. Move what the trigger does into the command/,
  );
  // Only inserts fire it: the command runs unless it inserts.
  assert.deepEqual(warnings, [
    'command "note" writes "account_note", which has the trigger "count_notes" (it writes rows) [command-trigger]: under the row policy, ' +
      'a write that fires it (inserts) is refused with 403; other writes run. Move what the trigger does into the command, whose writes the policy bounds, ' +
      "or keep the trigger to checks of NEW and OLD that raise (SQLite RAISE(ABORT, '…'); PostgreSQL IF … THEN RAISE EXCEPTION '…'), reading no other table.",
  ]);
  assert.ok(![...problems, ...warnings].some((line) => line.includes('restrict')), 'the validation-only trigger blocks nothing');
  // Without a row scope, nothing is refused and nothing is said.
  for (const rows of ['all', undefined])
    assert.deepEqual(commandTriggerFindings({ auth: { rows } } as unknown as AppDef, commands, at), { problems: [], warnings: [] });
  const tenant = { auth: { rows: 'tenant' } } as unknown as AppDef;
  assert.equal(commandTriggerFindings(tenant, commands, at).problems.length, 1);
});

test('a CHECK, a default or a domain calling a function of the database’s is named by what it is, run rather than fired', () => {
  const policy = { auth: { rows: 'policy' } } as unknown as AppDef;
  const code = new Map([
    [
      'ledger',
      [{ name: 'seen', kind: 'CHECK constraint', events: ['insert', 'update'], validates: false, why: 'it calls public.peek(text)' }],
    ],
    [
      'account_note',
      [
        {
          name: 'code',
          kind: 'domain',
          events: ['insert', 'update'],
          columns: ['code'],
          validates: false,
          why: 'it calls public.peek(text)',
        },
      ],
    ],
  ] as const);
  const { problems, warnings } = commandTriggerFindings(policy, commands, (logical) =>
    code.get(logical.slice(logical.indexOf('.') + 1) as 'ledger'),
  );
  // A delete runs neither: each blocks some writes.
  assert.deepEqual(problems, []);
  assert.deepEqual(warnings, [
    'command "note" writes "account_note", which has the domain "code" (it calls public.peek(text)) [command-trigger]: under the row policy, ' +
      'a write that runs it (inserts, updates of code) is refused with 403; other writes run. ' +
      "Write the CHECK, default or domain with PostgreSQL's own functions, or move what the function does into the command, whose writes the policy bounds.",
    'command "post" writes "ledger", which has the CHECK constraint "seen" (it calls public.peek(text)) [command-trigger]: under the row policy, ' +
      'a write that runs it (inserts, every update) is refused with 403; other writes run. ' +
      "Write the CHECK, default or domain with PostgreSQL's own functions, or move what the function does into the command, whose writes the policy bounds.",
  ]);
});

test('a command that writes a table an accepted trigger it fires also writes is named [trigger-double-write]', () => {
  const post = trigger(
    'CREATE TRIGGER post_balance AFTER INSERT ON ledger_entry BEGIN UPDATE account SET posted_minor = posted_minor + NEW.amount WHERE id = NEW.account_id; END',
  );
  const audit = trigger(
    "CREATE TRIGGER entry_audit AFTER INSERT ON ledger_entry BEGIN INSERT INTO entry_history (entry_id, what) VALUES (NEW.id, 'posted'); END",
  );
  const of = (logical: string) => (logical.endsWith('ledger_entry') ? [post, audit] : []);
  const app = {
    sources: { main: { connection: 'ops', default: true } },
    auth: { rows: 'policy' },
    resources: { ledger_entry: { access: 'write', triggers: ['post_balance', 'entry_audit'] } },
  } as unknown as AppDef;
  const posting = {
    post: { source: 'main', target: 'account', write: ['ledger_entry', 'account', 'entry_history'] },
    only: { source: 'main', target: 'account', write: ['ledger_entry'] },
  } as unknown as BusinessCommandRegistry;
  const { problems, warnings } = commandTriggerFindings(app, posting, of);
  assert.deepEqual(problems, [], 'named and accepted, neither trigger blocks the command');
  assert.equal(warnings.length, 2);
  assert.match(
    warnings[0],
    /^command "post" writes "account", which the trigger "post_balance" on "ledger_entry", a table it writes too, also writes \(posted_minor\) \[trigger-double-write\]: a change both make is applied twice\. Leave account\.posted_minor to the trigger/,
  );
  assert.match(warnings[1], /writes "entry_history", which the trigger "entry_audit" .* also inserts into \[trigger-double-write\]/);
  assert.ok(!warnings.some((line) => line.includes('"only"')), 'a command that leaves the account to the trigger is clean');
});

const SQLITE = `CREATE TABLE account(id INTEGER PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
    posted_minor INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE account_note(id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES account(id), body TEXT NOT NULL);
  CREATE TABLE note_count(account_id INTEGER PRIMARY KEY, n INTEGER NOT NULL);
  CREATE TRIGGER example_validation_only BEFORE UPDATE OF posted_minor ON account WHEN NEW.posted_minor < 0
  BEGIN SELECT RAISE(ABORT, 'Negative customer balance'); END;
  CREATE TRIGGER count_notes AFTER INSERT ON account_note BEGIN INSERT INTO note_count VALUES (NEW.account_id, 1); END;`;
const POSTGRES = `CREATE TABLE account(id integer PRIMARY KEY, name text NOT NULL, status text NOT NULL DEFAULT 'open',
    posted_minor integer NOT NULL DEFAULT 0);
  CREATE TABLE account_note(id integer PRIMARY KEY, account_id integer NOT NULL REFERENCES account(id), body text NOT NULL);
  CREATE TABLE note_count(account_id integer PRIMARY KEY, n integer NOT NULL);
  CREATE FUNCTION example_validation_only() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN IF NEW.posted_minor < 0 THEN RAISE EXCEPTION 'Negative customer balance'; END IF; RETURN NEW; END $$;
  CREATE TRIGGER example_validation_only BEFORE UPDATE OF posted_minor ON account
    FOR EACH ROW WHEN (NEW.posted_minor < 0) EXECUTE FUNCTION example_validation_only();
  CREATE FUNCTION count_notes() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN INSERT INTO note_count VALUES (NEW.account_id, 1); RETURN NEW; END $$;
  CREATE TRIGGER count_notes AFTER INSERT ON account_note FOR EACH ROW EXECUTE FUNCTION count_notes();`;

const APP = {
  id: 'ledger',
  name: 'Ledger',
  sources: { main: { connection: 'ops' } },
  auth: {
    signUp: 'invite',
    defaultRole: 'compliance',
    rows: 'policy',
    roles: { compliance: { read: true, commands: ['restrict', 'note'] } },
  },
  resources: {
    account: {
      access: 'write',
      actions: { restrict: { label: 'Restrict', command: 'restrict' }, note: { label: 'Note', command: 'note' } },
    },
    account_note: { access: 'write' },
  },
  views: { accounts: { kind: 'list', from: 'account' } },
  home: 'accounts',
  nav: ['accounts'],
};
const POLICY = `export default { appId: 'ledger', resultReferences: { restrict: () => [], note: () => [] },
  resolveRows() { return { account: true, account_note: true }; } };`;
const COMMANDS = `import { defineCommand, defineCommands } from ${sourceUrl('packages/mistri/src/server/commands/businessCommands.ts')};
export default defineCommands({
  restrict: defineCommand({ source: 'main', target: 'account', read: ['account'], write: ['account'],
    async handle({ db, record }) { await db.account.update(record, { status: 'restricted' }); return {}; } }),
  note: defineCommand({ source: 'main', target: 'account', read: ['account'], write: ['account_note'],
    async handle({ db, record }) { await db.account_note.insert({ id: 1, account_id: record.id, body: 'Called' }); return {}; } }),
});`;

async function check(t: TestContext, postgres: boolean): Promise<{ code: number; output: string }> {
  const { directory, stopping } = scratch(t, 'tablewalk-command-trigger-');
  let url: string;
  if (postgres) {
    const owned = await uuidPostgresDatabase('tw_command_trigger');
    stopping(() => owned.drop());
    const client = await pgClient(owned.url);
    try {
      await client.query(POSTGRES);
    } finally {
      await client.end();
    }
    url = owned.url;
    await migratePostgresCommandJournal(url);
  } else {
    url = join(directory, 'data.db');
    const db = new DatabaseSync(url);
    db.exec(SQLITE);
    db.close();
    migrateSqliteCommandJournal(url);
  }
  const app = join(directory, 'app');
  mkdirSync(app);
  writeFileSync(join(app, 'app.json'), JSON.stringify(APP));
  writeFileSync(join(directory, 'policy.mjs'), POLICY);
  writeFileSync(join(directory, 'commands.mjs'), COMMANDS);
  const config = join(directory, 'mistri.json');
  writeFileSync(config, JSON.stringify({ connections: [{ name: 'ops', url, writable: true }] }));
  const args = [
    '--config',
    config,
    '--app',
    app,
    '--policy',
    join(directory, 'policy.mjs'),
    '--commands',
    join(directory, 'commands.mjs'),
    VALIDATE,
  ];
  const run = validating(args, {
    ...process.env,
    DATABASE_URL: '',
    BETTER_AUTH_SECRET: 'command-trigger-fixture-secret-at-least-32-characters',
    XDG_CONFIG_HOME: join(directory, 'xdg'),
  });
  return new Promise((done, reject) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', resolve('packages/mistri/src/server/index.ts'), ...run.args],
      { timeout: 60_000, env: run.env },
      (error, stdout, stderr) => {
        if (error?.killed) return reject(new Error('The check did not finish.'));
        done({ code: Number(error?.code ?? 0), output: stdout + stderr });
      },
    );
  });
}

async function checks(t: TestContext, postgres: boolean) {
  const { code, output } = await check(t, postgres);
  // A warning: the command runs unless it inserts a note, which it does — a warning never fails the step.
  assert.equal(code, 0, output);
  assert.match(output, /Ledger: ok/, output);
  assert.match(
    output,
    /warning: command "note" writes "account_note", which has the trigger "count_notes" \(it writes rows\) \[command-trigger\]: under the row policy, a write that fires it \(inserts\) is refused with 403/,
  );
  assert.doesNotMatch(output, /example_validation_only/, 'the validation-only trigger is not named');
}

test(
  'mistri check names a command a writing trigger blocks on SQLite, and not one a validation-only trigger guards',
  { timeout: 90_000 },
  (t) => checks(t, false),
);

test(
  'mistri check names a command a writing trigger blocks on PostgreSQL, and not one a validation-only trigger guards',
  { timeout: 90_000, skip: LIVE_PG ? false : 'TABLEWALK_TEST_PG is not set' },
  (t) => checks(t, true),
);

/* ---------- check reads what the write reads ---------- */

/** One connection whose tables are their own logical names: what triggersAt judges `logical`'s triggers to be. */
const judgedBy = async (adapter: Adapter, logical: string) => {
  const resources = { connectionFor: () => 'ops', toLogicalAt: (id: string) => id } as unknown as RuntimeResources;
  return new Map(((await triggersAt(resources, [logical], async () => adapter))(logical) ?? []).map((trigger) => [trigger.name, trigger]));
};

test("check refuses an effect into a table whose schema declares a conflict clause, as the write's catalog does", async (t) => {
  const { directory } = scratch(t, 'tablewalk-check-conflict-');
  const file = join(directory, 'data.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE note (id INTEGER PRIMARY KEY, hist_id INTEGER);
    CREATE TABLE hist (id INTEGER PRIMARY KEY ON CONFLICT REPLACE, what TEXT);
    CREATE TRIGGER audit_delete AFTER DELETE ON note BEGIN INSERT INTO hist (id, what) VALUES (OLD.hist_id, 'deleted'); END;`);
  db.close();
  const adapter = new SqliteAdapter(file);
  t.after(() => adapter.close());
  assert.match(
    (await judgedBy(adapter, 'note')).get('audit_delete')?.unaccepted ?? '',
    /inserts into "hist", whose schema declares ON CONFLICT REPLACE/,
  );
});

test(
  "check refuses an effect onto a table in an inheritance hierarchy, or with row-level security, as the write's catalog does",
  { timeout: 60_000, skip: LIVE_PG ? false : 'TABLEWALK_TEST_PG is not set' },
  async (t) => {
    const owned = await uuidPostgresDatabase('tw_check_facts');
    let adapter: PostgresAdapter | undefined;
    t.after(async () => {
      await adapter?.close();
      await owned.drop();
    });
    const client = await pgClient(owned.url);
    try {
      await client.query(`CREATE TABLE account (id integer PRIMARY KEY, note text);
        CREATE TABLE account_child (PRIMARY KEY (id)) INHERITS (account);
        CREATE TABLE guarded (id integer PRIMARY KEY, note text);
        ALTER TABLE guarded ENABLE ROW LEVEL SECURITY;
        CREATE TABLE plain (id integer PRIMARY KEY, note text);
        CREATE TABLE entry (id integer PRIMARY KEY, account_id integer NOT NULL);
        CREATE FUNCTION touch() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN UPDATE public.account SET note = 'x' WHERE id = NEW.account_id; RETURN NULL; END $$;
        CREATE TRIGGER touch AFTER INSERT ON entry FOR EACH ROW EXECUTE FUNCTION touch();
        CREATE FUNCTION guard() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN UPDATE public.guarded SET note = 'x' WHERE id = NEW.account_id; RETURN NULL; END $$;
        CREATE TRIGGER guard AFTER INSERT ON entry FOR EACH ROW EXECUTE FUNCTION guard();
        CREATE FUNCTION mark() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN UPDATE public.plain SET note = 'x' WHERE id = NEW.account_id; RETURN NULL; END $$;
        CREATE TRIGGER mark AFTER INSERT ON entry FOR EACH ROW EXECUTE FUNCTION mark();
        CREATE FUNCTION heir() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN UPDATE public.account_child SET note = 'x' WHERE id = NEW.account_id; RETURN NULL; END $$;
        CREATE TRIGGER heir AFTER INSERT ON entry FOR EACH ROW EXECUTE FUNCTION heir();`);
    } finally {
      await client.end();
    }
    adapter = new PostgresAdapter(owned.url, 'check facts', ['public']);
    const judged = await judgedBy(adapter, 'public.entry');
    // The parent and the child alike: a child keeps keys and triggers of its own.
    for (const [trigger, table] of [
      ['touch', 'account'],
      ['heir', 'account_child'],
    ])
      assert.match(
        judged.get(trigger)?.unaccepted ?? '',
        new RegExp(`it writes "public\\.${table}", part of a partition or inheritance hierarchy`),
      );
    assert.match(judged.get('guard')?.unaccepted ?? '', /it writes "public\.guarded", which has row-level security/);
    // The same trigger onto a table nothing blocks: accepted, so the two above are the facts', not the grammar's.
    assert.equal(judged.get('mark')?.unaccepted, undefined);
    assert.ok(judged.get('mark')?.effects?.length);
  },
);
