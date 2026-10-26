/**
 * The store-layout fixtures under test/fixtures/store-layouts/<store>/<engine>/v<N>.sql
 * (test/store-upgrades.test.ts holds the check, storeLayouts.ts the registry).
 *
 *   node --import tsx scripts/store-layouts.mjs --write           the version this build expects, per store and engine
 *
 * Needs TABLEWALK_TEST_PG for PostgreSQL (a role that may create databases)
 * and pg_dump on the PATH (or PG_DUMP). Without PostgreSQL only SQLite is written.
 * A changed layout is a new version with an upgrade step, and the old fixture
 * stays: change `--write`'s output only by bumping the store's version.
 */
import { relative } from 'node:path';

if (!process.argv.includes('--write')) {
  console.error('usage: node --import tsx scripts/store-layouts.mjs --write');
  process.exit(1);
}
const { writeFixtures } = await import('../test/support/storeLayoutsWrite.ts');
const written = await writeFixtures();
for (const path of written) console.log(`wrote ${relative(process.cwd(), path)}`);
console.log(`${written.length} fixture${written.length === 1 ? '' : 's'} written.`);
