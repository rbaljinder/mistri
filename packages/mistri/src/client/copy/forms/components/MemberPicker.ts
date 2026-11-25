/** What MemberPicker says, in the forms room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  memberYou: '{name} (you)',
  memberUnnamed: 'Someone on the team',
  noTeamToList: 'The team cannot be listed here',
  choosePlaceholder: 'Choose {label}',
  chooseOne: 'Choose one',
});
