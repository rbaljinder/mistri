/** What AccountTrail says, in the account room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  administrator: 'Administrator',
  added: 'Added with {rolesSaid}',
  rolesChanged: 'Roles {before} → {after}',
  deactivated: 'Deactivated',
  reactivated: 'Reactivated',
  newPasswordSessionsEnded: 'New password; sessions ended',
  newPassword: 'New password',
  changed: 'Changed',
  maintenance: 'Maintenance',
  byInvitation: 'by invitation',
  atSignIn: 'at sign-in',
  theHistoryCouldNotBeLoaded: 'The history could not be loaded.',
  changesRange: '{first}–{last} of {total}',
  loadingHistory: 'Loading history…',
  noChangesToThisAccount: 'No changes to this account have been made here.',
  noChangesHaveBeen: 'No changes have been made here yet.',
  when: 'When',
  change: 'Change',
  by: 'By',
  changes: 'Changes {range}',
  historyPages: 'History pages',
  newer: 'Newer',
  older: 'Older',
});
