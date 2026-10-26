/**
 * Conditions in an App reader's words: every operator, the column types
 * that change how a value is said, lists, emptiness, references by name,
 * and the columns whose values are never said. Without an App — the
 * Workbench — the language as written.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { MASK } from '../../../../engine/src/shared/model.js';
import { setMessageLanguage, setMessageScope } from '../messages.js';
import { andWords, referencedIds, sayCondition, sayFilter, sayQuestion, sayTails, type ConditionSpeaker } from './conditionWords.js';
import type { DisplayRule } from './valueModel.js';

const col = (name: string, type: string, extra = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
const columns = Object.fromEntries(
  [
    col('status', 'TEXT', { allowed: ['open', 'in_progress', 'done'] }),
    col('claim_number', 'TEXT'),
    col('rent', 'INTEGER'),
    col('due_on', 'DATE'),
    col('owner_id', 'INTEGER', { references: { table: 'person', column: 'id' } }),
    col('notes', 'TEXT'),
    col('is_urgent', 'BOOLEAN'),
    col('priority', 'INTEGER'),
    col('ssn', 'TEXT'),
    col('card', 'TEXT'),
    col('stage', 'TEXT'),
    col('score', 'INTEGER'),
    col('reorder_level', 'INTEGER'),
    col('amount', 'NUMERIC'),
    col('kind', 'TEXT'),
  ].map((c) => [c.name, c]),
);
const labels: Record<string, string> = {
  claim_number: 'Claim number',
  due_on: 'Due',
  owner_id: 'Owner',
  'owner_id.name': 'Owner',
  is_urgent: 'Urgent',
  reorder_level: 'Reorder level',
};
const rules: Record<string, DisplayRule> = {
  rent: { format: 'money', currency: 'USD', unit: '/mo' },
  ssn: { masked: true },
  card: { masked: { prefix: '4111' } },
  stage: { values: { won: 'Closed won', lost: 'Closed lost' } },
  score: { format: 'percent' },
  priority: { tone: { '>= 3': 'bad' } },
  amount: { format: 'money', tone: { '>= 1000': 'good' } },
  kind: { tone: { in_person: 'good' } },
};
const people: Record<string, string> = { 3: 'Dana Ward', 7: 'Sam Reyes' };
const sp: ConditionSpeaker = {
  column: (name) => columns[name],
  label: (name) => labels[name] ?? name.charAt(0).toUpperCase() + name.slice(1).replace(/_/g, ' '),
  rule: (name) => rules[name] ?? null,
  recordName: (column, id) => (column === 'owner_id' ? people[id] : undefined),
};
const said = (condition: string) => sayCondition(sp, condition);
const thisYear = new Date().getFullYear();

afterEach(() => {
  setMessageLanguage('en');
  setMessageScope();
});

describe('each operator', () => {
  test('equality and its negation, in the vocabulary’s words', () => {
    expect(said('status = done')).toBe('Status is Done');
    expect(said('status != done')).toBe('Status is not Done');
    expect(said('status = in_progress')).toBe('Status is In progress');
  });
  test('the comparisons on a figure, in the rule’s money', () => {
    expect(said('rent >= 1000')).toBe('Rent from $1,000/mo');
    expect(said('rent <= 2500')).toBe('Rent up to $2,500/mo');
    expect(said('rent > 1000')).toBe('Rent more than $1,000/mo');
    expect(said('rent < 1000')).toBe('Rent less than $1,000/mo');
    expect(said('rent between 1000 and 2000')).toBe('Rent $1,000/mo – $2,000/mo');
    expect(said('score >= 90')).toBe('Score from 90%');
    expect(said('priority = 2')).toBe('Priority is 2');
    // A toned figure is still the rule's figure; a toned word is the pill's word.
    expect(said('amount >= 1000')).toBe('Amount from $1,000');
    expect(said('kind = in_person')).toBe('Kind is In person');
  });
  test('the comparisons on a date, as days', () => {
    expect(said(`due_on < ${thisYear}-10-01`)).toBe('Due before Oct 1');
    expect(said(`due_on > ${thisYear}-10-01`)).toBe('Due after Oct 1');
    expect(said(`due_on >= ${thisYear}-10-01`)).toBe('Due on or after Oct 1');
    expect(said(`due_on <= ${thisYear}-10-01`)).toBe('Due on or before Oct 1');
    expect(said('due_on <= 2019-10-01')).toBe('Due on or before Oct 1, 2019');
    expect(said(`due_on between ${thisYear}-10-01 and ${thisYear}-10-31`)).toBe('Due Oct 1 – Oct 31');
  });
  test('relative dates, as the presets say them', () => {
    expect(said('due_on = today')).toBe('Due today');
    expect(said('due_on = this week')).toBe('Due this week');
    expect(said('due_on = this quarter')).toBe('Due this quarter');
    expect(said('due_on = next quarter')).toBe('Due next quarter');
    expect(said('due_on = last 30 days')).toBe('Due in the last 30 days');
    expect(said('due_on = next 7 days')).toBe('Due in the next 7 days');
    expect(said('due_on < today')).toBe('Due before today');
  });
  test('the text operators, the reader’s text in quotes', () => {
    expect(said('claim_number contains zzzz')).toBe('Claim number contains “zzzz”');
    expect(said('claim_number contains "no show"')).toBe('Claim number contains “no show”');
    expect(said('claim_number not contains zzzz')).toBe('Claim number does not contain “zzzz”');
    expect(said('claim_number startswith CL-')).toBe('Claim number starts with “CL-”');
    expect(said('claim_number endswith 9')).toBe('Claim number ends with “9”');
    expect(said('claim_number like "CL-%"')).toBe('Claim number matches “CL-%”');
    // An exact value is the value; only a searched-for fragment is quoted.
    expect(said('claim_number = CL-9')).toBe('Claim number is CL-9');
  });
  test('empty and not empty', () => {
    expect(said('notes is empty')).toBe('Notes is empty');
    expect(said('notes is not empty')).toBe('Notes is not empty');
  });
  test('a flag says yes or no', () => {
    expect(said('is_urgent = true')).toBe('Urgent is Yes');
    expect(said('is_urgent = false')).toBe('Urgent is No');
  });
  test('me, and another column by its label', () => {
    expect(said('owner_id = me')).toBe('Owner is me');
    expect(said('priority < reorder_level')).toBe('Priority less than Reorder level');
  });
});

describe('lists and groups', () => {
  test('in and or-groups of one column read as one list', () => {
    expect(said('status in (open, done)')).toBe('Status is Open or Done');
    expect(said('status in (open, in_progress, done)')).toBe('Status is Open, In progress or Done');
    expect(said('(status = open or status = done)')).toBe('Status is Open or Done');
  });
  test('two negations of one column read as one', () => {
    expect(sayTails(sp, 'stage', ['!= won', '!= lost'])).toBe('Stage is not Closed won or Closed lost');
  });
  test('an or across columns, and a range written in two', () => {
    expect(said('status = open or is_urgent = true')).toBe('Status is Open or Urgent is Yes');
    expect(sayTails(sp, 'rent', ['>= 1000', '<= 2000'])).toBe('Rent $1,000/mo – $2,000/mo');
  });
  test('a filter, one phrase per condition; a question with its sort', () => {
    expect(sayFilter(sp, 'status != done and claim_number contains zzzz')).toEqual(['Status is not Done', 'Claim number contains “zzzz”']);
    expect(sayQuestion(sp, 'status = open sort due_on desc')).toEqual(['Status is Open', 'Sorted by Due, descending']);
    expect(andWords(['A', 'B', 'C'])).toBe('A, B and C');
  });
});

describe('references by name', () => {
  test('an id is said by its record’s name, once read', () => {
    expect(said('owner_id = 3')).toBe('Owner is Dana Ward');
    expect(said('owner_id in (3, 7)')).toBe('Owner is Dana Ward or Sam Reyes');
    expect(said('owner_id = 99')).toBe('Owner is 99');
  });
  test('the ids to read are gathered from every condition, me aside', () => {
    expect(referencedIds(sp, 'owner_id in (3, 7) and (owner_id = 9 or status = open) and owner_id != me')).toEqual(
      new Map([['owner_id', ['3', '7', '9']]]),
    );
  });
  test('a path is said by the reference it starts from', () => {
    expect(said('owner_id.name contains Dana')).toBe('Owner contains “Dana”');
  });
});

describe('what is never said', () => {
  test('a masked column’s value is the mask, whatever the operator', () => {
    expect(said('ssn = 123-45-6789')).toBe(`Ssn is ${MASK}`);
    expect(said('ssn contains 6789')).toBe(`Ssn contains ${MASK}`);
    expect(said('card startswith 4111')).toBe(`Card starts with ${MASK}`);
    expect(said('ssn is empty')).toBe('Ssn is empty');
  });
  test('a column this reader is not served is neither named nor valued', () => {
    for (const text of ['salary > 100000', 'salary.band = top', 'secret_code contains abc']) {
      const words = said(text);
      expect(words).toBe('Another condition');
      expect(words).not.toMatch(/salary|secret|100000|abc|top/i);
    }
  });
  test('no operator symbol or physical name survives', () => {
    for (const text of ['status != done', 'rent >= 1000', 'claim_number contains zzzz', 'due_on < today', 'owner_id in (3, 7)']) {
      expect(said(text)).not.toMatch(/!=|>=|<=|[<>=]|_| in \(|contains zzzz/);
    }
  });
  test('a condition the words cannot read is not echoed', () => {
    expect(said('status ~~ weird')).toBe('Another condition');
  });
});

test('the connectives come from the catalog', async () => {
  setMessageScope('words-test');
  // A language other than English is its own chunk, fetched when chosen.
  await setMessageLanguage('es');
  expect(said('status in (open, done)')).toBe('Status es Open o Done');
  expect(andWords(['A', 'B'])).toBe('A y B');
});

test('without an App, the Workbench’s language as written', () => {
  expect(sayCondition(null, 'status != done')).toBe('status != done');
  expect(sayTails(null, 'claim_number', ['contains zzzz'])).toBe('claim_number contains zzzz');
  expect(sayQuestion(null, 'status = open sort due_on')).toEqual(['status = open sort due_on']);
});
