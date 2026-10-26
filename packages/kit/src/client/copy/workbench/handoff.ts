/** What handoff says, in the Workbench room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../messages.js';

export const say = defineMessages({
  oneRow: 'One row of `{table}`: **{label}**',
  theQuestionOnScreen: 'The question on screen is:',
  ofMatching: ' of {total} matching',
  columnsOnScreen: 'Columns on screen: {columns}',
  thisDatabaseIsAvailable: 'This database is available over MCP as `tablewalk`. {next}',
  tableDescribesATable: '`table` describes a table, `find` says where a name or a value lives, and ',
  queryRunsTheSame: '`query` runs the same language as the box above. The values themselves are ',
  notIncludedHereFetch: 'not included here — fetch them if you need them.',
  positionCopiedPasteItInto: 'Position copied — paste it into an agent.',
  connectionNamed: 'Connection `{connection}`{dialect}.',
  defaultConnectionName: 'default',
  showingRows: { one: 'Showing {count} row{of}.', other: 'Showing {count} rows{of}.' },
  aPositionInTablewalk: '# {table} — a position in tablewalk',
  toReadThisRow: 'To read this row and everything pointing at it:',
  toSeeTheSame: 'To see the same rows:',
});
