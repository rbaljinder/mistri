/** What PageSectionBox says, in the record page room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages(
  {
    history: 'History',
    flows: 'Flows',
    diagram: 'Steps',
    thisSection: 'This section',
  },
  /* An untitled history() says its title in the reader's language; Spanish is the shell's second one. */
  { es: { history: 'Historial', flows: 'Flujos', diagram: 'Pasos', thisSection: 'Esta sección' } },
);
