/** What PageRelated says, in the record page room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages({
  thisListHasNoView: 'This list has no view definition.',
  nothingHereYet: 'Nothing here yet.',
  noIsSetSoThere: 'No {reference} is set, so there are no {things} to show.',
  thisListCouldNotBeRead: 'This list could not be read.',
  noRelatedRecordsYet: 'No related records yet.',
  noRightNow: 'No {thing} right now.',
  thisPageHasMoved: 'This page has moved on; nothing was renamed.',
  thisPageHasMovedOn: 'This page has moved on; nothing was removed.',
  theFileWasNotRemoved: 'The file was not removed.',
  thisPageHasMovedOnNothing: 'This page has moved on; nothing was attached.',
  recordAdded: 'Record added',
  photos: 'Photos',
  noPhotosYet: 'No photos yet.',
  noFilesYet: 'No files yet.',
  attachFiles: 'Attach files',
  addThing: 'Add {thing}',
  noForThisRecord: 'No {name} for this record.',
  previousRows: 'Previous rows',
  moreRows: 'More rows',
  totalAllThings: 'Total · all {things}',
  totalAllCountThings: 'Total · all {count} {things}',
  recordsNoun: 'records',
});
