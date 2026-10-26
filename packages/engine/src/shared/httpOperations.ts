/**
 * The documented reads of one resource of an HTTP connection, as the
 * explorer's API tab offers them.
 *
 * Shared so the form the client draws and the request the server builds come
 * from one shape: whatever the tab shows a box for is exactly what the server
 * will send, and nothing the description does not declare can reach either.
 */

/** What a list parameter does, so the tab can draw the right box for it. */
type HttpParamKind = 'filter' | 'search' | 'sort' | 'offset' | 'limit' | 'page' | 'size' | 'cursor';

export interface HttpParam {
  /** The query parameter, as the API spells it. */
  name: string;
  kind: HttpParamKind;
  /** A filter's column. */
  column?: string;
  /** A filter that takes several values (its operators include `in`). */
  many?: boolean;
  /** A sort's documented values. */
  values?: string[];
}

export interface HttpOperations {
  resource: string;
  /** The list GET: its path and the parameters its description declares. `next` points at the cursor a page names. */
  list: { path: string; params: HttpParam[]; next?: string };
  /** The item GET: its path template and the key it names. */
  item: { path: string; key: string };
}

/** One read, as it went: the request line and the answer, never a header. */
export interface HttpOperationReply {
  request: { method: 'GET'; path: string; query: string };
  status: number;
  /** The body, whole, when the API answered 2xx; absent otherwise, because egress never reads an error's body. */
  json?: unknown;
  ms: number;
}
