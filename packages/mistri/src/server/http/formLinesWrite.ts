/**
 * A new record's lines as a save sends them: the rows of `form.lines`, inserted
 * with the record. They arrive as `lines`, keyed by the child resource, each
 * the collection's every row in its order:
 *
 *   lines: { order_line: [{ values: { product_id: 3, quantity: 1 } }] }
 *
 * Which column joins a row to the record, and which one holds its place, come
 * from the App's declaration, never from the request, so a save can only ever
 * write the rows it declares — and each row is still written as the reader
 * could write it alone: the child's grant, its validation.
 */
import type { AppDef } from '../../shared/appModel.js';
import { tableNamed, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { appForConnection, appWriteWording } from '../app/apps.js';
import type { LineCollection, LineRow } from '@mistriwork/engine/server/recordWriteOperations.js';
import { writeRefusal } from '@mistriwork/engine/server/http/writeRefusal.js';
import type { PostContext } from '@mistriwork/engine/server/http/context.js';

/** As many rows as a New form's lines may hold (formRules.ts MAX_FORM_CHILD_ROWS). */
const MOST_ROWS = 64;

type Scalar = string | number | boolean | null;

interface Declared {
  from: string;
  whose: string;
  order?: string;
  min?: number;
  max?: number;
}

/** The collections a save of `tableId` may carry: its form's lines. */
function declared(app: AppDef, schema: DatabaseSchema, tableId: string): Declared[] {
  const resource = Object.entries(app.resources ?? {}).find(([name]) => tableNamed(schema, name)?.id === tableId)?.[1];
  return (resource?.form?.lines ?? []).map((line) => ({ ...line }));
}

const plain = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const scalar = (value: unknown): value is Scalar =>
  value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));

/** Who is saving, as the lines need to know it: the reader's own grants, judged by the writer the record goes through. */
interface LinesJudge {
  app: AppDef;
  schema: DatabaseSchema;
  /** Why this reader may not write rows of the child table, or nothing. */
  refused(child: string): string | null | undefined;
}

/**
 * The lines on a save, judged before anything is written: an answer to send
 * (a status and a sentence) when they are not ones this App takes, else the
 * collections, each with the reference that binds it and the rows in order.
 * The single-App route, a row policy's and a tenant lease's all judge them
 * here, each with its own reader's grants.
 */
export function judgeLines(
  judge: LinesJudge,
  tableId: string | undefined,
  raw: unknown,
): { lines: LineCollection[] } | { status: number; error: string } {
  const { app, schema } = judge;
  const base = tableId ? tableNamed(schema, tableId) : undefined;
  if (!base) return { status: 400, error: 'Lines are saved with a record of an App that declares them.' };
  if (!plain(raw)) return { status: 400, error: 'Lines are an object of rows by the resource they belong to.' };
  const allowed = declared(app, schema, base.id);
  const lines: LineCollection[] = [];
  for (const [name, rows] of Object.entries(raw)) {
    const child = tableNamed(schema, name);
    const line = child && allowed.find((d) => tableNamed(schema, d.from)?.id === child.id);
    if (!child || !line) return { status: 400, error: `This record does not take lines of "${name}".` };
    const fk = schema.foreignKeys.find(
      (k) => k.from.table === child.id && k.to.table === base.id && k.from.columns.length === 1 && k.from.columns[0] === line.whose,
    );
    if (!fk) return { status: 400, error: `"${line.whose}" is not a reference from ${child.name} to ${base.name}.` };
    const refused = judge.refused(child.id);
    if (refused) return { status: 403, error: refused };
    const most = Math.min(line.max ?? MOST_ROWS, MOST_ROWS);
    if (!Array.isArray(rows) || rows.length > most)
      return { status: 400, error: `Lines of ${child.name} are a list of at most ${most} rows.` };
    if (rows.length < (line.min ?? 0))
      return { status: 400, error: `This record is saved with at least ${line.min} lines of ${child.name}.` };
    const held: LineRow[] = [];
    for (const [i, row] of rows.entries()) {
      const at = `Line ${i + 1} of ${child.name}`;
      if (!plain(row) || !plain(row.values) || Object.values(row.values).some((v) => !scalar(v)))
        return { status: 400, error: `${at} is not { values } of plain values.` };
      if (line.whose in row.values || (line.order && line.order in row.values))
        return {
          status: 400,
          error: `${at} sets "${line.order && line.order in row.values ? line.order : line.whose}", which the save fills.`,
        };
      if (row.key !== undefined) return { status: 400, error: `${at} has a key; a new record's lines are new rows.` };
      held.push({ values: row.values as Record<string, Scalar> });
    }
    lines.push({
      table: child.id,
      whose: line.whose,
      refers: fk.to.columns[0],
      ...(line.order ? { order: line.order } : {}),
      rows: held,
    });
  }
  return { lines };
}

/** The lines on a single-App save, judged with the reader's grants on this connection. */
export function readLines(
  post: Pick<PostContext, 'schema' | 'registry' | 'connection' | 'appHosts' | 'resources' | 'access'>,
  tableId: string | undefined,
  raw: unknown,
): { lines: LineCollection[] } | { status: number; error: string } {
  const { schema, registry, connection, appHosts, resources, access } = post;
  const host = appHosts?.length ? appForConnection(appHosts, connection, registry.configOf(connection)?.name) : undefined;
  if (!host) return { status: 400, error: 'Lines are saved with a record of an App that declares them.' };
  return judgeLines(
    {
      app: host.app.app,
      schema,
      refused: (child) => writeRefusal(registry, appWriteWording(appHosts), connection, child, resources, access),
    },
    tableId,
    raw,
  );
}
