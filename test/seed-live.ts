/**
 * Put something in a live test database.
 *
 * The Postgres and MySQL blocks in this suite read whatever table they find,
 * on purpose: a test that hardcodes `customer` is a test that passes for the
 * wrong reason on a database that happens to have one. The cost is that an
 * empty database — which is what a fresh CI service container is, and what a
 * contributor starting a server has — gives them nothing to read.
 *
 * So this creates one small table. It is deliberately not part of the tests:
 * the suite is opt-in and someone will eventually point it at a database that
 * matters, and a suite that writes on startup is a suite that cannot be
 * pointed anywhere. Seeding is a separate, explicit command.
 *
 *   npm run seed:live
 *
 * Reads the same `TABLEWALK_TEST_PG` and `TABLEWALK_TEST_MYSQL` the tests do,
 * and does nothing for an engine that is not configured.
 */

interface PgLike {
  connect(): Promise<void>;
  query(text: string, params?: unknown[]): Promise<unknown>;
  end(): Promise<void>;
}

interface MysqlLike {
  query(text: string, params?: unknown[]): Promise<unknown>;
  end(): Promise<void>;
}

/** Distinctive enough to recognise, and to leave alone. */
const TABLE = 'tablewalk_fixture';

const ROWS = [
  [1, 'first', 10],
  [2, 'second', 20],
  [3, 'third', 30],
];

/* Both ways an engine pins a vocabulary, because the adapters read them from
   different places: Postgres from `pg_enum` and `pg_get_constraintdef`, MySQL
   off the declared type. Without a fixture carrying them, that SQL was only
   ever exercised against SQLite's very different spelling. */
const ENUM_LABELS = ['draft', 'issued', 'paid'];
const CHECKED = ['low', 'high'];

/* Imported through a variable, the same way the adapters do it: `pg` and
   `mysql2` are optional dependencies, and a literal specifier makes the type
   checker demand they be installed to compile a file that may never run. */
async function seedPostgres(url: string): Promise<void> {
  const specifier = 'pg';
  const pg = (await import(specifier)) as {
    default?: { Client: new (c: unknown) => PgLike };
    Client?: new (c: unknown) => PgLike;
  };
  const Client = pg.Client ?? pg.default?.Client;
  if (!Client) throw new Error('Could not find a Client export in the "pg" package.');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    /* A real enum type as well as a check, since Postgres reports them
       through different catalogs and only one of them is a constraint. */
    await client.query(`DO $$ BEGIN
      CREATE TYPE ${TABLE}_status AS ENUM (${ENUM_LABELS.map((l) => `'${l}'`).join(', ')});
    EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${TABLE} (
      id integer PRIMARY KEY,
      name text NOT NULL,
      amount integer,
      status ${TABLE}_status NOT NULL DEFAULT 'draft',
      priority text CHECK (priority IN (${CHECKED.map((l) => `'${l}'`).join(', ')}))
    )`);
    /* Added rather than assumed: a fixture table left over from before these
       columns existed is the common case on a machine that has run this
       suite before. */
    await client.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS status ${TABLE}_status NOT NULL DEFAULT 'draft'`);
    await client.query(
      `ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS priority text CHECK (priority IN (${CHECKED.map((l) => `'${l}'`).join(', ')}))`,
    );
    /* Emptied and refilled rather than appended to, so a second run leaves
       the same three rows and a test that counts them keeps working. */
    await client.query(`DELETE FROM ${TABLE}`);
    for (const [id, name, amount] of ROWS) {
      await client.query(`INSERT INTO ${TABLE} (id, name, amount) VALUES ($1, $2, $3)`, [id, name, amount]);
    }
    console.log(`seeded postgres: ${TABLE} (${ROWS.length} rows)`);
  } finally {
    await client.end();
  }
}

async function seedMysql(url: string): Promise<void> {
  const specifier = 'mysql2/promise';
  const mysql = (await import(specifier)) as {
    default?: { createConnection: (u: string) => Promise<MysqlLike> };
    createConnection?: (u: string) => Promise<MysqlLike>;
  };
  const createConnection = mysql.createConnection ?? mysql.default?.createConnection;
  if (!createConnection) throw new Error('Could not find createConnection in "mysql2".');
  const conn = await createConnection(url);
  try {
    await conn.query(`CREATE TABLE IF NOT EXISTS ${TABLE} (
      id int PRIMARY KEY,
      name varchar(40) NOT NULL,
      amount int,
      status enum(${ENUM_LABELS.map((l) => `'${l}'`).join(', ')}) NOT NULL DEFAULT 'draft'
    )`);
    await conn.query(`DELETE FROM ${TABLE}`);
    for (const [id, name, amount] of ROWS) {
      await conn.query(`INSERT INTO ${TABLE} (id, name, amount) VALUES (?, ?, ?)`, [id, name, amount]);
    }
    console.log(`seeded mysql: ${TABLE} (${ROWS.length} rows)`);
  } finally {
    await conn.end();
  }
}

const pgUrl = process.env.TABLEWALK_TEST_PG;
const mysqlUrl = process.env.TABLEWALK_TEST_MYSQL;

if (!pgUrl && !mysqlUrl) {
  console.error('Nothing to seed: set TABLEWALK_TEST_PG and/or TABLEWALK_TEST_MYSQL.');
  process.exit(1);
}
if (pgUrl) await seedPostgres(pgUrl);
if (mysqlUrl) await seedMysql(mysqlUrl);
