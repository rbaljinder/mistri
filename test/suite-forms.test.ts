import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { startConfiguredSuite } from '../packages/mistri/src/server/cli/suiteCommand.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { resetPublicFormLimits } from '../packages/engine/src/server/http/rateLimit.js';

function publicCommand(id: string, table: string, gate?: { entered: string; release: string }) {
  return `${id}: defineCommand({
    source: 'data', target: '${table}', targets: 'none', public: true,
    input: { body: { type: 'text' } },
    validate(value) { return value },
    output: shape({ reference: text() }),
    async handle(context, value) {
      ${
        gate
          ? `if (value.body === 'slow') {
        writeFileSync(${JSON.stringify(gate.entered)}, 'entered');
        while (!existsSync(${JSON.stringify(gate.release)})) await new Promise(resolve => setTimeout(resolve, 5));
      }`
          : ''
      }
      context.tx.insert({ table: '${table}', values: { body: value.body } });
      return { reference: '${table.toUpperCase()}-1' };
    }
  })`;
}

test('suite serves ordinary public forms on independent Apps and isolates their keys', { timeout: 20_000 }, async (t) => {
  resetPublicFormLimits();
  t.after(() => resetPublicFormLimits());
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-suite-forms-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));

  const apps = [];
  const sharedFormKey = 'apply';
  const gate = { entered: join(directory, 'entered'), release: join(directory, 'release') };
  for (const [id, table] of [
    ['alpha', 'note'],
    ['beta', 'lead'],
  ] as const) {
    const home = join(directory, id);
    mkdirSync(home);
    const database = join(home, 'business.db');
    const db = new DatabaseSync(database);
    db.exec(`CREATE TABLE ${table}(id INTEGER PRIMARY KEY, body TEXT)`);
    db.close();
    migrateSqliteCommandJournal(database);
    writeFileSync(
      join(home, 'app.json'),
      JSON.stringify({
        name: id,
        sources: { data: { connection: 'data', default: true } },
        resources: { [table]: { access: 'write' } },
        auth: { store: join(home, 'auth.db'), providers: ['email'], roles: { user: { read: true } } },
        views: {
          [id]: { kind: 'list', from: table },
          [sharedFormKey]: { kind: 'form', public: true, label: `${id} form`, command: sharedFormKey },
        },
        home: id,
        nav: [id],
      }),
    );
    writeFileSync(join(home, 'connections.json'), JSON.stringify({ connections: [{ name: 'data', url: database, writable: true }] }));
    writeFileSync(
      join(home, 'commands.mjs'),
      `import { defineCommand, defineCommands, shape, text } from ${JSON.stringify(new URL('../packages/mistri/src/server/commands.ts', import.meta.url).href)};
      import { existsSync, writeFileSync } from 'node:fs';
      export default defineCommands({ ${publicCommand(sharedFormKey, table, id === 'alpha' ? gate : undefined)} });`,
    );
    apps.push({
      id,
      directory: `./${id}`,
      config: `./${id}/connections.json`,
      mount: id === 'alpha' ? '/' : '/beta',
      environment: { BETTER_AUTH_SECRET: 'SUITE_TEST_SECRET' },
    });
  }
  const file = join(directory, 'suite.json');
  writeFileSync(file, JSON.stringify({ port, apps }));

  const suite = await startConfiguredSuite(file, { SUITE_TEST_SECRET: 'a-test-only-suite-secret-longer-than-thirty-two-characters' });
  t.after(async () => {
    await suite.close();
  });
  const origin = `http://127.0.0.1:${port}`;

  const listAlpha = await fetch(`${origin}/api/forms`);
  assert.equal(listAlpha.status, 200);
  const alphaForms = await listAlpha.json();
  assert.deepEqual(
    alphaForms.forms.map((f: { id: string }) => f.id),
    [sharedFormKey],
  );

  const readAlpha = await fetch(`${origin}/api/forms/${sharedFormKey}`);
  assert.equal(readAlpha.status, 200);
  const alphaForm = await readAlpha.json();
  assert.equal(alphaForm.form.id, sharedFormKey);

  const listBeta = await fetch(`${origin}/beta/api/forms`);
  assert.equal(listBeta.status, 200);
  const betaForms = await listBeta.json();
  assert.deepEqual(
    betaForms.forms.map((f: { id: string }) => f.id),
    [sharedFormKey],
  );

  const missingAlpha = await fetch(`${origin}/api/forms/no-such-form`);
  assert.equal(missingAlpha.status, 401, 'an unknown form key is refused on the root mount');

  const missingBeta = await fetch(`${origin}/beta/api/forms/no-such-form`);
  assert.equal(missingBeta.status, 401, 'an unknown form key is refused on a child mount');

  const badOriginAlpha = await fetch(`${origin}/api/forms/${sharedFormKey}`, {
    method: 'POST',
    headers: { origin: 'http://example.test', 'content-type': 'application/json' },
    body: JSON.stringify({ input: { body: 'hello' }, submission: 'shared-submission-key' }),
  });
  assert.equal(badOriginAlpha.status, 403, 'a public form submission still needs a same-origin header on the root mount');

  const badOriginBeta = await fetch(`${origin}/beta/api/forms/${sharedFormKey}`, {
    method: 'POST',
    headers: { origin: 'http://example.test', 'content-type': 'application/json' },
    body: JSON.stringify({ input: { body: 'hello' }, submission: 'shared-submission-key' }),
  });
  assert.equal(badOriginBeta.status, 403, 'a public form submission still needs a same-origin header on a child mount');

  const submitAlpha = await fetch(`${origin}/api/forms/${sharedFormKey}`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ input: { body: 'hello' }, submission: 'shared-submission-key' }),
  });
  assert.equal(submitAlpha.status, 200);
  const alphaReceipt = await submitAlpha.json();
  assert.equal(alphaReceipt.reference, 'NOTE-1');

  const submitBeta = await fetch(`${origin}/beta/api/forms/${sharedFormKey}`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ input: { body: 'hello' }, submission: 'shared-submission-key' }),
  });
  assert.equal(submitBeta.status, 200);
  const betaReceipt = await submitBeta.json();
  assert.equal(betaReceipt.reference, 'LEAD-1');
  assert.notDeepEqual(alphaReceipt, betaReceipt, 'the same public form key on different Apps produces distinct receipts');

  const replayAlpha = await fetch(`${origin}/api/forms/${sharedFormKey}`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ input: { body: 'hello' }, submission: 'shared-submission-key' }),
  });
  assert.equal(replayAlpha.status, 200);
  assert.deepEqual(await replayAlpha.json(), alphaReceipt, 'replaying within Alpha returns the Alpha receipt');

  const replayBeta = await fetch(`${origin}/beta/api/forms/${sharedFormKey}`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ input: { body: 'hello' }, submission: 'shared-submission-key' }),
  });
  assert.equal(replayBeta.status, 200);
  assert.deepEqual(await replayBeta.json(), betaReceipt, 'replaying within Beta returns the Beta receipt');

  const alphaDb = new DatabaseSync(join(directory, 'alpha', 'business.db'));
  assert.equal((alphaDb.prepare('SELECT COUNT(*) AS n FROM note').get() as { n: number }).n, 1, 'Alpha writes exactly one row');
  alphaDb.close();

  const betaDb = new DatabaseSync(join(directory, 'beta', 'business.db'));
  assert.equal((betaDb.prepare('SELECT COUNT(*) AS n FROM lead').get() as { n: number }).n, 1, 'Beta writes exactly one row');
  betaDb.close();

  // The caller goes away after the accepted command enters. The listener can
  // finish closing its socket before the handler finishes its transaction;
  // child cleanup must still keep the registry alive until that handler exits.
  const controller = new AbortController();
  let slow: Promise<unknown> | undefined;
  let closing: Promise<void> | undefined;
  let closed = false;
  try {
    slow = fetch(`${origin}/api/forms/${sharedFormKey}`, {
      method: 'POST',
      signal: controller.signal,
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ input: { body: 'slow' }, submission: 'disconnected-submission' }),
    }).catch(() => undefined);
    for (let i = 0; i < 400 && !existsSync(gate.entered); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(existsSync(gate.entered), 'the public form command reached its held operation');
    controller.abort();
    await slow;
    closing = suite.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(closed, false, 'suite cleanup must not pass the disconnected command');
  } finally {
    controller.abort();
    writeFileSync(gate.release, 'release');
    await slow;
    await (closing ?? suite.close());
  }
  const finished = new DatabaseSync(join(directory, 'alpha', 'business.db'), { readOnly: true });
  try {
    assert.equal((finished.prepare("SELECT COUNT(*) AS n FROM note WHERE body='hello'").get() as { n: number }).n, 1);
    assert.equal(
      (finished.prepare("SELECT COUNT(*) AS n FROM note WHERE body='slow'").get() as { n: number }).n,
      0,
      'an aborted public command rolls back rather than committing after shutdown',
    );
  } finally {
    finished.close();
  }
});

test(
  'suite serves row-policy public unkeyed forms and refuses cross-mount, unenrolled and raw-command submissions',
  { timeout: 20_000 },
  async (t) => {
    resetPublicFormLimits();
    t.after(() => resetPublicFormLimits());
    const directory = mkdtempSync(join(tmpdir(), 'tablewalk-suite-policy-forms-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const socket = createServer();
    await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
    const port = (socket.address() as { port: number }).port;
    await new Promise<void>((resolve) => socket.close(() => resolve()));

    function intakeApp(id: string) {
      const home = join(directory, id);
      mkdirSync(home);
      const database = join(home, 'business.db');
      const db = new DatabaseSync(database);
      db.exec('CREATE TABLE inbox(id INTEGER PRIMARY KEY, name TEXT NOT NULL, desk INTEGER NOT NULL DEFAULT 1)');
      db.close();
      migrateSqliteCommandJournal(database);
      writeFileSync(
        join(home, 'app.json'),
        JSON.stringify({
          id,
          name: id,
          sources: { main: { connection: 'data', default: true } },
          resources: { inbox: { access: 'write' } },
          auth: { store: join(home, 'auth.db'), rows: 'policy', roles: { staff: { read: true } } },
          views: {
            inbox: { kind: 'list', from: 'inbox' },
            contact: { kind: 'form', public: true, label: 'Contact', command: 'contact' },
            unavailable: { kind: 'form', public: true, label: 'Unavailable', command: 'unavailable' },
          },
          home: 'inbox',
          nav: ['inbox'],
        }),
      );
      writeFileSync(join(home, 'connections.json'), JSON.stringify({ connections: [{ name: 'data', url: database, writable: true }] }));
      writeFileSync(
        join(home, 'commands.mjs'),
        `import { defineCommand, defineCommands, shape, text, literal } from ${JSON.stringify(new URL('../packages/mistri/src/server/commands.ts', import.meta.url).href)};
      export default defineCommands({
        contact: defineCommand({ source: 'main', target: 'inbox', targets: 'none', public: true,
          input: { name: { type: 'text' } }, validate(value) { return value },
          output: shape({ reference: text(), message: literal('Received.') }),
          handle(context, value) {
            context.tx.insert({ table: 'inbox', values: { name: value.name } });
            return { reference: 'CONTACT-1', message: 'Received.' };
          }
        }),
        unavailable: defineCommand({ source: 'main', target: 'inbox', targets: 'none', public: true,
          input: { name: { type: 'text' } }, validate(value) { return value },
          output: shape({ reference: text(), message: literal('Received.') }),
          handle(context, value) {
            context.tx.insert({ table: 'inbox', values: { name: value.name } });
            return { reference: 'UNAVAILABLE-1', message: 'Received.' };
          }
        })
      });`,
      );
      const policyFile = join(home, 'policy.mjs');
      writeFileSync(
        policyFile,
        `export default {
      appId: ${JSON.stringify(id)},
      resolveRows() { throw new Error('Public intake must not resolve account rows'); },
      resultReferences: {},
      publicForms: { contact: { rows: { inbox: { groups: [[{ column: 'desk', op: '=', value: 1 }]] } }, resultReferences: () => [] } }
    };`,
      );
      return { id, home, database, policyFile };
    }

    const intake = intakeApp('intake');

    const betaHome = join(directory, 'beta');
    mkdirSync(betaHome);
    const betaDatabase = join(betaHome, 'business.db');
    const betaDb = new DatabaseSync(betaDatabase);
    betaDb.exec('CREATE TABLE lead(id INTEGER PRIMARY KEY, body TEXT)');
    betaDb.close();
    migrateSqliteCommandJournal(betaDatabase);
    writeFileSync(
      join(betaHome, 'app.json'),
      JSON.stringify({
        id: 'beta',
        name: 'beta',
        sources: { data: { connection: 'data', default: true } },
        resources: { lead: { access: 'write' } },
        auth: { store: join(betaHome, 'auth.db'), providers: ['email'], roles: { user: { read: true } } },
        views: { beta: { kind: 'list', from: 'lead' } },
        home: 'beta',
        nav: ['beta'],
      }),
    );
    writeFileSync(
      join(betaHome, 'connections.json'),
      JSON.stringify({ connections: [{ name: 'data', url: betaDatabase, writable: true }] }),
    );

    const file = join(directory, 'suite.json');
    writeFileSync(
      file,
      JSON.stringify({
        port,
        apps: [
          {
            id: 'intake',
            directory: './intake',
            config: './intake/connections.json',
            mount: '/',
            policy: './intake/policy.mjs',
            environment: { BETTER_AUTH_SECRET: 'SUITE_TEST_SECRET' },
          },
          {
            id: 'beta',
            directory: './beta',
            config: './beta/connections.json',
            mount: '/beta',
            environment: { BETTER_AUTH_SECRET: 'SUITE_TEST_SECRET' },
          },
        ],
      }),
    );

    const suite = await startConfiguredSuite(file, { SUITE_TEST_SECRET: 'a-test-only-suite-secret-longer-than-thirty-two-characters' });
    t.after(async () => {
      await suite.close();
    });
    const origin = `http://127.0.0.1:${port}`;

    const list = await fetch(`${origin}/api/forms`);
    assert.equal(list.status, 200);
    const forms = await list.json();
    assert.deepEqual(
      forms.forms.map((f: { id: string }) => f.id),
      ['contact', 'unavailable'],
    );

    const read = await fetch(`${origin}/api/forms/contact`);
    assert.equal(read.status, 200);
    const form = await read.json();
    assert.equal(form.form.id, 'contact');

    const body = { input: { name: 'Visitor' }, submission: 'public-submission-0001' };
    const submit = await fetch(`${origin}/api/forms/contact`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(submit.status, 200);
    const receipt = await submit.json();
    assert.equal(receipt.reference, 'CONTACT-1');
    assert.deepEqual(Object.keys(receipt).sort(), ['receipt', 'reference']);

    const replay = await fetch(`${origin}/api/forms/contact`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), receipt);

    const denied = await fetch(`${origin}/api/forms/unavailable`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ input: { name: 'Visitor' }, submission: 'public-submission-0002' }),
    });
    assert.equal(denied.status, 503, 'a row-policy form not enrolled in the policy is refused');
    assert.doesNotMatch(await denied.text(), /desk/);

    const wrongMount = await fetch(`${origin}/beta/api/forms/contact`);
    assert.equal(wrongMount.status, 401, 'a child App refuses a public form key it does not own');

    const rawCommand = await fetch(`${origin}/api/commands/execute`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'contact', input: { name: 'Visitor' } }),
    });
    assert.equal(rawCommand.status, 401, 'public form commands cannot be reached through the command route');

    const intakeDb = new DatabaseSync(intake.database);
    assert.equal((intakeDb.prepare('SELECT COUNT(*) AS n FROM inbox').get() as { n: number }).n, 1);
    intakeDb.close();
  },
);
