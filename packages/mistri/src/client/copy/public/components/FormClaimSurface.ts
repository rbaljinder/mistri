/** What FormClaimSurface says, in the public pages room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  addedToYourAccountTitle: 'Added to your account',
  notAdded: 'Not added',
  addItToYourAccount: 'Add it to your account?',
  nothingToAdd: 'Nothing to add',
  lookingForTheApplication: 'Looking for the application you just submitted…',
  addApplication: 'Add application',
  toTheAccountYouAreSigned: 'to the account you are signed in to? Only its status is shown there.',
  yesAdd: 'Yes, add it',
  isInYourAccount: '{reference} is in your account now.',
  seeItsStatus: 'See its status',
  itWasNotAdded: 'It was not added, and this browser can no longer add it.',
  thereIsNoApplication: 'There is no application waiting to be added here. It may have been added already, declined, or timed out.',
});
