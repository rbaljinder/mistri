/** What AsOfChip says, in the shell room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages({
  asOf: 'As of {moment}',
  whyAsOf:
    'This development server runs App logic as of another moment (mistri dev --as-of, or MISTRI_AS_OF): today, now and dashboard windows read it. Sign-in and sessions keep the real clock.',
});
