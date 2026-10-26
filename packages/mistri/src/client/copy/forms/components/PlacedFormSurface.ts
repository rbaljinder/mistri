/** What PlacedFormSurface says, in the forms room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  placementRecoveryExpired:
    'The time to check this result has ended. It may have been received. Contact the form’s owner before submitting another form.',
  placementCheckResult: 'Check result',
  placementRetry: 'Retry the same submission',
});
