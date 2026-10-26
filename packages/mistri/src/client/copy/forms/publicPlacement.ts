/** Receipt recovery is loaded with placed forms, never with ordinary first paint. */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  placementUnavailable: 'This form could not be opened. Reload the page and try again.',
  placementUnknown:
    'We haven’t confirmed whether this was received. Your answers are held here. Check the result before starting another form.',
  placementRestored:
    'An earlier submission is waiting for confirmation. Check its result before starting another form. Its answers were not saved on this device.',
  placementNotFound: 'No receipt was found yet. Your submission may still be finishing. Check again before starting another form.',
  placementRecoveryUnavailable: 'The result could not be checked. This does not mean the submission failed. Try checking again later.',
  placementRecoveryExpired:
    'The time to check this result has ended. It may have been received. Contact the form’s owner before submitting another form.',
  placementAlreadyPending: 'An earlier submission is waiting for confirmation. Close this form and open it again to check the result.',
  placementNewForm: 'This form can no longer be sent. Close and reopen it, or reload the page, to start a new form.',
});
