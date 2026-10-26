/**
 * Every refusal names its cause — to the people allowed to hear it.
 *
 * A caller is told one fixed sentence, and must be: a driver's error names
 * columns and values, a clash on a hidden unique column says that a row
 * exists, and a signed-out visitor is owed nothing about how an App is built.
 * But a bare 503 with nothing logged anywhere cost Keystone's authors hours
 * each time — a scoped command whose parent was outside its footprint, an
 * audit entry past its bound, `me` in a rollup. So the reason is recorded on
 * the refusal where it is decided (`recordRefusalCause`, shared/refusal.ts),
 * and said here, at the one place a request's failure becomes its answer:
 *
 * - on the operator's stderr, always, for a server failure (5xx) or a refusal
 *   that recorded why — the terminal an author runs the server in;
 * - in the answer itself, as `cause`, only when the reader is the App's
 *   author at work (`noteAuthorRequest`): signed in as its administrator (the
 *   `admin` role, the account that may already act as anyone), over a
 *   loopback listener nothing else can reach, at an App the server is
 *   watching in its source directory — the edit loop, where a save reloads.
 *   Never a signed-out visitor or an ordinary account, never a build, never a
 *   listener the network reaches or a proxy speaks for.
 */
import type { IncomingMessage } from 'node:http';
import { refusalReasons, refusalSaid } from '../../shared/refusal.js';
import { clientTrusted, type Bound } from './trust.js';
import { AppAccessDenied } from '../columnGrants.js';
import { TenantContextError } from '../evidence.js';
import { currentSpan, log } from '../../adapters/telemetry/trace.js';
import { product } from '../product.js';

/* A denial's own sentence says nothing its caller was not told: an ordinary
   refusal of an ordinary request, not a reason. */
const OPAQUE = new Set([new AppAccessDenied().message, new TenantContextError().message]);

const authors = new WeakSet<IncomingMessage>();
/* The Apps this process is authoring: served from source and watched, so a
   save reloads them (cli/serve.ts). By path, since a reload replaces the
   loaded App and a request works on a copy of it. */
const authoring = new Set<string>();

/** This App is served from its source and reloads on save. */
export function authoringApp(path: string): void {
  authoring.add(path);
}

/** Mark this request as the author's own, when it is: see the module comment. */
export function noteAuthorRequest(
  req: IncomingMessage,
  bound: Bound,
  administrator: boolean,
  apps: ReadonlyArray<{ path: string; build?: unknown }>,
): void {
  if (
    administrator &&
    apps.length &&
    apps.every((app) => !app.build && authoring.has(app.path)) &&
    clientTrusted(bound) &&
    !bound.identityHeader &&
    !bound.trustedProxies?.length
  )
    authors.add(req);
}

/** What the operator is told: the error's own words when it is no refusal at
    all (a driver's, a bug), then each reason recorded beneath it. */
function reasonsFor(error: unknown, heard: string | undefined): string[] {
  const own = error instanceof Error && error.message && error.message !== heard ? [error.message] : [];
  return [...new Set([...own, ...recorded(error)])].filter((reason) => reason !== heard && !OPAQUE.has(reason));
}
const recorded = (error: unknown) => refusalReasons(error).filter((reason) => !OPAQUE.has(reason));

/**
 * Say a refused request to the operator, and return the sentence its author
 * may read, if this request is the author's. Quiet for an ordinary refusal
 * that recorded nothing — a 404 for a typo is not the operator's business —
 * unless `always`: an error that was not a refusal at all, answered as one.
 */
export function reportRefusal(
  req: IncomingMessage,
  status: number,
  code: string | undefined,
  heard: string | undefined,
  error: unknown,
  always = false,
): string | undefined {
  const reasons = reasonsFor(error, heard);
  /* The same reasons, on the request's span: the code and status travel, the
     reasons stay local for the dev observer, where "Open in observer" leads. */
  const span = currentSpan();
  span?.setAttributes({ 'mistri.refusal.code': code ?? String(status), 'mistri.refusal.status': status });
  span?.detail(() => ({ refusal: { status, ...(code ? { code } : {}), ...(heard ? { said: heard } : {}) }, because: reasons }));
  log(status >= 500 ? 'error' : 'warn', 'refusal', `Request refused (${status}${code ? ` ${code}` : ''})`, {
    attributes: { 'mistri.refusal.code': code, 'http.response.status_code': status },
    detail: () => ({ said: heard, because: reasons }),
  });
  /* A refusal that said its rule (sayRefusal) is the operator's business too: a role or a policy that refuses
     what its author meant it to allow is found here, not first with diagnostics on (field report TR7). */
  if (status < 500 && !recorded(error).length && !refusalSaid(error) && !always) return undefined;
  const path = (req.url ?? '').split('?')[0];
  console.error(`${product()}: ${req.method ?? 'GET'} ${path} refused (${status}${code ? ` ${code}` : ''})${heard ? `: ${heard}` : ''}`);
  for (const reason of reasons) console.error(`  because: ${reason}`);
  // The innermost reason is the one that names the rule, the table or the column.
  return authors.has(req) ? reasons.at(-1) : undefined;
}
