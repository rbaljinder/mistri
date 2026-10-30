/** What a project says about its container: every field has the default a mistri App wants. */
export interface MistriContainerOptions {
  /** The port the App listens on in the image (PORT). Default 4111. */
  port?: number;
  /** Pin the instance type at each start (`standard-1`), for an account whose applications are created by the Durable Object. */
  instanceType?: string;
  /** The image's key in wrangler.jsonc, pinned at each start with `instanceType`. Unset leaves both to wrangler.jsonc. */
  image?: string;
  /** How long a request waits for a starting container to listen. mistri listens only after its startup checks, so minutes. Default 240000. */
  startupTimeoutMs?: number;
  /** Worker vars handed to the container by name (not secret). MISTRI_DEPLOY_ID is always among them. */
  vars?: readonly string[];
  /** Worker secrets handed to the container by name. */
  secrets?: readonly string[];
  /** The secret holding the restart token; a POST with its value in `x-mistri-restart` stops the container. Default MISTRI_RESTART_TOKEN. */
  restartTokenEnv?: string;
  /** The Durable Object's sleep timer. Default '5m'; it never stops an always-on container. */
  sleepAfter?: string;
  /** Keep the container running when idle: jobs, effects and mail run between requests. Default true. */
  alwaysOn?: boolean;
}

export const RESTART_HEADER = 'x-mistri-restart';
export const DEFAULT_RESTART_TOKEN_ENV = 'MISTRI_RESTART_TOKEN';
export const DEFAULT_STARTUP_MS = 240_000;
export const DEFAULT_PORT = 4111;
