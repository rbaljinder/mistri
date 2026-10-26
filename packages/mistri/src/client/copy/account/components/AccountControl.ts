/** What AccountControl says, in the account room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  yourProfile: 'Your profile',
  // Where the App names a settings record "Your profile" too: the sign-in's own details, told apart.
  yourAccount: 'Your account',
  signOutCouldNotBeConfirmed: 'Sign-out could not be confirmed',
  account: 'Account: {who}',
  signed: 'Signed in as',
  manageAccounts: 'Manage accounts',
  manageTenants: 'Manage tenants',
  apiTokens: 'API tokens',
  checkingTenantAdministration: 'Checking tenant administration…',
  retryTenantAdministration: 'Retry tenant administration',
  manageInvitations: 'Manage invitations',
  acceptInvitation: 'Accept invitation',
  checkingInvitations: 'Checking invitations…',
  checkInvitationPermissions: 'Check invitation permissions',
  signOut: 'Sign out',
});
