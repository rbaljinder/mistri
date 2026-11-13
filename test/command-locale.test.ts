/**
 * The locale a command is served in (`ctx.locale`), over a real server: the
 * server resolves it, never the input. A signed-in person's row names it; a
 * person whose row names none is served what their picker chose (the cookie);
 * a visitor on a public form is served their pick too; a tag the App ships no
 * catalog for falls back to the App's own. A refusal naming a message
 * (`refuse(msg('booking.full'))`) is said in it, at its field when it names one.
 * SQLite always; PostgreSQL when TABLEWALK_TEST_PG is set.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { LIVE_PG, policyServer, sourceUrl } from './support/policyServer.js';

const SQL = (integer: string) => `CREATE TABLE person(id ${integer} PRIMARY KEY, email TEXT NOT NULL, locale TEXT);
  CREATE TABLE booking(id ${integer} PRIMARY KEY, name TEXT NOT NULL);
  INSERT INTO person VALUES (1, 'ana@example.org', 'es'), (2, 'bo@example.org', NULL), (3, 'cy@example.org', 'fr');`;

const COMMANDS = `import { defineCommand, defineCommands } from ${sourceUrl('packages/mistri/src/server/commands/businessCommands.ts')};
import { refuse } from ${sourceUrl('packages/mistri/src/server/commands/commandErrors.ts')};
import { literal, shape, text } from ${sourceUrl('packages/mistri/src/server/commands/commandShapes.ts')};
import { publicReferencePattern } from ${sourceUrl('packages/mistri/src/server/forms/publicReference.ts')};
import { msg } from ${sourceUrl('packages/mistri/schema/app.mjs')};
export default defineCommands({
  say: defineCommand({ targets: 'none', source: 'main', target: 'booking', read: ['booking'], write: ['booking'],
    async handle({ locale }) { refuse('Served in ' + locale + '.'); } }),
  full: defineCommand({ targets: 'none', source: 'main', target: 'booking', read: ['booking'], write: ['booking'],
    async handle() { refuse(msg('booking.full')); } }),
  ask: defineCommand({ targets: 'none', source: 'main', target: 'booking', read: ['booking'], write: ['booking'], public: true,
    input: { name: { label: 'Name', type: 'text' } },
    output: shape({ reference: text({ pattern: publicReferencePattern('ASK') }), message: literal('Received.') }),
    async handle({ locale }, value) {
      if (value.name === 'late') refuse(msg('booking.late'), { field: 'name' });
      refuse('Served in ' + locale + '.');
    } }),
});`;

const catalog = (locale: string, entries: Record<string, string>) =>
  `export default ${JSON.stringify({ kind: 'messages', locale, entries })};\n`;

async function served(t: TestContext, postgres: boolean) {
  const server = await policyServer(t, {
    app: {
      id: 'words',
      name: 'Words',
      auth: {
        signUp: 'open',
        defaultRole: 'staff',
        roles: { admin: { read: true }, staff: { read: true, commands: ['say', 'full'] } },
        me: { from: 'person', column: 'email' },
      },
      resources: { person: {}, booking: { access: 'write' } },
      views: {
        bookings: { kind: 'list', from: 'booking' },
        ask: { kind: 'form', label: 'Ask', public: true, command: 'ask' },
      },
      home: 'bookings',
      nav: ['bookings'],
      ui: { locale: { column: 'person.locale', default: 'en-US' } },
    },
    files: {
      'messages/en.mjs': catalog('en', { 'booking.full': 'The day is full.', 'booking.late': 'Too late to book.' }),
      'messages/es.mjs': catalog('es', { 'booking.full': 'El día está lleno.', 'booking.late': 'Demasiado tarde.' }),
    },
    sql: SQL(postgres ? 'integer' : 'INTEGER'),
    commands: COMMANDS,
    postgres,
  });
  const picked = (locale: string) => `mistri-locale-words=${locale}`;
  // A command that names no record has no revision to prepare.
  const execute = (command: string, input: object, cookie: string) =>
    server.api(
      'commands/execute',
      { command, commandVersion: 1, key: {}, expectedVersion: 0, idempotencyKey: randomUUID(), input },
      cookie,
    );
  const run = async (command: string, cookie: string) => {
    const done = await execute(command, {}, cookie);
    assert.notEqual(done.status, 200, JSON.stringify(done.body));
    return done.body as { code: string; reason?: string; message?: string };
  };
  // An account the owner makes is proven, so its email names its person row (an open sign-up's names nobody yet).
  const owner = await server.owner();
  const person = async (name: string) => {
    const email = `${name}@example.org`;
    const made = await server.call(
      '/api/accounts',
      { app: 'words', operation: 'create', name, email, roles: ['staff'], password: 'staff-fixture-password-1' },
      owner,
    );
    assert.equal(made.status, 200, JSON.stringify(made.body));
    return server.signIn(email, 'staff-fixture-password-1');
  };
  const said = (body: { reason?: string; message?: string }) => body.reason ?? body.message;

  // A signed-in person's row names their locale, over the picker's cookie.
  const ana = await person('ana');
  assert.equal(said(await run('say', ana)), 'Served in es.');
  assert.equal(said(await run('say', `${ana}; ${picked('en')}`)), 'Served in es.');
  assert.equal(said(await run('full', ana)), 'El día está lleno.');
  // A row naming none: what they picked, else the App's own.
  const bo = await person('bo');
  assert.equal(said(await run('say', bo)), 'Served in en-US.');
  assert.equal(said(await run('say', `${bo}; ${picked('es')}`)), 'Served in es.');
  assert.equal(said(await run('full', `${bo}; ${picked('es')}`)), 'El día está lleno.');
  assert.equal(said(await run('full', bo)), 'The day is full.');
  // A tag the App ships no catalog for falls back to the App's own: the row's, and the cookie's.
  const cy = await person('cy');
  assert.equal(said(await run('say', cy)), 'Served in en-US.');
  assert.equal(said(await run('say', `${bo}; ${picked('fr')}`)), 'Served in en-US.');
  // The input says nothing about it.
  const forged = await execute('say', { locale: 'es' }, bo);
  assert.notEqual(forged.status, 200);
  assert.notEqual(said(forged.body), 'Served in es.');

  // A visitor on the public form: their pick, else the App's own; a field's refusal is said at the field.
  const submit = (name: string, cookie?: string, query = '') =>
    server.call(`/api/forms/ask?app=words${query}`, { input: { name }, submission: randomUUID() }, cookie);
  const visitor = await submit('Ada', picked('es'));
  assert.equal(said(visitor.body), 'Served in es.', JSON.stringify(visitor.body));
  assert.equal(said((await submit('Ada')).body), 'Served in en-US.');
  assert.equal(said((await submit('Ada', picked('fr'))).body), 'Served in en-US.');
  // The language the submission's address names (the client's pick, said there), over the cookie. One more submission
  // only: the address's budget is five a minute.
  assert.equal(said((await submit('Ada', picked('fr'), '&locale=es-MX')).body), 'Served in es-MX.');
  const late = await submit('late', picked('es'));
  assert.equal(late.status, 400, JSON.stringify(late.body));
  assert.deepEqual([late.body.code, late.body.field, late.body.message], ['invalid_input', 'name', 'Demasiado tarde.']);
}

test(
  "SQLite: a command's locale is the person's row, else their pick; a visitor's is theirs; refuse(msg) is said in it",
  { timeout: 60_000 },
  (t) => served(t, false),
);

test(
  "PostgreSQL: a command's locale is the person's row, else their pick; a visitor's is theirs; refuse(msg) is said in it",
  { timeout: 60_000, skip: LIVE_PG ? false : 'TABLEWALK_TEST_PG is not set' },
  (t) => served(t, true),
);
