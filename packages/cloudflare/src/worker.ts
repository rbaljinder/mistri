/** The Worker's `fetch` and `scheduled`: every request to one named, always-on instance. */
import { instanceOf } from './instance.js';

export interface MistriWorkerOptions {
  /** The Durable Object binding in wrangler.jsonc (`durable_objects.bindings[].name`). */
  binding: string;
  /** The instance's name. One instance: a second needs a shared cache and health-aware routing first. */
  instance: string;
  /** Where the instance runs, fixed the first time the name is used: `enam`, `wnam`, `weur`... Near the database. */
  location?: string;
}

/**
 * `fetch` and `scheduled` for a Worker in front of one always-on mistri container.
 *
 *   fetch      every request goes to the instance as it is; a WebSocket or a streamed response passes through
 *   scheduled  once a minute: starts the instance if a host restart or a rollout stopped it, asking for nothing but
 *              the process (/readyz answers before any App code)
 */
export function mistriWorker(options: MistriWorkerOptions) {
  const instance = (env: Record<string, unknown>) => instanceOf(env, options.binding, options.instance, options.location);
  return {
    fetch(request: Request, env: Record<string, unknown>): Promise<Response> {
      return instance(env).fetch(request);
    },
    async scheduled(_controller: unknown, env: Record<string, unknown>): Promise<void> {
      const base = (env.MISTRI_PUBLIC_URL as string | undefined) ?? 'http://container';
      const answer = await instance(env).fetch(new Request(new URL('/readyz', base)));
      if (!answer.ok) console.warn(`/readyz answered ${answer.status}`);
    },
  };
}
