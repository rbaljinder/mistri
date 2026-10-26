import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { appProblems, loadApp } from '../packages/mistri/src/server/app/apps.js';
import { appCeilingWarnings } from '../packages/mistri/src/shared/app.js';
import { typesForSchema } from '../packages/mistri/src/server/typegen.js';
import { textToBreakdown } from '../packages/engine/src/shared/breakdowntext.js';
import { compileBreakdown } from '../packages/engine/src/shared/breakdown.js';
import { POSTGRES_STYLE } from '../packages/engine/src/adapters/adapter.js';

for (const name of ['relay', 'thread', 'service-desk']) {
  test(`${name}: seeded schema satisfies its real manifest and all record pages`, async () => {
    const directory = mkdtempSync(join(tmpdir(), `tablewalk-${name}-`));
    const file = join(directory, 'fixture.db');
    let adapter: SqliteAdapter | undefined;
    try {
      const appDirectory = resolve('test/fixtures/apps', name);
      const script = name === 'thread' ? resolve('test/fixtures/databases/thread/seed.mjs') : join(appDirectory, 'seed.mjs');
      execFileSync(process.execPath, [script, file]);
      adapter = new SqliteAdapter(file);
      const schema = await adapter.introspect();
      const loaded = await loadApp(appDirectory);
      assert.deepEqual(appProblems(loaded, schema), []);
      assert.ok(loaded.pages.length > 0);
      assert.deepEqual(appCeilingWarnings(loaded.app, schema), []);
      if (name === 'service-desk') {
        assert.ok(loaded.path.endsWith('/app.ts'));
        assert.equal(loaded.pages.length, 9);
        const operations = Object.values(loaded.app.views).find((view) => 'sections' in view && view.label === 'Operations');
        assert.ok(operations && 'sections' in operations);
        // A chart declares no order (the query holds conditions only); the query bar's `sort` clause is what puts the days in sequence.
        const trend = operations.sections.find((section) => section.title === 'Incidents opened by day (all time)');
        assert.ok(trend);
        const parsed = textToBreakdown(schema, `${trend.table} ${trend.query ?? ''} count by ${trend.by} sort opened_day asc`);
        assert.deepEqual(parsed.errors, []);
        assert.ok(parsed.breakdown);
        assert.deepEqual(parsed.breakdown.orderBy, [{ name: 'opened_day', direction: 'asc' }]);
        const sql = compileBreakdown({ ...schema, dialect: 'postgres' }, parsed.breakdown, POSTGRES_STYLE).text;
        assert.match(sql, /ORDER BY "opened_day" ASC/);
        const result = await adapter.runBreakdown(parsed.breakdown);
        assert.deepEqual(
          result.rows.map((row) => row.opened_day),
          ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05'],
        );
        assert.equal(
          readFileSync(resolve('test/fixtures/apps/service-desk/mistri-schema.d.ts'), 'utf8'),
          typesForSchema({ ...schema, label: 'service-desk' }),
          'Regenerate Service Atlas types when its seeded schema changes',
        );
        execFileSync(
          process.execPath,
          [resolve('node_modules/typescript/bin/tsc'), '-p', resolve('test/fixtures/apps/service-desk/tsconfig.json')],
          { stdio: 'pipe', timeout: 120_000 },
        );
      }
      const before = readFileSync(file);
      assert.throws(() => execFileSync(process.execPath, [script, file], { stdio: 'pipe' }), /Refusing to replace/);
      assert.deepEqual(readFileSync(file), before);
      const reserved = join(directory, 'reserved.db');
      writeFileSync(`${reserved}.json`, 'keep');
      assert.throws(() => execFileSync(process.execPath, [script, reserved], { stdio: 'pipe' }), /Refusing to replace/);
      assert.equal(existsSync(reserved), false);
      assert.equal(readFileSync(`${reserved}.json`, 'utf8'), 'keep');
    } finally {
      await adapter?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
