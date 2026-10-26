/** What RecordTags says, in the record page room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages({
  tagAdded: 'Tag added',
  removed: 'Removed “{label}”',
  removeLabel: 'Remove {label}',
  addNoun: 'Add {noun}',
  plusAddNoun: '+ Add {noun}',
  addTag: 'Add tag',
  removeTag: 'Remove tag',
});
