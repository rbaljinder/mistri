/**
 * Parcel, the sample that reads an API. Three things keep it honest: its
 * committed description is what a fresh draft of its committed spec says (so
 * neither changes without the other), its App fits the catalog that
 * description makes, and its API serves rows of that shape — only to a
 * client with the token, and only for the parameters the spec documents.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { describedSchema, draftDescription, readDescription } from '../packages/engine/src/adapters/http/httpDescription.js';
import { readOpenApi } from '../packages/engine/src/adapters/http/openapi.js';
import { appProblems, loadApp } from '../packages/mistri/src/server/app/apps.js';
import { appCeilingWarnings } from '../packages/mistri/src/shared/app.js';

const DIR = 'test/fixtures/apps/parcel/source';
const specBytes = readFileSync(`${DIR}/openapi.json`);
const description = readDescription(JSON.parse(readFileSync(`${DIR}/parcel.http.json`, 'utf8')), `${DIR}/parcel.http.json`);

test('the committed description is a fresh draft of the committed spec', () => {
  const fresh = draftDescription(readOpenApi(JSON.parse(specBytes.toString('utf8'))), {
    file: 'openapi.json',
    sha256: createHash('sha256').update(specBytes).digest('hex'),
  });
  assert.deepEqual(description, fresh, 'redraft parcel.http.json with --from-openapi after changing openapi.json');
});

test('Parcel fits the catalog its description makes', async () => {
  const schema = describedSchema(description, 'parcel');
  const loaded = await loadApp('test/fixtures/apps/parcel');
  assert.deepEqual(appProblems(loaded, schema), []);
  assert.deepEqual(appCeilingWarnings(loaded.app, schema), []);
});

/* What a declared column's type admits, as the adapter reads a value. */
const fits = (type: string, nullable: boolean, value: unknown): boolean => {
  if (value === null || value === undefined) return nullable;
  switch (type) {
    case 'number':
    case 'integer':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'date':
      return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
    case 'datetime':
      return typeof value === 'string' && !Number.isNaN(Date.parse(value));
    default:
      return typeof value === 'string';
  }
};

test('the API serves rows of the described shape, only to its token and only for documented parameters', async () => {
  const reservation = createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = (reservation.address() as { port: number }).port;
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(process.execPath, [`${DIR}/api.mjs`, '--port', String(port)], {
    env: { ...process.env, PARCEL_API_TOKEN: 'parcel-test-token' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    let log = '';
    child.stdout!.on('data', (chunk) => {
      log += String(chunk);
    });
    while (!log.includes('listening')) {
      if (child.exitCode !== null) assert.fail(`the API exited: ${log}`);
      await once(child.stdout!, 'data');
    }
    const base = `http://127.0.0.1:${port}/v1`;
    const auth = { headers: { authorization: 'Bearer parcel-test-token' } };
    assert.equal((await fetch(`${base}/shipments`)).status, 401);
    assert.equal((await fetch(`${base}/shipments?color=red`, auth)).status, 400);

    for (const [resource, path, rowsAt] of [
      ['shipments', '/shipments?limit=100', ''],
      ['carriers', '/carriers?limit=50', 'data'],
    ] as const) {
      const declared = description.resources.find((each) => each.name === resource)!;
      const body = (await (await fetch(`${base}${path}`, auth)).json()) as Record<string, unknown>;
      const rows = (rowsAt ? body[rowsAt] : body) as Array<Record<string, unknown>>;
      assert.ok(rows.length > 0, `${resource} has rows`);
      for (const row of rows) {
        for (const column of declared.columns) {
          assert.ok(
            fits(column.type, column.nullable, row[column.name]),
            `${resource}.${column.name} = ${JSON.stringify(row[column.name])} is not ${column.type}`,
          );
        }
      }
    }
    const [first] = (await (await fetch(`${base}/shipments?limit=1`, auth)).json()) as Array<{ tracking_number: string }>;
    assert.equal((await (await fetch(`${base}/shipments/${first.tracking_number}`, auth)).json()).tracking_number, first.tracking_number);
  } finally {
    child.kill();
  }
});
