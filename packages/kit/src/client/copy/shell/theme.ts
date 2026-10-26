/** What theme says, in the shell room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../messages.js';

export const say = defineMessages(
  {
    matchTheSystem: 'match the system',
    alwaysLight: 'always light',
    alwaysDark: 'always dark',
  },
  {
    /* The words a visitor sees in the shell; the rest are said in English. */
    es: {
      matchTheSystem: 'según el sistema',
      alwaysLight: 'siempre claro',
      alwaysDark: 'siempre oscuro',
    },
  },
);
