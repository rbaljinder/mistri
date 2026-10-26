/**
 * The assistant's starters by place (`assistant({ starters })`): a bare line
 * everywhere, `{ text, views, records }` only in those views' rooms or on a
 * record of those tables. What an author may write and `mistri check`
 * refuses, what a reader is served, and which lines a place offers. The panel
 * drawing them is AssistantPanel.test.tsx.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { startersHere } from '../packages/mistri/src/shared/appAssistant.js';
import { servedApp } from '../packages/mistri/src/shared/appPayload.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

const col = (name: string) => ({ name, type: 'text', nullable: true, primaryKey: name === 'id' }) as never;
const SCHEMA: DatabaseSchema = {
  label: 'desk',
  dialect: 'postgres',
  readAt: '',
  tables: ['incident', 'deal'].map((name) => ({
    name,
    schema: 'public',
    id: `public.${name}`,
    columns: [col('id'), col('name')],
    isView: false,
  })) as never,
  foreignKeys: [],
};

const raw = (starters: unknown, assistant: Record<string, unknown> = {}) => ({
  id: 'desk',
  name: 'Desk',
  connection: 'x',
  resources: { incident: {}, deal: {} },
  views: {
    tickets: { kind: 'list', from: 'incident' },
    pipeline: { kind: 'list', from: 'deal' },
    overview: { kind: 'dashboard', label: 'Overview', sections: [{ kind: 'view', view: 'tickets' }] },
  },
  home: 'tickets',
  nav: ['tickets', 'pipeline', 'overview'],
  assistant: { starters, ...assistant },
});

const STARTERS = [
  'Which tickets are mine?',
  { text: 'Summarize this ticket', records: ['incident'] },
  { text: 'Find stale deals', views: ['pipeline'] },
  { text: 'What is breaching soon?', views: ['tickets', 'overview'], records: ['incident'] },
];

test('a starter may name where it is offered: views, records of a table, or both', () => {
  const app = parseAppConfig(raw(STARTERS), 'test');
  assert.deepEqual(app.assistant?.starters, STARTERS);
  /* Served: a record's table by its id, as the browser's walk names it. */
  assert.deepEqual(servedApp(app, SCHEMA).assistant?.starters, [
    'Which tickets are mine?',
    { text: 'Summarize this ticket', records: ['public.incident'] },
    { text: 'Find stale deals', views: ['pipeline'] },
    { text: 'What is breaching soon?', views: ['tickets', 'overview'], records: ['public.incident'] },
  ]);
});

test('a reader is not served the views they cannot open, and a starter left with no place is dropped', () => {
  const app = parseAppConfig(raw(STARTERS), 'test');
  const { pipeline: _gone, overview: _too, ...views } = app.views;
  assert.deepEqual(servedApp({ ...app, views, nav: [{ view: 'tickets' }] }, SCHEMA).assistant?.starters, [
    'Which tickets are mine?',
    { text: 'Summarize this ticket', records: ['public.incident'] },
    { text: 'What is breaching soon?', views: ['tickets'], records: ['public.incident'] },
  ]);
});

test('each place offers the bare lines and its own, in the App’s order', () => {
  const served = servedApp(parseAppConfig(raw(STARTERS), 'test'), SCHEMA).assistant?.starters;
  assert.deepEqual(startersHere(served, { view: 'pipeline' }), ['Which tickets are mine?', 'Find stale deals']);
  assert.deepEqual(startersHere(served, { view: 'tickets' }), ['Which tickets are mine?', 'What is breaching soon?']);
  assert.deepEqual(startersHere(served, { record: 'public.incident' }), [
    'Which tickets are mine?',
    'Summarize this ticket',
    'What is breaching soon?',
  ]);
  /* A deal's record is not a ticket's: "Summarize this ticket" stays off the pipeline. */
  assert.deepEqual(startersHere(served, { record: 'public.deal' }), ['Which tickets are mine?']);
  assert.deepEqual(startersHere(served, {}), ['Which tickets are mine?']);
  assert.deepEqual(startersHere(undefined, { view: 'tickets' }), []);
});

test('mistri check refuses a starter that names a place the App does not have', () => {
  const refused: Array<[unknown, RegExp, Record<string, unknown>?]> = [
    [[{ text: 'Hi', views: ['nowhere'] }], /starters\[0\]\.views names "nowhere", which is not one of this App's views/],
    [[{ text: 'Hi', records: ['invoice'] }], /starters\[0\]\.records names "invoice", which no list view or page/],
    [[{ text: 'Hi' }], /names no place/],
    [[{ text: 'Hi', views: [] }], /non-empty list of view keys/],
    [[{ text: 'Hi', views: ['tickets'], when: 'x' }], /unknown key "when"/],
    [[{ text: ' ', views: ['tickets'] }], /one line of at most 120/],
    [['Hi', { text: 'Hi', views: ['tickets'] }], /names "Hi" twice/],
    /* "this ticket" is the open record: a starter on records needs the assistant to be handed it. */
    [[{ text: 'Hi', records: ['incident'] }], /add "record" to placement/, { placement: ['panel'] }],
    /* Six in any one place: the four bare lines with three of the pipeline's own are seven there. */
    [['a', 'b', 'c', 'd', ...['e', 'f', 'g'].map((text) => ({ text, views: ['pipeline'] }))], /7 starters in view "pipeline"/],
    [['a', 'b', 'c', ...['d', 'e', 'f', 'g'].map((text) => ({ text, records: ['deal'] }))], /7 starters on a deal record/],
    [['a', 'b', 'c', 'd', 'e', 'f', 'g'], /7 starters everywhere/],
  ];
  for (const [starters, message, assistant] of refused) {
    assert.throws(
      () => parseAppConfig(raw(starters, assistant), 'test'),
      (error: { problems?: string[]; message: string }) => (error.problems ?? [error.message]).some((problem) => message.test(problem)),
      JSON.stringify(starters),
    );
  }
  /* Six in every place, though the App declares more: each view's room and each record has its own. */
  const many = [
    'a',
    'b',
    'c',
    ...['d', 'e', 'f'].map((text) => ({ text, views: ['pipeline'] })),
    ...['g', 'h', 'i'].map((text) => ({ text, records: ['incident'] })),
  ];
  assert.equal(parseAppConfig(raw(many), 'test').assistant?.starters.length, 9);
});

/* `confirm: 'writes'` could only restate what is always so, and was dropped before 1.0 froze it: refused with the
   reason, so an App that wrote it learns why rather than meeting an unknown key. */
test('assistant.confirm is refused: every write it proposes waits for the person, always', () => {
  assert.throws(
    () => parseAppConfig(raw(['Hi'], { confirm: 'writes' }), 'test'),
    (error: { problems?: string[]; message: string }) =>
      (error.problems ?? [error.message]).some((problem) => /assistant\.confirm is gone: every write .* Delete it\./.test(problem)),
  );
  assert.equal(Object.hasOwn(parseAppConfig(raw(['Hi']), 'test').assistant!, 'confirm'), false);
});
