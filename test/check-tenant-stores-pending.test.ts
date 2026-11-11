/**
 * `mistri check` on a tenant App whose stores are not made yet. Its stores are attested as its tenants are enrolled,
 * which is the last thing its startup does: everything before it reads only the App and the schema. A field report
 * heard of eleven segment names that clash with a column only after `migrate up` had made the stores, although none
 * reads one, because validation was skipped whole while they were pending.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEPOT_TABLE, writeDepotApp } from './appApiCli.js';
import { mistri } from './support/bootstrapApp.js';

function depot(t: { after(fn: () => void): void }, segments?: Record<string, { query: string }>) {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-check-tenant-stores-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const business = join(directory, 'business.db');
  const written = writeDepotApp(directory, { business, authStore: join(directory, 'auth.db'), physical: 'physical_item' });
  /* The business table is there, as a migration made it; the stores are not. */
  const db = new DatabaseSync(business);
  db.exec(DEPOT_TABLE('physical_item'));
  db.close();
  if (segments) {
    const manifest = join(written.appDir, 'app.json');
    const app = JSON.parse(readFileSync(manifest, 'utf8')) as { resources: { item: Record<string, unknown> } };
    app.resources.item.segments = segments;
    writeFileSync(manifest, JSON.stringify(app));
  }
  const check = () =>
    mistri(['check', '--config', written.config, '--app', written.appDir, '--policy', written.policy, '--json'], directory, {
      XDG_CONFIG_HOME: join(directory, 'xdg'),
      MISTRI_OPEN: '0',
      BETTER_AUTH_SECRET: 'x'.repeat(40),
    });
  return { check };
}

interface Report {
  exit: number;
  steps: { step: string; status: string; detail: string }[];
  problems: { code: string; step: string; message: string; severity: string }[];
}

test("a tenant App's own problems are said while its stores are pending", (t) => {
  const run = depot(t, { name: { query: "name = 'North one'" } }).check();
  /* Before: exit 8, validation skipped, and the clash said only once the stores were made. */
  assert.equal(run.code, 4, run.said);
  const report = JSON.parse(run.stdout) as Report;
  assert.deepEqual(
    report.steps.filter((step) => step.step === 'validation' || step.step === 'stores').map((step) => `${step.step}:${step.status}`),
    ['validation:failed', 'stores:pending'],
  );
  const errors = report.problems.filter((found) => found.step === 'validation' && found.severity === 'error');
  assert.ok(
    errors.some((found) => /segments "name": the name is/.test(found.message)),
    JSON.stringify(errors),
  );
  assert.ok(!errors.some((found) => /Stores this App needs are absent/.test(found.message)), JSON.stringify(errors));
});

test('a tenant App with nothing wrong but its stores passes validation and exits 8 for the stores', (t) => {
  const run = depot(t).check();
  assert.equal(run.code, 8, run.said);
  const report = JSON.parse(run.stdout) as Report;
  const validation = report.steps.find((step) => step.step === 'validation');
  assert.equal(validation?.status, 'passed', run.stdout);
  assert.match(validation!.detail, /stores/);
  assert.ok(!report.problems.some((found) => found.severity === 'error' && found.step === 'validation'), run.stdout);
});
