/**
 * Whether a store failed to open because the database could not be reached,
 * as against the store being absent or the wrong layout. Startup wrapped every
 * failure while opening the job, event and command stores in advice to
 * provision them; an operator whose Postgres said "sorry, too many clients
 * already" was sent to run a migration that had nothing to fix. Narrower than
 * `databaseFault` (evidence.ts) on purpose: a SQLSTATE such as 42P01 (a table
 * that is not there) is exactly the case the provisioning advice is for.
 */
const NETWORK = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN']);
/* SQLSTATE: class 08 (connection exception), 53300 (too many connections),
   57P01-03 (the server is shutting down or starting), 28xxx (authorization:
   the role or password is wrong), 3D000 (no such database). */
const SQLSTATE = /^(?:08[0-9A-Z]{3}|53300|57P0[123]|28[0-9A-Z]{3}|3D000)$/;
const MESSAGE =
  /^(?:Connection terminated|Client has encountered a connection error|timeout exceeded when trying to connect|sorry, too many clients already)/;

function connectionLevel(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  const { code } = error as { code?: unknown };
  if (typeof code === 'string' && (NETWORK.has(code) || SQLSTATE.test(code))) return true;
  return MESSAGE.test(error.message);
}

/**
 * The driver's own words when `error` (or the error it wraps, one level down)
 * is a connection-level failure; undefined for anything else. The message of
 * a pg connection error never carries the URL or password.
 */
export function connectionFailure(error: unknown): string | undefined {
  const found = connectionLevel(error)
    ? error
    : connectionLevel((error as { cause?: unknown } | null)?.cause)
      ? (error as { cause: Error }).cause
      : undefined;
  if (!found) return undefined;
  const { code } = found as { code?: unknown };
  const message = found.message || (found as { errors?: Error[] }).errors?.[0]?.message || '';
  return `${typeof code === 'string' ? `${code}: ` : ''}${message}`.trim();
}
