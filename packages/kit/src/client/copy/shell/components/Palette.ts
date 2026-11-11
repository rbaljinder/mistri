/** What Palette says, in the shell room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages({
  searchRecordsPagesAndCommands: 'Search records, pages and commands…',
  goToATable: 'Go to a table, view, saved filter or database…',
  nothingMatches: 'Nothing matches "{term}".',
  nothingToGo: 'Nothing to go to.',
  /* An App with more lists than one search asks: the ones left out are said, not silently unsearched. */
  searchedSome: 'Records are searched in {searched} of {total} lists.',
  /* The badge on each row says what it opens, in the reader's words rather than the registry's identifiers. */
  kindPage: 'page',
  kindView: 'view',
  kindTable: 'table',
  kindFilter: 'filter',
  kindRecent: 'recent',
  kindAction: 'action',
  kindRecord: 'record',
  kindSql: 'sql',
  kindDatabase: 'database',
  kindCreate: 'create',
  /* An App's row says what it opens in its line, first: "Page · Leasing". */
  kindDetail: '{kind} · {detail}',
  /* An App's palette sorts what it finds under these, in this order; a heading is a quiet label, not a badge. */
  groupRecent: 'Recent',
  groupPages: 'Pages',
  groupCreate: 'Create',
  groupCommands: 'Commands',
  groupRecords: 'Records',
  /* The footer's key hints: the keys are marks, these are what each does. */
  hintMove: 'move',
  hintOpen: 'open',
  hintClose: 'close',
  keyEscape: 'esc',
});
