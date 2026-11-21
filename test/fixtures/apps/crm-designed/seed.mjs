/**
 * The crm-designed fixture's database: the Compass CRM seed, dated from today so its windows hold rows, with the
 * connection `e2e/crm-designed.spec.ts` serves it by.
 *
 *   node --import tsx test/fixtures/apps/crm-designed/seed.mjs <new-file.db>
 *
 * Writes the database and `<file>.json`, a connection named `crm`. Refuses an existing file.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const file = resolve(process.argv[2] ?? '');
if (!process.argv[2] || existsSync(file)) throw new Error('Give a new database file to create.');
execFileSync(process.execPath, [resolve(dirname(fileURLToPath(import.meta.url)), '../../databases/crm/make-crm-db.mjs'), file], {
  stdio: 'pipe',
});
writeFileSync(`${file}.json`, `${JSON.stringify({ connections: [{ name: 'crm', url: file }] }, null, 2)}\n`);
