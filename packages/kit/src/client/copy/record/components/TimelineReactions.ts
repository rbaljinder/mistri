/** What TimelineReactions says, in the record page room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages({
  reactions: 'Reactions',
  reactionCount: { one: '{kind}, {count} reaction', other: '{kind}, {count} reactions' },
});
