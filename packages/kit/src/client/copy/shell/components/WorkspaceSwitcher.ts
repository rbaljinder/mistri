/** What WorkspaceSwitcher says, in the shell room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages(
  {
    workspaces: 'Workspaces',
  },
  {
    /* The words a visitor sees in the shell; the rest are said in English. */
    es: {
      workspaces: 'Espacios de trabajo',
    },
  },
);
