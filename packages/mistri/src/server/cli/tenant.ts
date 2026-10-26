/**
 * Serving a tenant App. It has a dedicated owner, never the ordinary registry
 * adapter or createApp's fallback: one explicit --app with --policy and a
 * connection-only config, and every other mode refused before any data is
 * acquired. The deployment's files are watched from before validation, so a
 * change during startup is a restart rather than a half-read deployment.
 */
import { readFile } from 'node:fs/promises';
import { createAppAuth } from '../auth/auth.js';
import { loadConfig, type Registry } from '@mistriwork/engine/server/connections.js';
import { loadApp } from '../app/apps.js';
import { checkAuthorityLock } from '../app/authorityLock.js';
import { openBrowser } from '@mistriwork/engine/server/cli/browser.js';
import type { Options } from '@mistriwork/engine/server/cli/args.js';
import type { StartupConfig } from '@mistriwork/engine/server/cli/config.js';
import type { StartupApps } from './apps.js';
import { apiReadStartupOptions, apiServingLine } from '@mistriwork/engine/server/cli/startupOptions.js';
import { refusalHeadline, refusalReasonsBelow } from '@mistriwork/engine/server/evidence.js';
import { appHome, publicRoot, settingsMount, type AddressMount } from '@mistriwork/engine/shared/mount.js';
import type { MountedServing } from './serve.js';
import { unsweptBuckets } from '../files/fileStorage.js';
import { embedIssuersOf, identityProvidersOf, oauthServerOf, scimDirectoriesOf } from '../serviceConnections.js';
import { CONFIG_SECTIONS } from '../serviceConnections.js';
import { testControlFrom } from '../http/testControl.js';

export async function serveTenantApp(
  opts: Options,
  registry: Registry,
  config: StartupConfig,
  apps: StartupApps,
  nonPolicyMode: boolean,
): Promise<void> {
  await startTenantServing(opts, registry, config, apps, nonPolicyMode);
}

/**
 * Everything `serveTenantApp` does short of a port, as `startServing` is for
 * the ordinary server (cli/serve.ts): with `opts.embedded` the tenant host
 * comes back unlistened for a mounted handler to dispatch to, its jobs
 * started, and a change to the deployment's files retires it rather than
 * exiting a process that is the host's.
 */
export async function startTenantServing(
  opts: Options,
  registry: Registry,
  config: StartupConfig,
  apps: StartupApps,
  nonPolicyMode: boolean,
): Promise<MountedServing | undefined> {
  const { loadedApps, pagesBeforeApp, loadOptions } = apps;
  const { configPath, loadedConfigSignature, loadedConfigText } = config;
  let stopWatching: (() => void) | undefined;
  let observer: import('../observe/observer.js').Observer | undefined;
  try {
    if (
      !opts.policy ||
      opts.apps?.length !== 1 ||
      loadedApps.length !== 1 ||
      config.apps.length ||
      nonPolicyMode ||
      opts.demo ||
      opts.target ||
      opts.schemas.length ||
      opts.authProxyHeader ||
      config.views.length ||
      config.queries.length ||
      pagesBeforeApp.length ||
      config.layouts.length
    ) {
      throw new Error(
        'Tenant startup requires --policy and one explicit --app with connection-only config; alternate modes, proxy identity and global authored resources are not supported.',
      );
    }
    const { prepareTenantStartup, watchTenantStartup } = await import('../tenant/tenantStartup.js');
    const { lookOnlyChange } = await import('../tenant/tenantLook.js');
    const loaded = loadedApps[0];
    /* One App, so at the root unless --mount says otherwise, and under
       --base-path as every server is (shared/mount.ts): the rule the
       ordinary App server reads its addresses by. */
    const mount: AddressMount = settingsMount([loaded.app.id], opts, config);
    let changed = false;
    let retireOnChange: (() => void) | undefined;
    /* Set once the host serves: before then a save of any kind is a restart, as a half-read deployment would be. */
    let restyle: ((touched: string[]) => Promise<boolean>) | undefined;
    // A build is served as built and watches nothing; a source App restarts on change, but for its look (tenantLook.ts).
    stopWatching = loaded.build
      ? () => {}
      : watchTenantStartup(
          {
            loaded,
            policyFile: opts.policy,
            ...(opts.commands ? { commandsFile: opts.commands } : {}),
            ...(opts.jobs ? { jobsFile: opts.jobs } : {}),
            ...(configPath ? { configPath } : {}),
            look: (touched) => restyle?.(touched) ?? Promise.resolve(false),
          },
          () => {
            changed = true;
            retireOnChange?.();
          },
        );
    // Close the load→watch gap. The original normalized definition and the
    // one read under observation must agree before importing server policy.
    const observed = await loadApp(opts.apps[0], {
      ...loadOptions,
      ...(loaded.entry ? { entry: loaded.entry } : {}),
      ...(opts.commands ? { commands: opts.commands } : {}),
    });
    if (changed || JSON.stringify(observed) !== JSON.stringify(loaded)) throw new Error('The tenant App changed during startup; restart.');
    if (
      configPath &&
      (JSON.stringify(await loadConfig(configPath, CONFIG_SECTIONS)) !== loadedConfigSignature ||
        (await readFile(configPath, 'utf8')) !== loadedConfigText)
    ) {
      throw new Error('The tenant connection configuration changed during startup; restart.');
    }
    const { enrollment, authStoreExclusion, jobLines, adviceLines } = await prepareTenantStartup({
      loaded,
      connections: registry.configs(),
      policyFile: opts.policy,
      ...(opts.commands ? { commandsFile: opts.commands } : {}),
      ...(opts.jobs ? { jobsFile: opts.jobs } : {}),
    });
    if (changed) throw new Error('Tenant deployment files changed during validation; restart.');
    if (opts.checkApp) {
      stopWatching();
      const lock = await checkAuthorityLock(loaded.authority, opts.writeAuthority);
      if (lock.wrote) console.error(`mistri: wrote ${lock.wrote}`);
      process.stdout.write(
        (lock.problem ? `${loaded.app.name}: 1 problem\n  ${lock.problem}\n` : `${loaded.app.name}: ok\n`) +
          adviceLines.map((line) => `  warning: ${line}\n`).join(''),
      );
      // The effective automation, one line a job, as an ordinary App's mistri check prints it.
      for (const line of jobLines) process.stdout.write(`${line}\n`);
      if (lock.problem) process.exitCode = 1;
      await registry.closeAll();
      return undefined;
    }
    /* The OAuth authorization server issues tokens for the App's network API: served only beside that API, never
       as a door to nothing (cli/serve.ts says the same of a single App). */
    const oauthServer = oauthServerOf(registry);
    if (oauthServer?.apps.includes(loaded.app.id) && !opts.apiReads) {
      throw new Error(
        `the config file's OAuth authorization server "${oauthServer.name}" issues tokens for "${loaded.app.id}"'s API, which this server does not serve. Serve it with --api-reads, or take "${loaded.app.id}" off its "apps".`,
      );
    }
    // With the base path or without it, as cli/serve.ts reads it (shared/mount.ts publicRoot).
    const publicURL = publicRoot(
      opts.embedded?.publicURL ??
        (process.env.MISTRI_PUBLIC_URL?.trim() ||
          (opts.allowedHosts[0] ? `https://${opts.allowedHosts[0]}` : `http://localhost:${opts.port}`)),
      mount.base,
    );
    // A SQLite business file is excluded from a file auth store by path and
    // inode; a postgres:// store is kept apart from every configured
    // connection, by URL and by asking each server who it is.
    const auth = await createAppAuth(loaded, {
      baseURL: `${publicURL}${mount.base}`,
      ...(authStoreExclusion ? { excludeStore: authStoreExclusion } : {}),
      excludeConnections: registry.configs(),
      identity: identityProvidersOf(registry),
      embed: embedIssuersOf(registry),
      scim: scimDirectoriesOf(registry),
      ...(opts.trustedProxies ? { trustedProxies: opts.trustedProxies } : {}),
      listenHost: opts.host,
      /* A tenant App's tokens are each bound to one membership (auth/oauthServer.ts), read through this host. The
         consent page is the App's own sign-in, under its mount as under its base (`--mount desk=/desk`): the root's /sign-in is no App's, and its whoami refused the request. */
      ...(oauthServer ? { oauth: { config: oauthServer, home: appHome(mount, loaded.app.id).replace(/\/$/, '') } } : {}),
      trustedOrigins: [
        ...new Set([
          publicURL,
          ...opts.allowedHosts.map((host) => `https://${host}`),
          `http://localhost:${opts.port}`,
          `http://127.0.0.1:${opts.port}`,
        ]),
      ],
    });
    const { createTenantAuthenticatedHttpServer } = await import('../tenant/tenantAuthenticatedHttp.js');
    // `--api-reads`: the App API beside the browser, checked before startup (mistriMain.ts) — beyond loopback only when the App declares it.
    const api = apiReadStartupOptions(opts);
    /* `--dev`'s observer, as the ordinary server starts it (cli/serve.ts):
       on a loopback listener only, masking by the same rules, and before the
       host is made, so its requests are traced from the first. */
    if (opts.dev) {
      if (opts.host !== '127.0.0.1' && opts.host !== 'localhost' && opts.host !== '::1') {
        console.error(`mistri: --dev serves the observer on a loopback listener only; ${opts.host} is not one, so it is off.`);
      } else {
        const { startObserver } = await import('../observe/observer.js');
        const hosts = [{ app: loaded, pages: loaded.pages }];
        observer = startObserver(
          { registry, apps: () => hosts },
          { slowMs: Number(process.env.MISTRI_OBSERVE_SLOW_MS) > 0 ? Number(process.env.MISTRI_OBSERVE_SLOW_MS) : undefined },
        );
      }
    }
    let owner: Awaited<ReturnType<typeof createTenantAuthenticatedHttpServer>>;
    let made: { readonly jobs?: Pick<import('../jobs/jobHost.js').JobHost, 'runNow'> } | undefined;
    const withTestControl = (jobs: () => Pick<import('../jobs/jobHost.js').JobHost, 'runNow'> | undefined) => {
      const testControl = testControlFrom(process.env, {
        registry,
        apps: () => [{ app: loaded, auth, pages: loaded.pages }],
        policy: opts.policy,
        get jobs() {
          return jobs();
        },
      });
      return testControl ? { testControl } : {};
    };
    try {
      owner = await createTenantAuthenticatedHttpServer({
        loaded,
        auth,
        enrollment,
        browser: true,
        bound: { host: opts.host, port: opts.port, allowedHosts: opts.allowedHosts },
        /* The public forms' and reads' per-client budgets, and the address the human check is told, are the visitor's
           behind a proxy `--trust-proxy` names, as the App API's are. */
        ...(opts.trustedProxies?.length ? { trustedProxies: opts.trustedProxies } : {}),
        mount,
        registry,
        publicURL,
        /* A test host's setup (http/testControl.ts): none unless startTestApp started this process. Its jobs are the
           host's, made with it, so they are read when a test runs one. */
        ...withTestControl(() => made?.jobs),
        ...(api ? { api: { ...api, ...(opts.trustedProxies?.length ? { trustedProxies: opts.trustedProxies } : {}) } } : {}),
      });
      made = owner;
    } catch (error) {
      auth.close();
      throw error;
    }
    let stopping: Promise<void> | undefined;
    const stop = (code: number) => {
      stopWatching?.();
      return (stopping ??= owner
        .retire()
        .catch(() => {
          code = 1;
        })
        .then(async () => {
          await registry.closeAll();
          observer?.stop();
          // A mounted handler's process is its host's: shut down, never exit.
          if (!opts.embedded) process.exit(code);
        }));
    };
    /* A save whose whole difference is the look is worn in place (G175): the App is loaded again as startup loaded
       it, and only a look-alone difference is taken. Anything else, or a load that fails, is the restart below. */
    let current = loaded;
    restyle = async (touched) => {
      const next = await loadApp(opts.apps![0], {
        ...loadOptions,
        ...(loaded.entry ? { entry: loaded.entry } : {}),
        ...(opts.commands ? { commands: opts.commands } : {}),
      });
      const look = lookOnlyChange(current, next, touched);
      if (!look || stopping) return false;
      owner.restyle(look);
      current = next;
      console.error(`mistri: ${loaded.app.name}'s look changed; reloaded in place.`);
      return true;
    };
    retireOnChange = () => {
      console.error('Tenant deployment files changed. Requests are unavailable; restart with the new configuration.');
      void stop(0);
    };
    if (changed) {
      await owner.retire();
      throw new Error('Tenant deployment files changed during authentication startup; restart.');
    }
    if (opts.embedded) {
      for (const line of unsweptBuckets([loaded.app], owner.filesSwept)) console.log(`mistri: ${line}`);
      if (owner.jobs) {
        for (const line of jobLines) console.log(`mistri: ${line}`);
        owner.jobs.start();
      }
      console.log(`  ${loaded.app.name}: mounted at ${appHome(mount, loaded.app.id)} (tenant membership isolation enabled)`);
      return { server: owner.server, mount, close: () => stop(0) };
    }
    owner.server.on('error', (error: NodeJS.ErrnoException) => {
      console.error(
        error.code === 'EADDRINUSE'
          ? `mistri: port ${opts.port} is already in use. Pick another with --port <n>.`
          : 'mistri: the tenant HTTP listener could not start.',
      );
      // Native auth/cookie origins are fixed at acquisition. Never silently
      // roll the listener onto another port beneath those bindings.
      void stop(1);
    });
    owner.server.on('listening', () => {
      const shown = opts.host === '127.0.0.1' ? 'localhost' : opts.host;
      console.log(`Listening on http://${shown}:${opts.port}${mount.base}`);
      observer?.listening(`http://${shown}:${opts.port}${mount.base}`);
      console.log(
        'mistri: tenant membership isolation enabled; explicit selection required. Contexts currently expire after at most five minutes.',
      );
      if (api) console.log(apiServingLine(loaded.app, api, true));
      for (const line of unsweptBuckets([loaded.app], owner.filesSwept)) console.log(`mistri: ${line}`);
      // One job host, after enrollment: it starts once the listener is up.
      if (owner.jobs) {
        for (const line of jobLines) console.log(`mistri: ${line}`);
        owner.jobs.start();
      }
      const open = process.env.MISTRI_OPEN;
      if (open === undefined ? opts.open : !['', '0', 'false'].includes(open.toLowerCase())) {
        void openBrowser(`http://${shown}:${opts.port}${appHome(mount, loaded.app.id)}`);
      }
    });
    process.on('SIGINT', () => {
      void stop(0);
    });
    process.on('SIGTERM', () => {
      void stop(0);
    });
    owner.server.listen(opts.port, opts.host);
    return undefined;
  } catch (error) {
    stopWatching?.();
    observer?.stop();
    // Startup attaches the reason it refused to `cause` for the operator who
    // started this deployment (tenantStartup.ts), and a stage message alone
    // does not say which store, module or copy refused — so print the chain.
    // Messages only: a cause may hold a driver error whose object carries
    // connection detail that does not belong on a console.
    console.error(`Tenant startup error: ${refusalHeadline(error)}`);
    // A tenant refusal records why it denied under a private symbol rather
    // than on `cause`, so that the reason cannot travel with the error
    // everywhere it is inspected or serialized; this is the trusted reader.
    for (const because of refusalReasonsBelow(error)) console.error(`  because: ${because}`);
    // A store behind its layout is the one refusal with a command to say, as it is for every other App (cli/commandHost.ts).
    const { storesBehind, storesUpCommand } = await import('../stores/storesCli.js');
    const behind = await storesBehind({ registry, config: {} as never, schemas: opts.schemas });
    if (behind.length)
      console.error(`Stores behind their layout: ${behind.join('; ')}.\nBring them forward with: ${storesUpCommand(opts)}`);
    // Startup never creates a tenant App's stores: the ones its database lacks (tenantStartup.ts), and the command that makes them.
    const absent = (error as { absentStores?: readonly string[] } | undefined)?.absentStores ?? [];
    if (absent.length) console.error(`Stores this App needs are absent: ${absent.join(', ')}.\nMake them with: ${storesUpCommand(opts)}`);
    await registry.closeAll();
    if (opts.embedded) throw error;
    process.exitCode = 1;
    return undefined;
  }
}
