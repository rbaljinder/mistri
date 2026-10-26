/**
 * Which requests write. One list, read by the tenant transport (the
 * mutations it carries, tenantTransport.ts) and by the request path (core.js),
 * which forgets a record page's composed answers as one is sent. Two lists
 * kept by hand had drifted: file uploads, record flows, agent calls and HTTP
 * operations changed a record and left the page's answers standing.
 */

/** The mutations a tenant's transport carries; `/api/commands/prepare` is among them but writes nothing. */
export const MUTATION_PATHS = [
  '/api/update',
  '/api/insert',
  '/api/file/upload',
  '/api/delete',
  '/api/revert',
  '/api/import',
  '/api/commands/prepare',
  '/api/commands/execute',
  '/api/commands/status',
] as const;

/* Writes the transport does not carry: a record flow, an agent's tool call and an HTTP operation run the App's own work. */
const OTHER_WRITES = new Set(['/api/record-flows/start', '/api/agent/call', '/api/http/operation']);
const MUTATIONS = new Set<string>(MUTATION_PATHS);

/**
 * Whether a request changes data, so what was read before it is not the record any more.
 * `/api/commands/prepare` only checks; `/api/revert` writes only when it confirms
 * (unconfirmed it is the undo menu's look at what it would undo, asked on every page);
 * a command's status answers an execute whose own answer was lost, and the write may have landed.
 */
export function isWritePath(path: string, body?: unknown): boolean {
  if (path === '/api/commands/prepare') return false;
  if (path === '/api/revert') return Boolean(body && typeof body === 'object' && (body as { confirm?: unknown }).confirm);
  return MUTATIONS.has(path) || OTHER_WRITES.has(path) || path.startsWith('/api/forms/');
}
