/**
 * The requests the server builds for its own work on a file (http/fileRows.ts,
 * an upload's values, files/fileStorage.ts placeFile): the only ones that may
 * name an `internal` column — a file's object and hash — which the access
 * guard (app/appAccess.ts resourceChecks) refuses to every other request, read or
 * write. A WeakSet of the objects themselves, so nothing that arrives as data —
 * JSON, a copy, a request rebuilt from one — is ever in it.
 */
const serverRequests = new WeakSet<object>();

/** Mark a request, or a write's values, as the server's own. */
export function serverRequest<T extends object>(request: T): T {
  serverRequests.add(request);
  return request;
}

/** Whether a request — or a write's `values`, which an upload's file columns are marked on — is the server's own. */
export function isServerRequest(request: unknown): boolean {
  if (typeof request !== 'object' || request === null) return false;
  if (serverRequests.has(request)) return true;
  const values = (request as { values?: unknown }).values;
  return typeof values === 'object' && values !== null && serverRequests.has(values);
}

/** A layer that copies a request (a tenant lease's captured data) carries the server's mark to its copy. */
export function carryServerRequest<T>(from: unknown, to: T): T {
  if (isServerRequest(from) && typeof to === 'object' && to !== null) {
    serverRequests.add(to);
    const values = (to as { values?: unknown }).values;
    if (typeof values === 'object' && values !== null) serverRequests.add(values);
  }
  return to;
}
