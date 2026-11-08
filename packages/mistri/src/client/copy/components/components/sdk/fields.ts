/** What sdk/fields says, in the custom components room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  enterAnAmount: 'Enter an amount.',
  atMostDecimals: 'Enter an amount with at most {digits} decimal places.',
  enterAWholeAmount: 'Enter a whole amount.',
  zeroOrMore: 'Enter an amount of zero or more.',
  notAnInput: '{command} has no input "{name}" to bind: useField names one of the inputs the command declares.',
});
