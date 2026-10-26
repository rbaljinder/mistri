/**
 * A bare word in a draft condition is the kind its field holds. `battery != no` over a choice of words compares the
 * word "no": untyped, every bare yes or no was read as true or false, which a text choice never equals, so a question
 * waiting on "anything but no" never showed. Only a yes-or-no field reads yes and no as true and false. The browser
 * and the server judge with the one evaluator (draftHolds), so a step's check and the run agree with the form.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defineCommand, DraftRefusal, judgeDraft } from '../packages/mistri/src/server/commands/businessCommands.js';
import { checkCommandStep } from '../packages/mistri/src/server/commands/commandCheck.js';
import { defineSource } from '../packages/mistri/src/server/commands/commandDb.js';
import { field } from '../packages/mistri/src/server/commands/commandFields.js';
import { bool } from '../packages/mistri/src/server/commands/commandShapes.js';
import { draftHolds } from '../packages/mistri/src/shared/commandDraft.js';
import { parseCommandInput } from '../packages/mistri/src/shared/commandInputParse.js';

const BATTERY = [
  { value: 'yes', label: 'Yes, include a battery' },
  { value: 'compare', label: 'Show me both' },
  { value: 'no', label: 'Solar only' },
] as const;

const fields = parseCommandInput(
  {
    battery: field.choice(BATTERY),
    owns_home: field.bool({ as: 'buttons' }),
    note: field.text({ optional: true }),
  },
  'input',
);

test('a bare yes or no beside a choice of words compares the word', () => {
  assert.equal(draftHolds('battery != no', { battery: 'yes' }, fields), true);
  assert.equal(draftHolds('battery != no', { battery: 'compare' }, fields), true);
  assert.equal(draftHolds('battery != no', { battery: 'no' }, fields), false);
  assert.equal(draftHolds('battery = yes', { battery: 'yes' }, fields), true);
  assert.equal(draftHolds('battery = no', { battery: 'no' }, fields), true);
  // Quoted, as the workaround wrote it, it reads the same.
  assert.equal(draftHolds("battery != 'no'", { battery: 'yes' }, fields), true);
  // A text box's bare word is its words too.
  assert.equal(draftHolds('note = no', { note: 'no' }, fields), true);
  // Unanswered stays unknown, so it does not hold.
  assert.equal(draftHolds('battery != no', {}, fields), false);
});

test('a yes-or-no field still reads a bare yes and no as true and false', () => {
  assert.equal(draftHolds('owns_home = no', { owns_home: false }, fields), true);
  assert.equal(draftHolds('owns_home = yes', { owns_home: true }, fields), true);
  assert.equal(draftHolds('owns_home = false', { owns_home: false }, fields), true);
  assert.equal(draftHolds('owns_home != no', { owns_home: false }, fields), false);
});

const source = defineSource<{ quote: { id: number; version: number } }>('desk');
const quote = defineCommand({
  source,
  target: 'quote',
  targets: 'none',
  output: bool(),
  handle: () => true,
  input: {
    battery: field.choice(BATTERY),
    backup: field.text({ label: 'What should keep running?', when: 'battery != no' }),
  },
});

test('the run and the step check agree with the form: asked unless the answer is "no"', () => {
  assert.throws(
    () => judgeDraft(quote, { battery: 'yes' }),
    (error: unknown) => error instanceof DraftRefusal && error.path === 'backup',
  );
  assert.doesNotThrow(() => judgeDraft(quote, { battery: 'yes', backup: 'Fridge' }));
  assert.doesNotThrow(() => judgeDraft(quote, { battery: 'no' }));
  assert.throws(
    () => judgeDraft(quote, { battery: 'no', backup: 'Fridge' }),
    (error: unknown) => error instanceof DraftRefusal && error.path === 'backup',
  );
  assert.deepEqual(checkCommandStep(quote, { battery: 'compare' }, ['battery', 'backup']), { backup: 'This is required.' });
  assert.deepEqual(checkCommandStep(quote, { battery: 'no' }, ['battery', 'backup']), {});
});
