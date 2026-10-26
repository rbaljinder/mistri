/** What Crumbs says, in the shell room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages(
  {
    trail: 'Trail',
    theSchemaYourWork: 'The schema, your work, the diagram (h)',
    appHome: '{app} home',
    home: 'Home',
    back: 'Back to {previous}',
  },
  {
    /* The words a visitor sees in the shell; the rest are said in English. */
    es: {
      trail: 'Ruta',
      appHome: 'Inicio de {app}',
      home: 'Inicio',
      back: 'Volver a {previous}',
    },
  },
);
