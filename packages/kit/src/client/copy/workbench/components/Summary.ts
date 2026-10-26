/** What Summary says, in the Workbench room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages({
  andMore: ', and {rest} more',
  startHere: 'Start here',
  queryLanguageParenQuestion: 'Query language (?)',
  open: 'Open {id}',
  showOrHideTheSummary: 'Show or hide the summary',
  centres: 'centres on {name}',
  theTableThatConnects: 'The table that connects to the most, with names you can recognise rows by',
  start: 'Start at {name} →',
  centresOnLabel: 'Centres on',
  referencedByOtherTables: ', referenced by {incoming} other tables',
  recordsEvents: 'Records events in',
  connectedThrough: 'Connected through',
  aJoinTable: ', a join table',
  whichAreJoinTables: ', which are join tables',
  deepestWalk: 'Deepest walk',
  standingAlone: 'Standing alone',
  noForeignKeys: ' — no foreign keys',
  noForeignKeysAtAll: ' — no foreign keys at all',
  tablesPoint: { one: '{count} table points', other: '{count} tables point' },
  views: { one: '{count} view', other: '{count} views' },
});
