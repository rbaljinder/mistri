/** What PageHead says, in the record page room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages({
  isPinnedToTheHome: '"{name}" is pinned to the home screen',
  pinToTheHome: 'Pin "{name}" to the home screen',
  addRemoveAndReorder: 'Add, remove and reorder the sections of this page',
  thisPageBelongsToTheFile: 'This page belongs to the file it came from — editing it starts your own copy',
  layout: 'Layout',
  copyLayout: 'Copy layout',
});
