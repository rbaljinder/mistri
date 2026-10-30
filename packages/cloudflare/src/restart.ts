/** The token-gated restart and status probe a deploy sends to a container that a code update left running. */
import { DEFAULT_RESTART_TOKEN_ENV, PROBE_PATH, RESTART_HEADER } from './options.js';

/** Equal in time for equal lengths, so the token is not read off response timing. */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function carriesToken(request: Request, env: Record<string, unknown>, tokenEnv: string): boolean {
  const token = env[tokenEnv];
  if (typeof token !== 'string' || token.length < 32) return false;
  const given = request.headers.get(RESTART_HEADER);
  return given !== null && same(given, token);
}

/**
 * Whether this request is an operator's restart: a POST carrying the restart secret (32 characters or more, so a
 * short guessable one never opens it) in `x-mistri-restart`. The container normally replaces itself after a deploy;
 * this is the manual fallback, and what `mistri deploy` sends when it does not.
 */
export function isRestart(request: Request, env: Record<string, unknown>, tokenEnv = DEFAULT_RESTART_TOKEN_ENV): boolean {
  return request.method === 'POST' && carriesToken(request, env, tokenEnv);
}

/**
 * Whether this request is the status probe: a GET of PROBE_PATH with the same token header. A path of its own (not `/`)
 * so a stray header never turns a page view into the probe; an older Worker proxies it to the App, which is not JSON.
 */
export function isProbe(request: Request, env: Record<string, unknown>, tokenEnv = DEFAULT_RESTART_TOKEN_ENV): boolean {
  return request.method === 'GET' && new URL(request.url).pathname === PROBE_PATH && carriesToken(request, env, tokenEnv);
}
