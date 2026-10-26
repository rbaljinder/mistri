/** What console/model says, in the Console room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  readFailed: 'The read could not be completed.',
  changeUnconfirmed: 'The change could not be confirmed. Refetch and reconcile before another change.',
  responseUnconfirmed: 'The response could not be confirmed. Refetch before continuing.',
  operationUnavailable: 'Console operation unavailable.',
  chooseDeclaredVariant: 'Choose a declared variant.',
  invalidValue: 'Enter a valid {type}.',
  declaredValue: 'declared value',
});
