/** What OAuthConsent says, in the public pages room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  title: 'Connect {client} to {app}',
  unnamed: 'An unnamed application',
  asks: '{client} asks to use {app} as you, {account}. The name is the one the application gave itself.',
  sendsBack: 'Your answer sends you back to {host}.',
  sendsBackApp: 'Your answer sends you back to the application on this device ({scheme}).',
  roles: 'What it may do',
  rolesHint: 'Only these roles of yours can be given. It can never do more than you can.',
  noRoles: 'Your account holds no role this App lets you give to an application.',
  tenant: 'Where it may act',
  tenantHint: 'It acts in this one only, with your membership there. If you leave it, the application loses access too.',
  noTenants: 'You are not an active member anywhere in this App, so there is nothing to give.',
  chooseATenant: 'Choose where the application may act.',
  lasts: 'It may act for an hour at a time, renewing for up to 30 days. Disconnect it any time from your profile.',
  chooseARole: 'Choose at least one role to allow.',
  allow: 'Allow',
  deny: 'Deny',
  expired: 'This request has expired. Start again from the application.',
  failed: 'The request could not be loaded. Start again from the application.',
});
