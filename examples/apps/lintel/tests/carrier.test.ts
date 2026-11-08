/**
 * The carrier's tracking API, the source Lintel's deliveries will be read beside (examples/databases/lintel/carrier).
 * Three things keep it honest, as for the Parcel sample: its committed description pins the committed spec by
 * hash (so neither changes without the other; `mistri check` reads the same pin), its stub serves rows of that shape and only for the
 * parameters the spec documents, and every tracking number the seed gives a delivery is a shipment the stub knows.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { createCarrier } from '../../../databases/lintel/carrier/api.mjs';
import { generate } from '../../../databases/lintel/data.mjs';

const DIR = new URL('../../../databases/lintel/carrier/', import.meta.url);
const specBytes = readFileSync(new URL('openapi.json', DIR));
interface Described {
  spec: { file: string; sha256: string };
  resources: Array<{ name: string; key: string; columns: Array<{ name: string; nullable: boolean; allowed?: string[] }> }>;
}
const description = JSON.parse(readFileSync(new URL('northbound.http.json', DIR), 'utf8')) as Described;

const server = createCarrier();
let base = '';
before(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
after(() => server.close());

test('the committed description pins the committed spec, and keys its shipments by tracking number', () => {
  assert.equal(description.spec.file, 'openapi.json');
  assert.equal(
    description.spec.sha256,
    createHash('sha256').update(specBytes).digest('hex'),
    'redraft northbound.http.json with --from-openapi',
  );
  const [shipments] = description.resources;
  assert.deepEqual([shipments.name, shipments.key], ['shipments', 'tracking_number']);
});

test('the API serves rows of the described shape, and only for documented parameters', async () => {
  assert.equal((await fetch(`${base}/shipments?color=red`)).status, 400);
  assert.equal((await fetch(`${base}/shipments?sort=weight`)).status, 400);
  const declared = description.resources.find((each) => each.name === 'shipments')!;
  const rows = (await (await fetch(`${base}/shipments?limit=100`)).json()) as Array<Record<string, unknown>>;
  assert.ok(rows.length > 0);
  for (const row of rows) {
    for (const column of declared.columns) {
      const value = row[column.name];
      if (value === null || value === undefined) assert.ok(column.nullable, `${column.name} is null`);
      else if (column.allowed) assert.ok(column.allowed.includes(String(value)), `${column.name} = ${String(value)}`);
      else assert.equal(typeof value, 'string', `${column.name} = ${JSON.stringify(value)}`);
    }
  }
  const held = (await (await fetch(`${base}/shipments?status=exception`)).json()) as Array<{ status: string }>;
  assert.ok(held.length > 0 && held.every((row) => row.status === 'exception'));
});

test('every delivery the seed makes carries a tracking number the carrier knows', async () => {
  const { tables } = generate({ today: '2026-11-08', photos: false });
  const numbers = tables.part_receipt.map((row) => String(row.tracking_number));
  assert.equal(numbers.length, 6);
  for (const number of numbers) {
    const found = await fetch(`${base}/shipments/${number}`);
    assert.equal(found.status, 200, `${number} is a shipment`);
    assert.equal(((await found.json()) as { status: string }).status, 'delivered');
  }
  assert.equal((await fetch(`${base}/shipments/NB0`)).status, 404);
});
