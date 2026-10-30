/** The token-gated restart a deploy sends to a container that a code update left running. */
import { DEFAULT_RESTART_TOKEN_ENV, RESTART_HEADER } from './options.js';

/** Equal in time for equal lengths, so the token is not read off response timing. */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Whether this request is an operator's restart: a POST carrying the restart secret (32 characters or more, so a
 * short guessable one never opens it) in `x-mistri-restart`. A code update resets the Durable Object but leaves a
 * running container as it is; `mistri deploy` sends this until the new container answers.
 */
export function isRestart(request: Request, env: Record<string, unknown>, tokenEnv = DEFAULT_RESTART_TOKEN_ENV): boolean {
  const token = env[tokenEnv];
  if (request.method !== 'POST' || typeof token !== 'string' || token.length < 32) return false;
  const given = request.headers.get(RESTART_HEADER);
  return given !== null && same(given, token);
}
