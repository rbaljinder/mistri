/**
 * A field report: a tenant App's validation trigger read another table, and its scoped command was refused at runtime
 * — the check database was made fresh and had no trigger for `[command-trigger]` to judge. `[schema-trigger]` reads
 * the App's schema.sql where the database cannot say.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { declaredTriggers, schemaTriggerWarnings } from '../packages/mistri/src/server/commands/commandTriggerChecks.js';
import { componentCode } from '../packages/mistri/src/server/build/checkProblems.js';
import type { ScopeTrigger } from '@mistriwork/engine/adapters/scoped/scopedTransaction.js';

const SQL = `
CREATE TABLE orders (id INTEGER PRIMARY KEY, item_id INTEGER, quantity INTEGER, note TEXT);
CREATE TABLE stock (item_id INTEGER PRIMARY KEY, on_hand INTEGER);
CREATE TABLE audit (id INTEGER PRIMARY KEY, what TEXT);
-- A check of NEW alone, with a CASE … END inside: no other table.
CREATE TRIGGER quantity_positive BEFORE INSERT ON orders BEGIN
  SELECT CASE WHEN NEW.quantity <= 0 THEN RAISE(ABORT, 'Nothing FROM stock to order') END;
END;
CREATE TRIGGER stock_check BEFORE UPDATE OF quantity ON orders BEGIN
  SELECT CASE WHEN NEW.quantity > (SELECT on_hand FROM stock WHERE item_id = NEW.item_id) THEN RAISE(ABORT, 'short') END;
END;
CREATE OR REPLACE FUNCTION log_order() RETURNS trigger LANGUAGE plpgsql AS $body$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM orders;
  INSERT INTO public.audit (what) VALUES ('order ' || NEW.id);
  RETURN NEW;
END $body$;
CREATE TRIGGER order_logged AFTER INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION log_order();
CREATE TRIGGER stock_touched AFTER UPDATE ON stock FOR EACH ROW EXECUTE FUNCTION missing_elsewhere();
`;

test("schema.sql's triggers that name another table are read, those that check NEW alone are not", () => {
  assert.deepEqual(declaredTriggers(SQL), [
    { name: 'stock_check', table: 'orders', names: ['stock'] },
    { name: 'order_logged', table: 'orders', names: ['audit'] },
  ]);
});

const app = { auth: { rows: 'tenant' }, sources: {}, resources: {} } as never;
const commands = {
  place: { source: 'main', write: ['orders'] },
  restock: { source: 'main', write: ['stock'] },
} as never;

test('a scoped command writing such a table is warned, naming the command, the trigger and what it names', () => {
  const warnings = schemaTriggerWarnings(app, commands, SQL, () => undefined);
  assert.equal(warnings.length, 2);
  assert.match(
    warnings[0]!,
    /^command "place" writes "orders", whose trigger "stock_check" in schema.sql names "stock" \[schema-trigger\]: .*403/,
  );
  assert.match(warnings[1]!, /trigger "order_logged" in schema.sql names "audit"/);
  assert.equal(componentCode(warnings[0]!), 'schema-trigger');
});

test('a trigger the database read already has is left to [command-trigger], and an unscoped App is not warned', () => {
  const read = [{ name: 'stock_check' }, { name: 'ORDER_LOGGED' }] as unknown as ScopeTrigger[];
  assert.deepEqual(
    schemaTriggerWarnings(app, commands, SQL, (logical) => (logical.endsWith('orders') ? read : [])),
    [],
  );
  assert.deepEqual(
    schemaTriggerWarnings({ auth: { rows: 'owner' }, sources: {}, resources: {} } as never, commands, SQL, () => undefined),
    [],
  );
});
