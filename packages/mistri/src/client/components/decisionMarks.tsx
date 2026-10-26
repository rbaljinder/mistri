/**
 * A list's marks (design §7): a row whose decided field is empty with a suggestion waiting draws the suggestion's
 * words, muted, beside a small glyph, in that empty cell — the cell's one line, so no row grows. Asked once per page of
 * rows, and only for a table the App says a decision answers; Accept is the record's (its ⋯ and its page).
 *
 * A phone's summary card says its facts on one wrapping line, where words arriving would push the facts after them
 * along or onto a line of their own. There a decided empty fact is drawn in its empty mark's own box from the first
 * paint, and a waiting suggestion is the glyph laid over that box, its words its name and its title: the card does not
 * move when the marks answer.
 */
import { useMemo, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, emptyWord, keyOf, state } from '@mistriwork/kit/client/core.js';
import { Icon } from '@mistriwork/kit/client/components/Icon.js';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import type { DecisionMark } from '../../shared/decisionSuggestions.js';
import { activeApp } from '../appState.js';
import { say } from '../copy/lists/components/decisionMarks.js';
import './decisionMarks.css';

/** The most a page of rows asks about at once (the server's own bound). */
const MARKS_MOST = 200;

export function useDecisionMarks(
  table: TableMeta | undefined,
  rows: ReadonlyArray<Record<string, unknown>>,
): ((row: Record<string, unknown>, column: string, form?: 'cell' | 'summary') => ReactNode | undefined) | undefined {
  const decided = table ? activeApp()?.decisions?.[table.id] : undefined;
  const keys = useMemo(
    () => (decided && table ? rows.slice(0, MARKS_MOST).map((row) => keyOf(table, row) as Record<string, unknown> | null) : []),
    [decided, table, rows],
  );
  const asked = keys.filter((key): key is Record<string, unknown> => key !== null);
  const keyText = JSON.stringify(asked);
  const connection = (state as { activeConnection?: string }).activeConnection ?? '';
  const marks = useQuery({
    queryKey: ['record-decisions', connection, table?.id ?? '', 'marks', keyText],
    queryFn: async () => ((await api('/api/record-decisions/marks', { table: table!.id, keys: asked })) as { marks: DecisionMark[] }).marks,
    enabled: Boolean(decided) && asked.length > 0,
    staleTime: 0,
  }).data;
  return useMemo(() => {
    if (!table || !decided) return undefined;
    const byRow = new Map<string, DecisionMark>();
    for (const mark of marks ?? []) byRow.set(`${JSON.stringify(asked[mark.row])}\n${mark.field}`, mark);
    return (row, column, form = 'cell') => {
      const key = keyOf(table, row);
      const mark = key ? byRow.get(`${JSON.stringify(key)}\n${column}`) : undefined;
      if (form === 'summary') {
        // Not a decided field: the summary's own empty mark.
        if (!Object.hasOwn(decided, column)) return undefined;
        const title = mark && say('markTitle', { value: mark.label });
        return (
          <span className={`decision-fact${mark ? ' is-marked' : ''}`}>
            <span className="null">{emptyWord()}</span>
            {mark && (
              <span className="decision-fact-mark" role="img" aria-label={title} title={title}>
                <Icon name="lightbulb" size="0.9em" className="decision-mark-glyph" />
              </span>
            )}
          </span>
        );
      }
      if (!mark) return undefined;
      return (
        <span className="decision-mark" title={say('markTitle', { value: mark.label })}>
          <Icon name="lightbulb" size="0.9em" className="decision-mark-glyph" />
          <span className="decision-mark-value">{mark.label}</span>
        </span>
      );
    };
  }, [table, decided, marks, keyText]); // eslint-disable-line react-hooks/exhaustive-deps
}
