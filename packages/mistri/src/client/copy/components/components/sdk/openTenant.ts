/** What sdk/openTenant says, in the custom components room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  keyIsInvalid: 'An opening key is 16 to 128 letters, digits, dashes or underscores.',
  profileNotApplied: '{label} did not apply, so no tenant was opened.',
  noAdministration: 'This account cannot open tenants.',
});
