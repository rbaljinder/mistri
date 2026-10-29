/** What Welcome says, in the Workbench room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  couldNotBuildTheSample: 'Could not build the sample database: {message}',
  followTheData: 'Follow the data.',
  openAnyRowAndYouSee: 'Open any row and you see what points at it. The orders on a customer, the customer on an order.',
  buildingTheSample: 'Building the sample…',
  openTheSampleDatabase: 'Open the sample database',
  connectADatabase: 'Connect a database',
  oneConnectionIsConfigured: 'One connection is configured, and it did not open.',
  connectionsAreConfiguredAndNone: '{brokenCount} connections are configured, and none of them opened.',
  openConnections: 'Open connections',
  readOnlyLede: 'Read only.',
  youTurnEditingOnYourself:
    ' You turn editing on yourself, per connection. Connections you add here are gone when you quit, unless you save them to a file.',
  whatToPoint: 'What to point it at',
  thePasswordDoes: 'The password does not have to be in the string. Write ',
  andItComesFromTheEnvironment:
    ' and it comes from the environment, or leave it out and keep it in the keychain. There is a Test button either way.',
  toSkipThisNext: 'To skip this next time, put them in a ',
  whereYouStartTablewalk: ' where you start tablewalk:',
});
