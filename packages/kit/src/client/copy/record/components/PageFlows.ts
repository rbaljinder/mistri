/** What PageFlows says, in the record page room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages({
  notRunning: 'Flows run when the server is started with --jobs.',
  noRuns: 'No flows have run on this record.',
  flowsOnThisRecord: 'Flow runs on this record appear here.',
  waitingFor: 'Waiting for {what}',
  until: 'Until {when}',
  started: 'Started {when}',
  start: 'Start {name}',
  startAFlow: 'Start a flow',
  starting: 'Starting…',
  couldNotStart: 'Could not start {name}: {reason}',
  running: 'Running',
  waiting: 'Waiting',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  diverged: 'Diverged',
  stepDone: 'done',
  steps: 'Steps',
});
