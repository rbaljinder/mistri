/**
 * A masked text may word its own refusal: a mask is the field's pattern, so `message` is what a value that does not
 * fill it says ("Enter the 5 digits of your ZIP"), as it is for a pattern or a format. Without a mask, a pattern or a
 * format, a message has nothing to say and is still refused.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { field } from '../packages/mistri/src/server/commands/commandFields.js';
import { commandInputProblems } from '../packages/mistri/src/shared/commandInput.js';
import { parseCommandInput } from '../packages/mistri/src/shared/commandInputParse.js';

test('a masked text takes a message, and a value short of the mask is refused as its pattern', () => {
  const fields = parseCommandInput(
    { zip: field.text({ label: 'ZIP code', mask: '00000', message: 'Enter the 5 digits of your ZIP.' }) },
    'input',
  );
  assert.equal((fields[0] as { message?: string }).message, 'Enter the 5 digits of your ZIP.');
  assert.deepEqual(
    commandInputProblems(fields, { zip: '803' }).map((problem) => [problem.path, problem.reason]),
    [['zip', 'pattern']],
  );
  assert.deepEqual(commandInputProblems(fields, { zip: '80302' }), []);
});

test('a message with nothing to say is still refused', () => {
  assert.throws(
    () => parseCommandInput({ city: field.text({ message: 'Say a city.' }) }, 'input'),
    /message is what a pattern, format or mask says/,
  );
});
