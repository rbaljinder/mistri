/**
 * `mistri migrate diff | check | squash`: schema.sql against the migration
 * chain. No network and no Atlas download here: a fake Atlas (MISTRI_ATLAS)
 * records what it was asked and reads the scratch database it was handed, so
 * these prove the parts that are tablewalk's — the words, the numbering, the
 * chain applied by tablewalk's own runner to a scratch database, the
 * `__mistri_*` exclusion, the pinned download's refusals. The comparison
 * itself is Atlas's; set TABLEWALK_TEST_ATLAS to an Atlas binary to run the
 * last test against the real one, on SQLite.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, test } from 'node:test';
import { runMigrate } from '../packages/engine/src/server/migrate/cli.js';
import { MIGRATE_APPS } from '../packages/mistri/src/server/cli/appTargets.js';
import {
  atlasBinary,
  atlasPath,
  atlasUrl,
  ATLAS_VERSION,
  defaultSchemaFile,
  squashInto,
  sqliteDesired,
} from '../packages/engine/src/server/migrate/desired.js';
import { newMigration } from '../packages/engine/src/server/migrate/files.js';

const work = mkdtempSync(join(tmpdir(), 'tablewalk-desired-'));
after(() => rmSync(work, { recursive: true, force: true }));
let n = 0;

/* The fake: logs its argv, the tables of the database it was given --from,
   and its PGPASSWORD, then prints FAKE_ATLAS_SQL (empty: the two agree). */
const fake = join(work, 'atlas');
writeFileSync(
  fake,
  `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const args = process.argv.slice(2);
const from = args[args.indexOf('--from') + 1].replace(/^sqlite:\\/\\//, '');
const db = new DatabaseSync(from, { readOnly: true });
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name);
db.close();
appendFileSync(process.env.FAKE_ATLAS_LOG, JSON.stringify({ args, tables }) + '\\n');
process.stdout.write(process.env.FAKE_ATLAS_SQL ?? '');
`,
);
chmodSync(fake, 0o755);

function project(files: Record<string, string>, schema = 'CREATE TABLE task (id INTEGER PRIMARY KEY, title TEXT NOT NULL);\n') {
  const root = join(work, `p${++n}`);
  const dir = join(root, 'db', 'migrations');
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  writeFileSync(join(root, 'db', 'schema.sql'), schema);
  return { root, dir, db: join(root, 'app.db'), log: join(root, 'atlas.log') };
}

/** runMigrate in-process with the fake as Atlas; what it wrote and said. */
async function migrate(args: string[], env: { log: string; sql?: string }) {
  const out: string[] = [];
  const err: string[] = [];
  const saved = { atlas: process.env.MISTRI_ATLAS, log: process.env.FAKE_ATLAS_LOG, sql: process.env.FAKE_ATLAS_SQL };
  const error = console.error;
  process.env.MISTRI_ATLAS = fake;
  process.env.FAKE_ATLAS_LOG = env.log;
  process.env.FAKE_ATLAS_SQL = env.sql ?? '';
  console.error = (line: string) => err.push(String(line));
  try {
    const code = await runMigrate(args, (line) => out.push(line), undefined, MIGRATE_APPS);
    return { code, out: out.join('\n'), err: err.join('\n') };
  } finally {
    console.error = error;
    for (const [key, name] of [
      ['atlas', 'MISTRI_ATLAS'],
      ['log', 'FAKE_ATLAS_LOG'],
      ['sql', 'FAKE_ATLAS_SQL'],
    ] as const) {
      if (saved[key] === undefined) delete process.env[name];
      else process.env[name] = saved[key];
    }
  }
}
const calls = (log: string) =>
  existsSync(log)
    ? readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { args: string[]; tables: string[] })
    : [];

const V1 = { 'V1__task.sql': 'CREATE TABLE task (id INTEGER PRIMARY KEY, title TEXT NOT NULL);\n' };
/* The quickstart's schema.sql (getting-started.md): PostgreSQL's spelling, which SQLite builds too. */
const QUICKSTART = `create table customer (
  id serial primary key,
  name text not null,
  email text
);

create table invoice (
  id serial primary key,
  customer_id integer not null references customer (id),
  total numeric(10, 2) not null,
  paid boolean not null default false
);
`;
const ADD = 'ALTER TABLE `task` ADD COLUMN `done` integer NOT NULL DEFAULT 0;\n';

describe('the words of diff, check and squash', () => {
  test('diff needs a name; the schema.sql flags belong to them; --tool and --dry-run do not', async () => {
    const p = project(V1);
    const base = ['--db', p.db, '--no-config', '--migrations', p.dir];
    const noName = await migrate(['diff', ...base], p);
    assert.equal(noName.code, 1);
    assert.match(noName.err, /diff needs a name: mistri migrate diff add_payoff_quote/);
    assert.match(
      (await migrate(['up', ...base, '--schema-file', 'x.sql'], p)).err,
      /--schema-file and --dev-url are for diff, check and squash/,
    );
    assert.match((await migrate(['status', ...base, '--dev-url', 'postgres://x/y'], p)).err, /are for diff, check and squash/);
    assert.match((await migrate(['check', ...base, '--dry-run'], p)).err, /check takes no --tool, --dry-run or --repeatable/);
    assert.match((await migrate(['diff', 'x', ...base, '--tool', 'flyway'], p)).err, /takes no --tool/);
    assert.match((await migrate(['check', ...base, '--schema-file'], p)).err, /--schema-file needs a value/);
    assert.match((await migrate(['--help'], p)).out, /diff <name> write the next V file from schema\.sql/);
    assert.deepEqual(calls(p.log), [], 'nothing reached Atlas');
  });

  test('a missing schema.sql, MySQL and a --dev-url of another kind are refused before Atlas runs', async () => {
    const p = project(V1);
    rmSync(join(p.root, 'db', 'schema.sql'));
    const missing = await migrate(['check', '--db', p.db, '--no-config', '--migrations', p.dir], p);
    assert.equal(missing.code, 1);
    assert.match(missing.err, /there is no .*db\/schema\.sql: write the schema you want there, or name it with --schema-file/);
    const other = project(V1);
    const mysql = await migrate(['check', '--db', 'mysql://u@127.0.0.1:1/x', '--no-config', '--migrations', other.dir], other);
    assert.match(mysql.err, /PostgreSQL and SQLite; MySQL is not covered yet/);
    const mixed = await migrate(
      ['check', '--db', other.db, '--no-config', '--migrations', other.dir, '--dev-url', 'postgres://u@h/d'],
      other,
    );
    assert.match(mixed.err, /--dev-url must be the same kind of database as the connection \(sqlite\)/);
    assert.deepEqual(calls(other.log), []);
  });
});

describe('the chain against schema.sql, on a scratch database', () => {
  test('check applies the chain with the runner, leaves tablewalk tables out, and exits 2 on a difference', async () => {
    const p = project(V1);
    const base = ['--db', p.db, '--no-config', '--migrations', p.dir];
    const same = await migrate(['check', ...base], p);
    assert.equal(same.code, 0, same.err);
    assert.match(same.out, /db\/schema\.sql matches the migrations in .*db\/migrations\./);
    const [call] = calls(p.log);
    assert.deepEqual(
      call.tables,
      ['__mistri_schema_history', '__mistri_schema_snapshot', 'task'],
      'the scratch database is the chain applied',
    );
    const at = (flag: string) => call.args[call.args.indexOf(flag) + 1];
    assert.deepEqual(call.args.slice(0, 2), ['schema', 'diff']);
    assert.equal(at('--to'), `file://${join(p.root, 'db', 'schema.sql')}`);
    assert.equal(at('--dev-url'), 'sqlite://dev?mode=memory');
    assert.ok(call.args.includes('__mistri_*'), 'the reserved tables are excluded');
    assert.ok(!existsSync(p.db), "the connection's own database is never opened, let alone made");
    assert.ok(!existsSync(at('--from').replace('sqlite://', '')), 'the scratch database is gone after');

    const differ = await migrate(['check', ...base], { ...p, sql: ADD });
    assert.equal(differ.code, 2);
    assert.match(differ.out, /disagree\. What the migrations still lack:\n {2}ALTER TABLE `task` ADD COLUMN `done`/);
    assert.match(differ.out, /mistri migrate diff <name>/);
  });

  test('diff writes the next version with a review header, warns on a drop, and writes nothing when they agree', async () => {
    const p = project({ ...V1, 'V2__more.sql': 'CREATE TABLE note (id INTEGER PRIMARY KEY);\n' });
    const base = ['--db', p.db, '--no-config', '--migrations', p.dir];
    const wrote = await migrate(['diff', 'add done', ...base], { ...p, sql: ADD });
    assert.equal(wrote.code, 0, wrote.err);
    const file = join(p.dir, 'V3__add_done.sql');
    assert.match(wrote.out, /wrote .*V3__add_done\.sql:\nALTER TABLE `task`/);
    assert.equal(
      readFileSync(file, 'utf8'),
      '-- Written by mistri migrate diff from schema.sql. Review it before committing:\n' +
        '-- a rename comes out as DROP and ADD, and a backfill or data step is not here.\n' +
        ADD,
    );
    const dropped = await migrate(['diff', 'drop_note', ...base], { ...p, sql: 'DROP TABLE `note`;\n' });
    assert.match(dropped.out, /note: it drops something\. If that is a rename, rewrite it as RENAME/);
    assert.ok(existsSync(join(p.dir, 'V4__drop_note.sql')));
    const none = await migrate(['diff', 'nothing', ...base], p);
    assert.equal(none.code, 0);
    assert.match(none.out, /Nothing to write: the migrations already build/);
    assert.ok(!existsSync(join(p.dir, 'V5__nothing.sql')));
  });

  test('--schema-file names the desired schema anywhere', async () => {
    const p = project(V1);
    const elsewhere = join(p.root, 'wanted.sql');
    writeFileSync(elsewhere, 'CREATE TABLE task (id INTEGER PRIMARY KEY);\n');
    const ran = await migrate(['check', '--db', p.db, '--no-config', '--migrations', p.dir, '--schema-file', elsewhere], p);
    assert.equal(ran.code, 0, ran.err);
    assert.ok(calls(p.log)[0].args.includes(`file://${elsewhere}`));
  });

  test('squash folds a settled chain into V1__baseline.sql holding schema.sql, and refuses an unsettled one', async () => {
    const schema = '-- tasks, as wanted\nCREATE TABLE task (id INTEGER PRIMARY KEY, title TEXT NOT NULL, done INTEGER);\n';
    const p = project({ ...V1, 'V2__done.sql': 'ALTER TABLE task ADD COLUMN done INTEGER;\n', 'R__views.sql': '-- none\n' }, schema);
    writeFileSync(join(p.dir, 'V2__done.sql.conf'), 'executeInTransaction=true\n');
    const base = ['--db', p.db, '--no-config', '--migrations', p.dir];
    const refused = await migrate(['squash', ...base], { ...p, sql: ADD });
    assert.equal(refused.code, 2);
    assert.match(refused.out, /nothing settled to squash/);
    assert.deepEqual(readdirSync(p.dir).sort(), ['R__views.sql', 'V1__task.sql', 'V2__done.sql', 'V2__done.sql.conf']);
    const squashed = await migrate(['squash', ...base], p);
    assert.equal(squashed.code, 0, squashed.err);
    assert.match(squashed.out, /Squashed 2 migrations into .*V1__baseline\.sql: V1__task\.sql, V2__done\.sql/);
    assert.deepEqual(readdirSync(p.dir).sort(), ['R__views.sql', 'V1__baseline.sql']);
    assert.ok(readFileSync(join(p.dir, 'V1__baseline.sql'), 'utf8').endsWith(schema));
    assert.equal(calls(p.log).at(-1)!.tables.includes('task'), true, 'the baseline was checked after');
    const again = await migrate(['squash', ...base], p);
    assert.match(again.out, /Nothing to squash: .* holds 1 versioned migration\./);
  });
});

describe('the pieces', () => {
  test('the default schema.sql sits beside the migrations directory', () => {
    assert.equal(defaultSchemaFile('/p/db/migrations'), '/p/db/schema.sql');
    assert.equal(defaultSchemaFile('/p/app/migrations/'), '/p/app/schema.sql');
  });

  test("a URL as Atlas reads it: the password in PGPASSWORD, never argv; one schema; the connection's TLS choice kept", () => {
    assert.deepEqual(atlasUrl('postgres://ana:s%3Acret@db.test:5433/app', 'crm'), {
      url: 'postgres://ana@db.test:5433/app?sslmode=disable&search_path=crm',
      env: { PGPASSWORD: 's:cret' },
    });
    assert.equal(
      atlasUrl('postgresql://ana@db.test/app?sslmode=require', 'public').url,
      'postgres://ana@db.test/app?sslmode=require&search_path=public',
    );
    assert.deepEqual(atlasUrl('/tmp/x/built.db'), { url: 'sqlite:///tmp/x/built.db', env: {} });
  });

  test('diff numbering follows the directory: the next integer, or a timestamp scheme kept', () => {
    const dir = join(work, 'numbering');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'V7__a.sql'), '');
    assert.ok(newMigration(dir, 'b', false, new Date(), 'SELECT 1;\n').endsWith('V8__b.sql'));
    assert.equal(readFileSync(join(dir, 'V8__b.sql'), 'utf8'), 'SELECT 1;\n');
    const stamped = join(work, 'stamped');
    mkdirSync(stamped, { recursive: true });
    writeFileSync(join(stamped, 'V20260101000000__a.sql'), '');
    assert.ok(newMigration(stamped, 'b', false, new Date('2026-10-06T12:00:00Z'), '').endsWith('V20261006120000__b.sql'));
  });

  test('squashInto removes every versioned file and its .conf, and keeps the repeatables', () => {
    const dir = join(work, 'squash');
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'V1__a.sql'), '');
    writeFileSync(join(dir, 'sub', 'V2__b.sql'), '');
    writeFileSync(join(dir, 'V2__b.sql.conf'), '');
    writeFileSync(join(dir, 'R__v.sql'), '');
    const schema = join(work, 'squash-schema.sql');
    writeFileSync(schema, 'CREATE TABLE t (id INTEGER);\n');
    const { removed } = squashInto(dir, schema);
    assert.deepEqual(removed, ['V1__a.sql', 'sub/V2__b.sql']);
    assert.deepEqual(readdirSync(dir, { recursive: true }).map(String).sort(), ['R__v.sql', 'V1__baseline.sql', 'V2__b.sql.conf', 'sub']);
  });

  test("SQLite reads PostgreSQL's serial primary key as its integer one, and refuses a serial it cannot number", () => {
    assert.equal(
      sqliteDesired('create table a (id serial primary key, n text);\ncreate table b (id BIGSERIAL NOT NULL PRIMARY KEY);\n-- serial\n'),
      'create table a (id integer primary key, n text);\ncreate table b (id integer NOT NULL PRIMARY KEY);\n-- serial\n',
    );
    const plain = 'create table serial (id integer primary key, serial_no text);\n';
    assert.equal(sqliteDesired(plain), plain, 'a table named serial, and a column that starts with it, are left alone');
    assert.throws(
      () => sqliteDesired('create table t (id integer primary key, n smallserial not null);'),
      /n is smallserial, which SQLite does not number\. On SQLite only the primary key is numbered: write it `n smallserial primary key`/,
    );
  });

  test('diff on SQLite hands Atlas the schema as SQLite reads it, refuses before Atlas, and squash writes that baseline', async () => {
    const p = project({}, QUICKSTART);
    const ran = await migrate(['check', '--db', p.db, '--no-config', '--migrations', p.dir], p);
    assert.equal(ran.code, 0, ran.err);
    const [call] = calls(p.log);
    assert.notEqual(call.args[call.args.indexOf('--to') + 1], `file://${join(p.root, 'db', 'schema.sql')}`, 'a copy, not the file');
    const refused = project({}, 'create table t (id integer primary key, n serial);\n');
    const said = await migrate(['diff', 'x', '--db', refused.db, '--no-config', '--migrations', refused.dir], refused);
    assert.equal(said.code, 1);
    assert.match(said.err, /n is serial, which SQLite does not number/);
    assert.deepEqual(calls(refused.log), [], 'refused before Atlas runs');

    const dir = join(work, 'squash-sqlite');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'V1__a.sql'), '');
    const schema = join(work, 'squash-sqlite.sql');
    writeFileSync(schema, QUICKSTART);
    squashInto(dir, schema, 'sqlite');
    const baseline = readFileSync(join(dir, 'V1__baseline.sql'), 'utf8');
    assert.match(baseline, /id integer primary key,\n {2}name text not null/);
    assert.doesNotMatch(baseline, /serial/);
  });

  test('the pinned Atlas: MISTRI_ATLAS wins, a fetched build is checked by sha256 before it lands, an unpinned platform is refused', async () => {
    const project = join(work, 'pinned');
    const saved = process.env.MISTRI_ATLAS;
    delete process.env.MISTRI_ATLAS;
    try {
      const said: string[] = [];
      let fetched = '';
      await assert.rejects(
        atlasBinary(
          project,
          (line) => said.push(line),
          async (url) => ((fetched = url), new Uint8Array([1, 2, 3])),
          'darwin-arm64',
        ),
        /is not the pinned build \(sha256 [0-9a-f]{64}\); nothing was installed/,
      );
      assert.equal(fetched, `https://release.ariga.io/atlas/atlas-community-darwin-arm64-${ATLAS_VERSION}`);
      assert.match(said[0], /Fetching Atlas community v1\.3\.0 \(darwin-arm64, about 40 MB\) into \.mistri\/bin, once\./);
      assert.ok(!existsSync(atlasPath(project)) && !existsSync(`${atlasPath(project)}.part`));
      await assert.rejects(
        atlasBinary(
          project,
          () => {},
          async () => new Uint8Array(),
          'win32-amd64',
        ),
        /no pinned Atlas build for win32-amd64\. Install Atlas v1\.3\.0 .* set MISTRI_ATLAS/,
      );
      // Once there, it is checked again on every run: the pinned bytes are used with no fetch...
      mkdirSync(join(project, '.mistri', 'bin'), { recursive: true });
      const pinned = Buffer.from('the pinned build');
      const pins = { 'darwin-arm64': createHash('sha256').update(pinned).digest('hex') };
      writeFileSync(atlasPath(project), pinned);
      const never = async (): Promise<Uint8Array> => {
        throw new Error('fetched again');
      };
      assert.equal(await atlasBinary(project, () => {}, never, 'darwin-arm64', pins), atlasPath(project));
      // ...and a binary replaced since is never run: it is removed and the pinned build fetched in its place.
      writeFileSync(atlasPath(project), 'something else');
      const replaced: string[] = [];
      assert.equal(
        await atlasBinary(
          project,
          (line) => replaced.push(line),
          async () => new Uint8Array(pinned),
          'darwin-arm64',
          pins,
        ),
        atlasPath(project),
      );
      assert.match(replaced[0], /is not the pinned build; fetching it again/);
      assert.deepEqual(readFileSync(atlasPath(project)), pinned);
      writeFileSync(atlasPath(project), 'something else');
      await assert.rejects(
        atlasBinary(
          project,
          () => {},
          async () => new Uint8Array([1]),
          'darwin-arm64',
          pins,
        ),
        /is not the pinned build \(sha256/,
      );
      assert.ok(!existsSync(atlasPath(project)), 'the replaced binary is gone, and nothing took its place');
      process.env.MISTRI_ATLAS = '/opt/atlas';
      assert.equal(await atlasBinary(join(work, 'elsewhere'), () => {}, never), '/opt/atlas');
    } finally {
      if (saved === undefined) delete process.env.MISTRI_ATLAS;
      else process.env.MISTRI_ATLAS = saved;
    }
  });
});

const REAL = process.env.TABLEWALK_TEST_ATLAS;
describe('with the real Atlas', { skip: REAL ? false : 'set TABLEWALK_TEST_ATLAS=<atlas binary> to run this' }, () => {
  test('diff, then check, on SQLite', async () => {
    const p = project(V1, 'CREATE TABLE task (id INTEGER PRIMARY KEY, title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0);\n');
    const saved = process.env.MISTRI_ATLAS;
    process.env.MISTRI_ATLAS = REAL;
    try {
      const base = ['--db', p.db, '--no-config', '--migrations', p.dir];
      const out: string[] = [];
      assert.equal(await runMigrate(['check', ...base], (line) => out.push(line), undefined, MIGRATE_APPS), 2);
      assert.equal(await runMigrate(['diff', 'add_done', ...base], (line) => out.push(line), undefined, MIGRATE_APPS), 0);
      assert.match(readFileSync(join(p.dir, 'V2__add_done.sql'), 'utf8'), /ADD COLUMN `done` integer NOT NULL DEFAULT 0/);
      assert.equal(await runMigrate(['check', ...base], (line) => out.push(line), undefined, MIGRATE_APPS), 0, out.join('\n'));
    } finally {
      if (saved === undefined) delete process.env.MISTRI_ATLAS;
      else process.env.MISTRI_ATLAS = saved;
    }
  });

  test("the quickstart's schema.sql on SQLite: a serial primary key is numbered, so a new row's id is not NULL", async () => {
    const p = project({}, QUICKSTART);
    const saved = process.env.MISTRI_ATLAS;
    process.env.MISTRI_ATLAS = REAL;
    try {
      const base = ['--db', p.db, '--no-config', '--migrations', p.dir];
      const out: string[] = [];
      assert.equal(await runMigrate(['diff', 'start', ...base], (line) => out.push(line), undefined, MIGRATE_APPS), 0, out.join('\n'));
      assert.doesNotMatch(readFileSync(join(p.dir, 'V1__start.sql'), 'utf8'), /serial/i);
      assert.equal(await runMigrate(['up', ...base], (line) => out.push(line), undefined, MIGRATE_APPS), 0, out.join('\n'));
      const db = new DatabaseSync(p.db);
      try {
        db.prepare("INSERT INTO customer (name) VALUES ('Ana')").run();
        db.prepare('INSERT INTO invoice (customer_id, total) VALUES (1, 12.5)').run();
        const ids = db.prepare('SELECT c.id AS customer, i.id AS invoice FROM customer c JOIN invoice i ON i.customer_id = c.id').get();
        assert.deepEqual({ ...ids }, { customer: 1, invoice: 1 });
      } finally {
        db.close();
      }
      assert.equal(await runMigrate(['check', ...base], (line) => out.push(line), undefined, MIGRATE_APPS), 0, out.join('\n'));
    } finally {
      if (saved === undefined) delete process.env.MISTRI_ATLAS;
      else process.env.MISTRI_ATLAS = saved;
    }
  });
});
