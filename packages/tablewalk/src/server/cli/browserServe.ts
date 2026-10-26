/**
 * The database browser served over HTTP: the Workbench on its connections, listening until a signal.
 *
 * The App framework's start (cli/serve.ts) does this and a great deal more — sign-in, policies, commands, jobs,
 * mail, analytics, an App's reload on save — and a start that serves no App paid for all of it, module by module,
 * before the first page. This is what is left when there is no App: one server, its shutdown, its port and what it
 * says when it listens. The browser's main (browserMain.ts) runs it; a start that names an App, or anything only
 * the App framework serves, is handed to the other main before it gets here.
 */
import type { Server } from 'node:http';
import type { Registry } from '@mistriwork/engine/server/connections.js';
import { configLocations } from '@mistriwork/engine/server/config/locations.js';
import { createBrowserApp } from '../http/browserServer.js';
import { collectCapacity, diagnosticsFromEnvironment } from '@mistriwork/engine/server/operations/diagnostics.js';
import { closeDevClientHmr, retireDevClient } from '@mistriwork/engine/server/devclient.js';
import { startTelemetry } from '@mistriwork/engine/adapters/telemetry/start.js';
import { runtimeVersion } from '@mistriwork/engine/server/packageVersion.js';
import { startupReport } from '@mistriwork/engine/shared/refusal.js';
import { settingsMount } from '@mistriwork/engine/shared/mount.js';
import { openBrowser } from '@mistriwork/engine/server/cli/browser.js';
import { exposureLines } from '@mistriwork/engine/server/cli/startupOptions.js';
import { DEFAULT_SHUTDOWN_TIMINGS, shutdownTimings, type Options } from '@mistriwork/engine/server/cli/args.js';
import type { StartupConfig } from '@mistriwork/engine/server/cli/config.js';

export async function serveBrowser(opts: Options, registry: Registry, config: StartupConfig, nothingToOpen: boolean): Promise<void> {
  let base: string;
  try {
    // The path a reverse proxy serves this server under; there is no App to mount beneath it.
    base = settingsMount([], opts, config).base;
  } catch (error) {
    console.error(`tablewalk: ${startupReport(error)}`);
    process.exitCode = 1;
    return;
  }
  let listening = false,
    stopping = false;
  const serving = {
    registry,
    views: config.views,
    configPath: config.configPath,
    queries: config.queries,
    pages: config.pages,
    layouts: config.layouts,
    bound: {
      host: opts.host,
      port: opts.port,
      allowedHosts: opts.allowedHosts,
      identityHeader: opts.authProxyHeader,
      trustedProxies: opts.trustedProxies,
    },
    addresses: { base },
    /* The operator's request log (`TABLEWALK_DIAGNOSTICS`): the engine's, so a plain start keeps it. */
    diagnostics: diagnosticsFromEnvironment(process.env.TABLEWALK_DIAGNOSTICS),
    ready: () => listening && !stopping,
  };
  /* OpenTelemetry when OTEL_* asks for it; nothing is loaded otherwise. */
  const telemetry = await startTelemetry(process.env, runtimeVersion(), undefined, 'tablewalk');
  /* Each diagnostics summary carries the pools and the event loop as they were when it was taken. */
  serving.diagnostics?.watchCapacity(() => collectCapacity(registry));
  let server: Server;
  try {
    server = createBrowserApp(serving);
  } catch (error) {
    console.error(`Server startup error: ${error instanceof Error ? startupReport(error) : 'The server could not start.'}`);
    await registry.closeAll();
    process.exitCode = 1;
    return;
  }
  let exitStatus = 0;
  let closing: Promise<void> | undefined;
  /* The order the App framework's start closes in, for the parts there are: the listener, then the requests it
     accepted, then the connections and the exporter. A response that never finishes (a client that stopped
     reading) gets a bounded grace rather than the ten-minute request timeout. */
  const exit = (status: number): Promise<void> => {
    exitStatus = Math.max(exitStatus, status);
    closing ??= (async () => {
      stopping = true;
      const timings = shutdownTimings(opts);
      const { drainMs, graceMs } = typeof timings === 'string' ? DEFAULT_SHUTDOWN_TIMINGS : timings;
      const attempt = async (work: () => unknown) => {
        try {
          await work();
        } catch {
          exitStatus = 1;
        }
      };
      // Readiness is 503 from `stopping`; a balancer that probes needs a beat before the listener goes.
      if (drainMs) await new Promise((resolve) => setTimeout(resolve, drainMs));
      const closed = attempt(
        () =>
          new Promise<void>((resolve, reject) =>
            server.close((error) =>
              error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve(),
            ),
          ),
      );
      await attempt(() => closeDevClientHmr(server));
      server.closeIdleConnections();
      const grace = setTimeout(() => server.closeAllConnections(), graceMs);
      await closed;
      clearTimeout(grace);
      await attempt(() => retireDevClient(server));
      await attempt(() => registry.closeAll());
      // The request log's last summary, written before the process goes.
      await attempt(() => serving.diagnostics?.flush());
      await attempt(() => telemetry.shutdown());
      if (exitStatus) console.error('tablewalk: one or more server resources could not be closed cleanly.');
      process.off('SIGINT', shutdown);
      process.off('SIGTERM', shutdown);
      process.exit(exitStatus);
    })();
    return closing;
  };
  const shutdown = () => void exit(0);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  /* A busy port is a normal thing, not a stack trace. If the port was the default and something is already there,
     roll on to the next one and say so; if it was named with --port, fail with one clear line rather than a guess
     the caller did not ask for. */
  const FIRST_PORT = opts.port;
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (stopping) {
      exitStatus = 1;
      return;
    }
    if (err.code === 'EADDRINUSE') {
      if (!opts.portGiven && opts.port - FIRST_PORT < 20) {
        console.log(`tablewalk: port ${opts.port} is in use, trying ${opts.port + 1}…`);
        opts.port += 1;
        setImmediate(() => {
          if (!stopping) server.listen(opts.port, opts.host);
        });
        return;
      }
      console.error(
        `tablewalk: port ${opts.port} is already in use.` +
          (opts.portGiven ? ' Pick another with --port <n>.' : ' Give it a free one with --port <n>.'),
      );
      void exit(1);
      return;
    }
    console.error(`tablewalk: ${startupReport(err)}`);
    void exit(1);
  });
  server.once('listening', () => {
    if (stopping) return;
    const address = server.address();
    if (address && typeof address !== 'string') {
      opts.port = address.port;
      serving.bound.port = address.port;
    }
    const shown = opts.host === '127.0.0.1' ? 'localhost' : opts.host;
    listening = true;
    console.log(`Listening on http://${shown}:${opts.port}${base}`);
    if (nothingToOpen) {
      /* Said here rather than left for the browser to explain: somebody who meant to pass a database and mistyped
         the flag is looking at this terminal, not at the page. */
      console.log('tablewalk: no connection yet — open the page and it will ask for one.');
      console.log(`  A config file would have been read from:\n    ${configLocations(opts.config).join('\n    ')}`);
    }
    for (const line of exposureLines(opts.host, [], opts.authProxyHeader)) console.log(line);
    // Each relaxes a check, and a relaxed check nobody can see in the log is one nobody remembers turning on.
    if (opts.allowedHosts.length) console.log(`tablewalk: also answering writes for host ${opts.allowedHosts.join(', ')}`);
    if (opts.authProxyHeader) {
      console.log(`tablewalk: trusting ${opts.authProxyHeader} for who is asking; requests from beyond loopback must carry it`);
    }
    if (opts.trustProxyHops !== undefined) {
      console.log(
        `tablewalk: the client address is ${opts.trustProxyHops} place(s) from the right of X-Forwarded-For, for rate limits and sign-in lockout`,
      );
    }
    if (opts.trustProxyCloudflare) {
      console.log('tablewalk: the client address is CF-Connecting-IP; keep this server reachable through Cloudflare only');
    }
    if (opts.trustedProxies?.length) {
      console.log(
        `tablewalk: the public form rate limit reads X-Forwarded-For from ${opts.trustedProxies.map((range) => range.text).join(', ')} as well as loopback`,
      );
    }
    /* TABLEWALK_OPEN, when set, has the last word on the browser: the desktop app shows the page in its own window
       and sets it empty, so a second copy does not open beside it. '1'/'true' forces it; unset leaves the flags. */
    const envOpen = process.env.TABLEWALK_OPEN;
    const wantOpen = envOpen === undefined ? opts.open : !(envOpen === '' || envOpen === '0' || envOpen.toLowerCase() === 'false');
    if (wantOpen) void openBrowser(`http://${shown}:${opts.port}${base || ''}${base ? '/' : ''}`);
  });
  server.listen(opts.port, opts.host);
}
