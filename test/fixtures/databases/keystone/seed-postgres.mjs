/**
 * Keystone into an empty PostgreSQL database: the schema (schema.sql), the
 * rows fixture.mjs draws, the vehicles' studio photos, and the stores every
 * Keystone App shares — the command journal, record history and the inbox —
 * and the lender's event, job and workflow stores.
 * Then it writes `<config>`, naming the connection `keystone`, writable.
 *
 *   node --import tsx test/fixtures/databases/keystone/seed-postgres.mjs <empty-postgres-url> <new-config.json> [--photos featured|all|none]
 *
 * The day is today (UTC), or `KEYSTONE_TODAY=YYYY-MM-DD`: every date is
 * counted back from it, so two runs on one day — or with the same
 * KEYSTONE_TODAY — write the same rows. Photos are drawn by Forecourt's
 * renderer (../forecourt/photos.mjs): `featured` (the default) gives each
 * dealer's four featured listings three angles; `all` also gives every other
 * listed or pending vehicle one; `none` draws nothing.
 *
 * It requires an empty `public` schema and never drops or replaces anything.
 * It does not provision /leads' tenant store or make any account: those
 * belong to the Apps (SUITE.md, "Provisioning"), and an intake address is
 * random by design, so the seed leaves every dealer's empty.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migratePostgresCommandJournal } from '@mistriwork/mistri/maintenance';
import { provisionStores } from '@mistriwork/mistri/maintenance';
import lenderCommands from '../../apps/keystone/lender/commands.ts';
import lenderJobs from '../../apps/keystone/lender/server/jobs.ts';
import { buildKeystone } from './fixture.mjs';
import { renderPhotoSet } from '../forecourt/photos.mjs';

const args = process.argv.slice(2);
const flag = args.indexOf('--photos');
const photos = flag === -1 ? 'featured' : args[flag + 1];
const [url, config] = args.filter((_, i) => flag === -1 || (i !== flag && i !== flag + 1));
if (!url || !config || !['featured', 'all', 'none'].includes(photos)) {
  console.error(
    'Usage: node --import tsx test/fixtures/databases/keystone/seed-postgres.mjs <empty-postgres-url> <new-config.json> [--photos featured|all|none]',
  );
  process.exit(1);
}
if (existsSync(resolve(config))) throw new Error(`Refusing to replace ${config}. Choose a new config path.`);
const today = process.env.KEYSTONE_TODAY ?? new Date().toISOString().slice(0, 10);
const here = dirname(fileURLToPath(import.meta.url));
const { tables } = buildKeystone(today);

/* The renderer's body shapes, and three angles a featured car is shot from. */
const SHAPE = { sedan: 'saloon', suv: 'suv', truck: 'pickup', coupe: 'coupe', hatchback: 'hatchback', wagon: 'estate', van: 'van' };
const ANGLES = [
  ['three-quarter', 'Front three-quarter'],
  ['side', 'Profile'],
  ['rear-quarter', 'Rear three-quarter'],
];
const LIGHTS = ['studio', 'warm', 'cool', 'studio', 'graphite'];
function photoRows(vehicles) {
  if (photos === 'none') return [];
  const cache = new Map();
  const rows = [];
  const dealers = [...new Set(vehicles.map((v) => v.dealer_id))];
  for (const v of vehicles) {
    const shots =
      v.featured && v.status === 'listed'
        ? ANGLES
        : photos === 'all' && (v.status === 'listed' || v.status === 'pending')
          ? ANGLES.slice(0, 1)
          : [];
    shots.forEach(([angle, caption], i) => {
      const lighting = LIGHTS[dealers.indexOf(v.dealer_id) % LIGHTS.length];
      const key = `${v.body}/${v.exterior_color}/${angle}/${lighting}`;
      if (!cache.has(key)) cache.set(key, renderPhotoSet({ body: SHAPE[v.body], colour: v.exterior_color, angle, lighting }));
      const { photo, thumb } = cache.get(key);
      rows.push({
        id: `${v.id}-${i + 1}`,
        dealer_id: v.dealer_id,
        vehicle_id: v.id,
        position: i + 1,
        caption: `${caption}, ${v.year} ${v.make} ${v.model}`,
        file_name: `${v.id}-${i + 1}.png`,
        content_type: 'image/png',
        byte_size: photo.byteLength,
        data: photo,
        thumbnail: thumb,
      });
    });
  }
  return rows;
}
const vehicles = tables.find(([name]) => name === 'vehicle')[1];
tables.splice(tables.findIndex(([name]) => name === 'vehicle') + 1, 0, ['vehicle_photo', photoRows(vehicles)]);

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query('begin');
  await client.query("SET LOCAL lock_timeout = '5s'");
  const lock = await client.query("SELECT pg_try_advisory_xact_lock(hashtext('tablewalk/keystone/public')) AS acquired");
  if (!lock.rows[0]?.acquired) throw new Error('Another Keystone seed is already running.');
  const namespace = await client.query("SELECT oid FROM pg_namespace WHERE nspname = 'public'");
  if (!namespace.rows.length) throw new Error('The public schema must exist before seeding.');
  const existing = await client.query(
    `SELECT 1 FROM pg_class WHERE relnamespace=$1
    UNION ALL SELECT 1 FROM pg_proc WHERE pronamespace=$1
    UNION ALL SELECT 1 FROM pg_type WHERE typnamespace=$1 LIMIT 1`,
    [namespace.rows[0].oid],
  );
  if (existing.rows.length) throw new Error('Refusing to seed: the public schema is not empty.');
  await client.query('SET LOCAL search_path = public, pg_catalog');
  await client.query(readFileSync(join(here, 'schema.sql'), 'utf8'));
  const identity = new Set(
    (
      await client.query(
        "SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'id' AND is_identity = 'YES'",
      )
    ).rows.map((row) => row.table_name),
  );
  for (const [name, rows] of tables) {
    if (rows.length) {
      const cols = Object.keys(rows[0]);
      // Many rows a statement, inside PostgreSQL's 65,535 parameters.
      const per = Math.max(1, Math.floor(60000 / cols.length));
      for (let at = 0; at < rows.length; at += per) {
        const batch = rows.slice(at, at + per),
          values = [];
        const tuples = batch.map(
          (row, r) =>
            `(${cols
              .map((c, i) => {
                values.push(row[c]);
                return `$${r * cols.length + i + 1}`;
              })
              .join(', ')})`,
        );
        await client.query(
          `INSERT INTO ${name} (${cols.join(', ')})${identity.has(name) ? ' OVERRIDING SYSTEM VALUE' : ''} VALUES ${tuples.join(', ')}`,
          values,
        );
      }
    }
    if (identity.has(name)) {
      await client.query(`SELECT setval(pg_get_serial_sequence('${name}', 'id'), coalesce((SELECT max(id) FROM ${name}), 0) + 1, false)`);
    }
    console.log(`${name.padEnd(20)} ${rows.length}`);
  }
  await client.query('ANALYZE');
  await client.query('commit');
} catch (error) {
  await client.query('rollback').catch(() => {});
  throw error;
} finally {
  await client.end();
}
// The stores every Keystone App shares, each keyed by App where it needs to be.
await migratePostgresCommandJournal(url);
await provisionStores({ postgres: url }, { only: ['record-history', 'inbox'] });
// The lender's commands record facts, and its credit decision runs on them: the event store, the job store and the workflow store it names.
await provisionStores(
  { postgres: url },
  {
    app: {
      id: 'lender',
      commands: lenderCommands,
      lock: readFileSync(new URL('../../apps/keystone/lender/authority.lock', import.meta.url), 'utf8'),
    },
    jobs: lenderJobs,
  },
);
writeFileSync(resolve(config), `${JSON.stringify({ connections: [{ name: 'keystone', url, writable: true }] }, null, 2)}\n`, {
  flag: 'wx',
});
console.log(`\nSeeded Keystone for ${today} (photos: ${photos}); wrote ${config}.`);
