/** What experimentExposure says, in the shell room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  unrecognizedAcknowledgement: 'Unrecognized exposure acknowledgement.',
  ownerUnavailable: 'Exposure owner unavailable.',
  ownerRetired: 'Exposure owner retired.',
  accountChanged: 'Exposure account changed.',
  leaseChanged: 'Exposure lease changed.',
  acknowledgementOwnerChanged: 'Exposure acknowledgement owner changed.',
  acknowledgementUnavailable: 'Exposure acknowledgement unavailable.',
  requestRefused: 'Exposure request refused.',
});
