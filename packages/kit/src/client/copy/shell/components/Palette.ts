/** What Palette says, in the shell room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages({
  searchRecordsPagesAndCommands: 'Search records, pages and commands…',
  goToATable: 'Go to a table, view, saved filter or database…',
  nothingMatches: 'Nothing matches "{term}".',
  nothingToGo: 'Nothing to go to.',
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
});
