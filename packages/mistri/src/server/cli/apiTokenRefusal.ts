// What `mistri api-token` may print about a failure: the one refusal that names a precondition, and the scrubbed cause of any other.
import { scrubSecrets } from '@mistriwork/engine/server/connections.js';

/**
 * A refusal of `mistri api-token` that names the failed precondition and nothing else: never the token, a connection
 * string or the underlying driver message, which may carry them. It is the one error the command prints the text of
 * (apiTokenCommand.ts); every other failure prints its cause through `describeFailure`, since a commit may have
 * succeeded before it.
 */
export class MaintenanceRefusal extends Error {}

/**
 * An unexpected failure's own words, safe to print. A field report found "maintenance failed; inspect before
 * retrying" naming nothing, so the message now travels, with the shapes a driver quotes taken out: any URL's
 * credentials, user name included, a token handed out by `issue`, and a `password=`/`token=` pair. Truncated, one line.
 */
export function describeFailure(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const text = scrubSecrets(raw.replace(/(:\/\/)[^\s/@'"`]*@/g, '$1'))
    .replace(/\btwa1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}\b/g, '<token>')
    .replace(/\b(password|passwd|pwd|secret|token|key)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1$2<hidden>')
    .replace(/\s+/g, ' ')
    .replace(/[\s.]+$/, '');
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}
