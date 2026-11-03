/** What HeldFiles says, in the forms room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  chooseFiles: 'Choose files',
  chooseFile: 'Choose a file',
  orDropOrPaste: 'or drop or paste them here',
  orDropOrPasteOne: 'or drop or paste it here',
  sending: 'Sending {name}, {percent}%',
  cancel: 'Cancel',
  remove: 'Remove',
  removeFile: 'Remove {name}',
  preview: 'Preview {name}',
  takesAtMost: { one: '{label} takes at most {count} file.', other: '{label} takes at most {count} files.' },
  notSent: '{name} was not sent: {reason}',
  couldNotSend: 'The server could not be reached.',
  tooLarge: 'it is too large',
  noHolding: 'Files cannot be sent from this form.',
  aFile: 'A file sent earlier',
});
