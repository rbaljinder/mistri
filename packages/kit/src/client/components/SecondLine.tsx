/**
 * A column's second line: the column its display rule names (`subtitle`, another column of the same record), drawn
 * quietly under the value wherever there is room for one (docs/design.md). Its own module so a test that stands a
 * value in for Value.tsx still draws the second line it is about.
 */
import type { ReactNode } from 'react';
import { columnDisplay } from '../core.js';
import { subtitlePath, type DisplayRule } from './valueModel.js';

/** The second line of `column` on `row`, as the record or the list read it with the row; none where it has no value. */
export function secondLine(
  tableId: string | undefined,
  column: string | undefined,
  row: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  if (tableId === undefined || !column || !row) return undefined;
  const path = subtitlePath(columnDisplay(tableId, column) as DisplayRule | null, column);
  const second = path !== undefined && Object.hasOwn(row, path) ? row[path] : undefined;
  return second === null || second === undefined || second === '' ? undefined : String(second);
}

/** Something drawn with its column's second line quietly under it, as a list's cell does. */
export function Subtitled({
  tableId,
  column,
  row,
  children,
}: {
  tableId: string | undefined;
  column: string | undefined;
  row: Readonly<Record<string, unknown>> | undefined;
  children: ReactNode;
}) {
  const second = secondLine(tableId, column, row);
  if (second === undefined) return children;
  return (
    <span className="value-subtitled">
      {children}
      <span className="value-sub">{second}</span>
    </span>
  );
}
