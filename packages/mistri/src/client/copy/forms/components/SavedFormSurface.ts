/** What SavedFormSurface says, in the forms room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  review: 'Review',
  reviewTitle: 'Review your answers',
  reviewLead: 'Check each section. Change anything that is not right.',
  keepThisReference: 'Keep this reference.',
  received: 'Received',
  yourReference: 'Your reference',
  submit: 'Submit',
  change: 'Change {label}',
  changeStep: 'Change',
  savedNotShownForYourPrivacy: 'Saved — not shown for your privacy',
  thisApplicationCanNoLonger: 'This application can no longer be continued, so it has been started again from the first step.',
  confirmYourEmail: 'Confirm your email',
  isConfirmedAnAccount: '{email} is confirmed. An account with this email will find your application.',
  optionalWeEmailACode:
    'Optional. We email a code to your address; confirming it lets an account with this email find the application straight away.',
  codeFromTheEmail: 'Code from the email',
  confirm: 'Confirm',
  sendAnotherCode: 'Send another code',
  emailMeACode: 'Email me a code',
  saveThisStepBefore: 'Save this step before you submit.',
  followItInAnAccount: 'Follow it in an account',
  thisBrowserCanNoLonger: 'This browser can no longer add the application to an account.',
  claimWindow: 'For the next 30 minutes, this browser can add the application to an account, where its status is shown.',
  createAnAccountToTrack: 'Create an account to track this',
  signInToAdd: 'Sign in to add it',
  thisIsAShared: 'This is a shared device',
  checkItsStatus: 'Check its status',
  anyTimeWithYourReference: 'any time with your reference.',
  notSavedYet: 'Not saved yet',
  yourApplicationIsSaved: 'Your application is saved. Carry on where you left off; what you saved is not shown again.',
  eachStepIsSaved:
    'Each step is saved as you go. We don’t show your details back to you; keep this tab open to review them before you submit.',
  checkingForAnApplication: 'Checking for an application in progress…',
});
