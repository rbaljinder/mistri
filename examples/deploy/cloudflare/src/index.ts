/**
 * A Worker that forwards every request to a mistri App container, and wakes the instances on a schedule.
 * Cloudflare Containers do not autoscale: the App runs on a fixed INSTANCES chosen here and in wrangler.jsonc,
 * and a request goes to one of them at random. Every instance is stateless (docs/deploy-targets.md), so any
 * one will do; past one, give the App a Valkey cache connection or each instance keeps its own rate limits.
 */
import { Container, getContainer } from '@cloudflare/containers';

/** Equal to the container's max_instances in wrangler.jsonc. */
const INSTANCES = 1;

/** What the container reads from the environment: the Worker's variables and secrets, passed by name. */
const FORWARDED = [
  'MISTRI_PUBLIC_URL',
  'MISTRI_ALLOWED_HOSTS',
  'MISTRI_POOLER',
  'BETTER_AUTH_SECRET',
  // Add every ${NAME} the baked mistri.json reads, and MISTRI_S3_* when files go to a bucket.
  'APP_DB_PASSWORD',
] as const;

interface Env {
  APP: DurableObjectNamespace<App>;
  [name: string]: unknown;
}

export class App extends Container<Env> {
  defaultPort = 4111;
  /* The cron below touches every instance each minute, so this only matters if that stops. */
  sleepAfter = '10m';
  enableInternet = true;
  /* Container's constructor takes the state with no props (`{}`); the bare DurableObjectState is `unknown`-propped
     in the current workers-types and is refused. */
  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.envVars = {
      NODE_ENV: 'production',
      // The client address is Cloudflare's CF-Connecting-IP; without this every visitor shares one rate limit.
      MISTRI_TRUST_PROXY_CLOUDFLARE: '1',
      ...Object.fromEntries(FORWARDED.flatMap((name) => (typeof env[name] === 'string' ? [[name, env[name] as string]] : []))),
    };
  }
}

const instance = (env: Env, n: number) => getContainer(env.APP, `app-${n}`);

export default {
  /* A WebSocket or a streamed response passes through `fetch` as it is; `containerFetch` would not carry either. */
  fetch(request: Request, env: Env): Promise<Response> {
    return instance(env, Math.floor(Math.random() * INSTANCES)).fetch(request);
  },

  /* Wakes every instance, starting it if it slept or was replaced, and renews its sleep timer. /readyz answers
     before any App code, so it asks for nothing but the process. */
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await Promise.allSettled(Array.from({ length: INSTANCES }, (_, n) => instance(env, n).fetch(new Request('http://container/readyz'))));
  },
};
