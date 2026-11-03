/** What TreePicker says, in the forms room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages({
  choose: 'Choose…',
  loading: 'Loading…',
  couldNotLoad: 'The choices could not be loaded.',
  nothingToChoose: 'Nothing to choose from.',
  noMatches: 'Nothing matches.',
  firstOnly: 'The first {count} only. Type to search.',
  path: 'Path',
});
