import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { appProblems, loadApp } from '../packages/mistri/src/server/app/apps.js';
import { typesForSchema } from '../packages/mistri/src/server/typegen.js';
import { appCeilingWarnings, withRollups } from '../packages/mistri/src/shared/app.js';

test('CRM: TypeScript DSL matches its seeded schema and generated authoring types', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-crm-typescript-'));
  let adapter: SqliteAdapter | undefined;
  try {
    const file = join(directory, 'crm.db');
    execFileSync(process.execPath, [resolve('test/fixtures/databases/crm/make-crm-db.mjs'), file], {
      stdio: 'pipe',
      env: { ...process.env, MISTRI_CRM_TODAY: '2026-08-30' },
    });
    adapter = new SqliteAdapter(file);
    const schema = await adapter.introspect();
    const loaded = await loadApp(resolve('test/fixtures/apps/crm'));
    assert.ok(loaded.path.endsWith('/app.ts'));
    assert.deepEqual(appProblems(loaded, schema), []);
    assert.deepEqual(appCeilingWarnings(loaded.app, schema), []);
    assert.deepEqual(
      loaded.pages.map((page) => page.id),
      ['account', 'campaign', 'contact', 'lead', 'opportunity'],
    );
    // Each page is found by its file (pages/<key>.ts, a default export): app.ts lists none.
    assert.equal(loaded.sources.lead, resolve('test/fixtures/apps/crm/pages/lead.ts'));
    assert.deepEqual(
      loaded.pageFiles,
      ['account', 'campaign', 'contact', 'lead', 'opportunity'].map((key) => `pages/${key}.ts`),
    );
    assert.equal(
      readFileSync(resolve('test/fixtures/apps/crm/mistri-schema.d.ts'), 'utf8'),
      // The App's rollups are named with their table's columns (typegen.ts).
      typesForSchema({ ...withRollups(loaded.app, schema), label: 'crm' }),
      'Regenerate CRM types when its seeded schema changes',
    );
    execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', resolve('test/fixtures/apps/crm/tsconfig.json')], {
      stdio: 'pipe',
      timeout: 120_000,
    });
  } finally {
    await adapter?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
