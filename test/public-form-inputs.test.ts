/**
 * The App's own input components on a public form's page. Seen from outside:
 *
 * - a public form may name them, by the form (`inputs`) and by a field (`input: 'dial'`), as a signed-in form does;
 * - its payload says where each one it draws is served, and nothing about any other component the App has;
 * - those files are a visitor's to fetch, on a tenant host too (publicComponentIds), never a source map;
 * - a value the component hands back is still the field's kind's to judge: the server parses by the kind.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { compileComponents } from '../packages/mistri/src/server/app/appComponents.js';
import { appComponents, publicComponentIds, publicFormInputIds } from '../packages/mistri/src/shared/appComponentPlaces.js';
import { isPublicForm } from '../packages/mistri/src/shared/app.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { shape, text } from '../packages/mistri/src/server/commands/commandShapes.js';
import { resetPublicFormLimits } from '../packages/engine/src/server/http/rateLimit.js';
import { parseTrustedProxies } from '../packages/engine/src/server/http/trust.js';
import { parseTestApp } from './support/commandCatalog.js';

const work = mkdtempSync(join(tmpdir(), 'mistri-public-inputs-'));
after(() => rmSync(work, { recursive: true, force: true }));

const swatch = { id: 'swatch', module: './widgets/Swatch.jsx', kind: 'input' };
const dial = { id: 'dial', module: './widgets/Dial.jsx', kind: 'input' };
const secret = { id: 'secret', module: './widgets/Secret.jsx', kind: 'input' };
const askInput = {
  color: { label: 'Color', type: 'text', max: 20 },
  size: { label: 'Size', type: 'number', min: 1, max: 10, input: 'dial' },
} as const;
const CONTRACTS = { ask: { public: true, input: askInput } };
const RAW = {
  id: 'paints',
  name: 'Paints',
  sources: { main: { connection: 'paints-db' } },
  auth: { roles: { clerk: { read: true } } },
  // A resource's own input, which no public form draws: its code is the signed-in page's alone.
  resources: { inquiry: { access: 'write', inputs: { color: secret } }, dials: { inputs: { size: dial } } },
  views: {
    inquiries: { kind: 'list', from: 'inquiry' },
    ask: { kind: 'form', label: 'Ask', public: true, done: { title: 'Thanks' }, command: 'ask', inputs: { color: swatch } },
  },
  home: 'inquiries',
  nav: ['inquiries'],
};

test('a public form names input components by the form and by a field, and they are a visitor’s to load', () => {
  const app = parseTestApp(RAW, 'public inputs fixture', CONTRACTS);
  const form = app.views.ask;
  assert.ok(isPublicForm(form));
  assert.deepEqual([...publicFormInputIds(form)].sort(), ['dial', 'swatch']);
  assert.deepEqual([...publicComponentIds(app, [])].sort(), ['dial', 'swatch'], 'never the resource’s own input');
  assert.deepEqual([...appComponents(app, [], 'fixture').keys()].sort(), ['dial', 'secret', 'swatch']);
});

async function serve(run: (base: string, db: DatabaseSync, files: Readonly<Record<string, string>>) => Promise<void>) {
  const app = parseTestApp(RAW, 'public inputs fixture', CONTRACTS);
  const dir = join(work, 'app');
  mkdirSync(join(dir, 'widgets'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{ "type": "module" }\n');
  for (const [name, color] of [
    ['Swatch', 'tomato'],
    ['Dial', 'teal'],
    ['Secret', 'black'],
  ])
    writeFileSync(
      join(dir, 'widgets', `${name}.jsx`),
      `export default function ${name}({ value, onChange }) { return <input data-c="${color}" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />; }\n`,
    );
  const components = await compileComponents(dir, appComponents(app, [], 'fixture'));
  assert.ok(components);
  resetPublicFormLimits();
  const file = join(work, `paints-${Date.now()}.db`);
  const db = new DatabaseSync(file);
  db.exec(
    'CREATE TABLE inquiry(id INTEGER PRIMARY KEY, color TEXT, size INTEGER); CREATE TABLE dials(id INTEGER PRIMARY KEY, size INTEGER);',
  );
  migrateSqliteCommandJournal(file);
  const registry = new Registry();
  registry.add({ id: 'paints-db', name: 'Paints', url: file, writable: true, source: 'config' });
  const commands = defineCommands({
    ask: defineCommand({
      targets: 'none',
      source: 'main',
      target: 'inquiry',
      read: ['inquiry'],
      write: ['inquiry'],
      public: true,
      input: askInput,
      output: shape({ reference: text() }),
      async handle(context, input) {
        await context.tx.insert({ table: 'inquiry', values: { color: input.color, size: input.size } });
        return { reference: 'ASK' };
      },
    }),
  });
  const host: AppHost = {
    app: { app, path: '/private/app.ts', pages: [], sources: {}, components },
    pages: [],
    auth: { spec: app.auth!, store: '/private/auth.db', close() {}, handler: async () => {}, session: async () => null },
  };
  const bound = { host: '127.0.0.1', port: 0, trustedProxies: parseTrustedProxies([]).ranges };
  const server = createApp({ registry, bound, apps: [host], commands: { appId: 'paints', registry: commands } });
  try {
    server.listen(0, bound.host);
    await once(server, 'listening');
    bound.port = (server.address() as { port: number }).port;
    await run(`http://${bound.host}:${bound.port}`, db, components.files);
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    db.close();
    resetPublicFormLimits();
  }
}

test(
  'the form’s payload says where its input components are served, and the value is still the kind’s to judge',
  { timeout: 60_000 },
  async () => {
    await serve(async (base, db, files) => {
      const read = await fetch(`${base}/api/forms/ask`, { headers: { origin: base } });
      assert.equal(read.status, 200);
      const { form } = (await read.json()) as {
        form: {
          inputs?: Record<string, { id: string }>;
          components?: Record<string, { href: string; css?: string }>;
          input: Array<{ name: string; input?: string }>;
        };
      };
      assert.deepEqual(form.inputs, { color: { id: 'swatch' } });
      assert.equal(form.input.find((field) => field.name === 'size')?.input, 'dial');
      assert.deepEqual(Object.keys(form.components ?? {}).sort(), ['dial', 'swatch'], 'the ones it draws, never the resource’s own');
      for (const entry of Object.values(form.components!)) assert.match(entry.href, /^\/paints\/_components\/[a-z]+-[0-9a-f]{12}\.js$/);

      // Signed out, with no session at all: the code, never its source map. The payload says the inside address; an App
      // served at the root is reached without its name (client addressMount.js appFile).
      const at = (href: string) => `${base}${href.slice('/paints'.length)}`;
      const code = await fetch(at(form.components!.swatch.href));
      assert.equal(code.status, 200, await code.clone().text());
      assert.match(code.headers.get('content-type') ?? '', /javascript/);
      assert.match(await code.text(), /tomato/);
      assert.equal((await fetch(`${at(form.components!.swatch.href)}.map`)).status, 404, 'never the source map');
      const hidden = await fetch(
        `${base}/_components/${Object.keys(files).find((file) => file.startsWith('secret-') && file.endsWith('.js'))}`,
      );
      assert.equal(hidden.status, 404, 'a component no public form draws is not a visitor’s');

      const submit = (input: Record<string, unknown>, n: number) =>
        fetch(`${base}/api/forms/ask`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: base },
          body: JSON.stringify({ input, submission: `public-inputs-key-${String(n).padStart(6, '0')}` }),
        }).then(async (response) => ({ status: response.status, body: (await response.json()) as Record<string, unknown> }));
      // Whatever the component hands back, the server reads the field by its kind.
      const wrong = await submit({ color: { hex: '#ff6347' }, size: 3 }, 1);
      assert.equal(wrong.status, 400, JSON.stringify(wrong.body));
      assert.equal(wrong.body.field, 'color');
      const outOfRange = await submit({ color: 'tomato', size: 40 }, 2);
      assert.equal(outOfRange.status, 400);
      assert.equal(outOfRange.body.field, 'size');
      const sent = await submit({ color: 'tomato', size: 3 }, 3);
      assert.equal(sent.status, 200, JSON.stringify(sent.body));
      assert.deepEqual(
        db
          .prepare('SELECT color, size FROM inquiry')
          .all()
          .map((row) => ({ ...row })),
        [{ color: 'tomato', size: 3 }],
      );
    });
  },
);
