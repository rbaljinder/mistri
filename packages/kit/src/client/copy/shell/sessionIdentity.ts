/** What sessionIdentity says, in the shell room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../messages.js';

export const say = defineMessages({
  thisOperationBelongsToAPrevious: 'This operation belongs to a previous account session.',
  theTenantRenewalCould: 'The tenant renewal could not be verified.',
  signInBeforeChoosing: 'Sign in before choosing a tenant.',
  theTenantSelectionCould: 'The tenant selection could not be verified.',
  theServerDidNotProvide: 'The server did not provide a valid session identity.',
  thisOperationBelongsToA: 'This operation belongs to a previous session.',
  theSessionIsUnavailable: 'The session is unavailable. Sign in again before continuing.',
  theResponseBelongsToADifferent: 'The response belongs to a different or unverified account.',
  sessionStorageIsUnavailable: 'Session storage is unavailable until identity is established.',
});
