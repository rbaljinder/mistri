/**
 * A conversation's card for a command the assistant proposed is decided elsewhere as often as in the chat: in For
 * review, on the record. The conversation never hears of it, so a reload asks the store by id (assistantRoutes.ts)
 * and draws the card with its state word and no buttons. The events' own outcome still wins where there is one.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { itemsOf, reviewOutcome, undecidedReviews } from '../packages/mistri/src/server/assistant/assistantTurn.js';
import type { StoredEvent } from '../packages/mistri/src/adapters/assistant/assistantStore.js';

const card = (id: string, review?: string) => ({
  type: 'proposal',
  id,
  proposal: { kind: 'action', action: 'assign', label: 'Assign', ...(review ? { review } : {}) },
});
let seq = 0;
const event = (kind: string, body: unknown): StoredEvent => ({ seq: ++seq, kind, body, at: '2026-11-17T00:00:00Z' });
const events = [
  event('person', { text: 'Assign the corner shop loan' }),
  event('tool', { results: [], display: [card('toolu_a', 'P-a'), card('toolu_b', 'P-b'), card('toolu_c', 'P-c'), card('toolu_d')] }),
  event('outcome', { id: 'toolu_c', status: 'failed', detail: 'Nobody reviews loans.' }),
];
const outcomes = (items: ReturnType<typeof itemsOf>) =>
  items.filter((item) => item.type === 'proposal').map((item) => [item.id, (item as { outcome?: unknown }).outcome]);

test("a stored proposal's state says the card's outcome; one still waiting says nothing", () => {
  assert.deepEqual(reviewOutcome('approved'), { status: 'done' });
  assert.deepEqual(reviewOutcome('dismissed'), { status: 'declined' });
  assert.deepEqual(reviewOutcome('expired'), { status: 'declined' });
  assert.deepEqual(reviewOutcome('failed'), { status: 'failed' });
  assert.equal(reviewOutcome('proposed'), undefined);
});

test('a reload asks only for the stored proposals whose outcome the events do not say', () => {
  assert.deepEqual(undecidedReviews(events), ['P-a', 'P-b']);
});

test('a card decided elsewhere is drawn decided; the events win where they speak; one still waiting stays live', () => {
  const reviewed = new Map([
    ['P-a', { status: 'done' as const }],
    ['P-c', { status: 'declined' as const }],
  ]);
  assert.deepEqual(outcomes(itemsOf(events, reviewed)), [
    ['toolu_a', { status: 'done' }],
    ['toolu_b', undefined],
    ['toolu_c', { status: 'failed', detail: 'Nobody reviews loans.' }],
    ['toolu_d', undefined],
  ]);
  // Nothing asked (or the ask refused): the cards as the events say.
  assert.deepEqual(outcomes(itemsOf(events)), [
    ['toolu_a', undefined],
    ['toolu_b', undefined],
    ['toolu_c', { status: 'failed', detail: 'Nobody reviews loans.' }],
    ['toolu_d', undefined],
  ]);
});
