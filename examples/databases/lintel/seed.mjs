/**
 * Lintel on SQLite: the three buildings (data.mjs) in a new file, for the
 * App's tests and a quick local try. PostgreSQL is the target and has its own
 * seed (seed-postgres.mjs) over the same rows and schema.
 *
 *   node --import tsx examples/databases/lintel/seed.mjs <new-file.db>
 *
 * From an installed package, with the App copied out of node_modules:
 *   LINTEL_APP=./lintel node node_modules/@mistriwork/mistri/examples/databases/lintel/seed.mjs <new-file.db>
 *
 * The day is today in Denver, or `LINTEL_TODAY=YYYY-MM-DD`, which makes the
 * same file every time. Writes the database and `<file>.json`: a writable
 * connection named `lintel`, and an email service that writes each message
 * to `<file>.mail.log` instead of sending it, its unsubscribe links signed
 * with the secret in LINTEL_MAIL_SECRET. Then it provisions every store the App
 * and its jobs use, as `mistri migrate stores up --app … --jobs …` does.
 * Refuses an existing file or config.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generate, lintelToday } from './data.mjs';
import { ddl, INDEXES } from './schema.mjs';

const value = (v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v === undefined ? null : v);
// An App inside node_modules cannot be loaded (Node strips no types there), so
// an installed package's reader copies it out and names the copy.
export const APP = process.env.LINTEL_APP
  ? `${resolve(process.env.LINTEL_APP)}/`
  : fileURLToPath(new URL('../../apps/lintel/', import.meta.url));

/** The server's config for a seeded database: the connection, and mail kept in a file beside it. */
export function lintelConfig(url, mailLog) {
  return {
    connections: [
      { name: 'lintel', url, writable: true },
      {
        name: 'mail',
        kind: 'email',
        url: `log:${mailLog}`,
        from: 'Lintel Property Co. <no-reply@lintel.example.test>',
        // A reference, never the value: set LINTEL_MAIL_SECRET where the App runs (the tests make one each).
        links: { secret: '${LINTEL_MAIL_SECRET}' },
      },
    ],
  };
}

/** `mistri migrate stores up` for the App and its jobs, as the package's own CLI runs it. */
export function provisionStores(config) {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve('@mistriwork/mistri/package.json'));
  const source = join(root, 'src/server/index.ts');
  // In a checkout, the CLI's source under tsx, as the test host runs it: a checkout's built CLI resolves the other
  // packages only under --conditions=mistri-built, and may be older than the source. Installed, the package's bin.
  const built = !existsSync(source);
  const cli = built
    ? [join(root, JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).bin.mistri)]
    : ['--import', pathToFileURL(require.resolve('tsx')).href, source];
  const result = spawnSync(
    process.execPath,
    [...cli, 'migrate', 'stores', 'up', '--app', APP, '--jobs', join(APP, 'jobs.ts'), '--config', config],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        // Provisioning signs nothing, but the config is read whole.
        LINTEL_MAIL_SECRET: process.env.LINTEL_MAIL_SECRET ?? randomBytes(24).toString('base64url'),
        ...(built ? {} : { TSX_TSCONFIG_PATH: join(root, '../../tsconfig.json') }),
      },
    },
  );
  if (result.status !== 0) throw new Error(`Provisioning the App's stores failed:\n${result.stdout}${result.stderr}`);
}

export function seed(file, { today = process.env.LINTEL_TODAY, photos = true, stores = true } = {}) {
  if (typeof file !== 'string' || !file || file.startsWith('--')) {
    throw new Error('Usage: node --import tsx examples/databases/lintel/seed.mjs <new-database-path>');
  }
  file = resolve(file);
  if (existsSync(file) || existsSync(`${file}.json`))
    throw new Error(`Refusing to replace ${file} or its config. Choose a new database path.`);
  const day = today && /^\d{4}-\d{2}-\d{2}$/.test(today) ? today : lintelToday();
  const { tables } = generate({ today: day, photos });
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('BEGIN');
    for (const [, statement] of ddl('sqlite')) db.exec(statement);
    for (const index of INDEXES) db.exec(index);
    for (const [name, rows] of Object.entries(tables)) {
      if (!rows.length) continue;
      const columns = Object.keys(rows[0]);
      const insert = db.prepare(`INSERT INTO ${name} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`);
      for (const row of rows) insert.run(...columns.map((column) => value(row[column])));
    }
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
  writeFileSync(`${file}.json`, `${JSON.stringify(lintelConfig(file, `${file}.mail.log`), null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  if (stores) provisionStores(`${file}.json`);
  return file;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 3) throw new Error('Pass one new database path.');
  const file = seed(process.argv[2]);
  console.log(`Seeded ${file}\nConfig: ${file}.json`);
}
