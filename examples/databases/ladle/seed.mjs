/**
 * Ladle's cooking school on SQLite: its classes and bookings in a new file, and `<file>.json`, a writable connection
 * named `ladle`. Then it provisions the stores the App uses (its sign-in and its command journal), as
 * `mistri migrate stores up --app …` does. Refuses an existing file or config.
 *
 *   node examples/databases/ladle/seed.mjs <new-file.db>
 *
 * From an installed package, with the App copied out of node_modules (Node strips no types there):
 *   LADLE_APP=./ladle node node_modules/@mistriwork/mistri/examples/databases/ladle/seed.mjs <new-file.db>
 *
 * The schedule is counted from today in Chicago, or from `LADLE_TODAY=YYYY-MM-DD`, which makes the same file every time.
 */
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const USAGE = 'Usage: node examples/databases/ladle/seed.mjs <new-database-path>';
export const APP = process.env.LADLE_APP
  ? `${resolve(process.env.LADLE_APP)}/`
  : fileURLToPath(new URL('../../apps/ladle/', import.meta.url));

/** `mistri migrate stores up` for the App, as the package's own CLI runs it. */
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
  const result = spawnSync(process.execPath, [...cli, 'migrate', 'stores', 'up', '--app', APP, '--config', config], {
    encoding: 'utf8',
    env: { ...process.env, ...(built ? {} : { TSX_TSCONFIG_PATH: join(root, '../../tsconfig.json') }) },
  });
  if (result.status !== 0) throw new Error(`Provisioning the App's stores failed:\n${result.stdout}${result.stderr}`);
}

/* The school's classes, by the day they fall on counted from the seed's today, so the schedule is always ahead of
   whoever seeds it. One is tonight, for the check-in page; one was last week, already taught. */
const CLASSES = [
  [1, 'Knife skills for weeknights', 'Basics', 'Rosa Delgado', -7, '18:30', 12, 65],
  [2, 'Fresh pasta by hand', 'Italian', 'Marco Bellini', 0, '18:30', 10, 85],
  [3, 'Dumplings from scratch', 'Chinese', 'Grace Lin', 2, '18:00', 12, 75],
  [4, 'Sourdough, start to loaf', 'Baking', 'Hannah Okafor', 4, '10:00', 8, 95],
  [5, 'Tacos al pastor', 'Mexican', 'Rosa Delgado', 6, '18:30', 14, 70],
  [6, 'Weekend brunch', 'Basics', 'Hannah Okafor', 9, '10:30', 12, 60],
  [7, 'Curry from the spice box', 'Indian', 'Priya Raman', 11, '18:00', 12, 80],
  [8, 'Knife skills for weeknights', 'Basics', 'Rosa Delgado', 14, '18:30', 12, 65],
  [9, 'French pastry: choux', 'Baking', 'Hannah Okafor', 18, '10:00', 8, 110],
];

/* Who booked what: [class, guest, party size, status]. Tonight's pasta class is nearly full and nobody has arrived. */
const BOOKINGS = [
  [1, 'Avery Brooks', 2, 'checked_in'],
  [1, 'Jordan Kim', 1, 'checked_in'],
  [1, 'Sam Patel', 1, 'cancelled'],
  [2, 'Morgan Lee', 2, 'booked'],
  [2, 'Taylor Nguyen', 1, 'booked'],
  [2, 'Casey Romero', 3, 'booked'],
  [2, 'Riley Chen', 2, 'booked'],
  [2, 'Jamie Foster', 1, 'cancelled'],
  [3, 'Drew Wallace', 2, 'booked'],
  [3, 'Quinn Harper', 1, 'booked'],
  [4, 'Skyler Adams', 1, 'booked'],
  [4, 'Parker Ellis', 2, 'booked'],
  [4, 'Reese Morgan', 4, 'booked'],
  [5, 'Alex Rivera', 2, 'booked'],
  [6, 'Cameron Diaz-Ortiz', 2, 'booked'],
  [6, 'Hayden Brooks', 1, 'booked'],
  [7, 'Emerson Gray', 2, 'booked'],
  [9, 'Rowan Price', 1, 'booked'],
  [9, 'Logan Hayes', 2, 'booked'],
];

/* Today in Chicago, the App's `ui.timezone`: "tonight" is the school's evening, not UTC's. */
const SCHOOL_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' });

/** `YYYY-MM-DD` for `today` moved by `days`. */
const dayFrom = (today, days) => {
  const date = new Date(`${today}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

/**
 * Create the school's classes and bookings and a writable connection config, `<file>.json`, naming it `ladle`.
 * `today` (YYYY-MM-DD, default LADLE_TODAY or the day in Chicago) is the day the schedule is counted from; `stores: false`
 * leaves the App's stores unprovisioned, for a test that needs only the rows.
 */
export function seed(file, { today = process.env.LADLE_TODAY ?? SCHOOL_DAY.format(new Date()), stores = true } = {}) {
  if (typeof file !== 'string' || !file || file.startsWith('--')) throw new Error(USAGE);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error(`LADLE_TODAY must be a day, YYYY-MM-DD: ${today}`);
  file = resolve(file);
  const config = `${file}.json`;
  if ([file, config].some((path) => lstatSync(path, { throwIfNoEntry: false }))) {
    throw new Error(`Refusing to replace ${file} or its config. Choose a new database path.`);
  }
  mkdirSync(dirname(file), { recursive: true });
  // Exclusive reservations also refuse files/symlinks created after preflight.
  const configFd = openSync(config, 'wx', 0o600);
  try {
    closeSync(openSync(file, 'wx', 0o600));
    const db = new DatabaseSync(file);
    try {
      db.exec(`
        BEGIN;
        CREATE TABLE class_session (
          id INTEGER PRIMARY KEY,
          title TEXT NOT NULL CHECK (length(trim(title)) > 0),
          cuisine TEXT NOT NULL,
          chef TEXT NOT NULL,
          starts_at DATETIME NOT NULL,
          seats INTEGER NOT NULL CHECK (seats > 0),
          price NUMERIC NOT NULL CHECK (price >= 0),
          status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled'))
        );
        CREATE TABLE booking (
          id INTEGER PRIMARY KEY,
          class_session_id INTEGER NOT NULL REFERENCES class_session (id),
          guest_name TEXT NOT NULL CHECK (length(trim(guest_name)) > 0),
          email TEXT NOT NULL,
          party_size INTEGER NOT NULL DEFAULT 1 CHECK (party_size BETWEEN 1 AND 6),
          status TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'checked_in', 'cancelled')),
          booked_at DATETIME NOT NULL,
          checked_in_at DATETIME
        );
        CREATE INDEX booking_class ON booking (class_session_id);
      `);
      const addClass = db.prepare(
        'INSERT INTO class_session (id, title, cuisine, chef, starts_at, seats, price) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      for (const [id, title, cuisine, chef, days, time, seats, price] of CLASSES) {
        addClass.run(id, title, cuisine, chef, `${dayFrom(today, days)} ${time}:00`, seats, price);
      }
      const addBooking = db.prepare(
        'INSERT INTO booking (class_session_id, guest_name, email, party_size, status, booked_at, checked_in_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      BOOKINGS.forEach(([classId, guest, party, status], i) => {
        const [, , , , days, time] = CLASSES[classId - 1];
        const email = `${guest.toLowerCase().replace(/[^a-z]+/g, '.')}@example.com`;
        const booked = `${dayFrom(today, Math.min(days, 0) - 10 + (i % 5))} 09:${String(10 + i).padStart(2, '0')}:00`;
        const arrived = status === 'checked_in' ? `${dayFrom(today, days)} ${time}:00` : null;
        addBooking.run(classId, guest, email, party, status, booked, arrived);
      });
      db.exec('COMMIT');
    } finally {
      db.close();
    }
    writeFileSync(configFd, `${JSON.stringify({ connections: [{ name: 'ladle', url: file, writable: true }] }, null, 2)}\n`);
  } finally {
    closeSync(configFd);
  }
  if (stores) provisionStores(config);
  return file;
}

// Importing the setup module is inert; only explicit CLI execution seeds data.
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 3) throw new Error(USAGE);
  const file = seed(process.argv[2]);
  console.log(`Seeded ${file}\nWritable config: ${file}.json`);
}
