/**
 * The triggers half of authority.lock (triggerLock.ts): a row-policy App names the triggers it accepts, and the lock
 * records each one's definition and the effects read from it. Adversarial test 5 of docs/trigger-effects.md: a named
 * trigger changed between runs leaves the lock stale, `mistri check` names it, and the server refuses to start.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { migratePostgresCommandJournal } from '../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import { readSqliteTrigger } from '../packages/engine/src/adapters/scoped/sqliteTriggers.js';
import { lockedTriggers, pinnedDigest, sayEffect, triggerLockFindings } from '../packages/mistri/src/server/commands/triggerLock.js';
import { authorityDiff } from '../packages/mistri/src/shared/appAuthority.js';
import type { AppDef } from '../packages/mistri/src/shared/app.js';
import { scratch } from './support/scratch.js';
import { LIVE_PG, sourceUrl } from './support/policyServer.js';
import { pgClient, uuidPostgresDatabase } from './support/tenantDialects.js';
import { VALIDATE, validating } from './support/validation.js';

const trigger = (sql: string) => readSqliteTrigger(/TRIGGER (\w+)/.exec(sql)![1], sql, new Set());
const COUNT = trigger(
  'CREATE TRIGGER count_notes AFTER INSERT ON account_note BEGIN INSERT INTO note_count (account_id, n) VALUES (NEW.account_id, 1); END',
);
const BUMP = trigger(
  'CREATE TRIGGER bump AFTER INSERT ON account_note BEGIN UPDATE account SET notes = notes + 1 WHERE id = NEW.account_id; END',
);
const CHECKS = trigger("CREATE TRIGGER checks BEFORE INSERT ON account_note WHEN NEW.body = '' BEGIN SELECT RAISE(ABORT, 'empty'); END");
const LOOSE = trigger('CREATE TRIGGER loose AFTER INSERT ON account_note BEGIN DELETE FROM note_count; END');
const naming = (...triggers: string[]) =>
  ({ auth: { rows: 'policy' }, resources: { account_note: { access: 'write', triggers } } }) as unknown as AppDef;

test("a named trigger's lock line says its events, its digest and what it does, and a stale one is a problem", () => {
  const triggersOf = (resource: string) => (resource === 'account_note' ? [COUNT, BUMP, CHECKS, LOOSE] : undefined);
  const fresh = triggerLockFindings(naming('count_notes', 'bump'), triggersOf, undefined);
  // Without a lock nothing is approved: each named trigger is a problem, with the remedy that writes the lock.
  assert.equal(fresh.problems.length, 2);
  for (const [at, name] of ['count_notes', 'bump'].entries())
    assert.match(
      fresh.problems[at],
      new RegExp(
        `triggers "${name}": the App keeps no authority\\.lock, so nothing has approved it \\[trigger-lock\\]\\. .*mistri check --write-authority`,
      ),
    );
  assert.deepEqual(fresh.lines, [
    `trigger account_note.count_notes on insert ${COUNT.digest}`,
    '  inserts note_count with account_id = NEW.account_id, n = 1',
    `trigger account_note.bump on insert ${BUMP.digest}`,
    '  writes account.notes where account.id = NEW.account_id',
  ]);
  // The lock approved count_notes as it was, and never bump.
  const stale = triggerLockFindings(naming('count_notes', 'bump'), triggersOf, new Map([['account_note.count_notes', 'sha256:00']]));
  assert.equal(stale.problems.length, 2);
  assert.match(stale.problems[0], /triggers "count_notes": its definition changed since authority\.lock approved it \[trigger-lock\]/);
  assert.match(stale.problems[1], /triggers "bump": authority\.lock has not approved it \[trigger-lock\]/);
  // The lock's own lines are read back as they were written.
  assert.deepEqual(
    lockedTriggers(fresh.lines.join('\n')),
    new Map([
      ['account_note.count_notes', COUNT.digest],
      ['account_note.bump', BUMP.digest],
    ]),
  );
  const odd = triggerLockFindings(naming('missing', 'checks', 'loose'), triggersOf, new Map());
  assert.match(odd.problems[0], /triggers "missing": the database has no trigger by that name on "account_note" \[trigger-unknown\]/);
  assert.match(odd.problems[1], /triggers "loose": .*outside the keyed-effect grammar \[command-trigger\]/);
  assert.match(odd.warnings[0], /triggers "checks": it only checks NEW and OLD and raises, .* drop the name/);
});

test('a transaction pins the digest the lock approved, and one no definition has where it approved none or there is no lock', () => {
  const app = (approvedTriggers?: Record<string, string>) => ({ ...(approvedTriggers ? { approvedTriggers } : {}) }) as AppDef;
  // No lock approves nothing: the write that fires the trigger is refused, as where the lock has no line for it.
  assert.equal(pinnedDigest(app(), 'account_note', 'count_notes'), 'sha256:unapproved');
  assert.equal(pinnedDigest(app({ 'account_note.count_notes': 'sha256:ab' }), 'account_note', 'count_notes'), 'sha256:ab');
  assert.equal(pinnedDigest(app({}), 'account_note', 'count_notes'), 'sha256:unapproved');
});

test("authority's own comparison leaves the trigger lines to theirs", () => {
  const lock = `auth rows policy  # the App\n\ntrigger account_note.count_notes on insert sha256:${'0'.repeat(64)}\n  inserts note_count with n = 1\n`;
  assert.deepEqual(authorityDiff(lock, 'auth rows policy  # the App\n'), []);
});

test('an effect is said as the lock says it', () => {
  assert.equal(
    sayEffect({ kind: 'delete', table: 'hold', key: { id: { row: 'old', column: 'hold_id' } } }),
    'deletes hold where hold.id = OLD.hold_id',
  );
  assert.equal(
    sayEffect({ kind: 'read', table: 'account', key: { id: { row: 'new', column: 'account_id' } }, values: { status: { literal: null } } }),
    'reads account.status where account.id = NEW.account_id',
  );
  assert.equal(
    sayEffect({ kind: 'insert', table: 'log', values: { what: { literal: "it's" }, at: { expression: true } } }),
    "inserts log with what = 'it''s', at = (computed)",
  );
});

/* ---------- adversarial 5, end to end ---------- */

const SQLITE = `CREATE TABLE account(id INTEGER PRIMARY KEY, name TEXT NOT NULL, notes INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE account_note(id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES account(id), body TEXT NOT NULL);
  CREATE TRIGGER bump AFTER INSERT ON account_note BEGIN UPDATE account SET notes = notes + 1 WHERE id = NEW.account_id; END;`;
const SQLITE_CHANGED = `DROP TRIGGER bump;
  CREATE TRIGGER bump AFTER INSERT ON account_note BEGIN UPDATE account SET notes = notes + 2 WHERE id = NEW.account_id; END;`;
const POSTGRES = `CREATE TABLE account(id integer PRIMARY KEY, name text NOT NULL, notes integer NOT NULL DEFAULT 0);
  CREATE TABLE account_note(id integer PRIMARY KEY, account_id integer NOT NULL REFERENCES account(id), body text NOT NULL);
  CREATE FUNCTION public.bump() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN UPDATE public.account SET notes = notes + 1 WHERE id = NEW.account_id; RETURN NULL; END $$;
  CREATE TRIGGER bump AFTER INSERT ON account_note FOR EACH ROW EXECUTE FUNCTION public.bump();`;
const POSTGRES_CHANGED = `CREATE OR REPLACE FUNCTION public.bump() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN UPDATE public.account SET notes = notes + 2 WHERE id = NEW.account_id; RETURN NULL; END $$;`;

const APP = {
  id: 'ledger',
  name: 'Ledger',
  sources: { main: { connection: 'ops' } },
  auth: { signUp: 'invite', defaultRole: 'clerk', rows: 'policy', roles: { clerk: { read: true, commands: ['note'] } } },
  resources: {
    account: { access: 'write', actions: { note: { label: 'Note', command: 'note' } } },
    account_note: { access: 'write', triggers: ['bump'] },
  },
  views: { accounts: { kind: 'list', from: 'account' } },
  home: 'accounts',
  nav: ['accounts'],
};
const POLICY = `export default { appId: 'ledger', resultReferences: { note: () => [] },
  resolveRows() { return { account: true, account_note: true }; } };`;
const COMMANDS = `import { defineCommand, defineCommands } from ${sourceUrl('packages/mistri/src/server/commands/businessCommands.ts')};
export default defineCommands({
  note: defineCommand({ source: 'main', target: 'account', read: ['account'], write: ['account_note'],
    async handle({ db, record }) { await db.account_note.insert({ id: 1, account_id: record.id, body: 'Called' }); return {}; } }),
});`;

async function ledger(t: TestContext, postgres: boolean) {
  const { directory, stopping } = scratch(t, 'tablewalk-trigger-lock-');
  let url: string;
  let change: () => Promise<void>;
  if (postgres) {
    const owned = await uuidPostgresDatabase('tw_trigger_lock');
    stopping(() => owned.drop());
    const run = async (sql: string) => {
      const client = await pgClient(owned.url);
      try {
        await client.query(sql);
      } finally {
        await client.end();
      }
    };
    await run(POSTGRES);
    url = owned.url;
    await migratePostgresCommandJournal(url);
    change = () => run(POSTGRES_CHANGED);
  } else {
    url = join(directory, 'data.db');
    const db = new DatabaseSync(url);
    db.exec(SQLITE);
    db.close();
    migrateSqliteCommandJournal(url);
    change = async () => {
      const db = new DatabaseSync(url);
      db.exec(SQLITE_CHANGED);
      db.close();
    };
  }
  const app = join(directory, 'app');
  mkdirSync(app);
  writeFileSync(join(app, 'app.json'), JSON.stringify(APP));
  writeFileSync(join(directory, 'policy.mjs'), POLICY);
  writeFileSync(join(directory, 'commands.mjs'), COMMANDS);
  const config = join(directory, 'mistri.json');
  writeFileSync(config, JSON.stringify({ connections: [{ name: 'ops', url, writable: true }] }));
  const flags = [
    '--config',
    config,
    '--app',
    app,
    '--policy',
    join(directory, 'policy.mjs'),
    '--commands',
    join(directory, 'commands.mjs'),
  ];
  const env = {
    ...process.env,
    DATABASE_URL: '',
    BETTER_AUTH_SECRET: 'trigger-lock-fixture-secret-at-least-32-characters',
    XDG_CONFIG_HOME: join(directory, 'xdg'),
  };
  const cli = (args: string[], wait: number): Promise<{ code: number; output: string }> => {
    const run = validating(args, env);
    return new Promise((done, reject) => {
      execFile(
        process.execPath,
        ['--import', 'tsx', resolve('packages/mistri/src/server/index.ts'), ...run.args],
        { timeout: wait, env: run.env },
        (error, stdout, stderr) => {
          if (error?.killed) return reject(new Error(`It did not stop:\n${stdout}${stderr}`));
          done({ code: Number(error?.code ?? 0), output: stdout + stderr });
        },
      );
    });
  };
  return {
    lock: join(app, 'authority.lock'),
    change,
    check: (...more: string[]) => cli([...flags, ...more, VALIDATE], 60_000),
    serve: async () => {
      const reservation = createServer();
      await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done));
      const port = (reservation.address() as { port: number }).port;
      await new Promise<void>((done) => reservation.close(() => done()));
      // A refused start stops by itself; one that serves is the failure, killed at the deadline.
      return cli([...flags, '--port', String(port)], 45_000);
    },
  };
}

async function adversarial5(t: TestContext, postgres: boolean) {
  const f = await ledger(t, postgres);
  // An App that names a trigger and keeps no lock has approved nothing: check names it, and the server does not start.
  const unlocked = await f.check();
  assert.equal(unlocked.code, 1, unlocked.output);
  assert.match(
    unlocked.output,
    /resources "account_note" triggers "bump": the App keeps no authority\.lock, so nothing has approved it \[trigger-lock\]\. .*mistri check --write-authority/,
  );
  const unstarted = await f.serve();
  assert.notEqual(unstarted.code, 0, unstarted.output);
  assert.match(unstarted.output, /the App keeps no authority\.lock, so nothing has approved it/);
  const written = await f.check('--write-authority');
  assert.equal(written.code, 0, written.output);
  const lock = readFileSync(f.lock, 'utf8');
  assert.match(lock, /^trigger account_note\.bump on insert sha256:[0-9a-f]{64}$/m);
  assert.match(lock, /^ {2}writes (public\.)?account\.notes where (public\.)?account\.id = NEW\.account_id$/m);
  const approved = await f.check();
  assert.equal(approved.code, 0, approved.output);
  assert.match(approved.output, /Ledger: ok/);
  assert.doesNotMatch(approved.output, /\[command-trigger\]/, 'a named, accepted trigger blocks nothing');

  await f.change();
  const stale = await f.check();
  assert.equal(stale.code, 1, stale.output);
  assert.match(
    stale.output,
    /resources "account_note" triggers "bump": its definition changed since authority\.lock approved it \[trigger-lock\]/,
  );
  const refused = await f.serve();
  assert.notEqual(refused.code, 0, refused.output);
  assert.match(refused.output, /its definition changed since authority\.lock approved it/);

  // Approved again: the lock moves, and check is clean.
  assert.equal((await f.check('--write-authority')).code, 0);
  assert.notEqual(readFileSync(f.lock, 'utf8'), lock);
  assert.equal((await f.check()).code, 0);
}

test(
  'adversarial 5 on SQLite: a named trigger changed between runs leaves the lock stale; check names it and the server does not start',
  { timeout: 240_000 },
  (t) => adversarial5(t, false),
);

test(
  'adversarial 5 on PostgreSQL: a function replaced between runs leaves the lock stale; check names it and the server does not start',
  { timeout: 240_000, skip: LIVE_PG ? false : 'TABLEWALK_TEST_PG is not set' },
  (t) => adversarial5(t, true),
);
