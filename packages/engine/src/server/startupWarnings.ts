/**
 * Node's ExperimentalWarning for `node:sqlite`, kept off a start's output.
 *
 * tablewalk opens `node:sqlite` whatever the connections are — its own stores
 * (sign-in, API tokens, a tenant's journal) are SQLite files — so the Node
 * releases that still call the module experimental printed "SQLite is an
 * experimental feature" on every start, above a config that names only
 * PostgreSQL. It is a note about Node's API to whoever chose to use it, and
 * that is this package, which pins the Node versions it supports: the person
 * running tablewalk can do nothing with it. Only that one warning is dropped;
 * every other goes out as Node would send it.
 */
import { envName, product } from './product.js';
type EmitWarning = typeof process.emitWarning;

const isSqliteExperimental = (warning: unknown, type: unknown): boolean => {
  const name = warning instanceof Error ? warning.name : typeof type === 'string' ? type : (type as { type?: unknown } | undefined)?.type;
  const message = warning instanceof Error ? warning.message : String(warning);
  return name === 'ExperimentalWarning' && /\bSQLite\b/i.test(message);
};

/** Installed once, before anything imports `node:sqlite`. */
export function quietSqliteExperimentalWarning(target: { emitWarning: EmitWarning } = process): void {
  const emit = target.emitWarning;
  target.emitWarning = function emitWarning(this: unknown, warning: string | Error, ...rest: unknown[]) {
    if (isSqliteExperimental(warning, rest[0])) return;
    return (emit as (...args: unknown[]) => void).call(this ?? target, warning, ...rest);
  } as EmitWarning;
}

/**
 * The oldest Node a start accepts: the major `engines` names in package.json, and the one CI, the image and the
 * desktop app run. npm only warns on `engines`, and `npx` not even that, so on an older Node the first anyone heard
 * was a missing export or a syntax error from somewhere inside the server. One line before any of it is loaded says
 * what is wrong instead.
 */
export const NODE_FLOOR = 24;

/** What a start on `version` (process.versions.node) prints before it refuses, or undefined when it is new enough. */
export function oldNodeRefusal(version: string = process.versions.node): string | undefined {
  if (Number(version.split('.')[0]) >= NODE_FLOOR) return undefined;
  return `${product()} needs Node ${NODE_FLOOR} or newer; this is Node ${version}. Install Node ${NODE_FLOOR} (https://nodejs.org) and run it again.`;
}

const said = new Set<string>();
/** Print `line` once per process, however many Apps or handlers reach it. */
export function warnOnce(key: string, line: string, write: (line: string) => void = console.warn): void {
  if (said.has(key)) return;
  said.add(key);
  write(`${product()}: warning: ${line}`);
}

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|::1|\[::1\])$/i;

/**
 * Sign-in served beyond this machine at an `http:` public address: the session cookies are marked Secure only when
 * the address the server answers to is https, so here they never are, and a browser sends them over plain http too.
 * Not a refusal: a TLS proxy in front is the usual shape, and only its public address is missing.
 */
export function insecureCookieWarning(publicUrl: string, listenHost: string): string | undefined {
  let url: URL;
  try {
    url = new URL(publicUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' || (LOOPBACK.test(listenHost) && LOOPBACK.test(url.hostname))) return undefined;
  return (
    `sign-in is served beyond this machine at ${url.origin}, an http address, so its session cookies are never marked Secure. ` +
    `Serve it behind a TLS proxy and set its public address (${envName('PUBLIC_URL')}) to the proxy's https address.`
  );
}

/** A fetch-style host that names no client: every visitor is one address to the sign-in and form rate limits. */
export const SHARED_RATE_LIMIT_WARNING =
  'the fetch handler was called without a clientAddress, so every visitor shares one sign-in rate limit and lockout. ' +
  "Pass the visitor's address as the second argument: tw.fetch(request, { clientAddress }).";
