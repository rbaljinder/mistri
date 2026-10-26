/** What MobileNavDrawer says, in the shell room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages(
  {
    navigation: '{name} navigation',
    menu: '{name} menu',
  },
  {
    /* The words a visitor sees in the shell; the rest are said in English. */
    es: {
      navigation: 'Navegación de {name}',
      menu: 'Menú de {name}',
    },
  },
);
