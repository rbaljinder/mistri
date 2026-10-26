// Server-only field shapes shared by the command handlers.
import { field } from '@mistriwork/mistri/commands';

export const markStipulationReceivedInput = {
  note: field.textarea({
    label: 'What was collected',
    max: 500,
    optional: true,
    help: 'Say what you have and where it is, such as "Two pay stubs, scanned to the deal jacket".',
  }),
};

export const withdrawApplicationInput = {
  reason: field.textarea({ label: 'Why it is being withdrawn', max: 500, help: 'Kept on the application; Keystone reads it too.' }),
};
