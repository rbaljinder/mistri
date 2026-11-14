import { expect, test } from 'vitest';
import { offeredChoices } from './pickerStaleness.js';

const label = (row: string) => row;

test('an answer for what the box says is offered whole, and may say nothing matches', () => {
  expect(offeredChoices({ typed: 'Bea', asked: 'Bea', rows: ['Bea South'], label })).toEqual({ choices: ['Bea South'], answered: true });
  expect(offeredChoices({ typed: 'Zed', asked: 'Zed', rows: [], label, last: ['Bea South'] })).toEqual({ choices: [], answered: true });
});

test('rows that answer earlier text keep only what the box names', () => {
  expect(offeredChoices({ typed: 'be', asked: '', rows: ['Ada North', 'Bea South'], label })).toEqual({
    choices: ['Bea South'],
    answered: false,
  });
  // Rows kept from an earlier question answer something else, whatever was asked.
  expect(offeredChoices({ typed: 'Bea', asked: 'Bea', placeholder: true, rows: ['Ada North', 'Bea South'], label }).answered).toBe(false);
});

/* An editable field asks for its chosen record's label while it shows it ("Ada North"). Someone types "Bea": the list
   opens on the rows it had, then the answer for the label lands and names nothing typed. The list went away for the
   pause before the next request and came back, and a press on "Bea South" fell on the page under it. */
test('an answer for other text that names nothing typed does not take the offered rows away', () => {
  const offered = offeredChoices({ typed: 'Bea', asked: '', placeholder: true, rows: ['Ada North', 'Bea South'], label });
  expect(offered.choices).toEqual(['Bea South']);
  const meanwhile = offeredChoices({ typed: 'Bea', asked: 'Ada North', rows: ['Ada North'], label, last: offered.choices });
  expect(meanwhile).toEqual({ choices: ['Bea South'], answered: false });
  // Only what the box still names: typing on narrows the kept rows as it narrows any others.
  expect(offeredChoices({ typed: 'Beat', asked: 'Ada North', rows: ['Ada North'], label, last: offered.choices }).choices).toEqual([]);
});
