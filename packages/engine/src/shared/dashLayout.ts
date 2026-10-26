/**
 * A dashboard's `areas`: sections placed in named areas of a grid of equal columns.
 *
 * One reading on both sides — the parser that refuses a template (appViews.ts), the lint that judges an area's
 * width (designLint.ts) and the client that draws it (components/Dashboard.tsx) — so a template means the same
 * thing wherever it is read. Pure data in, data out.
 */
import { nearest } from './suggest.js';

/** An area's name: a lowercase word that is also a CSS identifier, since the client names the grid area with it. */
const AREA_NAME = /^[a-z][a-z0-9-]{0,23}$/;
/** Words CSS reads before an area name: `grid-area: span` or `auto` is not a name. */
const CSS_WORDS = new Set(['auto', 'span', 'initial', 'inherit', 'unset', 'revert', 'default']);
const LAYOUT_MAX_ROWS = 8;
const LAYOUT_MAX_COLUMNS = 4;
/** The cell that holds no area. */
const EMPTY_CELL = '.';

/** A template as cells: `grid[row][column]` is an area's name or `.`. */
export type LayoutGrid = string[][];

/** Whether a word may name an area. */
export const isAreaName = (word: string): boolean => AREA_NAME.test(word) && !CSS_WORDS.has(word);

/** The rows of a template as cells. Ragged rows stay ragged: `layoutProblems` is what says so. */
export function layoutGrid(layout: readonly string[]): LayoutGrid {
  return layout.map((row) => row.trim().split(/\s+/).filter(Boolean));
}

/** The areas a template names, in reading order: row by row, each at its first cell. */
export function layoutAreas(grid: LayoutGrid): string[] {
  const seen: string[] = [];
  for (const row of grid) for (const cell of row) if (cell !== EMPTY_CELL && !seen.includes(cell)) seen.push(cell);
  return seen;
}

/** The cells an area covers, 0-based, in reading order. */
function cellsOf(grid: LayoutGrid, name: string): Array<{ row: number; column: number }> {
  const cells: Array<{ row: number; column: number }> = [];
  grid.forEach((row, r) => row.forEach((cell, c) => cell === name && cells.push({ row: r, column: c })));
  return cells;
}

/** An area's box: where it starts, and how many rows and columns it spans. Absent when the template does not name it. */
export function areaBox(grid: LayoutGrid, name: string): { row: number; column: number; rows: number; columns: number } | undefined {
  const cells = cellsOf(grid, name);
  if (!cells.length) return undefined;
  const rows = cells.map((cell) => cell.row);
  const columns = cells.map((cell) => cell.column);
  const row = Math.min(...rows);
  const column = Math.min(...columns);
  return { row, column, rows: Math.max(...rows) - row + 1, columns: Math.max(...columns) - column + 1 };
}

const place = (cell: { row: number; column: number }): string => `row ${cell.row + 1} column ${cell.column + 1}`;

/** "a, b and c". */
const said = (words: string[]): string =>
  words.length < 2 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;

/** Whether an area's cells fill their box exactly. */
function isRectangle(grid: LayoutGrid, name: string): boolean {
  const box = areaBox(grid, name);
  return !box || cellsOf(grid, name).length === box.rows * box.columns;
}

/**
 * Everything wrong with a template, in words, one pass: a template is judged whole so one run names every refusal.
 * `at` is the dashboard, as the other refusals name it.
 */
export function layoutProblems(layout: unknown, at: string): string[] {
  const here = `${at}, "areas"`;
  if (!Array.isArray(layout) || !layout.length || layout.some((row) => typeof row !== 'string')) {
    return [`${here} is not a list of rows, each a string of area names: ['kpis kpis', 'trend side'].`];
  }
  const problems: string[] = [];
  if (layout.length > LAYOUT_MAX_ROWS) problems.push(`${here} has ${layout.length} rows. At most ${LAYOUT_MAX_ROWS}.`);
  const grid = layoutGrid(layout as string[]);
  const widest = Math.max(...grid.map((row) => row.length));
  if (grid.some((row) => !row.length)) problems.push(`${here} has an empty row. Write . for a cell with nothing in it.`);
  if (widest > LAYOUT_MAX_COLUMNS)
    problems.push(
      `${here} has ${widest} columns in a row. At most ${LAYOUT_MAX_COLUMNS}: wider than that, a column is too narrow to read.`,
    );
  const counts = new Set(grid.filter((row) => row.length).map((row) => row.length));
  if (counts.size > 1) {
    problems.push(
      `${here} has rows of different lengths (${grid.map((row, i) => `row ${i + 1} has ${row.length}`).join(', ')}). Every row has the same number of cells; write . for one with nothing in it.`,
    );
  }
  for (const word of new Set(grid.flat())) {
    if (word !== EMPTY_CELL && !isAreaName(word)) {
      problems.push(
        `${here} has "${word}", which is not an area name. An area is a lowercase word (letters, digits and hyphens, at most 24, starting with a letter, and not ${[...CSS_WORDS].join(' or ')}); . is a cell with nothing in it.`,
      );
    }
  }
  if (problems.length) return problems;
  for (const name of layoutAreas(grid)) {
    if (isRectangle(grid, name)) continue;
    problems.push(
      `${here}: "${name}" is not a rectangle: it covers ${said(cellsOf(grid, name).map(place))}. An area is one block of cells; give each separate block its own name.`,
    );
  }
  return problems;
}

/**
 * The areas a layout leaves for a reader when `hidden` ones have nothing to draw: a hidden area's cells go to its left
 * neighbour in that row (the right one when it is first), and a row left with no area in it is dropped. A neighbour that
 * would stop being a rectangle by it is not given the cells, which stand empty. Pure: a template in, a template out.
 */
export function reflowLayout(grid: LayoutGrid, hidden: ReadonlySet<string>): LayoutGrid {
  let next = grid.map((row) => [...row]);
  for (const name of layoutAreas(grid)) {
    if (!hidden.has(name)) continue;
    const trial = next.map((row) => [...row]);
    const touched = new Set<string>();
    next.forEach((row, r) => {
      const first = row.indexOf(name);
      if (first < 0) return;
      const last = row.lastIndexOf(name);
      const neighbour = first > 0 ? row[first - 1]! : (row[last + 1] ?? EMPTY_CELL);
      for (let c = first; c <= last; c++) trial[r]![c] = neighbour;
      touched.add(neighbour);
    });
    for (const other of touched) {
      if (other !== EMPTY_CELL && !isRectangle(trial, other)) {
        trial.forEach((row, r) =>
          row.forEach((cell, c) => {
            if (cell === other && next[r]![c] === name) row[c] = EMPTY_CELL;
          }),
        );
      }
    }
    next = trial;
  }
  return next.filter((row) => row.some((cell) => cell !== EMPTY_CELL));
}

/** The template as the strings a CSS `grid-template-areas` takes: one quoted row each. */
export const gridTemplateAreas = (grid: LayoutGrid): string => grid.map((row) => `"${row.join(' ')}"`).join(' ');

/** An area that no section is placed in, or a section placed in none: the nearest name for a slip. */
export function nearestArea(name: string, areas: readonly string[]): string | undefined {
  return nearest(name, areas);
}
