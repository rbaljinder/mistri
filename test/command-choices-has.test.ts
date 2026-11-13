/**
 * `has` on an answer of several choices (`services has cleaning`, `services has (cleaning, repairs)`) in a field's
 * `when` and a command's rules: true where the list holds any of the values. The browser judges the draft as someone
 * types and the server judges it as the command runs, by one evaluator (commandDraft.ts), and `has` is refused where
 * it asks something that is not a list of choices, or a list is compared whole.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileCondition } from '../packages/engine/src/shared/formValues.js';
import { defineCommand } from '../packages/mistri/src/server/commands/businessCommands.js';
import { field } from '../packages/mistri/src/server/commands/commandFields.js';
import { bool } from '../packages/mistri/src/server/commands/commandShapes.js';
import { defineSource } from '../packages/mistri/src/server/commands/commandDb.js';
import { brokenRules, draftHolds } from '../packages/mistri/src/shared/commandDraft.js';
import { parseCommandInput } from '../packages/mistri/src/shared/commandInputParse.js';

const SERVICES = [
  { value: 'cleaning', label: 'Cleaning' },
  { value: 'repairs', label: 'Repairs' },
  { value: 'storage', label: 'Storage' },
];
const fields = parseCommandInput(
  {
    name: field.text({ max: 40 }),
    services: field.choices(SERVICES, { optional: true }),
    visit: field.text({ optional: true, when: 'services has (cleaning, repairs)' }),
  },
  'input',
);

test('has compiles to a comparison that holds any of its values', () => {
  assert.deepEqual(compileCondition('services has cleaning', 'when'), [[{ field: 'services', operator: 'has', values: ['cleaning'] }]]);
  assert.deepEqual(compileCondition("services has ('cleaning', repairs)", 'when'), [
    [{ field: 'services', operator: 'has', values: ['cleaning', 'repairs'] }],
  ]);
  // Read against the fields' kinds, a choices answer is the one column `has` may ask.
  const columns = [{ name: 'services', type: 'choices', nullable: true, primaryKey: false }];
  assert.deepEqual(compileCondition('services has cleaning and services has repairs', 'when', columns).flat().length, 2);
  assert.throws(
    () => compileCondition('services has cleaning', 'when', [{ name: 'services', type: 'TEXT', nullable: true, primaryKey: false }]),
    /"has" asks .* several choices, and "services" is none of them/,
  );
  assert.throws(() => compileCondition('services = cleaning', 'when', columns), /"services" holds several choices: ask it with has/);
  // The refusal for a word operator names has among what a condition may use.
  assert.throws(() => compileCondition('name contains Ana', 'when'), /compare with =, !=, <, <=, >, >=, in, has .* or is empty/);
});

test('a draft holds where its list of answers holds one of the values', () => {
  const holds = (condition: string, values: Record<string, unknown>) => draftHolds(condition, values, fields);
  assert.equal(holds('services has cleaning', { services: ['cleaning', 'storage'] }), true);
  assert.equal(holds('services has cleaning', { services: ['storage'] }), false);
  assert.equal(holds('services has (cleaning, repairs)', { services: ['storage', 'repairs'] }), true);
  assert.equal(holds('services has (cleaning, repairs)', { services: ['storage'] }), false);
  // Unanswered is null, and a comparison with null is not true, as every other field's is.
  assert.equal(holds('services has cleaning', {}), false);
  assert.equal(holds('services has cleaning', { services: [] }), false);
  assert.equal(holds("services has cleaning and name = 'Ana'", { services: ['cleaning'], name: 'Ana' }), true);
  assert.equal(holds("services has storage or name = 'Ana'", { services: ['cleaning'], name: 'Ana' }), true);
  // A field named on the right of has is a word, never another field.
  assert.equal(holds('services has name', { services: ['name'], name: 'Ana' }), true);
});

test('a number option is asked as it is written', () => {
  const sizes = parseCommandInput(
    {
      sizes: field.choices(
        [
          { value: 1, label: 'One' },
          { value: 2, label: 'Two' },
        ],
        { optional: true },
      ),
    },
    'input',
  );
  assert.equal(draftHolds('sizes has 2', { sizes: [1, 2] }, sizes), true);
  assert.equal(draftHolds('sizes has 3', { sizes: [1, 2] }, sizes), false);
});

test('a rule may ask a list with has, and breaks at its field', () => {
  const rules = [{ must: 'services has cleaning', when: "name = 'Ana'", message: 'Ana always has cleaning.' }];
  assert.deepEqual(brokenRules(rules, { name: 'Ana', services: ['storage'] }, fields), [
    { field: 'services', message: 'Ana always has cleaning.' },
  ]);
  assert.deepEqual(brokenRules(rules, { name: 'Ana', services: ['cleaning'] }, fields), []);
  assert.deepEqual(brokenRules(rules, { name: 'Bo', services: ['storage'] }, fields), []);
});

test('check refuses has on a field that is not a list of choices, and a list compared whole', () => {
  const asked = (when: string) => () =>
    parseCommandInput(
      { name: field.text({ max: 40 }), services: field.choices(SERVICES, { optional: true }), more: field.text({ optional: true, when }) },
      'input',
    );
  assert.doesNotThrow(asked('services has cleaning'));
  assert.throws(
    asked('name has cleaning'),
    /input "more" is asked when "name"…, a text field, and has asks the several answers of a choices field/,
  );
  assert.throws(asked('services = cleaning'), /"services"…, a choices field is a list, which a condition asks with has/);
  assert.throws(asked('services has cleaning or services is empty'), /a choices field is a list/);
  assert.throws(asked('record.services has cleaning'), /asks a field of the input; has reads the several answers of a choices field/);
});

test('a command refuses a rule that asks has of anything but a choices field', () => {
  const define = (rule: { must: string; message: string }) => () =>
    defineCommand({
      source: defineSource<{ request: { id: number; version: number } }>('desk'),
      target: 'request',
      targets: 'none',
      output: bool(),
      handle: () => true,
      input: { name: field.text({ max: 40 }), services: field.choices(SERVICES, { optional: true }) },
      rules: [rule],
    });
  assert.doesNotThrow(define({ must: 'services has cleaning', message: 'Cleaning is needed.' }));
  assert.throws(
    define({ must: 'name has cleaning', message: 'No.' }),
    /Command rules 1 names "name", a text field, and has asks the several answers/,
  );
  assert.throws(define({ must: 'services = cleaning', message: 'No.' }), /Command rules 1 names "services", a choices field is a list/);
});
