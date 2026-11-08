/**
 * A list's presentation as a free-form page's block (`<Board>`, `<Calendar>`, `<Gallery>`): the room the list views
 * draw it with, handed the question the block asked. Nothing is drawn here: the lanes, the cards, the month and the
 * drag are the list's own, so a board on a page moves a card exactly as a board in a view does.
 *
 * A card moves only through what the page declared. The resource's actions are narrowed to the commands and fixed
 * actions the page lists (`moves`), so a drop is one of those verbs, with its rules, its refusal and its optimistic
 * place; a board the page declares no move for is a place to read. Loaded when a page first draws one (blocks.tsx).
 *
 * The question is the list view's for the same presentation (`presentation` in its spec), and so are the reference
 * names read with it: a card's title, line or footer that is a reference says the record it names, as the view's
 * board does, never the key it holds.
 */
import { useMemo } from 'react';
import { TableRoom } from '@mistriwork/kit/client/components/TableRoom.js';
import { appListQuery, listReferenceNames, type ListSpec } from '@mistriwork/kit/client/components/appListModel.js';
import { offeredBy, resourceOf } from '@mistriwork/kit/client/components/appRooms.js';
import type { AppListPresentation } from '@mistriwork/engine/shared/listPresentations.js';
import type { AppAction } from '../../../shared/app.js';
import { shell } from '@mistriwork/kit/client/shellMode.js';
import { pageBridge } from '@mistriwork/kit/client/uiBridge.js';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';

export interface PresentedAsk {
  table: TableMeta;
  spec: AppListPresentation;
  /** The block's condition as one query text; sort and limit ride beside it. */
  query: string;
  sort?: string;
  limit?: number;
  label: string;
  /** The commands and fixed actions a card may be moved with; none, and the cards are read. */
  moves: readonly string[];
}

/** The resource's actions the page declared: a command's by the command it runs, a fixed one by its id. */
function declaredActions(table: string, moves: readonly string[]): AppAction[] {
  const app = pageBridge.activeApp() as Parameters<typeof resourceOf>[0];
  const offered = offeredBy(resourceOf(app, table)).actions ?? [];
  return offered.filter((action) => moves.includes((action.command ? (action.command as { id: string }).id : action.id) as string));
}

export function PresentedList({ table, spec, query, sort, limit, label, moves }: PresentedAsk) {
  const words = JSON.stringify([table.id, spec, query, sort, limit, label, moves]);
  /* Held on its words, so a page's redraw is not a refetch. */
  const held = useMemo(() => {
    const list: ListSpec = {
      table: table.id,
      label,
      presentation: spec,
      ...(query ? { query } : {}),
      ...(sort ? { sort } : {}),
      ...(limit === undefined ? {} : { limit }),
    };
    return {
      entry: { kind: 'table' as const, table: table.id, query: appListQuery(list) },
      actions: declaredActions(table.id, moves),
      referenceLabels: listReferenceNames(list),
    };
  }, [words]); // eslint-disable-line react-hooks/exhaustive-deps
  const board = spec.kind === 'board';
  return (
    <div className="dash-list">
      <TableRoom
        entry={held.entry}
        chrome={false}
        embedded
        interactive={board && held.actions.length > 0}
        export={false}
        presentation={spec}
        present={shell().present ?? undefined}
        listLabel={label}
        referenceLabels={held.referenceLabels}
        actions={board ? held.actions : undefined}
        recordNavigation={spec.kind === 'cards'}
      />
    </div>
  );
}
