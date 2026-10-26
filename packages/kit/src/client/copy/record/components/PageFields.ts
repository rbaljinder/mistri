/** What PageFields says, in the record page room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages({
  theseFieldsCouldNotBeRead: 'These fields could not be read.',
  noneYet: 'No {caption} yet',
  nothingHereEveryField: 'Nothing here: every field in this group is empty.',
});
