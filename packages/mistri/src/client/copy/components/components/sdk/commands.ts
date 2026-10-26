/** What sdk/commands says, in the custom components room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  theRecordHanded: 'The record handed to "{label}" has no {column}.',
  isNotAvailableOnThisRecord: '{label} is not available on this record now.',
  isNotSomethingYouCanDo: '{label} is not something you can do here.',
  signInToDo: 'Sign in to do that.',
  this: 'This',
  notConfirmed: '{label} was sent, and its result is not confirmed. Check the record before you send it again.',
});
