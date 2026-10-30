/** The Container class a mistri App runs in on Cloudflare (MistriContainer). */
import { Container } from '@cloudflare/containers';
import { containerEnv } from './env.js';
import {
  DEFAULT_RESTART_TOKEN_ENV,
  DEFAULT_STARTUP_MS,
  DEFAULT_PORT,
  WORKER_VERSION_HEADER,
  type MistriContainerOptions,
} from './options.js';
import { isProbe, isRestart } from './restart.js';

/** The runtime's handle on the container, as far as the pin reads it. */
interface Runtime {
  images?: Record<string, unknown>;
  running?: boolean;
  /* `image` is empty while the container starts or after the Durable Object was restored; read, never compared to decide. */
  inspect?(): Promise<{ image?: string }>;
  start(options: Record<string, unknown>): unknown;
}

interface Storage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
}

interface State {
  container?: Runtime;
  storage?: Storage;
  abort?(reason?: string): void;
}

/** What the container was started with: the Durable Object records it, since a running container keeps its startup image and env. */
interface Started {
  image: string | null;
  deployId: string | null;
  instanceType: string | null;
  at: string;
}

const STARTED_KEY = 'mistri:started';
const RESET_KEY = 'mistri:reset-at';
/** The least between two self-resets: an object the platform starts again on its old version is not reset in a loop. */
const RESET_GAP_MS = 30_000;
/** The least between two replacements: a start that does not take is retried by the next tick, not in a loop. */
const REPLACE_GAP_MS = 60_000;

/**
 * The Container class a mistri App runs in, with what a field deployment learned the hard way:
 *
 * - always on: the instance never sleeps on inactivity (jobs, effects, mail and live sync run between requests);
 * - patient startup: mistri listens only after its startup checks, and the class waits 20 s for the port by default,
 *   which turned every request during a start into a 500;
 * - an optional pin of the image and instance type at each start, for an account whose container applications are
 *   created by the Durable Object;
 * - a self-upgrade: under the `durable_object` scheduling policy `wrangler deploy` rolls nothing out and a running
 *   container keeps its startup image and env, so the Durable Object records what it started the container with and, on
 *   a request or the Worker's tick, replaces a healthy container whose image, deploy id or instance type is not what
 *   this Worker version wants (at most one replacement per minute; a container still starting is left alone);
 * - a self-reset: the platform moves a running Durable Object onto a new Worker version eventually (about five minutes
 *   here), so when the Worker's probe or tick names a newer version than this object's own, the object aborts (at most
 *   once per 30 seconds) and the platform starts it again on the version that is live;
 * - a token-gated status probe (isProbe) and restart (isRestart), the manual fallback;
 * - the Worker's named vars and secrets handed to the container, and its start, stop and error logged.
 *
 * Configure by overriding the static `options`:
 *
 *   export class App extends MistriContainer {
 *     static override options = { vars: ['MISTRI_PUBLIC_URL'], secrets: ['BETTER_AUTH_SECRET'] };
 *   }
 */
export class MistriContainer extends Container<Record<string, unknown>> {
  static options: MistriContainerOptions = {};

  defaultPort = DEFAULT_PORT;
  sleepAfter = '5m';
  /* PostgreSQL, SMTP and a model API are outbound. */
  enableInternet = true;
  /* Startup only waits for the port to answer; /healthz opens no database. */
  pingEndpoint = 'localhost/healthz';

  private readonly settings: MistriContainerOptions;
  private readonly workerEnv: Record<string, unknown>;
  private readonly runtime: Runtime | undefined;
  private readonly storage: Storage | undefined;
  private readonly object: State;
  private recorded: Started | null | undefined;
  private replacing = false;
  private lastReplace = Number.NEGATIVE_INFINITY;

  constructor(ctx: State, env: Record<string, unknown>) {
    super(ctx as never, env);
    const settings = (new.target as typeof MistriContainer).options;
    this.settings = settings;
    this.workerEnv = env;
    this.runtime = ctx.container;
    this.storage = ctx.storage;
    this.object = ctx;
    this.defaultPort = settings.port ?? DEFAULT_PORT;
    if (settings.sleepAfter) this.sleepAfter = settings.sleepAfter;
    const runtime = ctx.container;
    if (runtime && settings.image && settings.instanceType) {
      const { image, instanceType } = settings;
      /* `container` is the class's own handle on ctx.container; every use but start passes through unchanged. */
      (this as unknown as { container: Runtime }).container = new Proxy(runtime, {
        get(target, key) {
          if (key === 'start')
            return (options: Record<string, unknown>) =>
              target.start({ ...options, image: target.images?.[image], instance: instanceType });
          const value: unknown = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    }
    this.envVars = containerEnv(settings, env);
  }

  override async onActivityExpired(): Promise<void> {
    if (this.settings.alwaysOn === false) await super.onActivityExpired();
  }

  /** What this Worker version wants the container to be started with. */
  private desired(): Omit<Started, 'at'> {
    const image = this.settings.image ? this.runtime?.images?.[this.settings.image] : undefined;
    const deployId = this.workerEnv.MISTRI_DEPLOY_ID;
    return {
      image: image == null ? null : String(image),
      deployId: typeof deployId === 'string' && deployId !== '' ? deployId : null,
      instanceType: this.settings.instanceType ?? null,
    };
  }

  private async startedWith(): Promise<Started | null> {
    if (this.recorded === undefined) this.recorded = ((await this.storage?.get(STARTED_KEY)) as Started | undefined) ?? null;
    return this.recorded;
  }

  /**
   * Replace a healthy container that was started with something else than this Worker version wants. The container is
   * not restarted here: after the stop, the request in hand (or the next one) starts it with this version's image and
   * env. A container with no record was started before the Durable Object kept one, so it is replaced once.
   */
  private async upgrade(): Promise<void> {
    if (this.replacing || !this.runtime?.running || Date.now() - this.lastReplace < REPLACE_GAP_MS) return;
    const want = this.desired();
    if (want.image === null && want.deployId === null) return;
    const had = await this.startedWith();
    const differs =
      had === null ||
      (want.deployId !== null && had.deployId !== want.deployId) ||
      (want.image !== null && had.image !== want.image) ||
      (want.instanceType !== null && had.instanceType !== want.instanceType);
    if (!differs || (await this.getState()).status !== 'healthy') return;
    this.replacing = true;
    this.lastReplace = Date.now();
    try {
      console.log(`mistri container replaced: started with ${had?.deployId ?? 'unrecorded'}, wanted ${want.deployId ?? want.image}`);
      await this.destroy();
    } finally {
      this.replacing = false;
    }
  }

  private async report(): Promise<Response> {
    const running = this.runtime?.running === true;
    let image: string | null = null;
    try {
      image = (await this.runtime?.inspect?.())?.image || null;
    } catch {
      /* A runtime without inspect, or one that refuses while the container starts, reports no image. */
    }
    const had = await this.startedWith();
    const { image: wantImage, deployId } = this.desired();
    const version = (this.workerEnv.CF_VERSION_METADATA as { id?: string } | undefined)?.id;
    return Response.json({
      workerVersion: version ?? null,
      desired: { image: wantImage, deployId },
      startedWith: had ? { image: had.image, deployId: had.deployId, at: had.at } : null,
      container: { running, image },
    });
  }

  /**
   * Abort this Durable Object when the Worker in front of it runs a newer version: the next request finds it started
   * again on the live version, whose upgrade() then replaces the container. The time of the reset is stored first, so
   * an object the platform starts again on its old version is reset at most once per RESET_GAP_MS.
   */
  private async resetIfBehind(request: Request): Promise<void> {
    const [live, liveAt] = (request.headers.get(WORKER_VERSION_HEADER) ?? '').split(' ');
    const own = this.workerEnv.CF_VERSION_METADATA as { id?: string; timestamp?: string } | undefined;
    if (!live || !liveAt || !own?.id || !own.timestamp || live === own.id || typeof this.object.abort !== 'function') return;
    /* Only a newer Worker: during a split rollout an older one also stamps, and must not reset the newer object. */
    if (!(Date.parse(liveAt) > Date.parse(own.timestamp))) return;
    const last = Number((await this.storage?.get(RESET_KEY)) ?? 0);
    if (Date.now() - last < RESET_GAP_MS) return;
    await this.storage?.put(RESET_KEY, Date.now());
    console.log(`mistri durable object reset: running Worker version ${own.id}, the Worker in front runs ${live}`);
    this.object.abort(`Worker version ${live} is live`);
  }

  override async fetch(request: Request): Promise<Response> {
    await this.resetIfBehind(request);
    const tokenEnv = this.settings.restartTokenEnv ?? DEFAULT_RESTART_TOKEN_ENV;
    if (isRestart(request, this.workerEnv, tokenEnv)) {
      await this.destroy();
      return new Response('stopped; the next request starts it again\n');
    }
    const probe = isProbe(request, this.workerEnv, tokenEnv);
    try {
      await this.upgrade();
    } catch (error) {
      console.error('mistri container upgrade failed', error);
    }
    return probe ? this.report() : super.fetch(request);
  }

  override startAndWaitForPorts(...args: Parameters<Container['startAndWaitForPorts']>): Promise<void> {
    const [portsOrArgs, cancellation, start] = args;
    const patient = { instanceGetTimeoutMS: 60_000, portReadyTimeoutMS: this.settings.startupTimeoutMs ?? DEFAULT_STARTUP_MS };
    if (portsOrArgs !== undefined && typeof portsOrArgs === 'object' && !Array.isArray(portsOrArgs))
      return super.startAndWaitForPorts({ ...portsOrArgs, cancellationOptions: { ...patient, ...portsOrArgs.cancellationOptions } });
    return super.startAndWaitForPorts(portsOrArgs, { ...patient, ...cancellation }, start);
  }

  override async onStart(): Promise<void> {
    console.log('mistri container started');
    const want = this.desired();
    this.recorded = { ...want, at: new Date().toISOString() };
    await this.storage?.put(STARTED_KEY, this.recorded);
  }

  override onStop(params: { exitCode?: number; reason?: string }): void {
    console.warn(`mistri container stopped: exit ${params.exitCode ?? '?'} (${params.reason ?? 'no reason'})`);
  }

  override onError(error: unknown): unknown {
    console.error('mistri container error', error);
    throw error;
  }
}
