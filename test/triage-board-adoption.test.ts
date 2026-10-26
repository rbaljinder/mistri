import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TriageBoardProps, TriageCard, TriageLane, TriageTarget } from '../packages/mistri/src/client/components/TriageBoard.js';

/**
 * Adoption fixture for a Thread-like workflow. The App authors the lane
 * vocabulary and owns the selected/moving state; TriageBoard only receives
 * the current snapshot and reports user intent through these callbacks.
 */
const lanes: TriageLane[] = [
  { id: 'backlog', label: 'Backlog' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'review', label: 'Review' },
  { id: 'done', label: 'Done' },
];

const cards: TriageCard[] = [
  { id: 'issue-2', laneId: 'review', title: 'Add export', subtitle: 'Compass' },
  { id: 'issue-1', laneId: 'backlog', title: 'Fix sign-in', subtitle: 'Ignition' },
  { id: 'issue-3', laneId: 'review', title: 'Refresh inbox', subtitle: 'Thread' },
];

const selectionRequests: TriageCard[] = [];
const moveRequests: Array<{ card: TriageCard; targetLaneId: string }> = [];

const boardProps = {
  lanes,
  cards,
  selectedId: undefined,
  onSelect: (card: TriageCard) => selectionRequests.push(card),
  onMove: (card: TriageCard, to: TriageTarget) => moveRequests.push({ card, targetLaneId: to.lane }),
  emptyLaneMessage: 'No issues in this state.',
} satisfies TriageBoardProps;

test('TriageBoard adoption fixture preserves authored lane order and card grouping', () => {
  assert.deepEqual(
    boardProps.lanes.map((lane) => lane.id),
    ['backlog', 'in_progress', 'review', 'done'],
  );
  assert.deepEqual(
    boardProps.lanes.map((lane) => cards.filter((card) => card.laneId === lane.id).map((card) => card.id)),
    [['issue-1'], [], ['issue-2', 'issue-3'], []],
  );
  assert.equal(boardProps.emptyLaneMessage, 'No issues in this state.');
});

test('TriageBoard adoption fixture delegates selection without owning selected state', () => {
  boardProps.onSelect?.(cards[0]);

  assert.deepEqual(
    selectionRequests.map((card) => card.id),
    ['issue-2'],
  );
  assert.equal(boardProps.selectedId, undefined);
});

test('TriageBoard adoption fixture delegates a move intent without mutating the snapshot', () => {
  boardProps.onMove?.(cards[0], { lane: 'in_progress' });

  assert.deepEqual(
    moveRequests.map((request) => [request.card.id, request.targetLaneId]),
    [['issue-2', 'in_progress']],
  );
  assert.equal(cards[0].laneId, 'review');
});
