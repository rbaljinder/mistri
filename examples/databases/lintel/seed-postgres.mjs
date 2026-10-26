/**
 * Lintel on PostgreSQL, its target: the same buildings as the SQLite seed
 * (data.mjs) written into an empty `public` schema with real types — dates as
 * date, moments as timestamp, photos as bytea — identity keys and every
 * CHECK, then every store the App and its jobs use provisioned.
 *
 *   node --import tsx examples/databases/lintel/seed-postgres.mjs <new-postgres-url> <config.json>
 *
 * The day is today in Denver, or `LINTEL_TODAY=YYYY-MM-DD`. Keys are
 * identities, so a charge the rent job posts numbers on from the seeded ones.
 * Requires an empty public schema and never drops or replaces anything.
 * Writes the config file named (it must not exist yet): a writable connection
 * named `lintel`, and an email service writing to `<config>.mail.log`.
 * `pg` is an optional repository dependency.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { generate, lintelToday } from './data.mjs';
import { ddl, INDEXES } from './schema.mjs';
import { lintelConfig, provisionStores } from './seed.mjs';

const [url, configPath] = process.argv.slice(2);
if (!url || !configPath) {
  console.error('Usage: node --import tsx examples/databases/lintel/seed-postgres.mjs <new-postgres-url> <config.json>');
  process.exit(1);
}
const config = resolve(configPath);
if (existsSync(config)) throw new Error(`Refusing to replace ${config}. Name a new config file.`);
const today = /^\d{4}-\d{2}-\d{2}$/.test(process.env.LINTEL_TODAY ?? '') ? process.env.LINTEL_TODAY : lintelToday();
const { tables } = generate({ today });

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout = '5s'");
  const lock = await client.query("SELECT pg_try_advisory_xact_lock(hashtext('@mistriwork/mistri/lintel/public')) AS acquired");
  if (!lock.rows[0]?.acquired) throw new Error('Another Lintel seed is already running.');
  const namespace = await client.query("SELECT oid FROM pg_namespace WHERE nspname = 'public'");
  if (!namespace.rows.length) throw new Error('The public schema must exist before seeding.');
  const existing = await client.query(
    `SELECT 1 FROM pg_class WHERE relnamespace = $1
     UNION ALL SELECT 1 FROM pg_proc WHERE pronamespace = $1
     UNION ALL SELECT 1 FROM pg_type WHERE typnamespace = $1 LIMIT 1`,
    [namespace.rows[0].oid],
  );
  if (existing.rows.length) throw new Error('Refusing to seed: the public schema is not empty.');
  await client.query('SET LOCAL search_path = public, pg_catalog');
  for (const [, statement] of ddl('postgres')) await client.query(statement);
  for (const index of INDEXES) await client.query(index);
  for (const [name, rows] of Object.entries(tables)) {
    if (!rows.length) continue;
    const columns = Object.keys(rows[0]);
    const per = Math.max(1, Math.floor(30000 / columns.length));
    for (let at = 0; at < rows.length; at += per) {
      const values = [];
      const tuples = rows.slice(at, at + per).map(
        (row) =>
          `(${columns
            .map((column) => {
              values.push(row[column] ?? null);
              return `$${values.length}`;
            })
            .join(', ')})`,
      );
      await client.query(`INSERT INTO ${name} (${columns.join(', ')}) OVERRIDING SYSTEM VALUE VALUES ${tuples.join(', ')}`, values);
    }
    await client.query(`SELECT setval(pg_get_serial_sequence('${name}', 'id'), (SELECT max(id) FROM ${name}))`);
    console.log(`${name.padEnd(20)} ${rows.length}`);
  }
  await client.query('COMMIT');
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  await client.end();
}
writeFileSync(config, `${JSON.stringify(lintelConfig(url, `${config}.mail.log`), null, 2)}\n`, { flag: 'wx', mode: 0o600 });
provisionStores(config);
console.log(`Config: ${config}`);
