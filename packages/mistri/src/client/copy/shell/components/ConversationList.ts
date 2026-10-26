/** What ConversationList says, in the shell room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  newConversation: 'New conversation',
  noConversations: 'No conversations yet.',
  deleteConversation: 'Delete “{title}”',
  untitled: 'Untitled conversation',
  filterConversations: 'Filter conversations',
  clearSearch: 'Clear the search',
  searchResults: 'Conversations that match',
  noMatches: 'No conversations match',
  conversationActions: 'Actions for “{title}”',
  rename: 'Rename',
  renameLabel: 'Rename “{title}”',
  delete: 'Delete',
  deleteConversationTerms: 'Its messages are deleted for good. Records it showed or changed stay as they are.',
  waitingShort: 'Waiting for you',
  workingShort: 'Working',
  day_today: 'Today',
  day_yesterday: 'Yesterday',
  group_waiting: 'Waiting for you',
  group_today: 'Today',
  group_yesterday: 'Yesterday',
  group_week: 'Earlier this week',
  group_older: 'Older',
});
