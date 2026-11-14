import { matchRanges, matchSegments } from '@ui-sdk/react/text-match';
import { createContext, type ReactNode, useContext } from 'react';

/* What the list around a cell is being searched for. A list says it once; a cell that wants its text marked reads
   it here, so no column has to be handed the search. */
export const SearchWords = createContext('');

/* A cell's text with the part the search matched marked in it, so a reader sees why a row is still there. Outside a
   search, and where nothing in this text matched (another column did), it is the text as it was. */
export function Mark({ children }: { children: string }): ReactNode {
  const words = useContext(SearchWords).trim();
  if (!words) return children;
  const ranges = matchRanges(children, words, 'contains');
  if (!ranges.length) return children;
  return matchSegments(children, ranges).map((segment, index) =>
    // The segments of one text never reorder, so their place is their key.
    // eslint-disable-next-line react/no-array-index-key
    segment.match ? <mark key={index}>{segment.text}</mark> : segment.text,
  );
}
