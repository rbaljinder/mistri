/**
 * Why a write is refused, apart from the routes that write: data writes
 * (dataWriteRoutes.ts), a record's lines saved with it (formLinesWrite.ts) and
 * an import (importRoutes.ts) all ask it, and the routes import the lines
 * writer, so the question lives in a module of its own rather than closing a
 * loop between them (test/repo/runtime-cycles).
 */
import type { Registry } from '../connections.js';
import type { ColumnGrant } from '../columnGrants.js';
import { configFileName } from '../product.js';

/**
 * How a product says a refused write in its own words: an App answers for
 * the connections it serves (app/apps.ts `appWriteWording`), and says
 * nothing of the config file to the person using it. Absent, or undefined
 * for a connection, the database browser's words are said.
 */
export type WriteWording = (
  connection: string,
  name: string | undefined,
) => { readonly readOnly: string; denied(tableId: string | undefined, readable: boolean): string } | undefined;

/**
 * Why a write to `connection` (and `tableId`, when the write names one) is
 * refused, or null. Two gates in one sentence: the connection's `writable`
 * flag, then the grant's write scope — narrower than the connection's, never
 * wider. The message names the file and the field, because the person who
 * hits this is usually the person who can change it.
 */
export function writeRefusal(
  registry: Registry,
  wording: WriteWording | undefined,
  connection: string,
  tableId: string | undefined,
  resources?: { connectionFor(table: string): string },
  access?: ColumnGrant & { readonly actions?: ReadonlyMap<string, unknown> },
  /** An update (or its Undo) may reach a table where a role runs fixed actions without write; the facade judges which. */
  update = false,
): string | null {
  const owner = tableId && resources ? resources.connectionFor(tableId) : connection;
  const config = registry.configOf(owner);
  const said = wording?.(connection, registry.configOf(connection)?.name);
  if (!config?.writable) {
    if (said) return said.readOnly;
    return (
      `"${config?.name ?? connection}" is read-only. ` + `Add "writable": true to its entry in your ${configFileName()} to allow edits.`
    );
  }
  if (access && !access.writable.has(tableId ?? '') && !(update && access.actions?.has(tableId ?? ''))) {
    return said ? said.denied(tableId, tableId !== undefined && access.readable.has(tableId)) : 'Access to this resource is denied.';
  }
  return null;
}
