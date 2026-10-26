/**
 * A migrations directory in Flyway's format: what is in it, and what each
 * file's history row must say.
 *
 * The format is Flyway's so a team already on Flyway keeps its files, and can
 * switch either way: `V3__add_payoff_quote.sql` is version 3, "add payoff
 * quote"; `R__views.sql` is repeatable, run again whenever it changes; the
 * directory is read recursively and a file's script is its path under it.
 * The checksum is Flyway's own: CRC32 over the file's lines as UTF-8, with the
 * line breaks and a leading byte-order mark left out, as a signed 32-bit
 * integer — checked against flyway-core 13.8 in test/migrate.test.ts, so
 * `flyway validate` and `tablewalk migrate validate` agree about a file.
 *
 * A file may carry a Flyway script config beside it (`V4__index.sql.conf`)
 * whose one understood line is `executeInTransaction=false`, for a statement
 * PostgreSQL will not run in a transaction (`CREATE INDEX CONCURRENTLY`).
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { crc32 } from 'node:zlib';

export interface MigrationFile {
  readonly kind: 'versioned' | 'repeatable';
  /** Flyway's spelling of the version: the name's digits, `_` read as `.`. Absent for a repeatable. */
  readonly version?: string;
  /** The name after `__`, underscores as spaces: what the history's description says. */
  readonly description: string;
  /** The path under the directory, `/`-separated: the history's script. */
  readonly script: string;
  readonly path: string;
  readonly sql: string;
  readonly checksum: number;
  /** False only where the file's `.conf` says `executeInTransaction=false`. */
  readonly transactional: boolean;
}

export interface MigrationDirectory {
  readonly dir: string;
  readonly files: readonly MigrationFile[];
  /** Files that look meant as migrations and are not (`V1_add.sql`): said, never run. */
  readonly ignored: readonly string[];
}

const VERSIONED = /^V(\d+(?:[._]\d+)*)__(.+)\.sql$/;
const REPEATABLE = /^R__(.+)\.sql$/;

/** Flyway's checksum of a script's text. */
export function flywayChecksum(text: string): number {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = body.split(/\r\n|\r|\n/);
  // A final line break ends the last line; it does not start another (Java's readLine).
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  let sum = 0;
  for (const line of lines) sum = crc32(Buffer.from(line, 'utf8'), sum);
  return sum | 0;
}

/** Flyway's order of versions: dotted parts compared as numbers, a missing part as 0. */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(BigInt);
  const right = b.split('.').map(BigInt);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i] ?? 0n;
    const y = right[i] ?? 0n;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function transactional(path: string): boolean {
  const conf = `${path}.conf`;
  if (!existsSync(conf)) return true;
  for (const raw of readFileSync(conf, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^executeInTransaction\s*=\s*(true|false)$/.exec(line);
    if (!match)
      throw new Error(`${conf}: "${line}" is not understood; the one setting a script config takes here is executeInTransaction=false.`);
    return match[1] === 'true';
  }
  return true;
}

/** Every migration under `dir`, versioned ones in version order, then the repeatables by description. */
export function readMigrations(dir: string): MigrationDirectory {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return { dir, files: [], ignored: [] };
  const files: MigrationFile[] = [];
  const ignored: string[] = [];
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.sql')) continue;
    const path = join(entry.parentPath, entry.name);
    const script = relative(dir, path).split(sep).join('/');
    const versioned = VERSIONED.exec(entry.name);
    const repeatable = REPEATABLE.exec(entry.name);
    if (!versioned && !repeatable) {
      if (/^[VRUB]\d*_/i.test(entry.name)) ignored.push(script);
      continue;
    }
    const sql = readFileSync(path, 'utf8');
    files.push({
      kind: versioned ? 'versioned' : 'repeatable',
      ...(versioned ? { version: versioned[1].replace(/_/g, '.') } : {}),
      description: (versioned ? versioned[2] : repeatable![1]).replace(/_/g, ' '),
      script,
      path,
      sql,
      checksum: flywayChecksum(sql),
      transactional: transactional(path),
    });
  }
  files.sort((a, b) =>
    a.kind !== b.kind
      ? a.kind === 'versioned'
        ? -1
        : 1
      : a.version !== undefined && b.version !== undefined
        ? compareVersions(a.version, b.version)
        : a.description < b.description
          ? -1
          : a.description > b.description
            ? 1
            : 0,
  );
  return { dir, files, ignored };
}

/**
 * Write the next migration's file, empty but for a line that says what the
 * runner will do with it. The version is one past the highest the directory
 * holds, in the directory's own style: a team that numbers by timestamp gets a
 * timestamp. `body` is the file's text when something already wrote it
 * (`migrate diff`).
 */
export function newMigration(dir: string, name: string, repeatable: boolean, now = new Date(), body?: string): string {
  const slug = name
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!slug) throw new Error(`"${name}" gives the file no name: use letters or digits, like add_payoff_quote.`);
  mkdirSync(dir, { recursive: true });
  const { files } = readMigrations(dir);
  let file: string;
  if (repeatable) {
    file = `R__${slug}.sql`;
  } else {
    const majors = files.filter((f) => f.version !== undefined).map((f) => BigInt(f.version!.split('.')[0]));
    const highest = majors.reduce((a, b) => (b > a ? b : a), 0n);
    // Fourteen digits or more is a yyyyMMddHHmmss scheme: keep it.
    const stamp = BigInt(now.toISOString().replace(/\D/g, '').slice(0, 14));
    const next = highest >= 10_000_000_000_000n ? (stamp > highest ? stamp : highest + 1n) : highest + 1n;
    file = `V${next}__${slug}.sql`;
  }
  const path = join(dir, file);
  if (existsSync(path)) throw new Error(`${path} already exists.`);
  writeFileSync(
    path,
    body ??
      (repeatable
        ? `-- Runs again, after the versioned migrations, whenever this file changes: views, functions, grants.\n`
        : `-- Runs once, in version order. Forward only: a later migration undoes what this one does.\n`),
    { flag: 'wx' },
  );
  return path;
}
