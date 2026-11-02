/**
 * A field report: a row-policy App whose `account` table had a validation-only trigger —
 * `BEFORE UPDATE OF posted_minor … WHEN NEW.posted_minor < 0 … RAISE(ABORT, …)` — could not run a command that
 * updates only `status`: "it has the trigger "example_validation_only", whose writes the policy cannot bound".
 * The whole runtime, as the report met it: the command runs, the trigger still refuses a negative balance, and a
 * trigger that writes still refuses the write that fires it. SQLite always; PostgreSQL when TABLEWALK_TEST_PG is set.
 */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { commandEnvelope } from '../packages/mistri/src/server/testing/appRequests.js';
import { LIVE_PG, policyServer, sourceUrl } from './support/policyServer.js';

const SQLITE = `CREATE TABLE account(id INTEGER PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
    posted_minor INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE account_note(id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES account(id), body TEXT NOT NULL);
  CREATE TABLE note_count(account_id INTEGER PRIMARY KEY, n INTEGER NOT NULL);
  INSERT INTO account VALUES (1, 'Acme', 'open', 500);
  CREATE TRIGGER example_validation_only
  BEFORE UPDATE OF posted_minor ON account
  WHEN NEW.posted_minor < 0
  BEGIN
   SELECT RAISE(ABORT, 'Negative customer balance');
  END;
  CREATE TRIGGER count_notes AFTER INSERT ON account_note BEGIN
    INSERT INTO note_count VALUES (NEW.account_id, 1) ON CONFLICT (account_id) DO UPDATE SET n = n + 1;
  END;`;

const POSTGRES = `CREATE TABLE account(id integer PRIMARY KEY, name text NOT NULL, status text NOT NULL DEFAULT 'open',
    posted_minor integer NOT NULL DEFAULT 0);
  CREATE TABLE account_note(id integer PRIMARY KEY, account_id integer NOT NULL REFERENCES account(id), body text NOT NULL);
  CREATE TABLE note_count(account_id integer PRIMARY KEY, n integer NOT NULL);
  INSERT INTO account VALUES (1, 'Acme', 'open', 500);
  CREATE FUNCTION example_validation_only() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF NEW.posted_minor < 0 THEN
      RAISE EXCEPTION 'Negative customer balance';
    END IF;
    RETURN NEW;
  END $$;
  CREATE TRIGGER example_validation_only BEFORE UPDATE OF posted_minor ON account
    FOR EACH ROW WHEN (NEW.posted_minor < 0) EXECUTE FUNCTION example_validation_only();
  CREATE FUNCTION count_notes() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    INSERT INTO note_count VALUES (NEW.account_id, 1) ON CONFLICT (account_id) DO UPDATE SET n = note_count.n + 1;
    RETURN NEW;
  END $$;
  CREATE TRIGGER count_notes AFTER INSERT ON account_note FOR EACH ROW EXECUTE FUNCTION count_notes();`;

const POLICY = `export default { appId: 'ledger', resultReferences: { restrict: () => [], post: () => [], note: () => [] },
  resolveRows() { return { account: true, account_note: true, note_count: true }; } };`;
const COMMANDS = `import { defineCommand, defineCommands } from ${sourceUrl('packages/mistri/src/server/commands/businessCommands.ts')};
export default defineCommands({
  restrict: defineCommand({ source: 'main', target: 'account', read: ['account'], write: ['account'],
    async handle({ db, record }) { await db.account.update(record, { status: 'restricted' }); return {}; } }),
  post: defineCommand({ source: 'main', target: 'account', read: ['account'], write: ['account'],
    async handle({ db, record }) { await db.account.update(record, { posted_minor: -100 }); return {}; } }),
  note: defineCommand({ source: 'main', target: 'account', read: ['account'], write: ['account_note'],
    async handle({ db, record }) { await db.account_note.insert({ id: 1, account_id: record.id, body: 'Called' }); return {}; } }),
});`;

async function reproducer(t: TestContext, postgres: boolean) {
  const server = await policyServer(t, {
    app: {
      id: 'ledger',
      name: 'Ledger',
      auth: {
        signUp: 'open',
        defaultRole: 'compliance',
        rows: 'policy',
        roles: { compliance: { read: true, commands: ['restrict', 'post', 'note'] } },
      },
      resources: {
        account: {
          access: 'write',
          actions: {
            restrict: { label: 'Restrict', command: 'restrict' },
            post: { label: 'Post', command: 'post' },
            note: { label: 'Note', command: 'note' },
          },
        },
        account_note: { access: 'write' },
      },
      views: { accounts: { kind: 'list', from: 'account' } },
      home: 'accounts',
      nav: ['accounts'],
    },
    policy: POLICY,
    sql: postgres ? POSTGRES : SQLITE,
    commands: COMMANDS,
    postgres,
  });
  const person = await server.signUp('compliance');
  const run = async (command: string) => {
    const prepared = await server.api('commands/prepare', { command, commandVersion: 1, key: { id: 1 } }, person);
    assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
    return server.api(
      'commands/execute',
      commandEnvelope({ command, commandVersion: 1, key: { id: 1 }, expectedVersion: prepared.body.expectedVersion, input: {} }),
      person,
    );
  };
  const account = async () =>
    (await server.api('query', { table: 'account', filter: { groups: [[{ column: 'id', op: '=', value: 1 }]] } }, person)).body.rows[0];

  // The report's command: it updates status, which the trigger does not name.
  const restricted = await run('restrict');
  assert.equal(restricted.status, 200, JSON.stringify(restricted.body));
  assert.equal((await account()).status, 'restricted');
  assert.doesNotMatch(server.log(), /example_validation_only/);

  // The trigger still guards its column: the negative balance is refused, by the trigger, and nothing changes.
  const posted = await run('post');
  assert.notEqual(posted.status, 200, JSON.stringify(posted.body));
  assert.equal((await account()).posted_minor, 500);

  // A trigger that writes another table still refuses, under a row policy, the write that fires it.
  const noted = await run('note');
  assert.equal(noted.status, 403, JSON.stringify(noted.body));
  assert.match(server.log(), /an insert fires the trigger "count_notes" \(it writes rows\)/);
}

test('SQLite: a row-policy command runs under a validation-only trigger, and a writing trigger still refuses', { timeout: 60_000 }, (t) =>
  reproducer(t, false),
);

test(
  'PostgreSQL: a row-policy command runs under a validation-only trigger, and a writing trigger still refuses',
  { timeout: 60_000, skip: LIVE_PG ? false : 'TABLEWALK_TEST_PG is not set' },
  (t) => reproducer(t, true),
);
