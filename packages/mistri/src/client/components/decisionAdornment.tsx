/**
 * A record's waiting suggestions, drawn at their fields through the page's adornment slot (kit's pageContext.ts
 * `FieldAdornment`): asked beside the record's own read, only for a table the App says a decision answers, and drawn
 * by DecisionChip, which loads when a record first has one — an App that decides nothing never fetches it.
 *
 * Until the chip's code is here its place is held by the answer's words in the same muted ink, so the line it stands
 * on is the height it will be.
 *
 * The same slot says what waits on the record from a maker that is not a person: the AI proposals on it, as a line
 * under its head, and the fields an AI or a job wrote that no person has confirmed, marked at the field. Both are read
 * from the shell's one review list (commandProposals.ts `useReview`, asked once after first paint and only where the
 * App offers review), so a record opening adds no request. Here it is only asked whether anything waits on this
 * table; RecordProposalLine.tsx narrows it to the record and draws it, and loads the first time a table has some.
 * That narrowing is not here because this module is in every App's first paint.
 */
import { lazy, Suspense, useMemo, useRef, type ReactNode } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api } from '@mistriwork/kit/client/core.js';
import { onDemand } from '@mistriwork/kit/client/components/onDemand.js';
import type { FieldAdornment } from '@mistriwork/kit/client/components/pageContext.js';
import type { FieldSuggestion } from '../../shared/decisionSuggestions.js';
import { activeApp } from '../appState.js';
import { useReview } from '../commandProposals.js';
import './decisionMarks.css';

const NOTHING: readonly string[] = Object.freeze([]);

const DecisionChip = lazy(() => import('./DecisionChip.js'));
/* Both from one module, drawn as nothing until it is here: one chunk request, and a line that only appears. */
const proposalLine = () => import('./RecordProposalLine.js');
const RecordReview = onDemand(proposalLine, 'RecordReview', { quiet: true });
const FieldReview = onDemand(proposalLine, 'FieldReview', { quiet: true });

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
): { adorn?: FieldAdornment; held: readonly string[]; notice?: ReactNode } {
  const keyText = JSON.stringify(recordKey ?? null);
  const client = useQueryClient();
  const app = activeApp();
  const answered = app?.decisions?.[table];
  const review = useReview(connection || null, Boolean(app?.review) && recordKey !== undefined);
  /* Whether anything waits on this table at all: the proposals are of commands the reader may decide, any of which may
     be on this record, and the marks name their table. */
  const waiting = Boolean(review && recordKey && (review.proposals.length || review.unconfirmed.some((mark) => mark.resource === table)));
  const fieldMarks = review && recordKey ? review.unconfirmed.filter((mark) => mark.resource === table && mark.field !== null) : [];
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
    if (!recordKey || (!decided && !fieldMarks.length)) return undefined;
    const settled = () => {
      refreshDecisions(client, connection, table);
      landed.current();
    };
    /* A filled field a decision answers is marked from the first paint, whether or not a suggestion is on its way, so
       a phone gives its value the line under the caption before one comes (decisionMarks.css): beside the caption, a
       suggestion trailing the value widened it past the line, and the value dropped under the caption late. */
    return ({ column, filled }) => {
      const unconfirmed = fieldMarks.some((each) => each.field === column) ? (
        <FieldReview marks={fieldMarks} table={table} column={column} recordKey={recordKey} />
      ) : null;
      if (!decided) return unconfirmed;
      const suggestion = suggestions?.find((each) => each.field === column);
      if (!suggestion)
        return filled && Object.hasOwn(answered!, column) ? <span className="decision-slot">{unconfirmed}</span> : unconfirmed;
      return (
        <span className="decision-slot">
          <Suspense fallback={<span className="decision-chip-held">{suggestion.label}</span>}>
            <DecisionChip suggestion={suggestion} table={table} recordKey={recordKey} onSettled={settled} />
          </Suspense>
          {unconfirmed}
        </span>
      );
    };
  }, [decided, suggestions, review, client, connection, table, keyText]); // eslint-disable-line react-hooks/exhaustive-deps
  const held = decided && asked.isPending && asked.fetchStatus !== 'idle' ? Object.keys(answered!) : NOTHING;
  const notice =
    review && recordKey && waiting ? (
      <RecordReview review={review} table={table} recordKey={recordKey} onLanded={() => landed.current()} />
    ) : undefined;
  return { ...(adorn ? { adorn } : {}), held, ...(notice ? { notice } : {}) };
}
