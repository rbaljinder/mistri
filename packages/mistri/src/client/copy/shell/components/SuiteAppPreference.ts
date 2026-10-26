/** Account-persisted default-App preference messages, owned by the shell. */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  defaultApp: 'Default App',
  accountHint: 'Saved to your account. Switching Apps does not change this preference.',
  ask: 'Ask each time',
  loading: 'Loading your App preference…',
  loadFailed: 'Your App preference could not be loaded.',
  conflict: 'Your preference changed elsewhere. Refresh before saving again.',
  uncertain: 'Your change could not be confirmed. Refresh before saving again.',
  unavailable: 'Your selected App is no longer available. Choose another App.',
  refresh: 'Refresh preference',
  save: 'Save default App',
  saving: 'Saving…',
  saved: 'Default App saved to your account.',
});
