/**
 * A record's waiting suggestions, drawn at their fields through the page's adornment slot (kit's pageContext.ts
 * `FieldAdornment`): asked beside the record's own read, only for a table the App says a decision answers, and drawn
 * by DecisionChip, which loads when a record first has one — an App that decides nothing never fetches it.
 *
 * Until the chip's code is here its place is held by the answer's words in the same muted ink, so the line it stands
 * on is the height it will be.
 */
import { lazy, Suspense, useMemo, useRef } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api } from '@mistriwork/kit/client/core.js';
import type { FieldAdornment } from '@mistriwork/kit/client/components/pageContext.js';
import type { FieldSuggestion } from '../../shared/decisionSuggestions.js';
import { activeApp } from '../appState.js';
import './decisionMarks.css';

const NOTHING: readonly string[] = Object.freeze([]);

const DecisionChip = lazy(() => import('./DecisionChip.js'));

const suggestionsKey = (connection: string, table: string, key?: string) =>
  key === undefined ? ['record-decisions', connection, table] : ['record-decisions', connection, table, key];

/** Ask a record's suggestions again: after a command landed on it, or one was settled. */
export function refreshDecisions(client: QueryClient, connection: string, table: string): void {
  void client.invalidateQueries({ queryKey: suggestionsKey(connection, table) });
}

/**
 * A record's suggestions, drawn at its fields, and whether they are still being asked for the first time — the shell's
 * `useFieldAdornment` slot (kit's shellMode.ts), read by every record page. While asked, a header leaves an empty fact
 * out, so its facts' line waits for them (kit's pageContext.ts `adornHeld`) rather than grow when they come. An error is
 * not a wait. No key (a preview, a list with no record chosen) asks nothing.
 */
export function useRecordDecisions(
  connection: string,
  table: string,
  recordKey: Readonly<Record<string, unknown>> | undefined,
  onLanded: () => void,
): { adorn?: FieldAdornment; held: readonly string[] } {
  const keyText = JSON.stringify(recordKey ?? null);
  const client = useQueryClient();
  const answered = activeApp()?.decisions?.[table];
  const decided = Boolean(answered) && recordKey !== undefined;
  const asked = useQuery({
    queryKey: suggestionsKey(connection, table, keyText),
    queryFn: async () =>
      ((await api('/api/record-decisions', { table, key: recordKey })) as { suggestions: FieldSuggestion[] }).suggestions,
    enabled: decided,
    staleTime: 0,
  });
  const suggestions = asked.data;
  const landed = useRef(onLanded);
  landed.current = onLanded;
  const adorn = useMemo((): FieldAdornment | undefined => {
    if (!decided || !recordKey || !suggestions?.length) return undefined;
    const settled = () => {
      refreshDecisions(client, connection, table);
      landed.current();
    };
    return ({ column }) => {
      const suggestion = suggestions.find((each) => each.field === column);
      if (!suggestion) return null;
      return (
        <Suspense fallback={<span className="decision-chip-held">{suggestion.label}</span>}>
          <DecisionChip suggestion={suggestion} table={table} recordKey={recordKey} onSettled={settled} />
        </Suspense>
      );
    };
  }, [decided, suggestions, client, connection, table, keyText]); // eslint-disable-line react-hooks/exhaustive-deps
  const held = decided && asked.isPending && asked.fetchStatus !== 'idle' ? Object.keys(answered!) : NOTHING;
  return adorn ? { adorn, held } : { held };
}
