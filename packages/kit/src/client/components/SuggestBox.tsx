/**
 * A search box that suggests: the box a list's text filter already is, with
 * a short list of the values its columns hold that contain what was typed
 * (suggestModel.ts). Loaded on demand (onDemand.tsx) by the boxes that offer
 * it — the rail's text facet, the bar's search, a landing's hero search —
 * which draw their plain box until it arrives, so the first paint carries
 * none of it.
 *
 * Enter is still the box's own: nothing is lit until the reader arrows into
 * the list, so Enter searches for what was typed, and a lit or clicked
 * suggestion fills the box and searches for it.
 */
import { useEffect, useRef, useState, type InputHTMLAttributes, type Ref } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { state } from '../core.js';
import { batchedBreakdown } from '../breakdownBatch.js';
import { Typeahead } from '@mistriwork/ui/Typeahead.js';
import { SUGGEST_MOST, SUGGEST_WAIT_MS, rankSuggestions, suggestText, suggestionsOf, type Suggestion } from './suggestModel.js';

interface SuggestBoxProps {
  /** The list's table, by id. */
  table: string;
  /** The columns whose values are suggested. */
  columns: readonly string[];
  /** The list's standing query: a suggestion is a value the list can show. */
  standing?: string;
  text: string;
  onText: (text: string) => void;
  /** A suggestion taken: the box already says it. */
  onPick: (value: string) => void;
  inputProps: InputHTMLAttributes<HTMLInputElement>;
  inputRef?: Ref<HTMLInputElement>;
}

export function SuggestBox({ table, columns, standing = '', text, onText, onPick, inputProps, inputRef }: SuggestBoxProps) {
  const typed = text.trim();
  const [asked, setAsked] = useState(typed);
  useEffect(() => {
    const wait = setTimeout(() => setAsked(typed), SUGGEST_WAIT_MS);
    return () => clearTimeout(wait);
  }, [typed]);
  const [wanted, setWanted] = useState(false);
  const lit = useRef<Suggestion | undefined>(undefined);
  const answer = useQuery<Suggestion[]>({
    /* In the list's query family, so a write that refreshes the rows refreshes what is suggested. */
    queryKey: ['run', state.activeConnection ?? '', 'suggest', table, columns.join(','), standing, asked],
    queryFn: async () =>
      rankSuggestions(
        await Promise.all(
          columns.map(async (column) =>
            suggestionsOf(await batchedBreakdown({ text: suggestText(table, column, asked, standing), limit: SUGGEST_MOST })),
          ),
        ),
        asked,
      ),
    enabled: asked !== '',
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    retry: false,
  });
  /* What was typed, said back, is no suggestion. */
  const items = typed === '' ? [] : (answer.data ?? []).filter((item) => item.value.toLowerCase() !== typed.toLowerCase());
  const { onKeyDown, ...rest } = inputProps;
  return (
    <Typeahead<Suggestion>
      text={text}
      onText={(next) => {
        onText(next);
        setWanted(true);
      }}
      open={wanted && items.length > 0}
      onOpenChange={setWanted}
      items={items}
      itemKey={(item) => item.value}
      itemLabel={(item) => item.value}
      itemClassName={(_item, highlighted) => `dd-option${highlighted ? ' active' : ''}`}
      renderItem={(item) => <span className="dd-label">{item.value}</span>}
      onPick={(item) => {
        setWanted(false);
        onText(item.value);
        onPick(item.value);
      }}
      inputRef={inputRef}
      autoHighlight={false}
      onHighlight={(item) => {
        lit.current = item;
      }}
      inputProps={{
        ...rest,
        autoComplete: 'off',
        onKeyDown: (e) => {
          /* A lit suggestion is the list's to take on Enter; the box searches only for what was typed. */
          if (e.key === 'Enter' && wanted && lit.current) return;
          onKeyDown?.(e);
        },
      }}
      popupClassName="dd-popup"
      listClassName="dd-list"
      fit="min-width"
    />
  );
}
