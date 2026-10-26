/**
 * The local columns a list presentation reads, so a list's query fetches
 * them beside the keys. Its own module because the client needs it on first
 * paint and app.ts is the manifest parser: a client that imported it from
 * there took the whole parser — every key list, the page parser, the key
 * homes it installs at load — into the first script it downloads.
 */
import { cardsColumns } from './appCards.js';
import type { AppListPresentation } from './listPresentations.js';

/** A split reads through its own show, and the columns of its rows when it chooses them. */
export function listPresentationColumns(list: AppListPresentation): string[] {
  if (list.kind === 'split') {
    const { row } = list;
    return row
      ? [
          ...new Set([
            row.primary,
            ...(row.badge ? [row.badge] : []),
            ...(row.avatar ? [row.avatar] : []),
            ...(row.lines ?? []),
            ...(row.facts ?? []),
          ]),
        ]
      : [];
  }
  if (list.kind === 'custom') return [...list.show];
  if (list.kind === 'cards') return cardsColumns(list);
  if (list.kind === 'tree') return [...new Set([list.parent, list.primary, ...(list.lines ?? [])])];
  if (list.kind === 'gantt')
    return [
      ...new Set([
        list.start,
        list.end,
        list.primary,
        ...(list.by === undefined ? [] : [list.by]),
        ...(list.progress === undefined ? [] : [list.progress]),
      ]),
    ];
  const lines = list.lines ?? [];
  return list.kind === 'checklist'
    ? [list.primary, list.checked, ...lines]
    : list.kind === 'queue'
      ? [...new Set([list.primary, ...(list.badge === undefined ? [] : [list.badge]), ...lines, ...(list.facts ?? [])])]
      : list.kind === 'calendar'
        ? [
            ...new Set([
              list.date,
              ...(list.end === undefined ? [] : [list.end]),
              list.primary,
              ...lines,
              ...(list.badge === undefined ? [] : [list.badge]),
            ]),
          ]
        : // The place and the row are read with the card, so a lane can be drawn in its order and a row found.
          [
            list.by,
            list.primary,
            ...lines,
            ...(list.order === undefined ? [] : [list.order]),
            ...(list.swimlanes === undefined ? [] : [list.swimlanes]),
            ...(list.category === undefined ? [] : [list.category]),
            ...(list.footer ?? []).map((fact) => fact.column),
          ];
}
