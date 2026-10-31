/** What Grid says, in the lists and grid room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '../../../messages.js';

export const say = defineMessages({
  moreTags: '+{count}',
  moreCharactersOpenTheRow: {
    one: '{count} more character — open the row to read it',
    other: '{count} more characters — open the row to read it',
  },
  summing: 'Summing',
  total: 'Total',
  noRowsMatch: 'No rows match.',
  thisTableIsEmpty: 'This table is empty.',
  sortingAResultLike: '{name} — sorting a result like this one means editing the statement that produced it',
  notSortableHere: '{name} — this list cannot be sorted from its header.',
  sortBy: 'Sort by {name}',
  theApiDocumentsNoSort: '{name} — the API documents no sort by it.',
  isNotIndexedSorting: '{name} is not indexed — sorting it would scan the whole table. Type "sort {name}" in the query bar if you mean it.',
  isNotIndexedSortingInApp: '{name} is not indexed — sorting it would scan the whole table.',
  filterOn: 'Filter on {name}',
  expandEveryRow: 'Expand every row',
  collapseEveryRow: 'Collapse every row',
  moveColumnLeft: 'Move {name} left',
  moveColumnRight: 'Move {name} right',
  resizeColumn: 'Resize {name} column',
  resizeColumnHint: 'Drag or use arrow keys to resize {name}; double-click or Alt+Backspace to restore its fitted width',
  actions: 'Actions',
  rowsDrawnAsYouScroll: { one: '{count} row, drawn as you scroll.', other: '{count} rows, drawn as you scroll.' },
  defaultOrderRowsHaveToCome: 'default order — rows have to come back in some order, and this is the one tablewalk chose',
});
