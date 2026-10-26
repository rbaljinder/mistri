/** What WorkflowStatus says, in the record page room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages({
  workflowStatus: 'Workflow status',
  passed: '(passed)',
  availableFromHere: '(available from here)',
  currentState: 'Current state:',
  notSet: 'Not set',
});
