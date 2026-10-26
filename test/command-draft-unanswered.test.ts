/**
 * An unanswered field in a draft condition is null, three-valued as SQL is: `entry_ok = false` and
 * `entry_ok != true` are unknown until someone answers, so a question that waits on the answer stays hidden — in the
 * shared evaluator, in the run's refusal of a hidden answer or a missing shown one (judgeDraft), and in a step's
 * check (checkCommandStep). Answered "No", the dependent question shows and is asked.
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

const source = defineSource<{ request: { id: number; version: number } }>('desk');

/* Lintel's report, in small: a yes or a no as buttons, and a day asked only on its no. */
const report = defineCommand({
  source,
  target: 'request',
  targets: 'none',
  output: bool(),
  handle: () => true,
  input: {
    title: field.text({ max: 80 }),
    entry_ok: field.bool({ label: 'May we let ourselves in?', as: 'buttons' }),
    visit_on: field.date({ label: 'Day that suits you', when: 'entry_ok = false' }),
    note: field.text({ optional: true, when: 'entry_ok != true' }),
    either: field.text({ optional: true, when: "entry_ok = true or title = 'Leak'" }),
  },
});
const fields = parseCommandInput(
  {
    entry_ok: field.bool({ as: 'buttons' }),
    title: field.text(),
    visit_on: field.date({ when: 'entry_ok = false' }),
  },
  'input',
);

test('a comparison with an unanswered field is unknown, so it does not hold — = and != alike', () => {
  for (const values of [{}, { entry_ok: null }, { entry_ok: undefined }]) {
    assert.equal(draftHolds('entry_ok = false', values, fields), false);
    assert.equal(draftHolds('entry_ok != true', values, fields), false);
    assert.equal(draftHolds('entry_ok = true', values, fields), false);
  }
  assert.equal(draftHolds('entry_ok = false', { entry_ok: false }, fields), true);
  assert.equal(draftHolds('entry_ok != true', { entry_ok: false }, fields), true);
  assert.equal(draftHolds('entry_ok = false', { entry_ok: true }, fields), false);
  // An empty box is unanswered too; only `is empty` reads the null itself.
  assert.equal(draftHolds("title != 'Leak'", { title: '' }, fields), false);
  assert.equal(draftHolds('title is empty', { title: '' }, fields), true);
  assert.equal(draftHolds('title is not empty', {}, fields), false);
  // An or whose other side is unanswered holds where one side does, as SQL's does.
  assert.equal(draftHolds("entry_ok = true or title = 'Leak'", { title: 'Leak' }, fields), true);
  assert.equal(draftHolds("entry_ok = true and title = 'Leak'", { title: 'Leak' }, fields), false);
});

test('the run: an unanswered yes or no shows nothing that waits on it; answered No, the day is asked', () => {
  // Unanswered: the day is hidden, so not asked, and given it is refused as an answer nobody asked.
  assert.doesNotThrow(() => judgeDraft(report, { title: 'Tap' }));
  assert.throws(
    () => judgeDraft(report, { title: 'Tap', visit_on: '2026-11-02' }),
    (error: unknown) => error instanceof DraftRefusal && error.path === 'visit_on',
  );
  assert.throws(
    () => judgeDraft(report, { title: 'Tap', note: 'Ring twice' }),
    (error: unknown) => error instanceof DraftRefusal && error.path === 'note',
  );
  // Answered No: the day shows and is required.
  assert.throws(
    () => judgeDraft(report, { title: 'Tap', entry_ok: false }),
    (error: unknown) => error instanceof DraftRefusal && error.path === 'visit_on',
  );
  assert.doesNotThrow(() => judgeDraft(report, { title: 'Tap', entry_ok: false, visit_on: '2026-11-02' }));
  assert.doesNotThrow(() => judgeDraft(report, { title: 'Tap', entry_ok: false, visit_on: '2026-11-02', note: 'Ring twice' }));
  // Answered Yes: the day is hidden again.
  assert.throws(
    () => judgeDraft(report, { title: 'Tap', entry_ok: true, visit_on: '2026-11-02' }),
    (error: unknown) => error instanceof DraftRefusal && error.path === 'visit_on',
  );
  assert.doesNotThrow(() => judgeDraft(report, { title: 'Leak', either: 'Under the sink' }));
});

test("a step's check: unanswered, the yes or no is required and the day is not asked; answered No, the day is", () => {
  const asked = ['title', 'entry_ok', 'visit_on', 'note'];
  assert.deepEqual(checkCommandStep(report, { title: 'Tap' }, asked), { entry_ok: 'This is required.' });
  assert.deepEqual(checkCommandStep(report, { title: 'Tap', visit_on: '2026-11-02' }, asked), {
    entry_ok: 'This is required.',
    visit_on: 'This is not in the form it takes.',
  });
  assert.deepEqual(checkCommandStep(report, { title: 'Tap', entry_ok: false }, asked), { visit_on: 'This is required.' });
  assert.deepEqual(checkCommandStep(report, { title: 'Tap', entry_ok: false, visit_on: '2026-11-02' }, asked), {});
  assert.deepEqual(checkCommandStep(report, { title: 'Tap', entry_ok: true }, asked), {});
});
