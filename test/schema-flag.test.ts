/**
 * `--schema` by its effect on PostgreSQL: the catalog the start reads is the named schema's, and another schema's
 * tables are not in it. Over a database of the test's own, beside TABLEWALK_TEST_PG.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { liveSkip } from './live.js';
import { pgClient, uuidPostgresDatabase } from './support/tenantDialects.js';

test(
  '--schema reads the schema it names, and not the one beside it',
  { skip: liveSkip('postgres', process.env.TABLEWALK_TEST_PG) },
  async () => {
    const owned = await uuidPostgresDatabase('schema_flag');
    const xdg = mkdtempSync(join(tmpdir(), 'tablewalk-schema-flag-'));
    try {
      const client = await pgClient(owned.url);
      try {
        await client.query(`CREATE SCHEMA ledger; CREATE TABLE ledger.invoice (id integer PRIMARY KEY, total numeric);
        CREATE SCHEMA crm; CREATE TABLE crm.contact (id integer PRIMARY KEY, name text);`);
      } finally {
        await client.end();
      }
      const exported = (...schemas: string[]) =>
        spawnSync(
          process.execPath,
          [
            '--import',
            'tsx',
            'packages/mistri/src/server/index.ts',
            '--no-config',
            '--db',
            owned.url,
            ...schemas.flatMap((name) => ['--schema', name]),
            '--export',
            'brief',
          ],
          { encoding: 'utf8', env: { ...process.env, XDG_CONFIG_HOME: xdg, MISTRI_OPEN: '0' } },
        );
      const ledger = exported('ledger');
      assert.equal(ledger.status, 0, ledger.stderr);
      assert.match(ledger.stdout, /invoice/);
      assert.doesNotMatch(ledger.stdout, /contact/);
      // Repeatable: both named, both read.
      const both = exported('ledger', 'crm');
      assert.equal(both.status, 0, both.stderr);
      assert.match(both.stdout, /invoice/);
      assert.match(both.stdout, /contact/);
    } finally {
      rmSync(xdg, { recursive: true, force: true });
      await owned.drop();
    }
  },
);
