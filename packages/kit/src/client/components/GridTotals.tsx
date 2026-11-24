/**
 * The grid's totals: a column's sum as its cell would draw it, the row that stands them under their columns, and the
 * sums of the columns folded away, said beside the caption. Apart from Grid.tsx, which is long enough.
 */
import { Fragment } from 'react';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import { say } from '../copy/lists/components/GridTotals.js';
import { columnDisplay, emptyWord } from '../core.js';
import { formatNumber } from '../locale.js';
import { Dressed } from './Value.js';
import { dressFor, type DisplayRule } from './valueModel.js';

/** A total, dressed as its column is; a sum past 2^53 is shown as the server sent it. */
export function TotalValue({ value, display }: { value: unknown; display: DisplayRule | null }) {
  if (value === undefined)
    return (
      <span className="grid-totals-pending" aria-label={say('summing')}>
        …
      </span>
    );
  if (value === null) return <span className="null">{emptyWord()}</span>;
  const dress = dressFor(display, value);
  if (dress && dress.kind !== 'meter') return <Dressed dress={dress} compact={dress.kind === 'richText'} />;
  return <span className="num-value">{formatNumber(value)}</span>;
}

/** The words the totals row draws for a column's sum, which its column is sized by (TotalValue's words); none while the
    sum is on its way, absent, or drawn by a meter. */
export function totalWords(display: DisplayRule | null, value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const dress = dressFor(display, value);
  if (!dress) return formatNumber(value);
  if (dress.kind === 'meter') return undefined;
  return String((dress.kind === 'tone' || dress.kind === 'word' || dress.kind === 'mark' ? dress.label : dress.text) ?? value);
}

/** A sum whose column is not drawn, as a group's head or the totals row says it. */
export interface AwaySum {
  name: string;
  head: string;
}

/**
 * The sums of the columns folded under the row's name: a totalled column that folds has no cell left to stand its sum
 * in, and the footer said "Total" over nothing (a field report). Each is said beside the caption with its column's
 * head, "Total Quote $12,340.00", in the words its own cell would have drawn.
 */
export function SumsAway({ sums, away, table }: { sums: Record<string, unknown>; away: readonly AwaySum[]; table: TableMeta | undefined }) {
  return away.map(({ name, head }) => (
    <Fragment key={name}>
      {' '}
      <span className="grid-totals-label">{head}</span>{' '}
      <TotalValue value={sums[name]} display={columnDisplay(table?.id, name) as DisplayRule | null} />
    </Fragment>
  ));
}

/**
 * The totals row: the caption under the first column and each sum under the column it adds up. Where a totalled
 * column is folded away, the caption's cell takes the columns before the first sum still drawn and says the folded
 * ones in it, so no sum is asked for and not shown.
 */
export function TotalsRow({
  columns,
  totals,
  label,
  away = [],
  slot = false,
  trail = false,
  table,
}: {
  columns: readonly string[];
  totals: Record<string, unknown>;
  label: string;
  away?: readonly AwaySum[];
  slot?: boolean;
  trail?: boolean;
  table: TableMeta | undefined;
}) {
  const first = columns.findIndex((name) => Object.hasOwn(totals, name));
  const lead = away.length ? Math.max(1, first < 0 ? columns.length : first) : 1;
  return (
    <tr className="grid-totals">
      {slot && <td className="expander-cell" />}
      {columns.map((name, index) => {
        if (index > 0 && index < lead) return null;
        if (!Object.hasOwn(totals, name))
          return (
            <td key={name} colSpan={index === 0 && lead > 1 ? lead : undefined}>
              {index === 0 && <span className="grid-totals-label">{label}</span>}
              {index === 0 && <SumsAway sums={totals} away={away} table={table} />}
            </td>
          );
        return (
          <td key={name} className="align-right num">
            <TotalValue value={totals[name]} display={columnDisplay(table?.id, name) as DisplayRule | null} />
          </td>
        );
      })}
      {trail && <td />}
    </tr>
  );
}
