/** What AttachmentList says, in the record page room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages({
  download: 'Download',
  isOverTheLimit: '“{name}” is over the {maxBytes} limit for a file.',
  attached: 'Attached “{attached}”',
  attachedFiles: { one: 'Attached {count} file', other: 'Attached {count} files' },
  attaching: 'Attaching…',
  orDropFilesHere: 'or drop files here',
  preview: 'Preview {name}',
  downloadName: 'Download {name}',
  more: 'More for {name}',
  detailsItem: 'Details',
  removeMore: 'Remove…',
  aFileNeedsAName: 'A file needs a name.',
  fileName: 'File name',
  removeName: 'Remove {name}?',
  removeQuotedNameQuestion: 'Remove “{name}”?',
  theFileIsDeleted: 'The file is deleted for everyone who can see this record, and Undo cannot bring it back.',
  keep: 'Keep',
  removing: 'Removing…',
});
