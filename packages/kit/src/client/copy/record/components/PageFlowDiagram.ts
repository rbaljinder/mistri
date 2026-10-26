/** What PageFlowDiagram says, in the record page room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages({
  stepsOfThisFlow: "This flow's steps are drawn here.",
  noSteps: 'This flow has no steps yet.',
  noRun: 'No flow has run on this record yet.',
  diagram: 'The steps of this flow, in order',
  position: 'Step {position}',
  together: '{count} steps start together',
  otherwise: 'Otherwise',
  end: 'End',
  ifNot: 'If not: {to}',
  ifHolds: 'If {condition}',
  toEnd: 'the end',
  toStep: 'step {position}',
  // A step's kind in a word: the platform's own, and an App's by what it does.
  kindBranch: 'Branch',
  kindWait: 'Wait',
  kindUntil: 'Wait until a date',
  kindWaitFor: 'Wait for an event',
  kindSet: 'Set a field',
  kindNotify: 'Notify',
  // Where a run stands at a step.
  stateDone: 'Done',
  stateWaiting: 'Waiting',
  stateRunning: 'In progress',
  stateStopped: 'Stopped',
  stateAhead: 'Not reached',
  stateSkipped: 'Skipped',
  runRunning: 'Running',
  runWaiting: 'Waiting',
  runCompleted: 'Completed',
  runFailed: 'Failed',
  runCancelled: 'Cancelled',
  runDiverged: 'Diverged',
  runStarted: 'Started {when}',
});
