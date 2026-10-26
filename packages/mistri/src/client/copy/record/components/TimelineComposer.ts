/** What TimelineComposer says, in the record page room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  reply: 'Reply',
  internalNote: 'Internal note',
  addNote: 'Add note',
  sending: 'Sending…',
  writeAReply: 'Write a reply…',
  writeAnInternalNote: 'Write an internal note — only your team sees it…',
  mode: 'Send as',
  conversation: 'Conversation',
  templates: 'Templates',
  loadingTemplates: 'Loading…',
  templatesCouldNotBeRead: 'The templates could not be read.',
  noTemplates: 'No templates yet.',
});
