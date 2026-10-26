/** What Funnel says, in the dashboards room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  summary: '{count} stages from {first} to {last}',
  ofBasis: '{share} of {basis}',
  dropped: '−{figure}',
  droppedTitle: '{figure} reached {basis} and stopped before {stage}',
  optional: 'Optional',
  openReached: 'Open the {table} that reached {stage}',
  openDropped: 'Open the {table} that stopped before {stage}',
});
