/** What SettingsRoom says, in the account room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  appearance: 'Appearance',
  domains: 'Domains',
  domainsHint: 'The addresses your organization’s pages answer on, and a domain of your own pointed here.',
  appearanceHint: 'How this app looks in this browser. Each choice applies as it is made.',
  reading: 'Reading',
  readingHint: 'The language you read in, and how much a list shows at once.',
  readingHintPerson: 'The language you read in.',
});
