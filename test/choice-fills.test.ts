/**
 * A choice that fills other inputs (`default: { answer: '<choice>.<column>' }`): what the load refuses, with the fix in
 * the message, and what a public form's rows carry. The source is a choice of the same input, group or line, from a
 * table (a column) or written out (a key of an option's `values`); a fill never chains, and a signed-out visitor is
 * served only the columns `auth.public` opens. What a pick does in the form is the component test's
 * (CommandFields.fills.test.tsx).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { policyServer, refusedStart, sourceUrl, type PolicyServerOptions } from './support/policyServer.js';
import { choiceFillColumns, choiceFills } from '../packages/mistri/src/shared/command.js';
import { parseCommandInput } from '../packages/mistri/src/shared/commandInputParse.js';

const parse = (input: object, publicForm = false) => parseCommandInput(input, 'command "book"', { publicForm });

const table = { type: 'choice', from: 'treatment', labelColumn: 'name' };
const written = {
  type: 'choice',
  options: [
    { value: 'basic', label: 'Basic', values: { seats: 5 } },
    { value: 'team', label: 'Team', values: { seats: 25, tier: 'Growth' } },
  ],
};
const filled = (answer: string) => ({ type: 'number', optional: true, default: { answer } });

test('a table choice and a written one are sources; each input and the column it takes are read back', () => {
  const list = parse({ treatment: table, minutes: filled('treatment.usual_minutes'), fee: filled('treatment.usual_fee') });
  assert.deepEqual(choiceFills(list, 'treatment'), { minutes: 'usual_minutes', fee: 'usual_fee' });
  assert.deepEqual(choiceFillColumns(list, 'treatment'), ['usual_fee', 'usual_minutes']);
  const plan = parse({
    plan: written,
    seats: filled('plan.seats'),
    tier: { type: 'text', optional: true, default: { answer: 'plan.tier' } },
  });
  assert.deepEqual(choiceFills(plan, 'plan'), { seats: 'seats', tier: 'tier' });
  assert.deepEqual((plan[0] as unknown as { options: Array<{ values?: unknown }> }).options[1].values, { seats: 25, tier: 'Growth' });
});

test('a fill is said as a choice and a column, and names an input that is a choice beside it', () => {
  assert.throws(() => parse({ treatment: table, minutes: filled('usual_minutes') }), /{ answer } names a choice input and a column/);
  assert.throws(() => parse({ treatment: table, minutes: filled('treatment.a.b') }), /{ answer } names a choice input and a column/);
  assert.throws(
    () => parse({ minutes: filled('treatment.usual_minutes') }),
    /input "minutes" default { answer: 'treatment.usual_minutes' } names "treatment", which is not a choice beside it: a fill is from a choice of this input/,
  );
  assert.throws(() => parse({ minutes: filled('minutes.x') }), /which is not a choice beside it/);
  assert.throws(
    () => parse({ treatment: { type: 'text' }, minutes: filled('treatment.usual_minutes') }),
    /names "treatment", a text field; only a choice, one pick, fills other inputs/,
  );
  assert.throws(
    () => parse({ many: { type: 'choices', from: 'treatment', labelColumn: 'name' }, minutes: filled('many.usual_minutes') }),
    /names "many", a choices field; only a choice, one pick/,
  );
});

test('a written choice needs an option that carries the key, and its values are scalars', () => {
  assert.throws(() => parse({ plan: written, seats: filled('plan.nope') }), /no option of "plan" carries values\.nope/);
  assert.throws(
    () => parse({ plan: { type: 'choice', options: [{ value: 'a', label: 'A', values: { seats: { n: 1 } } }] } }),
    /values: "seats" is text of at most 500 characters, a finite number, true, false or null/,
  );
  assert.throws(
    () => parse({ plan: { type: 'choice', options: [{ value: 'a', label: 'A', values: [] }] } }),
    /values: is an object of keys/,
  );
});

test('a fill does not chain, and a sensitive input is never filled', () => {
  assert.throws(
    () => parse({ treatment: table, minutes: filled('treatment.usual_minutes'), more: filled('minutes.x') }),
    /names "minutes", a number field; only a choice/,
  );
  assert.throws(
    () =>
      parse({
        first: table,
        second: { ...table, default: { answer: 'first.usual_pick' } },
        fee: filled('second.usual_fee'),
      }),
    /names "second", which is itself filled from another input; a fill does not chain/,
  );
  assert.throws(
    () => parse({ treatment: table, code: { type: 'text', sensitive: { keep: 'hash' }, default: { answer: 'treatment.code' } } }),
    /a sensitive field is never prefilled/,
  );
});

test('a choice fills its own group or line, never one in another', () => {
  const group = (fields: object) => ({ type: 'group', repeat: { max: 3 }, fields });
  const lines = parse({ visits: group({ treatment: table, minutes: filled('treatment.usual_minutes') }) });
  assert.deepEqual(choiceFills((lines[0] as unknown as { fields: never[] }).fields, 'treatment'), { minutes: 'usual_minutes' });
  assert.throws(
    () => parse({ treatment: table, visits: group({ minutes: filled('treatment.usual_minutes') }) }),
    /which is not a choice beside it: a fill is from a choice of the same group or line/,
  );
  assert.throws(
    () => parse({ visits: group({ treatment: table }), minutes: filled('treatment.usual_minutes') }),
    /which is not a choice beside it: a fill is from a choice of this input/,
  );
});

/* The public form's rows: a visitor is served each pick's columns, so only the ones `auth.public` opens. */
const SQL = `CREATE TABLE treatment(id INTEGER PRIMARY KEY, name TEXT NOT NULL, usual_minutes INTEGER, secret_cost INTEGER);
  CREATE TABLE booking(id INTEGER PRIMARY KEY, treatment_id INTEGER, minutes INTEGER);
  INSERT INTO treatment VALUES (1, 'Cleaning', 30, 7), (2, 'Filling', 60, 9);`;

const commands = (column: string) => `import { defineCommand, defineCommands } from ${sourceUrl(
  'packages/mistri/src/server/commands/businessCommands.ts',
)};
import { refuse } from ${sourceUrl('packages/mistri/src/server/commands/commandErrors.ts')};
import { literal, shape, text } from ${sourceUrl('packages/mistri/src/server/commands/commandShapes.ts')};
import { publicReferencePattern } from ${sourceUrl('packages/mistri/src/server/forms/publicReference.ts')};
export default defineCommands({
  book: defineCommand({ targets: 'none', source: 'main', target: 'booking', read: ['booking', 'treatment'], write: ['booking'], public: true,
    input: ${JSON.stringify({
      treatment: { label: 'Treatment', type: 'choice', from: 'treatment', labelColumn: 'name' },
      minutes: { label: 'Minutes', type: 'number', optional: true, default: { answer: `treatment.${column}` } },
    })},
    output: shape({ reference: text({ pattern: publicReferencePattern('BOOK') }), message: literal('Received.') }),
    async handle() { refuse('Not taken.'); } }),
});`;

const options = (column: string, publicFields?: string[]): PolicyServerOptions => ({
  app: {
    id: 'dental',
    name: 'Dental',
    auth: {
      roles: { staff: { read: true } },
      public: { read: ['treatment'], ...(publicFields ? { fields: { treatment: { read: publicFields } } } : {}) },
    },
    resources: { treatment: {}, booking: { access: 'write' } },
    views: {
      bookings: { kind: 'list', from: 'booking' },
      book: { kind: 'form', label: 'Book', public: true, done: { title: 'Thanks' }, command: 'book' },
    },
    home: 'bookings',
    nav: ['bookings'],
  },
  sql: SQL,
  commands: commands(column),
  live: true,
});

test('a public form is served the filled column on each row, and no other', { timeout: 60_000 }, async (t) => {
  const server = await policyServer(t, options('usual_minutes'));
  const answer = await server.call('/api/forms/book?app=dental');
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  const picked = (answer.body.form.input as Array<{ name: string; options?: Array<{ value: number; row?: object }> }>).find(
    (each) => each.name === 'treatment',
  )!;
  assert.deepEqual(
    picked.options!.map((option) => [option.value, option.row]),
    [
      [1, { usual_minutes: 30 }],
      [2, { usual_minutes: 60 }],
    ],
  );
});

test(
  'a column the public may not read is refused at load, by name; a column the table lacks holds the form back',
  { timeout: 120_000 },
  async (t) => {
    const closed = await refusedStart(t, options('usual_minutes', ['id', 'name']));
    assert.match(closed, /\[public-form-picker\][^\n]*a visitor may not read its column "usual_minutes"/);
    const missing = await policyServer(t, options('nope'));
    assert.match(missing.log(), /App warning: [^\n]*"treatment\.nope"[^\n]*"treatment" has no column "nope"/);
  },
);
