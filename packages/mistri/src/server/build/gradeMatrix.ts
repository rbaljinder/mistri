/**
 * `grade --theme all [--palette all] [--as all]` said as one table: a row per theme, palette and role, a column per
 * window, each cell ✓ or its count of findings; under it, each failing cell's first finding with its promise, and
 * where a theme's color caused it, the token and a value that passes. Pure, so it is tested without a browser.
 */
import { WINDOWS, type GradeFinding, type Judged } from './gradeJudge.js';

/** One row of the matrix: the windows it was graded in, and its findings merged as a run merges them. */
export interface MatrixRow {
  theme: string;
  palette: string;
  /** The role signed in as, `signed-out`, or `everyone` for an App with no sign-in. */
  role: string;
  windows: readonly string[];
  findings: readonly GradeFinding[];
}

const labelOf = (row: MatrixRow) => `${row.theme}/${row.palette}/${row.role}`;

/** The table: a header of windows, then a row each; `·` where a row was not graded in a window (a palette's desk). */
export function matrixTable(rows: readonly MatrixRow[]): string[] {
  const width = Math.max(...rows.map((row) => labelOf(row).length)) + 3;
  const columns = WINDOWS.map((window) => window.label);
  const line = (label: string, cells: readonly string[]) =>
    `${label.padEnd(width)}${cells.map((cell, i) => `${i ? '  ' : ''}${cell.padStart(columns[i]!.length)}`).join('')}`;
  return [
    line('', columns),
    ...rows.map((row) =>
      line(
        labelOf(row),
        columns.map((window) => {
          if (!row.windows.includes(window)) return '·';
          const n = row.findings.filter((finding) => finding.windows.includes(window)).length;
          return n ? String(n) : '✓';
        }),
      ),
    ),
  ];
}

/**
 * Each failing cell's first finding, one line: `C2 faint-edge cadence/default/manager 390 /parts — colors.light.lineControl
 * #c9c1d6 → #8a7fa0`. A theme's color says its token (the row names the theme) and the value `passing` finds of its
 * hue; any other finding says its message.
 */
export function matrixLines(rows: readonly MatrixRow[], passing: (token: NonNullable<Judged['token']>) => string | undefined): string[] {
  const lines: string[] = [];
  for (const row of rows) {
    for (const window of WINDOWS.map((each) => each.label)) {
      const first = row.findings.find((finding) => finding.windows.includes(window));
      if (!first) continue;
      const token = first.token;
      const said = token
        ? `${token.path.replace(/^[\w-]+\./, '')} ${token.value}${passing(token) ? ` → ${passing(token)}` : ''}`
        : first.message;
      lines.push(`${first.promise ? `${first.promise} ` : ''}${first.code} ${labelOf(row)} ${window} ${first.page} — ${said}`);
    }
  }
  return lines;
}
