/** What MinorMoneyInput says, in the forms room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages(
  {
    enterAnAmount: 'Enter an amount with at most {digits} decimal places.',
    enterAWholeAmount: 'Enter a whole amount.',
  },
  {
    es: {
      enterAnAmount: 'Ingresa un monto con como máximo {digits} decimales.',
      enterAWholeAmount: 'Ingresa un monto entero.',
    },
  },
);
