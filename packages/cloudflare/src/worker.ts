/** The Worker's `fetch` and `scheduled`: every request to one named, always-on instance. */
import { instanceOf } from './instance.js';
import { DEFAULT_RESTART_TOKEN_ENV, WORKER_VERSION_HEADER } from './options.js';
import { isProbe } from './restart.js';

export interface MistriWorkerOptions {
  /** The Durable Object binding in wrangler.jsonc (`durable_objects.bindings[].name`). */
  binding: string;
  /** The instance's name. One instance: a second needs a shared cache and health-aware routing first. */
  instance: string;
  /** Where the instance runs, fixed the first time the name is used: `enam`, `wnam`, `weur`... Near the database. */
  location?: string;
  /** The secret holding the restart token, as the container's `restartTokenEnv`. Default MISTRI_RESTART_TOKEN. */
  restartTokenEnv?: string;
}

/**
 * `fetch` and `scheduled` for a Worker in front of one always-on mistri container.
 *
 *   fetch      every request goes to the instance as it is; a WebSocket or a streamed response passes through
 *   scheduled  once a minute: starts the instance if a host restart or a rollout stopped it, asking for nothing but
 *              the process (/readyz answers before any App code)
 *
 * The status probe and the tick carry this Worker's version id (the `version_metadata` binding), so a Durable Object
 * still on the previous version learns a newer one is live and resets itself (MistriContainer) instead of waiting out
 * the platform's rollout, which took about five minutes. The probe is stamped only when it carries the restart token,
 * so no visitor can make the object reset; the tick is the Worker's own. Every other request has a client's copy of
 * the header removed, so a stamp the object reads was always put there here.
 */
export function mistriWorker(options: MistriWorkerOptions) {
  const instance = (env: Record<string, unknown>) => instanceOf(env, options.binding, options.instance, options.location);
  return {
    fetch(request: Request, env: Record<string, unknown>): Promise<Response> {
      const stamp = isProbe(request, env, options.restartTokenEnv ?? DEFAULT_RESTART_TOKEN_ENV);
      return instance(env).fetch(stamp || request.headers.has(WORKER_VERSION_HEADER) ? stamped(request, env, stamp) : request);
    },
    async scheduled(_controller: unknown, env: Record<string, unknown>): Promise<void> {
      const base = (env.MISTRI_PUBLIC_URL as string | undefined) ?? 'http://container';
      const answer = await instance(env).fetch(stamped(new Request(new URL('/readyz', base)), env, true));
      if (!answer.ok) console.warn(`/readyz answered ${answer.status}`);
    },
  };
}

/** The request with this Worker's version id and upload time in WORKER_VERSION_HEADER when `stamp`, and with no such header otherwise. */
function stamped(request: Request, env: Record<string, unknown>, stamp: boolean): Request {
  const headers = new Headers(request.headers);
  const version = env.CF_VERSION_METADATA as { id?: string; timestamp?: string } | undefined;
  if (stamp && version?.id && version.timestamp) headers.set(WORKER_VERSION_HEADER, `${version.id} ${version.timestamp}`);
  else headers.delete(WORKER_VERSION_HEADER);
  return new Request(request, { headers });
}
