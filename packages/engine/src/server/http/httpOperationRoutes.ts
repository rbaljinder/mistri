/**
 * The explorer's API tab: a resource's documented reads, described and tried.
 *
 *   POST /api/http/operations  { resource }                       → HttpOperations
 *   POST /api/http/operation   { resource, operation, params }    → HttpOperationReply
 *
 * The browser never names a URL, a header or an undeclared parameter: the
 * adapter builds every request from the connection's description, attaches
 * the credential and sends it through egress, and the reply carries the path,
 * the query string, the status and the body — never a header. A refusal is a
 * 400 and a failed call a 502, by the server's usual mapping.
 *
 * It is the operator's tool, beside Definition and the SQL pane: an App never
 * offers it, and a shape-only connection refuses it, because it shows bodies
 * whole — every row value in them included.
 */
import type { HttpAdapter } from '../../adapters/http/httpAdapter.js';
import { send } from './reply.js';
import type { PostContext } from './context.js';

const DESCRIBE = '/api/http/operations';
const TRY = '/api/http/operation';

/** Why this request cannot try an API, or undefined when it can. */
export function operationRefusal(request: {
  appConfigured: boolean;
  dialect: string;
  rowsKept: boolean;
}): { status: number; error: string } | undefined {
  if (request.appConfigured)
    return { status: 403, error: 'Trying an API is part of the database browser; an application does not offer it.' };
  if (request.dialect !== 'http')
    return { status: 400, error: 'This connection is a database, not an API, so it has no operations to try.' };
  if (request.rowsKept)
    return {
      status: 403,
      error: 'This connection keeps its rows in ("rows": false), and an API\'s answer is rows, so it is not tried here.',
    };
  return undefined;
}

const isParams = (value: unknown): value is Record<string, string> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.values(value).every((each) => typeof each === 'string');

export async function httpOperationRoutes(post: PostContext): Promise<boolean> {
  const { res, path, body, adapter, schema, registry, connection, appConfigured } = post;
  if (path !== DESCRIBE && path !== TRY) return false;
  const refused = operationRefusal({ appConfigured, dialect: schema.dialect, rowsKept: registry.configOf(connection)?.rows === false });
  if (refused) {
    send(res, refused.status, { error: refused.error });
    return true;
  }
  const api = adapter as Partial<HttpAdapter>;
  if (typeof api.operations !== 'function' || typeof api.operation !== 'function') {
    send(res, 501, { error: 'This connection cannot describe its API operations in this build.' });
    return true;
  }
  const resource = String(body.resource ?? '');
  // Refusals (an unknown resource, an undeclared parameter) and API failures throw, and server.ts maps them.
  if (path === DESCRIBE) {
    send(res, 200, api.operations.call(adapter, resource));
    return true;
  }
  const kind = body.operation;
  if (kind !== 'list' && kind !== 'item') {
    send(res, 400, { error: 'An operation is "list" or "item".' });
    return true;
  }
  const params = body.params ?? {};
  if (!isParams(params)) {
    send(res, 400, { error: "An operation's parameters are names and text values." });
    return true;
  }
  send(res, 200, await api.operation.call(adapter, resource, kind, params));
  return true;
}
