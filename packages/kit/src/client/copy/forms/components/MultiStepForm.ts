/** What MultiStepForm says, in the forms room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages({
  reviewThisStepBefore: 'Review this step before continuing.',
  thisStepCouldNotBeValidated: 'This step could not be validated. Try again.',
  thisFormCouldNotBeCompleted: 'This form could not be completed. Try again.',
  formSteps: 'Form steps',
  stepOf: 'Step {step} of {count}',
  progress: 'Step {step} of {count}: {label}',
  continue: 'Continue',
  stepDone: ', done',
});
