#!/usr/bin/env node
/**
 * Seed one sample App's database into a data directory, once.
 *
 *   node examples/docker/seed.mjs <tick> <data-dir>
 *
 * This is the init step of each container in docker-compose.yml, and it is
 * the reason a restart is safe: the public seeds under examples/databases
 * refuse an existing target, which is the right behaviour for a person
 * choosing a path and the wrong one for a container that comes back up with
 * its volume already populated. So the gate is the connection config each
 * seed leaves behind — present means seeded, and the whole step is skipped.
 *
 * The one line written to stdout is the config path, which start.sh hands
 * to the server as --config. Everything else goes to stderr so that a seed's
 * own chatter cannot be mistaken for it.
 *
 * Nothing here is Docker-specific: the same command against a checkout and
 * a temp directory is how the compose setup was proved without a daemon.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const databases = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'databases');
const log = (line) => process.stderr.write(`${line}\n`);

/* Tick already writes `<db>.json` beside the file with a writable
   connection; there is nothing to add. */
async function seedSmall(app, data) {
  const file = join(data, `${app}.db`);
  const config = `${file}.json`;
  if (existsSync(config)) return config;
  const { seed } = await import(join(databases, app, 'seed.mjs'));
  seed(file);
  log(`Seeded ${file}`);
  return config;
}

const [app, dir] = process.argv.slice(2);
if (!app || !dir || process.argv.length !== 4) {
  throw new Error('Usage: node examples/docker/seed.mjs <tick> <data-dir>');
}
const data = resolve(dir);
if (!existsSync(data)) throw new Error(`${data} does not exist. It is the mounted data directory, not something to create here.`);
const seeders = {
  tick: () => seedSmall('tick', data),
};
const run = seeders[app];
if (!run) throw new Error(`Unknown sample "${app}". One of: ${Object.keys(seeders).join(', ')}.`);
process.stdout.write(`${await run()}\n`);
