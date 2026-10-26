/** What Prefs says, in the shell room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages(
  {
    english: 'English',
    notSaved: 'Your language could not be saved to your profile. It is kept in this browser.',
  },
  {
    /* The words a visitor sees in the shell; the rest are said in English. */
    es: {
      notSaved: 'No se pudo guardar tu idioma en tu perfil. Se guarda en este navegador.',
    },
  },
);
