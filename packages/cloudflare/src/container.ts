/** The Container class a mistri App runs in on Cloudflare (MistriContainer). */
import { Container } from '@cloudflare/containers';
import { containerEnv } from './env.js';
import { DEFAULT_RESTART_TOKEN_ENV, DEFAULT_STARTUP_MS, DEFAULT_PORT, type MistriContainerOptions } from './options.js';
import { isRestart } from './restart.js';

/** The runtime's handle on the container, as far as the pin reads it. */
interface Runtime {
  images?: Record<string, unknown>;
  start(options: Record<string, unknown>): unknown;
}

interface State {
  container?: Runtime;
}

/**
 * The Container class a mistri App runs in, with what a field deployment learned the hard way:
 *
 * - always on: the instance never sleeps on inactivity (jobs, effects, mail and live sync run between requests);
 * - patient startup: mistri listens only after its startup checks, and the class waits 20 s for the port by default,
 *   which turned every request during a start into a 500;
 * - an optional pin of the image and instance type at each start, for an account whose container applications are
 *   created by the Durable Object;
 * - a token-gated restart (isRestart): a code update resets the Durable Object but leaves the container as it is;
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

  constructor(ctx: State, env: Record<string, unknown>) {
    super(ctx as never, env);
    const settings = (new.target as typeof MistriContainer).options;
    this.settings = settings;
    this.workerEnv = env;
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

  override async fetch(request: Request): Promise<Response> {
    if (isRestart(request, this.workerEnv, this.settings.restartTokenEnv ?? DEFAULT_RESTART_TOKEN_ENV)) {
      await this.destroy();
      return new Response('stopped; the next request starts it again\n');
    }
    return super.fetch(request);
  }

  override startAndWaitForPorts(...args: Parameters<Container['startAndWaitForPorts']>): Promise<void> {
    const [portsOrArgs, cancellation, start] = args;
    const patient = { instanceGetTimeoutMS: 60_000, portReadyTimeoutMS: this.settings.startupTimeoutMs ?? DEFAULT_STARTUP_MS };
    if (portsOrArgs !== undefined && typeof portsOrArgs === 'object' && !Array.isArray(portsOrArgs))
      return super.startAndWaitForPorts({ ...portsOrArgs, cancellationOptions: { ...patient, ...portsOrArgs.cancellationOptions } });
    return super.startAndWaitForPorts(portsOrArgs, { ...patient, ...cancellation }, start);
  }

  override onStart(): void {
    console.log('mistri container started');
  }

  override onStop(params: { exitCode?: number; reason?: string }): void {
    console.warn(`mistri container stopped: exit ${params.exitCode ?? '?'} (${params.reason ?? 'no reason'})`);
  }

  override onError(error: unknown): unknown {
    console.error('mistri container error', error);
    throw error;
  }
}
