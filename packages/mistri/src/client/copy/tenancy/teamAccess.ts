/** What teamAccess says, in the tenancy room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  noTeam: 'There is no team to change here.',
  memberOutOfReach: 'That member is not one you can change.',
  invitationOutOfReach: 'That invitation is not one you can change.',
  cannotInvite: 'You cannot invite people to this team.',
});
