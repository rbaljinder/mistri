/** What TopNav says, in the shell room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages(
  {
    searchK: 'Search (⌘K)',
    search: 'Search…',
  },
  {
    /* The words a visitor sees in the shell; the rest are said in English. */
    es: {
      searchK: 'Buscar (⌘K)',
      search: 'Buscar…',
    },
  },
);
