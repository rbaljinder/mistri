/**
 * `tablewalk migrate diff | check | squash`: the schema a team wants, written
 * once in `schema.sql`, and the versioned files that get a database there.
 *
 * tablewalk stays database-first: nothing here comes from the App's DSL. The
 * person edits `schema.sql` the way they would write it by hand; `diff`
 * writes the next `V<n>__<name>.sql` holding what the migrations so far lack,
 * for review; `check` fails when the migrations and `schema.sql` disagree, so
 * neither drifts from the other in a commit; `squash` folds the chain into
 * one baseline before a database worth keeping exists.
 *
 * The comparison is Atlas's (the Apache-2.0 community build), not ours: a
 * schema differ is a database tool, and tablewalk rides on the database
 * rather than becoming one. It is fetched pinned — a version and a sha256 per
 * platform — into `.mistri/bin` (`.tablewalk/bin` for the browser) beside the project, on the first `diff` or
 * `check` and said aloud, never while serving, and run with its update check
 * off. Stripe's pg-schema-diff was tried first and set aside: it cannot leave
 * tablewalk's `__mistri_*` tables out (only whole schemas), so a diff would
 * drop the migration history, and its plans use `CREATE INDEX CONCURRENTLY`
 * and `SET SESSION`, which do not fit one transaction per file.
 *
 * Both sides are real databases: the migrations are applied to a scratch one
 * by tablewalk's own runner (the runner a deploy uses, so the chain is judged
 * as it will run), and Atlas reads `schema.sql` into a second, empty one. On
 * PostgreSQL both are created on the connection's server (or `--dev-url`'s)
 * and dropped after, which needs `CREATEDB`; on SQLite one is a temporary file
 * and the other is in memory. Neither is the connection's own database.
 */
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { RUNTIME_TABLE_PREFIXES } from '../../shared/runtimeTables.js';
import { dialectOf, openMigrationDb, quoteIdent, sqlitePath } from './database.js';
import { readMigrations } from './files.js';
import { migrateUp, type MigrateTarget } from './runner.js';
import { envName, product, productEnv } from '../product.js';

/** The pinned build. A new version is a new line here and new checksums, reviewed like any dependency. */
export const ATLAS_VERSION = 'v1.3.0';
const ATLAS_SHA256: Readonly<Record<string, string>> = {
  'darwin-arm64': '4e5ffdc10b2b4fd3a06074aba72848150907d5316cacad7b19bae6c6ae3db991',
  'darwin-amd64': '650981a024301775ec964e5134e2d5712b7ef1b25fec4b2ec54bad762b4bdf6f',
  'linux-amd64': '10d7913e3dce43ab99b8d71534a4cbadaf11a16dc293adf3b91d10e83a0ac70b',
  'linux-arm64': '082188c57a53439596a3ee52173b12e785aa83ec718505674e2052db0fec0c4c',
};

/** Where the binary lives: local to the project, ignored by git, named by its version so a bump fetches again. */
export const atlasPath = (projectDir: string) => join(projectDir, `.${product()}`, 'bin', `atlas-${ATLAS_VERSION}`);

/** The desired schema, by default: `schema.sql` beside the migrations directory (`db/migrations` → `db/schema.sql`). */
export const defaultSchemaFile = (migrationsDir: string) => join(dirname(resolve(migrationsDir)), 'schema.sql');

/**
 * The Atlas binary to run: `MISTRI_ATLAS` (`TABLEWALK_ATLAS` under the browser, product.ts) when set (an Atlas the team
 * installed itself, taken as it is), else the pinned build, fetched once and
 * checked against its sha256 before it is ever made executable.
 */
export async function atlasBinary(
  projectDir: string,
  say: (line: string) => void,
  fetcher: (url: string) => Promise<Uint8Array> = download,
  platform = `${process.platform}-${process.arch === 'x64' ? 'amd64' : process.arch}`,
  pins: Readonly<Record<string, string>> = ATLAS_SHA256,
): Promise<string> {
  const own = productEnv('ATLAS');
  if (own) return own;
  const path = atlasPath(projectDir);
  const want = pins[platform];
  if (!want)
    throw new Error(
      `there is no pinned Atlas build for ${platform}. Install Atlas ${ATLAS_VERSION} (community edition) and set ${envName('ATLAS')} to its path.`,
    );
  /* Checked again on every run, not only when fetched: the file sits in the project, where anything that writes there
     (a dependency's install script, a checkout of someone's branch) could replace what this then executes. */
  if (existsSync(path)) {
    if (createHash('sha256').update(readFileSync(path)).digest('hex') === want) return path;
    say(`The Atlas binary in ${join(`.${product()}`, 'bin')} is not the pinned build; fetching it again.`);
    rmSync(path, { force: true });
  }
  const url = `https://release.ariga.io/atlas/atlas-community-${platform}-${ATLAS_VERSION}`;
  say(`Fetching Atlas community ${ATLAS_VERSION} (${platform}, about 40 MB) into ${join(`.${product()}`, 'bin')}, once.`);
  const bytes = await fetcher(url);
  const got = createHash('sha256').update(bytes).digest('hex');
  if (got !== want) throw new Error(`the Atlas download from ${url} is not the pinned build (sha256 ${got}); nothing was installed.`);
  mkdirSync(dirname(path), { recursive: true });
  const part = `${path}.part`;
  writeFileSync(part, bytes);
  chmodSync(part, 0o755);
  renameSync(part, path);
  /* An older pin's binary is dead weight once the version moves. */
  for (const old of readdirSync(dirname(path)))
    if (old.startsWith('atlas-') && old !== `atlas-${ATLAS_VERSION}`) rmSync(join(dirname(path), old), { force: true });
  return path;
}

async function download(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`could not fetch Atlas from ${url}: HTTP ${response.status}.`);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * A database URL as Atlas reads it, and the environment that carries its
 * password: never on argv, where every user of the machine can read it in
 * the process list. Atlas's PostgreSQL driver honours `PGPASSWORD` as libpq
 * does. Scoped to one schema, so `--exclude` names tables and nothing else of
 * a shared database is compared.
 */
export function atlasUrl(url: string, schema?: string): { url: string; env: Record<string, string> } {
  if (dialectOf(url) === 'sqlite') {
    const path = sqlitePath(url);
    return { url: path.startsWith('file:') || path.includes('?') ? `sqlite://${path}` : `sqlite://${resolve(path)}`, env: {} };
  }
  const parsed = new URL(url);
  const password = parsed.password ? decodeURIComponent(parsed.password) : undefined;
  parsed.password = '';
  parsed.protocol = 'postgres:';
  /* node-postgres speaks plain TCP unless told otherwise; Atlas would insist on TLS. Keep the connection's choice. */
  if (!parsed.searchParams.has('sslmode')) parsed.searchParams.set('sslmode', 'disable');
  if (schema !== undefined) parsed.searchParams.set('search_path', schema);
  return { url: parsed.toString(), env: password !== undefined ? { PGPASSWORD: password } : {} };
}

/** Run Atlas, its update check off, its edition notice dropped; resolves to stdout, rejects with what it said. */
function runAtlas(binary: string, args: readonly string[], env: Record<string, string> = {}): Promise<string> {
  return new Promise((done, fail) => {
    execFile(
      binary,
      args,
      { env: { ...process.env, ...env, ATLAS_NO_UPDATE_NOTIFIER: '1' }, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) return done(stdout);
        const said = String(stderr)
          .replace(/^Notice: This Atlas[\s\S]*?docs#installation\s*/m, '')
          .trim();
        fail(
          new Error(
            (error as NodeJS.ErrnoException).code === 'ENOENT'
              ? `Atlas is not at ${binary}${productEnv('ATLAS') ? ` (${envName('ATLAS')})` : ''}.`
              : `Atlas: ${said || error.message}`,
          ),
        );
      },
    );
  });
}

interface Scratch {
  /** Where the migrations are applied. */
  readonly built: string;
  /** Empty: where Atlas reads schema.sql in. */
  readonly dev: string;
  readonly drop: () => Promise<void>;
}

/** Two throwaway databases beside the connection's (or `devUrl`'s) server, never the connection's own. */
async function scratch(url: string, devUrl?: string): Promise<Scratch> {
  const dialect = dialectOf(url);
  if (dialect === 'mysql') throw new Error('migrate diff, check and squash run on PostgreSQL and SQLite; MySQL is not covered yet.');
  if (devUrl !== undefined && dialectOf(devUrl) !== dialect)
    throw new Error(`--dev-url must be the same kind of database as the connection (${dialect}).`);
  if (dialect === 'sqlite') {
    const dir = mkdtempSync(join(tmpdir(), 'tablewalk-schema-'));
    return {
      built: join(dir, 'built.db'),
      dev: 'sqlite://dev?mode=memory',
      drop: async () => rmSync(dir, { recursive: true, force: true }),
    };
  }
  const server = devUrl ?? url;
  const stem = `tablewalk_schema_${process.pid}_${randomBytes(3).toString('hex')}`;
  const names = [`${stem}_built`, `${stem}_dev`];
  const admin = await openMigrationDb(server, [], false);
  const at = (name: string) => {
    const parsed = new URL(server);
    parsed.pathname = `/${name}`;
    return parsed.toString();
  };
  const made: string[] = [];
  const drop = async () => {
    for (const name of made) await admin.run(`DROP DATABASE IF EXISTS ${quoteIdent('postgres', name)} WITH (FORCE)`).catch(() => {});
    await admin.close();
  };
  try {
    for (const name of names) {
      await admin.run(`CREATE DATABASE ${quoteIdent('postgres', name)}`);
      made.push(name);
    }
  } catch (error) {
    await drop();
    throw new Error(
      `could not create a scratch database on that server (${(error as Error).message}). The role needs CREATEDB, or name a server where it has it with --dev-url.`,
    );
  }
  return { built: at(names[0]), dev: at(names[1]), drop };
}

interface DesiredOptions {
  /** The desired schema: `schema.sql` beside the migrations unless named. */
  readonly schemaFile: string;
  /** A PostgreSQL server where two scratch databases may be made and dropped; the connection's own by default. */
  readonly devUrl?: string;
  readonly atlas: string;
}

/**
 * What the migrations still lack to reach `schema.sql`, as SQL: empty when
 * they agree. tablewalk's own tables (`__mistri_*`, and the history table
 * if it is named otherwise) are left out of the comparison: they move through
 * tablewalk, not through schema.sql.
 */
export async function pendingSql(target: MigrateTarget, options: DesiredOptions): Promise<string> {
  if (!existsSync(options.schemaFile))
    throw new Error(`there is no ${options.schemaFile}: write the schema you want there, or name it with --schema-file.`);
  if (target.schemas.length > 1)
    throw new Error(`migrate diff compares one schema, and this run owns ${target.schemas.join(', ')}: name one with --schema.`);
  const dialect = dialectOf(target.url);
  const db = await scratch(target.url, options.devUrl);
  try {
    const built = { ...target, url: db.built };
    const result = await migrateUp(built);
    if (result.refused) throw new Error(result.refused);
    if (result.status.plan.problems.length) throw new Error(result.status.plan.problems.join(' '));
    if (result.failure) throw new Error(`${result.failure.file.script} failed on a scratch database: ${result.failure.message}`);
    const schema = dialect === 'postgres' ? (target.schemas[0] ?? 'public') : undefined;
    /* Atlas reads schema.sql into the scoped schema of the dev database, and will not make it. */
    if (schema !== undefined && schema !== 'public') {
      const dev = await openMigrationDb(db.dev, [], false);
      try {
        await dev.run(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent('postgres', schema)}`);
      } finally {
        await dev.close();
      }
    }
    const from = atlasUrl(db.built, schema);
    const dev = dialect === 'postgres' ? atlasUrl(db.dev, schema) : { url: db.dev, env: {} };
    /* SQLite reads a copy with PostgreSQL's serial primary keys in its own spelling; the file itself when nothing changed. */
    let to = resolve(options.schemaFile);
    if (dialect === 'sqlite') {
      const text = readFileSync(to, 'utf8');
      const read = sqliteDesired(text);
      if (read !== text) writeFileSync((to = join(dirname(db.built), 'schema.sql')), read);
    }
    const excludes = [...new Set([...RUNTIME_TABLE_PREFIXES.map((prefix) => `${prefix}*`), target.table])].flatMap((pattern) => [
      '--exclude',
      pattern,
    ]);
    const sql = await runAtlas(
      options.atlas,
      ['schema', 'diff', '--from', from.url, '--to', `file://${to}`, '--dev-url', dev.url, ...excludes, '--format', '{{ sql . "  " }}'],
      { ...from.env, ...dev.env },
    );
    return sql.trim();
  } finally {
    await db.drop();
  }
}

/**
 * schema.sql as SQLite is to read it. PostgreSQL numbers a `serial` column
 * from a sequence; SQLite takes any word as a type, so `id serial primary key`
 * is accepted as a plain nullable column, Atlas writes it back as
 * `` `id` serial NULL ``, and every new row's id is NULL. SQLite numbers only
 * an `integer` primary key (the rowid's other name), so a serial primary key
 * is read as one here, and one schema.sql serves both databases — the
 * quickstart's and the home page's do. A serial column that is not declared
 * the primary key on its own line has nothing on SQLite to number it, and is
 * refused by name rather than left to come out NULL.
 */
export function sqliteDesired(text: string): string {
  const read = text.replace(/\b(?:small|big)?serial(\s+(?:not\s+null\s+)?primary\s+key)\b/gi, 'integer$1');
  const bare = read.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '');
  /* Not before `(`: that is a table or an index named serial, not a column's type. */
  const left = /([A-Za-z_][\w$]*|"[^"]+"|`[^`]+`)\s+((?:small|big)?serial)\b(?!\s*\()/i.exec(bare);
  if (left)
    throw new Error(
      `${left[1]} is ${left[2]}, which SQLite does not number. On SQLite only the primary key is numbered: write it \`${left[1]} ${left[2]} primary key\` (read as integer primary key), or give it another type.`,
    );
  return read;
}

/** The header a written migration carries: where it came from, and what a diff cannot know. */
export const diffHeader = () =>
  '-- Written by ' +
  product() +
  ' migrate diff from schema.sql. Review it before committing:\n' +
  '-- a rename comes out as DROP and ADD, and a backfill or data step is not here.\n';

/**
 * The first versioned migration: what an empty database lacks to reach
 * `schema.sql` is `schema.sql`, so it is written as it stands — comments and
 * all, as a squash writes it — and no diff tool is fetched for it. On SQLite
 * it is schema.sql as SQLite reads it (`sqliteDesired`). `migrate up` is what
 * proves it runs; the next `migrate diff` compares the two as any other does.
 */
export function firstMigration(schemaFile: string, dialect: string, schemas: readonly string[]): string {
  if (!existsSync(schemaFile))
    throw new Error(`there is no ${schemaFile}: write the schema you want there, or name it with --schema-file.`);
  if (schemas.length > 1)
    throw new Error(`migrate diff compares one schema, and this run owns ${schemas.join(', ')}: name one with --schema.`);
  const text = readFileSync(schemaFile, 'utf8');
  return dialect === 'sqlite' ? sqliteDesired(text) : text;
}

/** The header the first migration carries: it is schema.sql, not a diff. */
export const firstHeader = () =>
  '-- Written by ' + product() + ' migrate diff: schema.sql as it stands, the first migration. Review it before committing.\n';

/**
 * Fold the versioned chain into one `V1__baseline.sql` holding `schema.sql`
 * itself — comments and all, since the check has just shown the two build the
 * same schema. Repeatable files stay. Only before a database worth keeping
 * exists: one migrated with the old chain no longer matches its history.
 * On SQLite it is schema.sql as SQLite reads it (`sqliteDesired`), so the
 * baseline numbers its ids as the diff's files did. Returns the files
 * removed and the one written.
 */
export function squashInto(dir: string, schemaFile: string, dialect?: string): { removed: string[]; wrote: string } {
  const { files } = readMigrations(dir);
  const versioned = files.filter((file) => file.kind === 'versioned');
  const removed: string[] = [];
  for (const file of versioned) {
    rmSync(file.path);
    if (existsSync(`${file.path}.conf`)) rmSync(`${file.path}.conf`);
    removed.push(file.script);
  }
  const text = readFileSync(schemaFile, 'utf8');
  const wrote = join(dir, 'V1__baseline.sql');
  writeFileSync(
    wrote,
    `-- The migrations up to here, squashed by ${product()} migrate squash: the schema.sql they built.\n${dialect === 'sqlite' ? sqliteDesired(text) : text}`,
  );
  return { removed, wrote };
}
