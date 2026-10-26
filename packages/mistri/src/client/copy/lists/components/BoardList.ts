/** What BoardList says, in the lists and grid room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  triageBoard: 'Triage board',
  noCaption: 'No {caption}',
  changesOnlyThroughTheRecords: "{caption} changes only through the record's actions, so a card keeps its row.",
  isNotYoursToChange: '{caption} is not yours to change here, so a card keeps its row.',
  actionDone: '{label} — done',
  rowAndPlace: 'row and place',
  movedToButItsWasNotSaved: 'Moved to {where}, but its {what} was not saved: {unsaved}',
  movedToItsWasNotSaved: 'Moved “{title}” to {where}; its {what} was not saved',
  place: ', place {index}',
  moved: 'Moved “{title}” to {where}{at}',
  movedToPlaceOfIn: 'Moved “{title}” to place {index} of {cellCount} in {laneLabel}',
  savedTitle: 'Saved “{title}”',
  wentBack: '“{title}” went back to {where}: {reason}',
  readingTheLanes: 'Reading the lanes…',
  noRecordsHere: 'No records here.',
  moveTitleToLane: 'Move "{title}" to {lane}',
  recordsAre: { one: '{count} record is', other: '{count} records are' },
  inMoreLanes: {
    one: '{records} in {count} more lane: a board draws at most {cap} lanes.',
    other: '{records} in {count} more lanes: a board draws at most {cap} lanes.',
  },
  inMoreStates: {
    one: '{records} in {count} more state: a board draws at most {cap} lanes.',
    other: '{records} in {count} more states: a board draws at most {cap} lanes.',
  },
  inOtherLanes: '{records} in other lanes.',
  inOtherStates: '{records} in other states.',
});
