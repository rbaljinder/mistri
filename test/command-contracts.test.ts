/**
 * A command's version is authority.lock's, not its source's
 * (commandContracts.ts): a contract line per command, a change written down
 * freely until something durable depends on the command, and then refused
 * until `mistri check --bump <command>` moves it to its next version —
 * which the API's routes, receipts and jobs then carry.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { defineCommand, defineCommands, withCommandVersions } from '../packages/mistri/src/server/commands/businessCommands.js';
import { field } from '../packages/mistri/src/server/commands/commandFields.js';
import { defineEvent, defineEventProjection } from '../packages/mistri/src/server/commands/businessEvents.js';
import { shape, text } from '../packages/mistri/src/server/commands/commandShapes.js';
import {
  appCommandCatalog,
  contractDigest,
  contractLines,
  lockedContracts,
  lockedVersion,
} from '../packages/mistri/src/server/commands/commandContracts.js';
import { VALIDATE, validating } from './support/validation.js';

const app = { sources: { desk: { connection: 'desk', default: true } } };
const registry = (input: Record<string, unknown>) =>
  defineCommands({
    change: defineCommand({ source: 'desk', target: 'ticket', input: input as never, async handle() {} }),
    close: defineCommand({ source: 'desk', target: 'ticket', async handle() {} }),
  });

test('command names use a sole implicit default source before App parsing', () => {
  const commands = registry({});
  const raw = { sources: { desk: { connection: 'desk' } } } as unknown as typeof app;
  assert.equal(appCommandCatalog(commands, raw).get('change')?.target, 'ticket');
  assert.equal(
    appCommandCatalog(commands, { sources: { desk: { connection: 'desk', default: false } } }).get('change')?.target,
    'desk.ticket',
  );
  // A root connection is the one source named for it, so its commands' targets stay bare.
  assert.equal(appCommandCatalog(commands, { connection: 'desk' }).get('change')?.target, 'ticket');
});

test('a contract line per command: written at v1, rewritten freely, held where something durable depends on it, bumped on request', () => {
  const first = registry({ note: field.text({ max: 80 }) });
  const { lines } = contractLines(app, first, undefined, () => []);
  assert.deepEqual(
    lines.map((line) => line.replace(/ [0-9a-f]{12}$/, '')),
    ['contract change v1', 'contract close v1'],
  );
  const lock = `allow something\n\n${lines.join('\n')}\n`;
  assert.deepEqual([...lockedContracts(lock).keys()], ['change', 'close']);
  // The handler, the footprint and `when` are not the caller's contract: the digest stays.
  const same = defineCommands({
    ...first,
    change: defineCommand({
      source: 'desk',
      target: 'ticket',
      read: ['note'],
      when: 'status = open',
      input: { note: field.text({ max: 80 }) },
      async handle() {
        /* another body */
      },
    }),
  });
  assert.equal(contractDigest(app, same.change), contractDigest(app, first.change));
  // Another input is another contract. With nothing durable on it, the new digest is simply written, at the same version.
  const changed = registry({ note: field.text({ max: 80 }), priority: field.number({ optional: true }) });
  assert.notEqual(contractDigest(app, changed.change), contractDigest(app, first.change));
  const free = contractLines(app, changed, lock, () => []);
  assert.deepEqual(free.changes, [{ id: 'change', version: 1, durable: [] }]);
  assert.equal(free.lines[0], `contract change v1 ${contractDigest(app, changed.change)}`);
  // Published by the API, the change is breaking: the old line stays, so writing the lock cannot accept it.
  const held = contractLines(app, changed, lock, (id) => (id === 'change' ? ['the App API publishes it'] : []));
  assert.deepEqual(held.changes, [{ id: 'change', version: 1, durable: ['the App API publishes it'] }]);
  assert.equal(held.lines[0], lines[0]);
  // --bump moves it on, with the digest it has now; the others keep theirs.
  const bumped = contractLines(app, changed, lock, (id) => (id === 'change' ? ['the App API publishes it'] : []), ['change']);
  assert.deepEqual(bumped.lines, [`contract change v2 ${contractDigest(app, changed.change)}`, lines[1]]);
  // The registry the server runs carries the lock's version; a command the lock does not name is at 1.
  const versioned = withCommandVersions(changed, lockedVersion(bumped.lines.join('\n')));
  assert.equal(versioned.change.version, 2);
  assert.equal(versioned.close.version, 1);
  assert.equal(changed.change.version, 1, 'the registry itself is left as it was');
});

test('event field and payload-shape changes participate in the producing command contract', () => {
  const command = (max: number) => {
    const event = defineEvent('ticket.changed', shape({ note: text({ max }) }));
    return defineCommands({
      change: defineCommand({
        source: 'desk',
        target: 'ticket',
        events: { changed: defineEventProjection(event, () => ({ note: 'changed' })) },
        async handle() {},
      }),
    }).change;
  };
  assert.notEqual(contractDigest(app, command(80)), contractDigest(app, command(40)));
});

const ROOT = resolve('.');
/* An App's starts are mistri's (test/support/bins.ts). */
const ENTRY = join(ROOT, 'packages', 'mistri', 'src', 'server', 'index.ts');
interface Ran {
  code: number;
  out: string;
  err: string;
}
function tablewalk(args: string[], env: Record<string, string>): Promise<Ran> {
  return new Promise((done, reject) => {
    const child = validating(args, { ...process.env, ...env });
    execFile(
      process.execPath,
      ['--import', 'tsx', ENTRY, ...child.args],
      { cwd: ROOT, timeout: 120_000, killSignal: 'SIGKILL', env: child.env },
      (error, out, err) => {
        if (error && (error as { killed?: boolean }).killed) {
          reject(new Error(`tablewalk ${args.join(' ')} did not exit`));
          return;
        }
        done({ code: (error as { code?: number } | null)?.code ?? 0, out, err });
      },
    );
  });
}

test(
  "the --bump flow: check writes the lines, a published command's change fails the check until it is bumped",
  { timeout: 600_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'tablewalk-contracts-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const env = { XDG_CONFIG_HOME: join(directory, 'config') };
    const db = join(directory, 'desk.db');
    const raw = new DatabaseSync(db);
    raw.exec(
      "CREATE TABLE ticket (id INTEGER PRIMARY KEY, title TEXT NOT NULL, note TEXT, revision INTEGER NOT NULL DEFAULT 0); INSERT INTO ticket (title) VALUES ('One');",
    );
    raw.close();
    migrateSqliteCommandJournal(db);
    const dir = join(directory, 'desk');
    mkdirSync(dir);
    writeFileSync(
      join(dir, 'app.json'),
      JSON.stringify({
        id: 'desk',
        name: 'Desk',
        sources: { desk: { connection: 'desk', default: true } },
        resources: { ticket: { access: 'write' } },
        auth: { providers: ['email'], store: join(directory, 'auth.db'), roles: { operator: { read: true, commands: ['change'] } } },
        views: { tickets: { kind: 'list', from: 'ticket' } },
        home: 'tickets',
        api: { version: 1, roles: ['operator'], resources: { ticket: { fields: ['id', 'title', 'revision'] } }, commands: ['change'] },
      }),
    );
    const commands = (input: string) =>
      writeFileSync(
        join(dir, 'commands.mjs'),
        `import { defineCommand, defineCommands, field } from ${JSON.stringify(pathToFileURL(join(ROOT, 'packages/mistri/src/server/commands.ts')).href)};
export default defineCommands({ change: defineCommand({ source: 'desk', target: 'ticket', input: ${input},
  async handle({ db, record }, input) { await db.ticket.update(record, { note: input.note }); } }) });
`,
      );
    commands('{ note: field.text() }');
    const config = join(directory, 'mistri.json');
    writeFileSync(config, JSON.stringify({ connections: [{ name: 'desk', url: db, writable: true }] }));
    const lockOf = () => readFileSync(join(dir, 'authority.lock'), 'utf8');
    const check = (...extra: string[]) => tablewalk(['--config', config, '--app', dir, VALIDATE, ...extra], env);

    const written = await check('--write-authority');
    assert.equal(written.code, 0, written.err);
    assert.match(lockOf(), /^contract change v1 [0-9a-f]{12}$/m);
    const v1 = lockOf();

    // The API publishes it: a new input is a breaking change, named with the way out, and --write-authority cannot accept it.
    commands('{ note: field.text(), urgent: field.bool({ optional: true }) }');
    const breaking = await check('--write-authority');
    assert.equal(breaking.code, 1, breaking.out);
    assert.match(
      breaking.err + breaking.out,
      /command "change" changed its contract .* the App API publishes it: bump it with mistri check --bump change, which moves it to version 2/,
    );
    assert.equal(lockOf().match(/^contract .*$/m)?.[0], v1.match(/^contract .*$/m)?.[0]);

    const unknown = await check('--bump', 'chnage');
    assert.equal(unknown.code, 1);
    assert.match(unknown.err + unknown.out, /--bump names "chnage", which the commands module does not register/);

    const bumped = await check('--bump', 'change');
    assert.equal(bumped.code, 0, bumped.err + bumped.out);
    assert.match(lockOf(), /^contract change v2 [0-9a-f]{12}$/m);
    const clean = await check();
    assert.equal(clean.code, 0, clean.err + clean.out);

    // The published route carries the lock's version.
    const openapi = await tablewalk(['--config', config, '--app', dir, '--export', 'openapi', '--api-integers', 'number'], env);
    assert.equal(openapi.code, 0, openapi.err);
    assert.match(openapi.out, /\/commands\/change\/v2/);
    assert.doesNotMatch(openapi.out, /\/commands\/change\/v1/);
  },
);
