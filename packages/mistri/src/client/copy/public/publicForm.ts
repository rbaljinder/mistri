/** What publicForm says, in the public pages room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  thereIsNoSuch: 'There is no such form here.',
  theFormCouldNotBeLoaded: 'The form could not be loaded ({status}).',
  checkYourApplicationName: 'Check your application · {name}',
  signInToAddYourApplication: 'Sign in to add your application to your account.',
  addYourApplication: 'Add your application · {name}',
  signInToAddTheApplication: 'Sign in to add the application you just submitted to your account.',
});
