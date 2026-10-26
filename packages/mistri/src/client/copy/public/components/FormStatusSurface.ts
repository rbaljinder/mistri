/** What FormStatusSurface says, in the public pages room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  signIn: 'Sign in',
  moreDetails: 'More details',
  weCanEmailACode: 'We can email a code to the address on this application. It opens its details once, for 10 minutes.',
  emailMeACode: 'Email me a code',
  codeFromTheEmail: 'Code from the email',
  showDetails: 'Show details',
  sendAnotherCode: 'Send another code',
  confirmYourAccountsEmail: 'Confirm your account’s email with the link we sent you, and applications submitted with it are found here.',
  addedToYourAccount: 'Added to your account, submitted with your email: {linked}.',
  weFound1Application: 'We found 1 application submitted with this email — is this yours?',
  weFoundApplicationsSubmitted: 'We found {openCount} applications submitted with this email — are these yours?',
  sayYesOnlyToOne: 'Say yes only to one you made: it is added to your account, where its status is shown.',
  yesItsMine: 'Yes, it’s mine',
  reference: 'Reference',
  enter: 'Enter your {label}.',
  isNowInYourAccount: '{reference} is now in your account.',
  checkYourApplication: 'Check your application',
  enterTheReferenceYouWereGiven: '{label}: enter the reference you were given and the details below. Only its status is shown.',
  yourApplications: 'Your applications',
  checkStatus: 'Check status',
  signInToAdd: 'Sign in to add it to your account and follow it there.',
  addToMyAccount: 'Add to my account',
});
