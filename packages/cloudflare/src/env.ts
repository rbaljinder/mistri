/** The environment a mistri container starts with, from the Worker's own. */
import { DEFAULT_PORT, type MistriContainerOptions } from './options.js';

/**
 * The environment the container starts with: the image's own ENV said again (a start's environment is not guaranteed
 * to be merged into the image's), what a Cloudflare front end needs, then every named var and secret the Worker holds.
 * A name that is unset or empty is left out, so the container's default applies.
 */
export function containerEnv(options: MistriContainerOptions, env: Record<string, unknown>): Record<string, string> {
  const names = [...new Set(['MISTRI_DEPLOY_ID', ...(options.vars ?? []), ...(options.secrets ?? [])])];
  return {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    PORT: String(options.port ?? DEFAULT_PORT),
    NODE_OPTIONS: '--enable-source-maps',
    NODE_COMPILE_CACHE: '/tmp/v8',
    NODE_ENV: 'production',
    /* The client address is Cloudflare's CF-Connecting-IP; without this every visitor shares one rate limit. */
    MISTRI_TRUST_PROXY_CLOUDFLARE: '1',
    ...Object.fromEntries(
      names.flatMap((name) => (typeof env[name] === 'string' && env[name] !== '' ? [[name, env[name] as string]] : [])),
    ),
  };
}
