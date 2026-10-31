/** What FilePreview says, in the record page room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages({
  thisFileIsNoLonger: 'This file is no longer here.',
  thisFileCouldNotBeRead: 'This file could not be read.',
  thisFileIsNamed: 'This file is named as a PDF, but it is not one.',
  thisFileIsNotText: 'This file is not text, so it can only be downloaded.',
  thisFileIsNotPlayable: 'This file is not a recording this browser can play, so it can only be downloaded.',
  tooLargeToPlay: 'Recordings over {size} are not played here. Download the file to play it.',
  tooLargeToShow: 'PDFs over {size} are not shown here. Download the file to open it.',
  opening: 'Opening {name}…',
  showingTheFirstDownload: 'Showing the first {size}. Download the file for the rest.',
  previewOf: 'Preview of {name}',
  download: 'Download',
});
