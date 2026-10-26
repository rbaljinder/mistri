/**
 * Connection management: what this server is running, who is asking, and the
 * session-only registry edits the standalone browser's connection form makes.
 * An App server answers the first two in its own words and refuses the rest
 * (appConnections.ts).
 */
import { redact, saveConfig } from '@mistriwork/engine/server/connections.js';
import { configLocations } from '@mistriwork/engine/server/config/locations.js';
import { scrubSecrets, storeSecret } from '@mistriwork/engine/server/connections.js';
import { connect } from '@mistriwork/engine/adapters/connect.js';
import { resolveConnection } from '@mistriwork/engine/server/auth/credentials.js';
import { untrustedTargetRefusal } from '@mistriwork/engine/server/http/trust.js';
import { UNTRUSTED_NETWORK } from '@mistriwork/engine/adapters/net/untrustedDatabase.js';
import { readJson, send } from '@mistriwork/engine/server/http/reply.js';
import type { RequestContext } from '@mistriwork/engine/server/http/context.js';
import { agentTools } from '../mcp.js';

export async function connectionRoutes(ctx: RequestContext): Promise<boolean> {
  const { req, res, path, registry, configPath, bound, identity, trusted } = ctx;

  /* ---------- connection management ---------- */

  /**
   * The MCP tools, for the agent console: the Workbench's (an App server
   * refuses them, appConnections.ts). The same list, from the same function, that
   * tools/list answers over stdio — including the rule that write tools exist
   * only where some connection's config allows any.
   */
  if (path === '/api/agent/tools' && (req.method === 'GET' || req.method === 'HEAD')) {
    send(res, 200, { tools: agentTools(registry) });
    return true;
  }
  if (path === '/api/runtime') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, { error: 'Method not allowed.' });
      return true;
    }
    send(res, 200, { appConfigured: false });
    return true;
  }

  if (path === '/api/connections' && req.method !== 'POST') {
    send(res, 200, {
      connections: registry.list(),
      active: registry.active,
      appConfigured: false,
    });
    return true;
  }

  /**
   * Try a connection without keeping it.
   *
   * Adding was the only way to find out whether a target worked, and a failed
   * add leaves an entry behind — on purpose, so a mistyped password is a
   * correction rather than a retype. That is right for adding and wrong for
   * checking: someone who is not sure yet should not have to tidy up after
   * asking.
   *
   * It opens and introspects, because a URL that connects and cannot be read
   * is not a working connection, then closes. Nothing is registered, nothing
   * is written, and the secret is scrubbed out of any failure the same way
   * the registry scrubs its own.
   */
  /* Whether the browser on this listener is the operator — see `clientTrusted`.
     Decided once per request and consulted by every route below that takes a
     database address, a file path, or a place to write from the client. */

  /* Who the server thinks is asking, for a client that wants to say so. */
  if (path === '/api/whoami') {
    res.setHeader('cache-control', 'no-store');
    send(res, 200, { who: identity.who ?? null, header: bound.identityHeader ?? null, signedIn: false });
    return true;
  }

  if (path === '/api/connections/test' && req.method === 'POST') {
    const body = await readJson(req);
    const target = String(body.url ?? '').trim();
    if (!target) {
      send(res, 400, { error: 'A url is required.' });
      return true;
    }
    if (!trusted) {
      const why = untrustedTargetRefusal(target);
      if (why) {
        send(res, 403, { error: why });
        return true;
      }
    }

    let adapter;
    try {
      const resolved = await resolveConnection(String(body.name ?? '').trim() || 'test', target, { secrets: trusted });
      adapter = connect(resolved.url, {
        schemas: Array.isArray(body.schemas) ? (body.schemas as string[]) : [],
        label: 'test',
        ...(trusted ? {} : { network: UNTRUSTED_NETWORK }),
      });
      const schema = await adapter.introspect();
      send(res, 200, {
        ok: true,
        dialect: schema.dialect,
        tables: schema.tables.length,
        /* Where the password came from, since the answer to "will this work"
           includes "and where did the credential come from" — a connection
           that works because a password is sitting in the URL is a different
           answer from one that works from the keychain. */
        secret: resolved.source,
        warning: resolved.warning,
      });
      return true;
    } catch (err) {
      send(res, 200, { ok: false, error: scrubSecrets((err as Error).message, target) });
      return true;
    } finally {
      await adapter?.close().catch(() => {});
    }
  }

  /**
   * Build the sample database and open it.
   *
   * The welcome screen's "try it" button, serving the same throwaway database
   * `--demo` does so the first thing a fresh install can do is walk something.
   * Session-only, like every runtime add: written to the temp directory,
   * rebuilt on each call so it never drifts from the schema this version
   * knows, and gone when the process exits. A second click reuses the demo
   * already open rather than stacking another onto the list.
   */
  if (path === '/api/connections/demo' && req.method === 'POST') {
    const existing = registry.list().find((c) => c.name === 'demo');
    if (existing) {
      registry.setActive(existing.id);
      send(res, 200, { connections: registry.list(), active: registry.active, added: existing.id });
      return true;
    }
    const { demoDatabaseFile, makeDemoDatabase, seedDemoDatabase } = await import('@mistriwork/engine/server/demo.js');
    const file = demoDatabaseFile();
    try {
      makeDemoDatabase(file);
      seedDemoDatabase(file, { scale: 150 });
    } catch (err) {
      send(res, 500, { error: `Could not build the sample database: ${(err as Error).message}` });
      return true;
    }
    const previous = registry.active;
    const added = registry.add({ name: 'demo', url: file, source: 'session' });
    try {
      await registry.open(added.id);
    } catch (err) {
      registry.setActive(previous);
      send(res, 500, { error: (err as Error).message });
      return true;
    }
    send(res, 200, { connections: registry.list(), active: registry.active, added: added.id });
    return true;
  }

  if (path === '/api/connections' && req.method === 'POST') {
    /* Adding a connection at runtime is session-only — it is deliberately
       not written back to the config file, because a browser page silently
       editing a file on disk is a surprise nobody asked for. */
    const body = await readJson(req);
    const target = String(body.url ?? '').trim();
    if (!target) {
      send(res, 400, { error: 'A url is required.' });
      return true;
    }
    if (!trusted) {
      const why = untrustedTargetRefusal(target);
      if (why) {
        send(res, 403, { error: why });
        return true;
      }
    }
    /* Kept so a failed add can put it back. `add` makes the first connection
       active before anything has tried to dial it, so an add that then failed
       to open left the application pointed at a connection that had never
       worked — and every later request answering with its error, including
       the ones for the connection that *did* work. */
    const previous = registry.active;
    const added = registry.add(
      {
        name: String(body.name ?? '').trim() || redact(target),
        url: target,
        schemas: Array.isArray(body.schemas) ? (body.schemas as string[]) : undefined,
        source: 'session',
      },
      { untrusted: !trusted },
    );
    try {
      await registry.open(added.id);
    } catch (err) {
      registry.setActive(previous);
      /* The entry stays, listed with its error.

         "The add failed" and "nothing was added" are not the same thing, and
         here the first is the useful one: a mistyped password should leave the
         connection on screen to be corrected, not make someone retype the URL
         they just got nearly right. It is also what already happens to a
         connection in the config file that will not open — listed, with the
         reason, rather than dropped.

         The list goes back with the error so the client can show that without
         a second request, which is what the id alone used to make it do. */
      send(res, 400, {
        error: (err as Error).message,
        id: added.id,
        added: added.id,
        connections: registry.list(),
        active: registry.active,
      });
      return true;
    }
    send(res, 200, { connections: registry.list(), active: registry.active, added: added.id });
    return true;
  }

  /**
   * Edit a connection.
   *
   * In the running session only. Making it permanent is a separate, explicit
   * act — see /api/connections/save — because a browser page quietly editing
   * a file on disk is a surprise nobody asked for.
   */
  if (path === '/api/connections/update' && req.method === 'POST') {
    const body = await readJson(req);
    const id = String(body.id ?? '');
    if (!registry.has(id)) {
      send(res, 404, { error: `No connection called "${id}".` });
      return true;
    }

    const patch: Record<string, unknown> = {};
    if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim();
    if (typeof body.url === 'string' && body.url.trim()) patch.url = body.url.trim();
    if (Array.isArray(body.schemas)) patch.schemas = body.schemas as string[];

    if (!trusted && (patch.url || patch.schemas)) {
      /* A connection the operator wrote into the config is not the network's
         to redirect: pointing "production" at another host from a browser on
         another machine changes what every other reader of this server sees.
         A session connection is the client's own and may be corrected. */
      const entry = registry.configs().find((c) => c.id === id);
      if (entry && entry.source !== 'session') {
        send(res, 403, {
          error:
            `"${entry.name}" comes from the config file and cannot be pointed elsewhere from here. ` + 'Edit tablewalk.json on the server.',
        });
        return true;
      }
      const why = typeof patch.url === 'string' ? untrustedTargetRefusal(patch.url) : null;
      if (why) {
        send(res, 403, { error: why });
        return true;
      }
    }

    try {
      await registry.update(id, patch, { untrusted: !trusted });
      /* Opened straight away when the target changed, so a typo fails here
         rather than the next time someone clicks the connection. */
      if (patch.url || patch.schemas) await registry.open(id);
    } catch (err) {
      send(res, 400, { error: (err as Error).message, connections: registry.list() });
      return true;
    }
    send(res, 200, { connections: registry.list(), active: registry.active });
    return true;
  }

  if (path === '/api/connections/remove' && req.method === 'POST') {
    const body = await readJson(req);
    const id = String(body.id ?? '');
    if (!registry.has(id)) {
      send(res, 404, { error: `No connection called "${id}".` });
      return true;
    }
    try {
      await registry.remove(id);
    } catch (err) {
      send(res, 400, { error: (err as Error).message });
      return true;
    }
    send(res, 200, { connections: registry.list(), active: registry.active });
    return true;
  }

  /**
   * Write the current connections to a config file.
   *
   * The one place a page is allowed to change a file on disk, and only because
   * someone pressed a button that named the file it was about to write. The
   * path is echoed back so the UI can say what happened rather than implying
   * it.
   */
  if (path === '/api/connections/save' && req.method === 'POST') {
    /* Saving writes this machine's config file and moves passwords into its
       keychain. From a browser on another machine that is a stranger editing
       the operator's config — and choosing the path to write it to. */
    if (!trusted) {
      send(res, 403, {
        error:
          'This server is reachable beyond this machine, so connections are saved from the machine ' +
          'running tablewalk: edit tablewalk.json there.',
      });
      return true;
    }
    const body = await readJson(req);
    const target = typeof body.path === 'string' && body.path.trim() ? body.path.trim() : (configPath ?? configLocations()[0]);
    /* Passwords come out of the URL before the file is written.

       `storeSecret` was written for exactly this and nothing called it, so
       the guarantee in its own comment — "the URL that gets written to disk
       never contains the password" — was not in force: a connection added
       with `postgres://user:hunter2@host/db` put `hunter2` in the config
       file, in plaintext, for anyone the file is later shared or committed
       with.

       The secret goes where the OS keeps secrets (the keychain) or into a
       credentials file at 0600, and the URL keeps its user and loses its
       password. `resolveConnection` puts it back by connection name on the
       next open, which is the mechanism that already existed and had nothing
       feeding it. */
    const moved: Array<{ name: string; stored: 'keychain' | 'file' }> = [];
    for (const config of registry.configs()) {
      const result = await storeSecret(config.name, config.url).catch(() => undefined);
      if (!result) continue;
      /* The live connection is already open and stays open; this changes what
         is remembered about it, so the write below and the next start both
         see the URL without the secret. `rewriteUrl` rather than `update`,
         because the database has not changed — only where its password is
         kept — and a retarget would close the adapter and drop the writable
         flag the file is about to record. */
      try {
        registry.rewriteUrl(config.id, result.url);
      } catch {
        continue;
      }
      moved.push({ name: config.name, stored: result.stored });
    }

    try {
      // The cache and search services travel with it: saving must not delete what it does not list.
      await saveConfig(target, registry.configs(), registry.serviceConfigs(), registry.sections, registry.keptEntries());
    } catch (err) {
      send(res, 500, { error: `Could not write ${target}: ${(err as Error).message}` });
      return true;
    }
    send(res, 200, {
      path: target,
      count: registry.configs().length,
      /* Said rather than done silently: moving somebody's password is a
         helpful thing to do and a surprising thing to discover. */
      secrets: moved,
    });
    return true;
  }

  if (path === '/api/connections/select' && req.method === 'POST') {
    const body = await readJson(req);
    const id = String(body.id ?? '');
    if (!registry.has(id)) {
      send(res, 404, { error: `No connection called "${id}".` });
      return true;
    }
    const { schema } = await registry.open(id);
    registry.setActive(id);
    send(res, 200, { active: id, schema });
    return true;
  }

  if (path === '/api/connections/refresh' && req.method === 'POST') {
    const body = await readJson(req);
    const id = String(body.id ?? registry.active ?? '');
    const { schema } = await registry.refresh(id);
    send(res, 200, { schema });
    return true;
  }

  return false;
}
