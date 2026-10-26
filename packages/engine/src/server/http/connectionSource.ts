/**
 * The source a database browser request reads: the connection it names, or
 * the active one, opened and leased for the request's life. An App's source
 * — its resources, its reader's grants, its row policy — is the App
 * framework's (source.ts), which comes here only for a request no App
 * curates.
 */
import { HttpError } from './reply.js';
import type { RequestContext, ResolvedSource } from './context.js';

/** The query-string key a request names its source with. */
export function sourceSelector(ctx: Pick<RequestContext, 'appConfigured'>): 'app' | 'conn' {
  return ctx.appConfigured ? 'app' : 'conn';
}

export async function resolveConnectionSource(ctx: RequestContext, id: string | null | undefined): Promise<ResolvedSource> {
  const { res, registry } = ctx;
  /* Named but unknown is a 404, not a fallback. Falling back ran the
     request against whatever happened to be active — the right answer to
     the wrong question, and with raw SQL on the same path, the wrong
     database. */
  if (id && !registry.has(id)) throw new HttpError(404, `No connection called "${id}".`);
  const target = id ?? registry.active;
  if (!target) throw new HttpError(409, 'No connection is open.');
  const opened = await registry.open(target);
  const release = registry.lease(target);
  if (res.destroyed) release();
  else res.once('close', release);

  /* Every answer says which database gave it.

     Set here rather than added to a dozen `send` calls: this is the one
     place that knows, and a header covers the replies that are arrays and
     the ones that are errors as well as the ones that are objects.

     It exists to make the guarantee checkable. "The reply came from the
     connection the request named" is the whole of the multi-tab fix, and
     without this it is a claim rather than something a test or a reader can
     verify. */
  res.setHeader('x-mistri-connection', target);
  return {
    adapter: opened.adapter,
    schema: opened.schema,
    connectionId: target,
    publicScope: { connection: target },
    publicDefinition: (definition) => definition,
  };
}
