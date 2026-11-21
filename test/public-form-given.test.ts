/**
 * `given` on a public form: the link carries the id (a QR code on a unit's door) and the visitor is never shown it.
 * Seen from outside the server: the form's payload names the input as given, so the page leaves it undrawn, and the
 * value the link carried still travels to the command and is judged by it as anything typed is: hidden is not trusted.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { shape, text } from '../packages/mistri/src/server/commands/commandShapes.js';
import { resetPublicFormLimits } from '../packages/engine/src/server/http/rateLimit.js';
import { parseTrustedProxies } from '../packages/engine/src/server/http/trust.js';
import { createApp } from './support/createApp.js';
import { parseTestApp } from './support/commandCatalog.js';

const work = mkdtempSync(join(tmpdir(), 'mistri-public-given-'));
after(() => rmSync(work, { recursive: true, force: true }));

const askInput = {
  unit: { label: 'Unit', type: 'text', max: 8, pattern: '^U-[0-9]+$' },
  note: { label: 'What is wrong', type: 'text', max: 200 },
} as const;
const CONTRACTS = { ask: { public: true, input: askInput } };
const RAW = {
  id: 'repairs',
  name: 'Repairs',
  sources: { main: { connection: 'repairs-db' } },
  auth: { roles: { clerk: { read: true } } },
  resources: { request: { access: 'write' } },
  views: {
    requests: { kind: 'list', from: 'request' },
    ask: { kind: 'form', label: 'Ask', public: true, done: { title: 'Thanks' }, command: 'ask', given: ['unit'] },
  },
  home: 'requests',
  nav: ['requests'],
};

test('a public form is given an input by its link: undrawn, yet judged by the command', { timeout: 60_000 }, async () => {
  const app = parseTestApp(RAW, 'public given fixture', CONTRACTS);
  resetPublicFormLimits();
  const file = join(work, 'repairs.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE request(id INTEGER PRIMARY KEY, unit TEXT, note TEXT);');
  migrateSqliteCommandJournal(file);
  const registry = new Registry();
  registry.add({ id: 'repairs-db', name: 'Repairs', url: file, writable: true, source: 'config' });
  const commands = defineCommands({
    ask: defineCommand({
      targets: 'none',
      source: 'main',
      target: 'request',
      read: ['request'],
      write: ['request'],
      public: true,
      input: askInput,
      output: shape({ reference: text() }),
      async handle(context, input) {
        await context.tx.insert({ table: 'request', values: { unit: input.unit, note: input.note } });
        return { reference: 'ASK' };
      },
    }),
  });
  const host: AppHost = {
    app: { app, path: '/private/app.ts', pages: [], sources: {} },
    pages: [],
    auth: { spec: app.auth!, store: '/private/auth.db', close() {}, handler: async () => {}, session: async () => null },
  };
  const bound = { host: '127.0.0.1', port: 0, trustedProxies: parseTrustedProxies([]).ranges };
  const server = createApp({ registry, bound, apps: [host], commands: { appId: 'repairs', registry: commands } });
  try {
    server.listen(0, bound.host);
    await once(server, 'listening');
    const base = `http://${bound.host}:${(server.address() as { port: number }).port}`;
    const read = await fetch(`${base}/api/forms/ask`, { headers: { origin: base } });
    assert.equal(read.status, 200);
    const { form } = (await read.json()) as { form: { given?: string[]; input: Array<{ name: string }> } };
    // The page draws every input but these; the command's contract still names the unit, so it is judged.
    assert.deepEqual(form.given, ['unit']);
    assert.ok(form.input.some((field) => field.name === 'unit'));

    let n = 0;
    const submit = (input: Record<string, unknown>) =>
      fetch(`${base}/api/forms/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({ input, submission: `public-given-key-${String(++n).padStart(6, '0')}` }),
      }).then(async (response) => ({ status: response.status, body: (await response.json()) as Record<string, unknown> }));
    // A link's value is no more trusted than a typed one: the command's own pattern refuses a forged id.
    const forged = await submit({ unit: 'not-a-unit', note: 'Leak' });
    assert.equal(forged.status, 400, JSON.stringify(forged.body));
    assert.equal(forged.body.field, 'unit');
    // A link that left it out meets the command's refusal, on the input's line.
    const missing = await submit({ note: 'Leak' });
    assert.equal(missing.status, 400, JSON.stringify(missing.body));
    assert.equal(missing.body.field, 'unit');
    assert.equal(db.prepare('SELECT count(*) AS n FROM request').get()!.n, 0);
    // The one the link carried reaches the command.
    const sent = await submit({ unit: 'U-12', note: 'Leak' });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.deepEqual(
      db
        .prepare('SELECT unit, note FROM request')
        .all()
        .map((row) => ({ ...row })),
      [{ unit: 'U-12', note: 'Leak' }],
    );
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    db.close();
    resetPublicFormLimits();
  }
});
