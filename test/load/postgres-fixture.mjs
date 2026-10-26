import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { captureReleasePostgres, ownPostgresDatabase } from './postgres-ownership.mjs';
import { seedFixture } from './fixture.mjs';
import { DDL, TABLES } from './postgres-thread.mjs';

const inspect = () =>
  JSON.parse(
    execFileSync('docker', ['inspect', 'tablewalk-050-postgres'], {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rows = (input) =>
  input.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        value instanceof Uint8Array ? { bytesHex: Buffer.from(value).toString('hex') } : value,
      ]),
    ),
  );

/** Only the fixed release-owned55450 container. No URL/environment/config input.
 * The run owns this database; stop its child before calling cleanup(). */
export async function seedPostgresFixture(directory, count, signal) {
  signal?.throwIfAborted();
  captureReleasePostgres(inspect());
  const { default: pg } = await import('pg');
  const controlUrl = 'postgresql://postgres@127.0.0.1:55450/tablewalk';
  const settings = {
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
    lock_timeout: 3000,
    application_name: 'tablewalk-owned-load',
    types: { getTypeParser: (oid, format) => ([1082, 1114].includes(oid) ? (value) => value : pg.types.getTypeParser(oid, format)) },
  };
  const control = new pg.Client({ ...settings, connectionString: controlUrl });
  let owned, client;
  const cleanup = async () => {
    try {
      // A failed fixture-client close must not authorize DROP, but still must
      // attempt to close the separately owned control connection.
      if (client) {
        await client.end();
        client = undefined;
      }
      if (owned) await owned.drop();
    } finally {
      await control.end();
    }
  };
  try {
    await control.connect();
    signal?.throwIfAborted();
    owned = await ownPostgresDatabase(control, inspect);
    signal?.throwIfAborted();
    const url = new URL(controlUrl);
    url.pathname = '/' + owned.name;
    client = new pg.Client({ ...settings, connectionString: url.href });
    await client.connect();
    if ((await client.query('SELECT current_database() AS name')).rows[0].name !== owned.name) throw new Error('Wrong owned database');
    await client.query("SET search_path=public,pg_catalog; SET TIME ZONE 'UTC'");
    await owned.assertCurrent();
    const canonical = await seedFixture(directory, count);
    const { DatabaseSync } = await import('node:sqlite');
    const sqlite = new DatabaseSync(canonical.file, { readOnly: true });
    const dataset = {};
    try {
      for (const table of TABLES) dataset[table] = sqlite.prepare(`SELECT * FROM "${table}" ORDER BY id`).all();
    } finally {
      sqlite.close();
    }
    await client.query('BEGIN');
    try {
      await client.query(DDL);
      for (const table of TABLES) {
        signal?.throwIfAborted();
        const source = dataset[table],
          columns = Object.keys(source[0]);
        for (const row of source) {
          signal?.throwIfAborted();
          await client.query(
            `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(',')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(',')})`,
            columns.map((c) => (row[c] instanceof Uint8Array ? Buffer.from(row[c]) : row[c])),
          );
        }
        await client.query(`SELECT setval(pg_get_serial_sequence($1,'id'),$2,true)`, [table, Math.max(...source.map((row) => row.id))]);
        const actual = (await client.query(`SELECT * FROM "${table}" ORDER BY id`)).rows;
        if (hash(rows(actual)) !== hash(rows(source))) throw new Error(`Synthetic ${table} row parity failed`);
      }
      signal?.throwIfAborted();
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    for (const table of TABLES) await client.query(`ANALYZE "${table}"`);
    const constraints = (
      await client.query(`SELECT c.relname AS table_name, con.conname AS name, pg_get_constraintdef(con.oid) AS definition
      FROM pg_catalog.pg_constraint con JOIN pg_catalog.pg_class c ON c.oid=con.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.relname,con.conname`)
    ).rows;
    const indexes = (
      await client.query(
        "SELECT tablename,indexname,indexdef FROM pg_catalog.pg_indexes WHERE schemaname='public' ORDER BY tablename,indexname",
      )
    ).rows;
    const version = (await client.query('SHOW server_version')).rows[0].server_version;
    const configFile = join(directory, 'postgres-owned.json');
    writeFileSync(configFile, JSON.stringify({ connections: [{ name: 'thread', url: url.href, writable: true }] }), {
      flag: 'wx',
      mode: 0o600,
    });
    const evidence = {
      dialect: 'postgres',
      database: owned.name,
      identity: owned.identity,
      container: owned.container,
      version,
      analyzed: [...TABLES],
      schemaDdlHash: hash(DDL),
      constraints,
      indexes,
      dataset: Object.fromEntries(TABLES.map((table) => [table, { rows: dataset[table].length, sha256: hash(rows(dataset[table])) }])),
    };
    await client.end();
    client = undefined;
    let stopping;
    return {
      ...canonical,
      configFile,
      evidence,
      cleanup: () => (stopping ??= cleanup()),
      redact: (text) => text.replaceAll(url.href, '[owned PostgreSQL]').replaceAll(controlUrl, '[owned PostgreSQL control]'),
    };
  } catch (error) {
    let cleanupFailed = false;
    try {
      await cleanup();
    } catch {
      cleanupFailed = true;
    }
    const safe =
      error instanceof Error && /^(Owned PostgreSQL|Synthetic [a-z_]+ row parity)/.test(error.message)
        ? error.message
        : 'Owned PostgreSQL fixture failed';
    throw new Error(`${safe}${cleanupFailed ? `; cleanup refused, inspect owned database ${owned?.name ?? 'identity unavailable'}` : ''}`);
  }
}
