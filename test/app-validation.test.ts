import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { authorizeTransaction } from '../packages/mistri/src/server/app/appAccess.js';
import { compileAppValidation } from '../packages/mistri/src/server/app/appValidation.js';
import { AppValidationDenied } from '../packages/mistri/src/server/app/appValidationDenied.js';

function fixture(
  sql = `CREATE TABLE task (id INTEGER PRIMARY KEY, name TEXT, state TEXT DEFAULT 'new');
    INSERT INTO task (name) VALUES ('first');`,
) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-app-validation-'));
  const file = join(directory, 'validation.db');
  const db = new DatabaseSync(file);
  db.exec(sql);
  db.close();
  return { directory, file };
}

test('root App validation checks the stored post-image and rolls back invalid updates', async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  const adapter = new SqliteAdapter(f.file, 'validation');
  t.after(() => adapter.close());
  const schema = await adapter.introspect();
  const validation = compileAppValidation(schema, { task: [{ must: 'state is not empty', message: 'State is required.' }] });
  const access = { readable: new Set(['task']), writable: new Set(['task']), validation };
  await assert.rejects(
    () =>
      adapter.transaction!((tx) =>
        authorizeTransaction(schema, access, tx).update({
          table: 'task',
          key: { id: 1 },
          values: { state: '' },
        }),
      ),
    (error) => error instanceof AppValidationDenied && error.fields.includes('state'),
  );
  const check = new DatabaseSync(f.file);
  t.after(() => check.close());
  assert.equal(check.prepare('SELECT state FROM task WHERE id = 1').get()?.state, 'new');
});

test('a comparison with a constant refuses the stored post-image naming its field, and a mistyped constant fails binding', async (t) => {
  const f = fixture(`CREATE TABLE deal (id INTEGER PRIMARY KEY, stage TEXT NOT NULL, probability INTEGER NOT NULL DEFAULT 0);
    INSERT INTO deal (stage, probability) VALUES ('negotiation', 80);`);
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  const adapter = new SqliteAdapter(f.file, 'validation');
  t.after(() => adapter.close());
  const schema = await adapter.introspect();
  const won = { must: 'probability = 100', when: 'stage = won', message: 'A won deal is at 100%.' };
  assert.throws(
    () => compileAppValidation(schema, { deal: [{ ...won, must: 'probability = certain' }] }),
    /validation\.deal: Condition on "probability" is not comparable with this schema\./,
  );
  const validation = compileAppValidation(schema, { deal: [won] });
  const access = { readable: new Set(['deal']), writable: new Set(['deal']), validation };
  const update = (values: Record<string, string | number>) =>
    adapter.transaction!((tx) =>
      authorizeTransaction(schema, access, tx).update({
        table: 'deal',
        key: { id: 1 },
        values,
      }),
    );
  await assert.rejects(
    () => update({ stage: 'won' }),
    (error) => error instanceof AppValidationDenied && error.fields.join() === 'probability' && !/100%/.test(error.message),
  );
  const check = new DatabaseSync(f.file);
  t.after(() => check.close());
  assert.deepEqual(
    { ...check.prepare('SELECT stage, probability FROM deal WHERE id = 1').get() },
    { stage: 'negotiation', probability: 80 },
  );
  await update({ stage: 'won', probability: 100 });
  assert.deepEqual({ ...check.prepare('SELECT stage, probability FROM deal WHERE id = 1').get() }, { stage: 'won', probability: 100 });
});

test('root App validation observes database defaults in the stored post-image', async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  const adapter = new SqliteAdapter(f.file, 'validation');
  t.after(() => adapter.close());
  const schema = await adapter.introspect();
  const validation = compileAppValidation(schema, { task: [{ must: 'state is not empty', message: 'State is required.' }] });
  const access = { readable: new Set(['task']), writable: new Set(['task']), validation };
  const result = await adapter.transaction!((tx) =>
    authorizeTransaction(schema, access, tx).insert({
      table: 'task',
      values: { name: 'defaulted' },
    }),
  );
  assert.equal(result.row?.state, 'new');
  const check = new DatabaseSync(f.file);
  t.after(() => check.close());
  assert.equal(check.prepare('SELECT name, state FROM task WHERE id = ?').get(result.key.id)?.name, 'defaulted');
});
