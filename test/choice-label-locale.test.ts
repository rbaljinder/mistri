/**
 * A choice from a table said in its reader's language (`field.choice({ from, labelColumn, labelColumns: { es } })`),
 * over a real server, on SQLite and on PostgreSQL: a public form's visitor who picked Spanish is offered each row by
 * its Spanish column, in Spanish order; a row with no Spanish name falls back to `labelColumn`; anyone else is offered
 * `labelColumn`. The rows are kept apart per locale where change capture keeps them at all. The load refuses a
 * `labelColumns` naming a locale the App has no catalog for and, on a public form, a column `auth.public` does not
 * open; a column its table lacks is warned of, as a `labelColumn` that names one is.
 *
 * Its own file: a load holds an App's catalogs under its id, and the App here is `paint`.
 */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { LIVE_PG, policyServer, refusedStart, sourceUrl, type PolicyServerOptions } from './support/policyServer.js';

const SQL = (integer: string) => `CREATE TABLE colour(id ${integer} PRIMARY KEY, name TEXT NOT NULL, name_es TEXT);
  CREATE TABLE booking(id ${integer} PRIMARY KEY, colour_id ${integer});
  INSERT INTO colour VALUES (1, 'Red', 'Rojo'), (2, 'Blue', 'Azul'), (3, 'Teal', NULL);`;

const commands = (labelColumns: Record<string, string>) => `import { defineCommand, defineCommands } from ${sourceUrl(
  'packages/mistri/src/server/commands/businessCommands.ts',
)};
import { refuse } from ${sourceUrl('packages/mistri/src/server/commands/commandErrors.ts')};
import { literal, shape, text } from ${sourceUrl('packages/mistri/src/server/commands/commandShapes.ts')};
import { publicReferencePattern } from ${sourceUrl('packages/mistri/src/server/forms/publicReference.ts')};
export default defineCommands({
  ask: defineCommand({ targets: 'none', source: 'main', target: 'booking', read: ['booking', 'colour'], write: ['booking'], public: true,
    input: { colour: { label: 'Colour', type: 'choice', from: 'colour', labelColumn: 'name', labelColumns: ${JSON.stringify(labelColumns)} } },
    output: shape({ reference: text({ pattern: publicReferencePattern('ASK') }), message: literal('Received.') }),
    async handle() { refuse('Not taken.'); } }),
});`;

const catalog = (locale: string) => `export default ${JSON.stringify({ kind: 'messages', locale, entries: { 'paint.title': locale } })};\n`;

const options = (
  postgres: boolean,
  said: { labelColumns?: Record<string, string>; publicFields?: string[] } = {},
): PolicyServerOptions => ({
  app: {
    id: 'paint',
    name: 'Paint',
    auth: {
      roles: { staff: { read: true } },
      public: { read: ['colour'], ...(said.publicFields ? { fields: { colour: { read: said.publicFields } } } : {}) },
    },
    resources: { colour: {}, booking: { access: 'write' } },
    views: {
      bookings: { kind: 'list', from: 'booking' },
      ask: { kind: 'form', label: 'Ask', public: true, done: { title: 'Thanks' }, command: 'ask' },
    },
    home: 'bookings',
    nav: ['bookings'],
    ui: { locale: 'en-US' },
  },
  files: { 'messages/en.mjs': catalog('en'), 'messages/es.mjs': catalog('es') },
  sql: SQL(postgres ? 'integer' : 'INTEGER'),
  commands: commands(said.labelColumns ?? { es: 'name_es' }),
  live: true,
  postgres,
});

async function offered(t: TestContext, postgres: boolean) {
  const server = await policyServer(t, options(postgres));
  const choices = async (cookie?: string) => {
    const answer = await server.call('/api/forms/ask?app=paint', undefined, cookie);
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    const field = (answer.body.form.input as Array<{ name: string; options: Array<{ value: number; label: string }> }>).find(
      (each) => each.name === 'colour',
    );
    return field!.options.map((option) => `${option.value}:${option.label}`);
  };
  const spanish = 'mistri-locale-paint=es';
  const english = ['2:Blue', '1:Red', '3:Teal'];
  assert.deepEqual(await choices(spanish), ['2:Azul', '1:Rojo', '3:Teal'], 'by the Spanish column, in its order; none falls back');
  assert.deepEqual(await choices(), english, 'by labelColumn');
  assert.deepEqual(await choices('mistri-locale-paint=es-MX'), ['2:Azul', '1:Rojo', '3:Teal'], "a region is shown its language's");
  // Asked again, each locale is answered its own: an entry each, where the capture keeps them.
  assert.deepEqual(await choices(spanish), ['2:Azul', '1:Rojo', '3:Teal']);
  assert.deepEqual(await choices('mistri-locale-paint=en'), english);
}

test("SQLite: a choice from a table is said in its reader's language, else by labelColumn", { timeout: 60_000 }, (t) => offered(t, false));

test(
  "PostgreSQL: a choice from a table is said in its reader's language, else by labelColumn",
  { timeout: 60_000, skip: LIVE_PG ? false : 'TABLEWALK_TEST_PG is not set' },
  (t) => offered(t, true),
);

test(
  'the load refuses labelColumns naming a locale with no catalog or a column the public cannot read, and warns of a missing one',
  {
    timeout: 90_000,
  },
  async (t) => {
    const french = await refusedStart(t, options(false, { labelColumns: { fr: 'name_es' } }));
    assert.match(french, /input "colour" names a label column for "fr" \(labelColumns\), and the App has no catalog for it/);
    // A column the table lacks is said as labelColumn's is: the form is held back with why, and startup warns of it.
    const missing = await policyServer(t, options(false, { labelColumns: { es: 'name_fr' } }));
    assert.match(missing.log(), /App warning: [^\n]*"colour" has no column "name_fr"/);
    const closed = await refusedStart(t, options(false, { publicFields: ['id', 'name'] }));
    assert.match(closed, /\[public-form-picker\][^\n]*a visitor may not read its column "name_es"/);
    const malformed = await refusedStart(t, options(false, { labelColumns: { 'not a tag': 'name_es' } }));
    assert.match(malformed, /labelColumns: "not a tag" is not a locale tag/);
  },
);
