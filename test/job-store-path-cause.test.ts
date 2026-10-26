/**
 * Field report TR8: a job store's database at a wrong path was told as "Job
 * storage or policy could not be verified" alone, which sent the App's author
 * to the store's layout. The fixed sentence stays (a caller hears nothing
 * more), and the reason under it — the path that is not there, a directory,
 * foreign keys off — is what the operator's startup headline says.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openSqliteJobStore } from '../packages/mistri/src/adapters/jobs/jobStore.js';
import { assertSqliteJobStore, provisionSqliteJobStore } from '../packages/mistri/src/adapters/jobs/jobStoreSchema.js';
import { refusalHeadline } from '../packages/engine/src/shared/refusal.js';

const refused = (run: () => unknown): Error => {
  try {
    run();
  } catch (error) {
    assert.match((error as Error).message, /^Job storage or policy could not be verified/);
    return error as Error;
  }
  return assert.fail('expected a refusal');
};

test('a job store at a wrong path, or at a directory, says so beneath its fixed sentence', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-job-store-path-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const missing = join(directory, 'nowhere', 'ops.db');
  assert.match(refusalHeadline(refused(() => openSqliteJobStore(missing, { namespace: 'spoke' }))), /does not exist/);
  assert.match(refusalHeadline(refused(() => provisionSqliteJobStore(missing, { namespace: 'spoke' }))), /does not exist/);
  assert.match(refusalHeadline(refused(() => openSqliteJobStore(directory, { namespace: 'spoke' }))), /is not a file/);

  const path = join(directory, 'ops.db');
  new DatabaseSync(path).close();
  provisionSqliteJobStore(path, { namespace: 'spoke' });
  const off = new DatabaseSync(path, { enableForeignKeyConstraints: false });
  t.after(() => off.close());
  assert.match(refusalHeadline(refused(() => assertSqliteJobStore(off, { namespace: 'spoke' } as never))), /foreign keys off/);
});
