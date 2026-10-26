/** What ConnectedClients says, in the account room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  connectedApplications: 'Connected applications',
  theyActAsYou: 'Applications you allowed to act as you, with the roles you gave them.',
  none: 'No application is connected.',
  unnamed: 'An unnamed application',
  until: '{roles} · until {date}',
  disconnect: 'Disconnect',
  disconnectNamed: 'Disconnect {client}',
  disconnecting: 'Disconnecting…',
  disconnected: '{client} is disconnected.',
  couldNotLoad: 'Connected applications could not be loaded.',
  couldNotDisconnect: '{client} could not be disconnected. Try again.',
});
