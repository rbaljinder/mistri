/**
 * The API modes' own flags, checked before anything is read or loaded.
 *
 * Kept apart from the modes themselves (`api-read-startup-options.ts`,
 * `appMcpMode.ts`) because `main` asks these questions on every start, and
 * the modes import the auth store, the API owners and the tenant host: a
 * check that lived beside them made `--help` and `--mcp` load all of that to
 * learn that no API flag was given. This module imports nothing but types.
 */
import type { Options } from './args.js';
import { product } from '../product.js';

export const APP_MCP_TOKEN_VARIABLE = 'MISTRI_API_TOKEN';

/** `--api-reads` and the flags that only mean something with it or an export. */
export function apiReadStartupOptions(opts: Options) {
  const exporting = ['openapi', 'asyncapi'].includes(opts.export?.toLowerCase() ?? '');
  if (!opts.apiReads) {
    if (opts.apiRequestsPerMinute !== undefined) throw new Error('--api-requests-per-minute requires --api-reads.');
    if (exporting || opts.appMcp ? !['decimal-string', 'number'].includes(opts.apiIntegers ?? '') : opts.apiIntegers !== undefined) {
      throw new Error(
        '--api-integers decimal-string or number is required with --export openapi or asyncapi, --api-reads or --app-mcp, and only valid with those modes.',
      );
    }
    return undefined;
  }
  if (
    !['decimal-string', 'number'].includes(opts.apiIntegers ?? '') ||
    !/^[1-9][0-9]*(?![\s\S])/.test(opts.apiRequestsPerMinute ?? '') ||
    Number(opts.apiRequestsPerMinute) > 1000000
  )
    throw new Error('--api-reads requires explicit --api-integers and --api-requests-per-minute (1–1000000).');
  if (
    opts.export !== undefined ||
    opts.fromOpenapi !== undefined ||
    opts.openapi !== undefined ||
    opts.mcp ||
    opts.appMcp ||
    opts.lint !== undefined ||
    opts.diff !== undefined ||
    opts.scaffoldApp !== undefined ||
    opts.checkApp ||
    opts.writeAuthority ||
    opts.reindex !== undefined ||
    opts.demo
  ) {
    throw new Error('--api-reads cannot be combined with one-shot, import, MCP or demo modes.');
  }
  // A client address read from an arbitrary header could be anyone's: the
  // per-address budget trusts only X-Forwarded-For from a --trust-proxy peer.
  if (opts.authProxyHeader) throw new Error('--api-reads cannot be combined with --auth-proxy-header.');
  /* Listening beyond loopback — another interface, a name other than this
     machine's, or behind a proxy — is the operator's half of the network
     opt-in; the App's `api.network: true` is the other, checked once the App
     is loaded (assertApiReadStartupComposition). */
  const network =
    !['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1'].includes(opts.host) ||
    opts.allowedHosts.length > 0 ||
    opts.trustProxy.length > 0 ||
    opts.trustProxyHops !== undefined ||
    opts.trustProxyCloudflare ||
    (opts.trustedProxies?.length ?? 0) > 0;
  return Object.freeze({
    integers: opts.apiIntegers as 'decimal-string' | 'number',
    requestsPerMinute: Number(opts.apiRequestsPerMinute),
    ...(network ? { network: true as const } : {}),
  });
}

/** The startup line for a served App API: where it answers, to whom, and at
 * what rate — said where the operator is looking, so a network exposure is
 * never a surprise. */
export function apiServingLine(
  app: Readonly<{ name: string; id: string; api?: Readonly<{ version: number }> }>,
  api: Readonly<{ requestsPerMinute: number; network?: true }>,
  tenant = false,
): string {
  const at = `/api/apps/${app.id}/v${app.api?.version ?? 1}`;
  return (
    `${product()}: "${app.name}" API at ${at} (MCP at ${at}/$mcp) ` +
    (api.network ? 'beyond loopback' : 'on loopback') +
    `: scoped bearer tokens only${tenant ? ', each bound to one membership' : ''}; ` +
    `${api.requestsPerMinute} requests a minute per token, counted in this process` +
    (api.network ? '. Terminate TLS in front of it.' : '.')
  );
}

/**
 * What a listener beyond loopback exposes, said once it listens. The Workbench, or an App that signs no one in,
 * reads the database for whoever reaches the port; an App that signs people in reads for a signed-out visitor only
 * what its `auth.public` opens, so the warning that "anyone can read the database" was not true of it (OP8).
 * Behind `--auth-proxy-header` a request from beyond loopback must carry the proxy's identity, so nobody is read for
 * without one and the warning would be false; without it, the warning names the three ways out, because the Docker
 * image binds 0.0.0.0 by default and the person who started it never typed a host (SSRF-4).
 */
export function exposureLines(
  host: string,
  apps: ReadonlyArray<Readonly<{ name: string; auth?: Readonly<{ public?: Readonly<{ read: readonly string[] }> }> }>>,
  authProxyHeader?: string,
): string[] {
  if (/^(localhost|127\.0\.0\.1|::1)$/i.test(host)) return [];
  if (authProxyHeader) return [];
  const remedy = 'Bind --host 127.0.0.1, put it behind a proxy that signs people in (--auth-proxy-header), or give the App sign-in.';
  if (!apps.length)
    return [`Warning: bound to ${host}, beyond loopback, with no sign-in. Anyone who can reach this port can read the database. ${remedy}`];
  return apps.map((app) =>
    !app.auth
      ? `Warning: bound to ${host}, beyond loopback, and "${app.name}" signs no one in: anyone who can reach this port reads what it shows. ${remedy}`
      : app.auth.public?.read.length
        ? `${product()}: bound beyond loopback; "${app.name}" signs people in, and a signed-out visitor reads only what auth.public opens (${app.auth.public.read.join(', ')}) and its public forms show.`
        : `${product()}: bound beyond loopback; "${app.name}" signs people in, and a signed-out visitor reads nothing but what its public forms show.`,
  );
}

/** `--app-mcp`'s own flags. */
export function appMcpStartupOptions(opts: Options) {
  if (!opts.appMcp) return undefined;
  if (
    opts.apiReads ||
    opts.apiRequestsPerMinute !== undefined ||
    opts.mcp ||
    opts.export !== undefined ||
    opts.fromOpenapi !== undefined ||
    opts.openapi !== undefined ||
    opts.lint !== undefined ||
    opts.diff !== undefined ||
    opts.scaffoldApp !== undefined ||
    opts.checkApp ||
    opts.writeAuthority ||
    opts.reindex !== undefined ||
    opts.demo ||
    opts.jobs !== undefined ||
    opts.open ||
    opts.portGiven
  ) {
    throw new Error(
      '--app-mcp has no listener: it cannot be combined with --api-reads, --mcp, --jobs, --port, --open, or an import, one-shot or demo mode.',
    );
  }
  if (!['decimal-string', 'number'].includes(opts.apiIntegers ?? ''))
    throw new Error('--app-mcp requires explicit --api-integers decimal-string or number.');
  return Object.freeze({ integers: opts.apiIntegers as 'decimal-string' | 'number' });
}

/** Taken once and removed from the environment before any App or command code
 * loads, so neither can find it there and no child process inherits it.
 * Never echoed: the message names the variable, not its value. */
export function readAppMcpToken(env: NodeJS.ProcessEnv): string {
  const value = env[APP_MCP_TOKEN_VARIABLE];
  delete env[APP_MCP_TOKEN_VARIABLE];
  // Shape only; whether it is a token at all is the owners' decision, per call.
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\s\p{Cc}]/u.test(value)) {
    throw new Error(`--app-mcp reads the App API token from ${APP_MCP_TOKEN_VARIABLE}; set it to a token from mistri api-token issue.`);
  }
  return value;
}
