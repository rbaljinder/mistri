/**
 * A field report: a table's trigger read another table and refused writes in ways the App could not see. rc.43 names such
 * a trigger when a scoped write meets it; `mistri check` now names it for any App, from the database it reads and from
 * the schema.sql a migration has yet to bring in, as `[trigger-cross-table]`, an advisory.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { validating } from './support/validation.js';

const TABLES = `CREATE TABLE stock (item_id INTEGER PRIMARY KEY, on_hand INTEGER NOT NULL);
  CREATE TABLE orders (id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL, quantity INTEGER NOT NULL);
  INSERT INTO stock VALUES (1, 5);`;
const CROSSING = `CREATE TRIGGER stock_check BEFORE INSERT ON orders BEGIN
  SELECT CASE WHEN NEW.quantity > (SELECT on_hand FROM stock WHERE item_id = NEW.item_id) THEN RAISE(ABORT, 'short') END;
END;`;
const ALONE = `CREATE TRIGGER quantity_positive BEFORE INSERT ON orders BEGIN
  SELECT CASE WHEN NEW.quantity <= 0 THEN RAISE(ABORT, 'Nothing to order') END;
END;`;

function fixture(inDatabase: string, inSchema?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-cross-trigger-'));
  mkdirSync(join(directory, 'app'));
  const file = join(directory, 'data.db');
  const db = new DatabaseSync(file);
  db.exec(`${TABLES}\n${inDatabase}`);
  db.close();
  writeFileSync(
    join(directory, 'app', 'app.json'),
    JSON.stringify({
      id: 'shop',
      name: 'Shop',
      connection: 'data',
      resources: { order: { physical: 'orders', access: 'write' } },
      auth: { roles: { clerk: { read: true } } },
      views: { orders: { kind: 'list', from: 'order' } },
      home: 'orders',
    }),
  );
  if (inSchema !== undefined) writeFileSync(join(directory, 'app', 'schema.sql'), `${TABLES}\n${inSchema}`);
  const config = join(directory, 'connections.json');
  writeFileSync(config, JSON.stringify({ connections: [{ id: 'data', name: 'Data', url: file, writable: true }] }));
  return { directory, args: ['check', '--warnings', '--config', config, '--app', join(directory, 'app')] };
}

function check(f: ReturnType<typeof fixture>) {
  const spawned = validating(f.args, { ...process.env, XDG_CONFIG_HOME: join(f.directory, 'xdg'), MISTRI_OPEN: '0' });
  return new Promise<string>((done) =>
    execFile(
      process.execPath,
      ['--import', 'tsx', resolve('packages/mistri/src/server/index.ts'), ...spawned.args],
      { timeout: 30_000, env: spawned.env },
      (_error, out, err) => done(out + err),
    ),
  );
}

test('a trigger that reads another table is named, with its table, as an advisory that fails nothing', async (t) => {
  const f = fixture(CROSSING);
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  const said = await check(f);
  assert.match(said, /table "order" has the trigger "stock_check" \(it reads another table\) \[trigger-cross-table\]/);
  assert.doesNotMatch(said, /validation\s+failed/);
});

test('a trigger of NEW and OLD alone is not named', async (t) => {
  const f = fixture(ALONE);
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  assert.doesNotMatch(await check(f), /trigger-cross-table/);
});

test('a trigger schema.sql declares and the database lacks is named before its migration runs', async (t) => {
  const f = fixture('', CROSSING);
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  const said = await check(f);
  assert.match(said, /table "order" has the trigger "stock_check" in schema.sql, which names "stock" \[trigger-cross-table\]/);
});
