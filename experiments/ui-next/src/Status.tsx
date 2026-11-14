import type { ReactNode } from 'react';

export type Tone = 'neutral' | 'good' | 'warning' | 'critical' | 'info';

/* Meaning is a dot and its word: the word stays in the ink and only the dot carries the tone, so a column of
   statuses reads as words (docs/design.md, rule 6). */
export function Status({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span data-slot="status" data-tone={tone}>
      {children}
    </span>
  );
}
