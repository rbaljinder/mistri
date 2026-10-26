/** What Sidebar says, in the shell room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages({
  keptOpenForTheCurrent: 'Kept open for the current page or menu filter',
  missing: 'missing',
  view: 'view',
  moreThanTheMenu: 'More than {count} — the menu counts no further.',
  roughlyFromTheDatabases: 'Roughly, from the database’s own statistics — no rows were counted.',
});
