/**
 * A stitched reference onto an API (the Parcel fixture's shipments, read from
 * a SQLite list of notes): the second step is one `in` read where the API
 * documents a list for the key, a bounded request per key where it does not,
 * and a target that is down leaves the rows with their keys and says so
 * (`partial`) rather than failing the list. A declaration the API cannot answer
 * is refused when the App loads; a fan-out is advised on by `mistri check`.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { readDescription, type HttpDescription } from '../packages/engine/src/adapters/http/httpDescription.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { appAdvisories, appProblems, type AppHost } from '../packages/mistri/src/server/app/apps.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { createApp } from './support/createApp.js';

const DIR = 'test/fixtures/apps/parcel/source';
const TOKEN = 'parcel-test-token';
const base: HttpDescription = readDescription(JSON.parse(readFileSync(`${DIR}/parcel.http.json`, 'utf8')), `${DIR}/parcel.http.json`);

/** The same API where the shipments' key takes a list too, as an API that documents `in` would say it. */
const withIn: HttpDescription = (() => {
  const copy = structuredClone(base);
  copy.resources.find((each) => each.name === 'shipments')!.filters.tracking_number = { param: 'tracking_number', ops: ['=', 'in'] };
  return copy;
})();

let child: ChildProcess;
let origin: string;
let numbers: string[] = [];
/** In front of the API: counts what is asked, answers `tracking_number=a&tracking_number=b` from the item paths (the API itself takes no such list), and can be down. */
let front: Server;
let frontOrigin: string;
const seen: string[] = [];
let down = false;

before(async () => {
  const reservation = createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = (reservation.address() as { port: number }).port;
  await new Promise((resolve) => reservation.close(resolve));
  child = spawn(process.execPath, [`${DIR}/api.mjs`, '--port', String(port)], {
    env: { ...process.env, PARCEL_API_TOKEN: TOKEN },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout!.on('data', (chunk) => (log += String(chunk)));
  while (!log.includes('listening')) {
    if (child.exitCode !== null) assert.fail(`the API exited: ${log}`);
    await once(child.stdout!, 'data');
  }
  origin = `http://127.0.0.1:${port}`;
  const auth = { headers: { authorization: `Bearer ${TOKEN}` } };
  numbers = ((await (await fetch(`${origin}/v1/shipments?limit=60`, auth)).json()) as Array<{ tracking_number: string }>).map(
    (row) => row.tracking_number,
  );
  front = createServer(async (request, response) => {
    const url = new URL(request.url!, origin);
    seen.push(`${url.pathname}${url.search}`);
    if (down) return request.socket.destroy();
    const keys = url.pathname === '/v1/shipments' ? url.searchParams.getAll('tracking_number') : [];
    const answer = keys.length
      ? await Promise.all(keys.map(async (key) => (await fetch(`${origin}/v1/shipments/${key}`, auth)).json()))
      : undefined;
    if (answer) {
      response.setHeader('content-type', 'application/json');
      return void response.end(JSON.stringify(answer));
    }
    const forwarded = await fetch(`${origin}${url.pathname}${url.search}`, {
      headers: { authorization: request.headers.authorization ?? '' },
    });
    response.statusCode = forwarded.status;
    response.setHeader('content-type', 'application/json');
    response.end(await forwarded.text());
  }).listen(0, '127.0.0.1');
  await once(front, 'listening');
  frontOrigin = `http://127.0.0.1:${(front.address() as { port: number }).port}`;
});
after(async () => {
  child.kill();
  front.closeAllConnections();
  await new Promise((resolve) => front.close(resolve));
});

const app = (references: Record<string, unknown> = { tracking: { to: 'parcel.shipments' } }) => ({
  id: 'parcel-notes',
  name: 'Parcel notes',
  sources: { ops: { connection: 'ops', default: true }, parcel: { connection: 'parcel' } },
  resources: { 'parcel.shipments': {}, parcel_note: { access: 'write', references } },
  views: { notes: { kind: 'list', from: 'parcel_note', label: 'Notes' } },
  home: 'notes',
  nav: ['notes'],
});

async function open(description: HttpDescription, notes: string[]) {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-stitch-http-'));
  const file = join(directory, 'ops.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE parcel_note (id INTEGER PRIMARY KEY, tracking TEXT, note TEXT)');
  const insert = db.prepare('INSERT INTO parcel_note (tracking, note) VALUES (?, ?)');
  notes.forEach((tracking, index) => insert.run(tracking, `note ${index + 1}`));
  db.close();
  const registry = new Registry();
  registry.add({ id: 'ops', name: 'ops', url: file, source: 'config', writable: true });
  registry.add({
    name: 'parcel',
    url: `${frontOrigin}/v1/`,
    writable: false,
    source: 'config',
    http: { description, insecure: true, auth: { bearer: TOKEN } },
  });
  return {
    directory,
    registry,
    close: async () => {
      await registry.closeAll();
      clearJournal('ops');
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function serve(
  description: HttpDescription,
  notes: string[],
  run: (call: (q: string) => Promise<{ status: number; body: any; text: string }>) => Promise<void>,
) {
  const { registry, close } = await open(description, notes);
  const parsed = parseAppConfig(app(), 'stitched http');
  const hosts: AppHost[] = [{ app: { path: 'stitch.ts', app: parsed, pages: [], sources: {} }, pages: [] }];
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: hosts, pages: [] });
  server.listen(0, bound.host);
  await once(server, 'listening');
  bound.port = (server.address() as { port: number }).port;
  try {
    await run(async (q) => {
      const response = await fetch(`http://${bound.host}:${bound.port}/api/run?app=${parsed.id}`, {
        signal: AbortSignal.timeout(10_000),
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app: parsed.id, q }),
      });
      const text = await response.text();
      return { status: response.status, text, body: JSON.parse(text) };
    });
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await close();
  }
}

const listed = 'parcel_note show id, tracking, tracking.status sort id limit 100';
const statuses = (rows: Array<Record<string, unknown>>) => rows.map((row) => row['tracking.status']);

test('an API that documents `in` on the key is read once for the page', async () => {
  seen.length = 0;
  down = false;
  await serve(withIn, numbers.slice(0, 3), async (call) => {
    const answer = await call(listed);
    assert.equal(answer.status, 200, answer.text.slice(0, 400));
    assert.ok(
      statuses(answer.body.rows).every((status) => typeof status === 'string'),
      JSON.stringify(answer.body.rows),
    );
    assert.equal(answer.body.partial, undefined);
  });
  const lookups = seen.filter((path) => path.startsWith('/v1/shipments?tracking_number='));
  assert.equal(lookups.length, 1, `one list read of the page's keys: ${seen.join(' ')}`);
  assert.equal(lookups[0].split('tracking_number=').length - 1, 3);
});

test('an API with no list for the key is asked a key at a time, in bounds', async () => {
  seen.length = 0;
  down = false;
  const keys = [...numbers.slice(0, 5), numbers[0]];
  await serve(base, keys, async (call) => {
    const answer = await call(listed);
    assert.equal(answer.status, 200, answer.text.slice(0, 400));
    assert.ok(
      statuses(answer.body.rows).every((status) => typeof status === 'string'),
      JSON.stringify(answer.body.rows),
    );
    assert.equal(statuses(answer.body.rows)[0], statuses(answer.body.rows)[5], 'a key two notes share labels both');
  });
  const lookups = seen.filter((path) => path.startsWith('/v1/shipments/'));
  assert.deepEqual(
    [...lookups].sort(),
    numbers
      .slice(0, 5)
      .map((key) => `/v1/shipments/${key}`)
      .sort(),
    'each distinct key once',
  );
});

test('more keys than an API is asked for at once refuses the read, saying how many', async () => {
  seen.length = 0;
  await serve(base, numbers.slice(0, 51), async (call) => {
    const answer = await call(listed);
    assert.ok(answer.status >= 400 || answer.body.errors?.length, answer.text.slice(0, 300));
    assert.match(answer.text, /more than the 50 an API is asked for/);
    assert.match(answer.text, /Show fewer rows/);
  });
  assert.deepEqual(
    seen.filter((path) => path.startsWith('/v1/shipments/')),
    [],
    'nothing was sent',
  );
});

test('a target that is down leaves the rows with their keys and says which labels are missing', async () => {
  down = true;
  try {
    await serve(base, numbers.slice(0, 3), async (call) => {
      const answer = await call(listed);
      assert.equal(answer.status, 200, answer.text.slice(0, 400));
      assert.deepEqual(
        answer.body.partial?.map((each: { reference: string }) => each.reference),
        ['tracking'],
      );
      assert.match(answer.body.partial[0].reason, /^[a-z_]+$/, "a word, never the operator's message");
      assert.deepEqual(
        answer.body.rows.map((row: Record<string, unknown>) => row['tracking.status']),
        numbers.slice(0, 3),
        'the key stands where the label would be',
      );
    });
  } finally {
    down = false;
  }
});

test('a declaration the API cannot answer is refused when the App loads, with the fix', async () => {
  const { registry, close } = await open(base, []);
  try {
    const load = (references: Record<string, unknown>) => loadAppRuntimeResources(registry, parseAppConfig(app(references), 'load'), 'ops');
    await assert.rejects(
      load({ tracking: { to: 'parcel.shipments', column: 'service' } }),
      /documents no filter on "service".*Declare a service filter on `parcel\.shipments`/,
    );
    await load({ tracking: { to: 'parcel.shipments' } });
  } finally {
    await close();
  }
});

test('check advises on a fan-out and is quiet where the API takes a list', async () => {
  const advice = async (description: HttpDescription) => {
    const { registry, close, directory } = await open(description, []);
    try {
      const parsed = parseAppConfig(app(), 'advice');
      const runtime = await loadAppRuntimeResources(registry, parsed, 'ops');
      const loaded = { path: join(directory, 'app.ts'), app: parsed, pages: [], sources: {} };
      assert.deepEqual(appProblems(loaded, runtime.schema), []);
      return appAdvisories(loaded, runtime.schema).filter((line) => line.includes('[stitched-fanout]'));
    } finally {
      await close();
    }
  };
  const said = await advice(base);
  assert.equal(said.length, 1, said.join('\n'));
  assert.match(said[0], /parcel_note.*"tracking" is looked up in parcel\.shipments.*once per distinct key/);
  assert.deepEqual(await advice(withIn), []);
});
