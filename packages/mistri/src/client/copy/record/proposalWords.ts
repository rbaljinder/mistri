/** A proposal's state, said one way on every surface (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  drafted: 'Drafted',
  approved: 'Approved',
  done: 'Done',
  dismissed: 'Dismissed',
  failed: 'Failed',
});
