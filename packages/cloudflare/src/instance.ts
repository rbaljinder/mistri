/** The Durable Object namespace as the Worker uses it: only what is called. */
interface Namespace {
  idFromName(name: string): unknown;
  get(id: unknown, options?: { locationHint?: string }): { fetch(request: Request): Promise<Response> };
}

/**
 * The one named instance. Its Durable Object, and so its container, is placed where the name is first used, near the
 * database rather than the visitor: a page is several round trips to it.
 */
export function instanceOf(env: Record<string, unknown>, binding: string, name: string, location?: string) {
  const namespace = env[binding] as Namespace | undefined;
  if (!namespace || typeof namespace.idFromName !== 'function') throw new Error(`the Worker has no Durable Object binding "${binding}"`);
  return namespace.get(namespace.idFromName(name), location ? { locationHint: location } : undefined);
}
