/**
 * A split's record room: the list kept in place beside the record it picked,
 * as the record room draws it where the view is a split (Rooms.tsx
 * `KeyedRowRoom`, through the shell's rooms slot `SplitRecord`). The App
 * framework's, so the kit's rooms name neither the split nor its detail pane.
 */
import { allowMutationExit, currentEntry, findTable, go, pageSize, state, tableView } from '@mistriwork/kit/client/core.js';
import type { RecordTrail } from '@mistriwork/kit/client/recordTrail.js';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import { headingOf } from '@mistriwork/engine/shared/appNoun.js';
import { appListQuery, newRecordNoun, splitListSpec, splitOf, type ListSpec } from '@mistriwork/kit/client/components/appListModel.js';
import type { RowEntry } from '@mistriwork/kit/client/components/Record.js';
import { RecordKeys } from '@mistriwork/kit/client/components/recordKeys.js';
import { AppListRoom } from '@mistriwork/kit/client/components/Rooms.js';
import { SplitDetailActions, SplitDetailPane } from './SplitDetailPane.js';
import { SplitListDetail } from './SplitListDetail.js';
import { say } from '../copy/shell/components/SplitRecordRoom.js';

function splitListQuery(spec: ListSpec): string {
  // The list's authored limit rides its spec, so the list reads it as the view's own.
  return appListQuery(splitListSpec(spec));
}

/**
 * A split row keeps the list in place while the selected record becomes its
 * detail sibling. Closing replaces the selection with the same authored list
 * question; it does not invent a second history step or discard list filters.
 */
/* The walk entries whose list page the split has already turned to. */
const pagedTo = new WeakSet<object>();

/**
 * A record opened from, or stepped to on, another page of the split's list
 * turns the list beside it to that page — once per record, before the list
 * reads its page, so the reader sees the row they are on. Every step of the
 * walk starts on the first page (core.js `go`), which put the row a click
 * chose out of sight; a page the reader turns afterwards is theirs to keep.
 */
function followTrailPage(entry: object & { trail?: RecordTrail }) {
  if (pagedTo.has(entry)) return;
  pagedTo.add(entry);
  const list = entry.trail?.list;
  if (list && list.limit === pageSize() && list.offset % list.limit === 0) state.page = list.offset / list.limit;
}

const noKeys = {};

export function SplitRecordRoom({ entry, spec }: { entry: RowEntry & { view?: string }; spec: ListSpec }) {
  followTrailPage(entry);
  const listSpec = splitListSpec(spec);
  const listQuery = splitListQuery(spec);
  const detail = splitOf(spec)?.detail;
  const tableName = (findTable(entry.table) as TableMeta | undefined)?.name ?? entry.table;
  const close = () => {
    if (currentEntry() !== entry) return;
    /* Back to the list the pick stood on, when it is this view's own: a
       second list above it read `/thread/inbox/inbox` and drew the list twice
       in the trail. Replaced, not stepped, as any close is. */
    const below = state.stack[state.stack.length - 2] as { kind?: string; table?: string; view?: string } | undefined;
    if (below?.kind === 'table' && below.table === entry.table && below.view === entry.view) {
      if (!allowMutationExit()) return;
      state.stack.pop();
      go(below, 'replace');
      return;
    }
    go({ ...tableView(entry.table, listQuery), view: entry.view }, 'replace');
  };
  return (
    <RecordKeys.Provider value={spec.keys ?? noKeys}>
      <SplitListDetail
        list={<AppListRoom entry={{ table: entry.table, query: listQuery, view: entry.view }} spec={listSpec} />}
        selected
        detailTitle={headingOf(newRecordNoun(spec, tableName))}
        detailActions={<SplitDetailActions entry={entry} />}
        detail={<SplitDetailPane entry={entry} show={detail} onClose={close} />}
        onCloseDetail={close}
        isCurrent={() => currentEntry() === entry}
        listLabel={say('list', { label: spec.label })}
        detailLabel={say('details', { label: spec.label })}
      />
    </RecordKeys.Provider>
  );
}
