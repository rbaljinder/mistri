/**
 * Foundry Market on SQLite: curated vintage workshops, listings, studio photographs, and consignment
 * submissions in a new file, plus `<file>.json`, a writable connection named `foundry`. Then it
 * provisions the stores the App uses (sign-in and command journal), as `mistri migrate stores up` does.
 * Refuses an existing file or config.
 *
 *   node examples/databases/foundry/seed.mjs <new-file.db>
 *
 * From an installed package, with the App copied out of node_modules (Node strips no types there):
 *   FOUNDRY_APP=./foundry node node_modules/@mistriwork/mistri/examples/databases/foundry/seed.mjs <new-file.db>
 */
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const USAGE = 'Usage: node examples/databases/foundry/seed.mjs <new-database-path>';
export const APP = process.env.FOUNDRY_APP
  ? `${resolve(process.env.FOUNDRY_APP)}/`
  : fileURLToPath(new URL('../../apps/foundry/', import.meta.url));
const PHOTOS_DIR = fileURLToPath(new URL('./photos/', import.meta.url));

/** `mistri migrate stores up` for the App, as the package's own CLI runs it. */
export function provisionStores(config) {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve('@mistriwork/mistri/package.json'));
  const source = join(root, 'src/server/index.ts');
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

const SELLERS = [
  [
    1,
    'Wetzlar & Co. Optics',
    'Portland, OR',
    'Cameras & Optics',
    1,
    'Specialist mechanical rangefinder workshop servicing 1950s–70s German optics.',
  ],
  [
    2,
    'Nordic Atelier Studio',
    'Seattle, WA',
    'Mid-Century Furniture',
    1,
    'Curated Danish and Swedish seating, lighting, and case goods restored with natural oils.',
  ],
  [
    3,
    'Sonora Hi-Fi Lab',
    'San Francisco, CA',
    'Analog Audio',
    1,
    'Bench-calibrated vintage turntables, receivers, and Braun industrial audio.',
  ],
];

const LISTINGS = [
  [
    1,
    '1958 Leica M3 Double Stroke + 50mm Summicron',
    'Ernst Leitz Wetzlar',
    'Cameras',
    1958,
    'Collector Grade',
    'Portland, OR',
    385000,
    420000,
    'live',
    1,
    'Freshly serviced double-stroke M3 paired with the rigid 50mm f/2 Summicron. Rangefinder patch is bright and high-contrast; all shutter speeds accurate from 1s to 1/1000s.',
    'Single-owner Portland darkroom estate. Full CLA completed October 2026 with bench test sheet.',
  ],
  [
    2,
    'Walnut & Cognac Leather Lounge Chair',
    'Soren Lindholm',
    'Furniture',
    1964,
    'Restored',
    'Seattle, WA',
    265000,
    295000,
    'live',
    2,
    'Sculpted solid walnut frame with newly hand-stitched vegetable-tanned cognac aniline leather cushions. Gentle patina on armrests and pegged joinery throughout.',
    'Sourced from a Bellevue mid-century architectural residence. Re-oiled and inspected in Seattle.',
  ],
  [
    3,
    'Braun Atelier Walnut Plinth Turntable',
    'Braun AG',
    'Audio',
    1966,
    'Mint Serviced',
    'San Francisco, CA',
    189000,
    null,
    'live',
    3,
    'Iconic Dieter Rams era belt-drive deck with brushed aluminum top plate, solid walnut surround, and original acrylic dust cover. New belt, lubricated bearing, and Shure cartridge.',
    'Calibrated on Sonora Hi-Fi Lab test bench. Wow & flutter measured under 0.08%.',
  ],
  [
    4,
    'Scandinavian Brushed Brass & Opal Glass Lamp',
    'Fog & Morup',
    'Lighting',
    1968,
    'Excellent',
    'Seattle, WA',
    94000,
    110000,
    'live',
    2,
    'Hand-blown cased opal glass dome floating atop a spun brushed-brass tulip base. Rewired with twisted linen cord and inline solid-brass rotary dimmer.',
    'Imported from Copenhagen design archive; UL-listed socket upgrade completed.',
  ],
  [
    5,
    'Danish Sculptural Teak & Walnut Credenza',
    'H.P. Hansen',
    'Furniture',
    1962,
    'Restored',
    'Seattle, WA',
    445000,
    490000,
    'live',
    2,
    'Six-foot tambour and hinged-door credenza with recessed solid teak pulls, adjustable interior trays, and tapered solid legs. Deep book-matched grain across the facade.',
    'Original maker stamp preserved on back panel; finished in three coats of Danish oil.',
  ],
  [
    6,
    '1974 Silver-Face Integrated Stereo Amplifier',
    'Luxman',
    'Audio',
    1974,
    'Mint Serviced',
    'San Francisco, CA',
    215000,
    240000,
    'live',
    3,
    'Warm analog dual-VU meter integrated amplifier with machined aluminum fascia, stepped attenuator, and dual phono stages. Recapped power supply and bias-aligned.',
    'Original walnut sleeve intact; 6-month bench warranty from Sonora Hi-Fi Lab.',
  ],
];

const PHOTOS = [
  [
    1,
    1,
    '1958 Leica M3 Double Stroke three-quarter studio view',
    'Three-quarter view showing satin chrome finish and rigid 50mm Summicron.',
    'leica-m3-hero.jpg',
  ],
  [
    1,
    2,
    'Leica M3 top plate engraving and shutter speed dial',
    'Crisp top-plate engraving, double-stroke advance lever, and frame counter.',
    'leica-m3-top.jpg',
  ],
  [
    1,
    3,
    '50mm f/2 Summicron optical glass and aperture ring closeup',
    'Clean front element with smooth aperture detents and original Leica filter thread.',
    'leica-m3-lens.jpg',
  ],
  [
    2,
    1,
    'Walnut and cognac leather lounge chair in sunlit studio',
    'Hand-stitched cognac leather cushions on sculpted solid walnut frame.',
    'lounge-chair.jpg',
  ],
  [
    3,
    1,
    'Braun Atelier walnut plinth turntable with dust cover',
    'Brushed aluminum deck with original walnut plinth and hinged dust cover.',
    'braun-turntable.jpg',
  ],
  [
    4,
    1,
    'Brushed brass and opal glass mid-century table lamp glowing',
    'Warm diffused glow through cased opal glass on spun brass stem.',
    'brass-lamp.jpg',
  ],
  [
    5,
    1,
    'Danish mid-century teak and walnut credenza in minimalist gallery',
    'Book-matched teak facade with sculpted pulls and tapered legs.',
    'walnut-credenza.jpg',
  ],
  [
    6,
    1,
    '1974 vintage silver-face stereo amplifier with warm VU meters',
    'Dual illuminated VU meters and machined aluminum control fascia.',
    'silver-amplifier.jpg',
  ],
];

/** Create Foundry Market's database at `target` and `<target>.json` beside it; refuses existing files. */
export function seed(target, { stores = true } = {}) {
  const file = resolve(target);
  const config = `${file}.json`;
  for (const path of [file, config]) {
    if (existsSync(path)) throw new Error(`Refusing to overwrite existing file: ${path}`);
    try {
      lstatSync(path);
      throw new Error(`Refusing to overwrite existing path: ${path}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  mkdirSync(dirname(file), { recursive: true });
  const configFd = openSync(config, 'wx', 0o600);
  try {
    closeSync(openSync(file, 'wx', 0o600));
    const db = new DatabaseSync(file);
    try {
      db.exec(`
        BEGIN;
        CREATE TABLE seller (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          city TEXT NOT NULL,
          specialty TEXT NOT NULL,
          verified INTEGER NOT NULL DEFAULT 1,
          bio TEXT NOT NULL
        );
        CREATE TABLE listing (
          id INTEGER PRIMARY KEY,
          title TEXT NOT NULL,
          maker TEXT NOT NULL,
          category TEXT NOT NULL,
          year_made INTEGER NOT NULL,
          condition TEXT NOT NULL,
          city TEXT NOT NULL,
          price_cents INTEGER NOT NULL,
          was_price_cents INTEGER,
          status TEXT NOT NULL DEFAULT 'live',
          seller_id INTEGER NOT NULL REFERENCES seller(id),
          description TEXT NOT NULL,
          provenance TEXT NOT NULL,
          buyer_name TEXT,
          buyer_email TEXT
        );
        CREATE TABLE listing_photo (
          id INTEGER PRIMARY KEY,
          listing_id INTEGER NOT NULL REFERENCES listing(id) ON DELETE CASCADE,
          position INTEGER NOT NULL DEFAULT 1,
          alt TEXT NOT NULL,
          caption TEXT,
          content BLOB NOT NULL,
          filename TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          size_bytes INTEGER NOT NULL
        );
        CREATE TABLE consignment (
          id INTEGER PRIMARY KEY,
          seller_name TEXT NOT NULL,
          seller_email TEXT NOT NULL,
          item_title TEXT NOT NULL,
          category TEXT NOT NULL,
          asking_cents INTEGER NOT NULL,
          notes TEXT,
          status TEXT NOT NULL DEFAULT 'new'
        );
        CREATE INDEX listing_photo_listing ON listing_photo (listing_id, position);
      `);
      const addSeller = db.prepare('INSERT INTO seller (id, name, city, specialty, verified, bio) VALUES (?, ?, ?, ?, ?, ?)');
      for (const row of SELLERS) addSeller.run(...row);

      const addListing = db.prepare(`
        INSERT INTO listing
          (id, title, maker, category, year_made, condition, city, price_cents, was_price_cents, status, seller_id, description, provenance)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of LISTINGS) addListing.run(...row);

      const addPhoto = db.prepare(`
        INSERT INTO listing_photo (listing_id, position, alt, caption, content, filename, mime_type, size_bytes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const [listingId, pos, alt, caption, filename] of PHOTOS) {
        const bytes = readFileSync(join(PHOTOS_DIR, filename));
        addPhoto.run(listingId, pos, alt, caption, bytes, filename, 'image/jpeg', bytes.byteLength);
      }
      db.exec('COMMIT');
    } finally {
      db.close();
    }
    writeFileSync(configFd, `${JSON.stringify({ connections: [{ name: 'foundry', url: file, writable: true }] }, null, 2)}\n`);
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
