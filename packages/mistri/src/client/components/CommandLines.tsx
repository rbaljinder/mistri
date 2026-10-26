/**
 * A command's lines (`field.lines`), drawn with the record's lines grid
 * (FormLines.tsx): the same cells by kind, the reference with its photo and
 * second line, money in its currency, the handle a line moves by, the line's
 * computed figures beside it and their money added up under the grid. The
 * values are the form's (CommandFields.tsx), held as the grid holds them; what
 * is sent is read by the command's own reader, and the handler writes the rows.
 *
 * Loaded with the first form that asks lines, never by a public form, which
 * cannot.
 */
import { columnLabel, findTable } from '@mistriwork/kit/client/core.js';
import type { AppCommandField, AppCommandLines } from '../../shared/command.js';
import { lineCell } from '../../shared/commandLineCell.js';
import { humanName } from '@mistriwork/engine/shared/model.js';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import { LinesEditor, type LineDraft } from './FormLines.js';

/** A line's cell read as its column's kind, from the catalog the form is served (the server reads it again). */
export function lineCellOf(table: string, column: string, value: string | number | boolean) {
  const meta = findTable(table) as TableMeta | undefined;
  return meta ? lineCell(meta, column, value) : { value };
}

/** A grid line's cell and its words: `lines[1].quantity` → the lines field, its row and its column's caption. */
export function lineAt(
  fields: readonly AppCommandField[],
  path: string,
): { field: AppCommandLines; row: number; label: string } | undefined {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\[(\d+)\]\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(path);
  const field = m ? fields.find((candidate) => candidate.name === m[1]) : undefined;
  if (!m || field?.type !== 'lines') return undefined;
  const table = findTable(field.from) as TableMeta | undefined;
  return { field, row: Number(m[2]), label: (table && (columnLabel(table.id, m[3]) as string | null)) || humanName(m[3]) };
}

/** The grid's problems, `${row}.${column}`, from the form's by path (`lines[1].quantity`). */
function cellProblems(path: string, problems: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const prefix = `${path}[`;
  return Object.fromEntries(
    Object.entries(problems ?? {}).flatMap(([at, said]) => {
      if (!at.startsWith(prefix)) return [];
      const m = /^\[(\d+)\]\.(.+)$/.exec(at.slice(path.length));
      return m ? [[`${m[1]}.${m[2]}`, said]] : [];
    }),
  );
}

export function CommandLines({
  field,
  path,
  rows,
  problems,
  disabled,
  onChange,
}: {
  field: AppCommandLines;
  path: string;
  rows: readonly LineDraft[];
  problems?: Readonly<Record<string, string>>;
  disabled?: boolean;
  onChange: (rows: LineDraft[], path: string) => void;
}) {
  const table = findTable(field.from) as TableMeta | undefined;
  /* A reader who cannot read the rows' resource is not offered its grid: the form says the input is missing when sent. */
  if (!table) return null;
  return (
    <LinesEditor
      title={field.label}
      {...(field.help ? { description: field.help } : {})}
      table={table}
      columns={field.show}
      rows={rows}
      onChange={(next) => onChange(next, path)}
      ordered
      max={field.max}
      problems={cellProblems(path, problems)}
      disabled={disabled === true}
      {...(field.copy ? { copy: field.copy } : {})}
      {...(field.query ? { where: field.query } : {})}
      subtotal
    />
  );
}
