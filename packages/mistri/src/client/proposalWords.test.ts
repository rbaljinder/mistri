/** One vocabulary for a proposal's state: drafted, approved, the command's past tense (Done when unreadable), dismissed. */
import { expect, test } from 'vitest';
import { pastTense, proposalStateWord } from './proposalWords.js';

test("a command's label is read as its past tense, regular and irregular", () => {
  expect(pastTense('Send appeal')).toBe('Sent');
  expect(pastTense('Assign')).toBe('Assigned');
  expect(pastTense('Start working')).toBe('Started');
  expect(pastTense('Close')).toBe('Closed');
  expect(pastTense('Copy to inbox')).toBe('Copied');
  expect(pastTense('Submit claim')).toBe('Submitted');
});

test('a label that is not a verb says nothing of its own', () => {
  expect(pastTense('Approved')).toBeUndefined();
  expect(pastTense('—')).toBeUndefined();
  expect(pastTense('')).toBeUndefined();
});

test('each state has one word, and a run that has not settled stays Approved', () => {
  expect(proposalStateWord('proposed', 'Send appeal')).toBe('Drafted');
  expect(proposalStateWord('approved', 'Send appeal', false)).toBe('Approved');
  expect(proposalStateWord('approved', 'Send appeal')).toBe('Sent');
  expect(proposalStateWord('done', undefined)).toBe('Done');
  expect(proposalStateWord('done', 'Approved')).toBe('Done');
  expect(proposalStateWord('dismissed', 'Send appeal')).toBe('Dismissed');
  expect(proposalStateWord('expired', 'Send appeal')).toBe('Dismissed');
});
