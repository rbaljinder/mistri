/** What sdk/host says, in the custom components room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  isNotOneOfThisApps: '"{resource}" is not one of this App\'s resources.',
  theRowsOfCould: 'The rows of "{name}" could not be read.',
  isNotAList: '"{view}" is not a list or dashboard this reader is served.',
  thePageCannotOpen: 'The page cannot open a form yet; try again once it has loaded.',
  thisPageCannotRun: 'This page cannot run commands.',
});
