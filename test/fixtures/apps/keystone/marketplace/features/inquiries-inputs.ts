// Server-only field shapes shared by the command handlers.
import { field } from '@mistriwork/mistri/commands';
import { person } from '../inputs.ts';

export const sendInquiryInput = {
  ...person,
  message: field.textarea({
    label: 'Your question',
    max: 2000,
    help: 'A test drive, a trade-in, financing: the dealer replies by email or phone.',
  }),
};
