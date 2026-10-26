/** Private suite Console hosting through the ordinary App renderer. No source
 * is registered in the Workbench registry. Request capabilities stay in this
 * owner's async lifetime and are addressed by the internal App's identity. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import type { IncomingMessage, ServerResponse, OutgoingHttpHeaders } from 'node:http';
import type { Adapter } from '@mistriwork/engine/adapters/adapter.js';
import { TransactionOutcomeUnknown } from '@mistriwork/engine/adapters/adapter.js';
import { parseBasePath } from '@mistriwork/engine/shared/mount.js';
import { resolveAppAccess } from '../../shared/app.js';
import { Registry } from '@mistriwork/engine/server/connections.js';
import { captureAppAuthRuntime, type AppAuthRuntime } from '../auth/auth.js';
import type { LoadedApp, AppHost } from '../app/apps.js';
import { createApp, commandOperations } from '../http/server.js';
import { consoleDispatchOwners, consoleSourceOwners } from '../http/appContext.js';
import { HttpError, readJson, send } from '@mistriwork/engine/server/http/reply.js';
import { doorRefusal, writes, type Bound } from '@mistriwork/engine/server/http/trust.js';
import { getTenantHostIntent } from '../http/tenantHosts.js';
import { FlagManagementDenied, FlagRevisionConflict } from '../flags/store.js';
import { closeDevClientHmr, retireDevClient } from '@mistriwork/engine/server/devclient.js';
import { createConsoleApp, CONSOLE_APP_ID, CONSOLE_MOUNT_PATH } from './app.js';
import { createConsoleControlSource, consoleRecord, type ConsoleProof } from './controlSource.js';
import { bindConsoleTarget, type ConsoleControlService, type ConsoleTargetOwner, type ConsoleGuardedChange } from './services.js';
import { createConsoleCommands } from './commands.js';
import { captureTenantData } from '@mistriwork/engine/server/evidence.js';
import type { CompiledComponents } from '../app/appComponents.js';
import { consoleComponents } from './components.js';
import { consoleOperationsApi, type ConsoleOperationsOwner } from './operations.js';
import { consoleGovernanceApi } from './governance.js';

/** Include this exact entry in openSuiteIdentity's deployments BEFORE creating
 * the identity owner. Its existing chooser/grant routes then know the App and
 * its explicit `admitted` role. Pass identity.forApp(entry.app, entry.basePath)
 * to openSuiteConsole; root/native admin roles are not Console grants. */
export function consoleIdentityRegistration(suiteBase = '') {
  const basePath = `${parseBasePath(suiteBase)}${CONSOLE_MOUNT_PATH}`;
  const app: LoadedApp = { path: 'internal:mistri-console', app: createConsoleApp(basePath), pages: [], sources: {} };
  return { app, basePath, environment: {} as NodeJS.ProcessEnv, connections: [] };
}

/** The renderer may stream its first-paint block. Hold those exact bytes until
 * all current proofs settle; never replace it with a second HTML renderer. */
class ConsoleReply extends Writable {
  statusCode = 200;
  headersSent = false;
  readonly req = undefined;
  private headers = new Map<string, number | string | readonly string[]>();
  private chunks: Buffer[] = [];
  private size = 0;
  constructor() {
    super({ autoDestroy: false });
  }
  setHeader(name: string, value: number | string | readonly string[]) {
    this.headers.set(name.toLowerCase(), value);
    return this;
  }
  appendHeader(name: string, value: string | readonly string[]) {
    const previous = this.getHeader(name);
    return this.setHeader(name, [
      ...(previous === undefined ? [] : Array.isArray(previous) ? previous : [String(previous)]),
      ...(typeof value === 'string' ? [value] : value),
    ]);
  }
  getHeader(name: string) {
    return this.headers.get(name.toLowerCase());
  }
  getHeaders(): OutgoingHttpHeaders {
    return Object.fromEntries([...this.headers].map(([name, value]) => [name, typeof value === 'object' ? [...value] : value]));
  }
  hasHeader(name: string) {
    return this.headers.has(name.toLowerCase());
  }
  removeHeader(name: string) {
    this.headers.delete(name.toLowerCase());
  }
  writeHead(status: number, headers?: OutgoingHttpHeaders) {
    this.statusCode = status;
    for (const [name, value] of Object.entries(headers ?? {})) if (value !== undefined) this.setHeader(name, value);
    this.headersSent = true;
    return this;
  }
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) {
    this.size += chunk.length;
    if (this.size > 4 * 1024 * 1024) {
      done(new HttpError(503, 'Console response is too large.'));
      return;
    }
    this.chunks.push(Buffer.from(chunk));
    done();
  }
  publish(res: ServerResponse) {
    if (res.destroyed || res.writableEnded) return;
    this.removeHeader('etag');
    this.setHeader('cache-control', 'private, no-store');
    res.writeHead(this.statusCode, this.getHeaders());
    res.end(Buffer.concat(this.chunks));
  }
  asResponse() {
    return this as unknown as ServerResponse;
  }
}

const GETS = new Set([
  '/api/whoami',
  '/api/runtime',
  '/api/app',
  '/api/schema',
  '/api/pages',
  '/api/views',
  '/api/pages/suggest',
  '/api/pages/relations',
]);
const POSTS = new Set(['/api/query', '/api/run', '/api/count', '/api/counts', '/api/references', '/api/pages/compose']);

interface ConsoleSuiteHost {
  readonly id: typeof CONSOLE_APP_ID;
  readonly basePath: string;
  readonly server: ReturnType<typeof createApp>;
  start(): void;
  stop(): Promise<void>;
  close(): Promise<void>;
}
export async function openSuiteConsole(options: {
  /** The exact entry already registered with openSuiteIdentity. */
  registration: ReturnType<typeof consoleIdentityRegistration>;
  suiteBase?: string;
  suiteAuth: AppAuthRuntime;
  bound: Bound;
  /** Fixed deployed owners, obtained by the suite flags owner, not a URL. */
  targets: readonly ConsoleTargetOwner[];
  guardedChange?: ConsoleGuardedChange;
  /** Each App's jobs, deliveries, workflows, store layouts and analytics, for
   * the Operations and Analytics rooms. Each answers only to its own App's
   * `operations` grants, read through that App's own session projection. */
  operations?: readonly ConsoleOperationsOwner[];
  /** Optional host-owned artifact override. Otherwise source hosting compiles
   * lazily once and installed hosting reads the shipped artifact. */
  compiledComponents?: CompiledComponents;
}): Promise<ConsoleSuiteHost> {
  const { registration, suiteAuth, bound } = options;
  const basePath = `${parseBasePath(options.suiteBase ?? '')}${CONSOLE_MOUNT_PATH}`;
  const auth = captureAppAuthRuntime(suiteAuth),
    definition = registration.app.app;
  if (
    registration.basePath !== basePath ||
    definition.id !== CONSOLE_APP_ID ||
    auth.appId !== CONSOLE_APP_ID ||
    !suiteAuth.suite ||
    suiteAuth.suite.basePath !== parseBasePath(options.suiteBase ?? '') ||
    definition.auth?.public ||
    options.targets.some((owner) => owner.target.appId === CONSOLE_APP_ID) ||
    options.targets.some(
      (owner) =>
        !owner.auth.suite ||
        owner.auth.suite.basePath !== suiteAuth.suite!.basePath ||
        owner.auth.store !== suiteAuth.store ||
        captureAppAuthRuntime(owner.auth).appId !== owner.target.appId,
    ) ||
    options.targets.some((owner) => typeof owner.tenantApp !== 'boolean' || (owner.tenantApp && typeof owner.scopeProof !== 'function')) ||
    new Set(options.targets.map((owner) => owner.target.appId)).size !== options.targets.length ||
    (options.operations ?? []).some(
      (owner) =>
        owner.appId === CONSOLE_APP_ID ||
        !owner.auth.suite ||
        owner.auth.suite.basePath !== suiteAuth.suite!.basePath ||
        owner.auth.store !== suiteAuth.store ||
        captureAppAuthRuntime(owner.auth).appId !== owner.appId,
    ) ||
    new Set((options.operations ?? []).map((owner) => owner.appId)).size !== (options.operations ?? []).length
  ) {
    throw new Error('Console requires its registered internal App and native suite projection.');
  }
  const targets = options.targets.map((owner) =>
    Object.freeze({
      target: owner.target,
      auth: owner.auth,
      name: owner.name,
      tenantApp: owner.tenantApp,
      scopeProof: owner.scopeProof?.bind(owner),
      flags: owner.flags && captureTenantData(owner.flags),
      tenantScopes: owner.tenantScopes?.bind(owner),
      results: owner.results?.bind(owner),
      experiment: owner.experiment?.bind(owner),
      decide: owner.decide?.bind(owner),
      lifecycle: owner.lifecycle?.bind(owner),
      experimentFlags: owner.experimentFlags && Object.freeze([...owner.experimentFlags]),
    }),
  );
  const operations = Object.freeze([...(options.operations ?? [])]);
  const secret = randomBytes(32),
    registry = new Registry();
  const host: AppHost = {
    app: { ...registration.app, components: options.compiledComponents ?? (await consoleComponents()) },
    pages: [],
    auth: suiteAuth,
  };
  let ready = false,
    stopping = false,
    closed: Promise<void> | undefined;
  type Lease = {
    req: IncomingMessage;
    accountId: string;
    sessionId: string;
    proof: ConsoleProof;
    retained: ConsoleProof[];
    adapters: Adapter[];
    adapter?: Promise<Adapter>;
    live: boolean;
    selection: URLSearchParams;
    mutationAcknowledged?: boolean;
  };
  const scope = new AsyncLocalStorage<Lease>();
  const server = createApp({
    registry,
    apps: [host],
    bound,
    sourceClient: false,
    drainRequests: true,
    addresses: { base: basePath },
    ready: () => ready && !stopping,
  });
  const active = () => {
    if (!ready || stopping) throw new HttpError(503, 'Console is not ready.');
  };
  type Selection = { appId: string; tenantId: string | null; flagId: string | null; accountId: string };
  const seal = (value: Selection) => {
    const nonce = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', secret, nonce);
    return Buffer.concat([nonce, cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]).toString('base64url');
  };
  const unseal = (token: string, lease: Lease): Selection => {
    try {
      if (!/^[A-Za-z0-9_-]{40,2048}$/.test(token)) throw new Error();
      const bytes = Buffer.from(token, 'base64url'),
        cipher = createDecipheriv('aes-256-gcm', secret, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(-16));
      const value = consoleRecord(JSON.parse(Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString('utf8')), [
        'appId',
        'tenantId',
        'flagId',
        'accountId',
      ]);
      if (
        value.accountId !== lease.accountId ||
        typeof value.appId !== 'string' ||
        (value.tenantId !== null && typeof value.tenantId !== 'string') ||
        (value.flagId !== null && typeof value.flagId !== 'string')
      )
        throw new Error();
      return value as Selection;
    } catch {
      throw new HttpError(403, 'Console selection unavailable.');
    }
  };
  const bind = async (lease: Lease, owner: ConsoleTargetOwner, tenantId: string | null): Promise<ConsoleControlService | null> =>
    bindConsoleTarget({
      owner,
      request: lease.req,
      accountId: lease.accountId,
      sessionId: lease.sessionId,
      tenantId,
      consoleProof: lease.proof,
      guardedChange: options.guardedChange,
      retain: (proof) => lease.retained.push(proof),
    });
  const consoleApi = async (lease: Lease, url: URL, response: ServerResponse) => {
    const path = url.pathname.slice('/api/console'.length);
    if (
      await consoleOperationsApi({
        request: lease.req,
        response,
        url,
        path,
        accountId: lease.accountId,
        owners: operations,
        acknowledged: () => {
          lease.mutationAcknowledged = true;
        },
      })
    )
      return;
    if (await consoleGovernanceApi({ request: lease.req, response, url, path, accountId: lease.accountId, owners: operations })) return;
    const parameters =
      path === '/catalog' ? ['scope'] : path.endsWith('/flags') ? ['flag'] : path.endsWith('/history') ? ['beforeRevision'] : [];
    if ([...url.searchParams.keys()].some((key) => !parameters.includes(key) || url.searchParams.getAll(key).length > 1))
      throw new HttpError(400, 'Invalid Console query.');
    if (lease.req.method === 'GET' && path === '/catalog') {
      const asked = url.searchParams.get('scope'),
        selected = asked ? unseal(asked, lease) : undefined;
      if (selected?.flagId) throw new HttpError(400, 'Invalid scope.');
      const visible = [];
      for (const owner of targets) {
        const tenants = owner.tenantScopes ? captureTenantData(await owner.tenantScopes(lease.req, lease.accountId)) : [];
        if (tenants.length > 100 || new Set(tenants.map((item) => item.tenantId)).size !== tenants.length)
          throw new HttpError(503, 'Console scope catalog unavailable.');
        const choices = [{ tenantId: null as string | null, label: 'Global' }, ...tenants],
          scopes = [];
        for (const choice of choices) {
          if (choice.tenantId !== null && (typeof choice.tenantId !== 'string' || !choice.tenantId || typeof choice.label !== 'string'))
            throw new FlagManagementDenied();
          const service = await bind(lease, owner, choice.tenantId);
          if (!service || !(await service.viewable())) continue;
          scopes.push({
            id:
              selected?.appId === owner.target.appId && selected.tenantId === choice.tenantId
                ? asked!
                : seal({ appId: owner.target.appId, tenantId: choice.tenantId, flagId: null, accountId: lease.accountId }),
            label: choice.label,
          });
        }
        if (scopes.length)
          visible.push({
            id: seal({ appId: owner.target.appId, tenantId: null, flagId: null, accountId: lease.accountId }),
            name: owner.name,
            environment: owner.target.environment,
            scopes,
          });
      }
      return send(response, 200, { targets: visible });
    }
    const match = /^\/(scopes|flags)\/([A-Za-z0-9_-]+)(?:\/(flags|history|results|decide|lifecycle|set|kill|revert))?$/.exec(path);
    if (!match) throw new HttpError(404, 'Console route unavailable.');
    const selection = unseal(match[2], lease),
      owner = targets.find((item) => item.target.appId === selection.appId);
    if (!owner) throw new HttpError(403, 'Console selection unavailable.');
    const service = await bind(lease, owner, selection.tenantId);
    if (!service) throw new HttpError(403, 'Console selection unavailable.');
    if (lease.req.method === 'GET' && match[1] === 'scopes' && match[3] === 'flags' && selection.flagId === null) {
      const asked = url.searchParams.get('flag'),
        selected = asked ? unseal(asked, lease) : undefined;
      if (selected && (selected.appId !== selection.appId || selected.tenantId !== selection.tenantId))
        throw new HttpError(403, 'Console selection unavailable.');
      const rows = await service.discover();
      return send(response, 200, {
        environment: service.environment,
        items: rows.map((row) => ({ ...row, id: selected?.flagId === row.flagId ? asked! : seal({ ...selection, flagId: row.flagId }) })),
      });
    }
    if (match[1] !== 'flags' || !selection.flagId) throw new HttpError(403, 'Console selection unavailable.');
    if (lease.req.method === 'GET') {
      if (match[3] === undefined)
        return send(response, 200, { ...(await service.detail(selection.flagId)), id: match[2], environment: service.environment });
      if (match[3] === 'history') {
        const raw = url.searchParams.get('beforeRevision'),
          before = raw === null ? undefined : Number(raw);
        if (before !== undefined && (!Number.isSafeInteger(before) || before < 0)) throw new HttpError(400, 'Invalid history cursor.');
        const page = await service.historyPage(selection.flagId, before);
        return send(response, 200, {
          entries: page.entries.map((row) => ({
            revision: row.revision,
            operation: row.operation,
            reason: row.reason,
            at: row.at,
            before: row.before,
            after: row.after,
          })),
          nextBeforeRevision: page.nextBeforeRevision,
        });
      }
      if (match[3] === 'results') return send(response, 200, { evidence: await service.result(selection.flagId) });
    }
    if (lease.req.method === 'POST' && match[3] === 'lifecycle') {
      if (lease.req.headers['x-mistri-account'] !== lease.accountId) throw new HttpError(409, 'The signed-in account changed.');
      const result = await service.lifecycle(selection.flagId, await readJson(lease.req, 64 * 1024));
      lease.mutationAcknowledged = true;
      return send(response, 200, { acknowledgement: result, outcome: 'applied' });
    }
    if (lease.req.method === 'POST' && match[3] === 'decide') {
      if (lease.req.headers['x-mistri-account'] !== lease.accountId) throw new HttpError(409, 'The signed-in account changed.');
      // Result authority is reobserved after the held body and again at commit.
      await service.result(selection.flagId);
      const result = await service.decide(selection.flagId, await readJson(lease.req, 64 * 1024));
      lease.mutationAcknowledged = true;
      return send(response, 200, { acknowledgement: result, outcome: 'applied' });
    }
    if (lease.req.method !== 'POST' || !['set', 'kill', 'revert'].includes(match[3]))
      throw new HttpError(405, 'Console method unavailable.');
    if (lease.req.headers['x-mistri-account'] !== lease.accountId) throw new HttpError(409, 'The signed-in account changed.');
    // The target is admitted before the body wait as well as at execution.
    const operation = match[3] as 'set' | 'kill' | 'revert';
    const targetProof = await service.authorize(selection.flagId, operation);
    if (!targetProof) throw new FlagManagementDenied();
    const body = await readJson(lease.req, 64 * 1024);
    await targetProof.reobserve();
    await lease.proof.reobserve();
    targetProof.assertCurrent();
    lease.proof.assertCurrent();
    const commands = createConsoleCommands({ admission: { admit: async () => lease.proof }, target: service, flagId: selection.flagId });
    const result = await commands[operation](body);
    lease.mutationAcknowledged = true;
    return send(response, 200, { ...result, outcome: 'applied' });
  };
  consoleSourceOwners.set(definition, async (ctx, selectedHost) => {
    const lease = scope.getStore();
    if (!lease?.live || ctx.identity.id !== lease.accountId || selectedHost.app.app !== definition)
      throw new HttpError(403, 'Console access denied.');
    await lease.proof.reobserve();
    lease.adapter ??= (async () => {
      const tenantId = lease.selection.get('tenant'),
        selected = lease.selection.get('targetApp');
      if (
        lease.selection.getAll('tenant').length > 1 ||
        lease.selection.getAll('targetApp').length > 1 ||
        tenantId === '' ||
        selected === '' ||
        (tenantId !== null && !selected)
      )
        throw new HttpError(400, 'Invalid Console selection.');
      const services = [];
      for (const owner of targets) {
        // Tenant intent is meaningful only for the selected target. Other
        // targets remain global; no suite-wide membership list is guessed.
        const service = await bindConsoleTarget({
          owner,
          request: lease.req,
          accountId: lease.accountId,
          sessionId: lease.sessionId,
          tenantId: owner.target.appId === selected ? tenantId : null,
          consoleProof: lease.proof,
          guardedChange: options.guardedChange,
          retain: (proof) => lease.retained.push(proof),
        });
        if (service) services.push(service);
      }
      const chosen = services.find((service) => service.appId === selected);
      if (selected !== null && !chosen) throw new HttpError(403, 'Console target unavailable.');
      if (chosen && !(await chosen.viewable())) throw new HttpError(403, 'Console target unavailable.');
      const adapter = createConsoleControlSource({
        admission: {
          admit: async () => {
            await lease.proof.reobserve();
            return lease.proof;
          },
        },
        targets: services,
        selected: chosen,
        keySecret: secret,
      });
      lease.adapters.push(adapter);
      return adapter;
    })();
    const adapter = await lease.adapter,
      schema = await adapter.introspect();
    lease.proof.assertCurrent();
    ctx.res.setHeader('cache-control', 'private, no-store');
    ctx.res.setHeader('x-mistri-app', CONSOLE_APP_ID);
    return {
      adapter,
      schema,
      selectedHost,
      connectionId: CONSOLE_APP_ID,
      access: resolveAppAccess(definition, schema, ['admitted']),
      publicScope: { appId: CONSOLE_APP_ID },
      publicDefinition: <T extends { connection?: string }>(value: T): T => {
        const { connection: _connection, ...rest } = value;
        return rest as T;
      },
    };
  });
  consoleDispatchOwners.set(server, async (req, res, dispatch) => {
    res.setHeader('cache-control', 'private, no-store');
    let lease: Lease | undefined;
    const reply = new ConsoleReply();
    // Install the error listener before a renderer starts writing/streaming.
    const settled = finished(reply);
    void settled.catch(() => {});
    const cancel = () => reply.destroy();
    res.once('close', cancel);
    try {
      active();
      if (getTenantHostIntent(req) || doorRefusal(req, bound, { writing: writes(req) })) throw new HttpError(403, 'Console access denied.');
      const url = new URL(req.url ?? '/', 'http://localhost'),
        path = url.pathname;
      const controls = path.startsWith('/api/console/');
      if (
        !controls &&
        (path.startsWith('/api/')
          ? !(req.method === 'GET' || req.method === 'HEAD' ? GETS.has(path) : req.method === 'POST' && POSTS.has(path))
          : (path.startsWith('/_mistri') && !path.startsWith('/_mistri/sdk/')) || !['GET', 'HEAD'].includes(req.method ?? ''))
      )
        throw new HttpError(403, 'Console operation unavailable.');
      const native = await auth.sessionInstance(req);
      active();
      if (!native || native.identity.role !== 'admitted') throw new HttpError(403, 'Console access denied.');
      const expected = req.headers['x-mistri-account'];
      if (expected !== undefined && expected !== native.identity.id) throw new HttpError(409, 'The signed-in account changed.');
      const current = () => {
        active();
        if (!lease?.live) throw new HttpError(403, 'Console access denied.');
        auth.assertSessionCurrent(native);
      };
      const proof: ConsoleProof = {
        assertCurrent: current,
        reobserve: async () => {
          current();
          await auth.observeSession(native);
          current();
        },
      };
      lease = {
        req,
        accountId: native.identity.id,
        sessionId: native.sessionId,
        proof,
        retained: [],
        adapters: [],
        live: true,
        selection: url.searchParams,
      };
      reply.setHeader('cache-control', 'private, no-store');
      await scope.run(lease, () => (controls ? consoleApi(lease!, url, reply.asResponse()) : dispatch(reply.asResponse())));
      await settled;
      // These rechecks cannot emit data; keep every byte buffered until all
      // target reads, Console admission, and synchronous fences have passed.
      for (const retained of lease.retained) await retained.reobserve();
      await proof.reobserve();
      for (const retained of lease.retained) retained.assertCurrent();
      proof.assertCurrent();
      reply.publish(res);
    } catch (error) {
      const unknown = lease?.mutationAcknowledged || error instanceof TransactionOutcomeUnknown;
      if (!res.destroyed && !res.writableEnded)
        send(
          res,
          unknown ? 503 : error instanceof FlagRevisionConflict ? 409 : error instanceof HttpError ? error.status : 403,
          unknown
            ? {
                code: 'outcome_unknown',
                outcome: 'unknown',
                error: 'The change could not be confirmed. Refetch and reconcile before another change.',
              }
            : error instanceof FlagRevisionConflict
              ? { code: 'revision_conflict', error: 'The revision changed. Your edits are preserved; refetch before submitting again.' }
              : {
                  code: 'console_unavailable',
                  error: error instanceof HttpError && error.status === 503 ? 'Console is not ready.' : 'Console operation unavailable.',
                },
        );
    } finally {
      res.off('close', cancel);
      reply.destroy();
      if (lease) {
        lease.live = false;
        await Promise.all(lease.adapters.map((adapter) => adapter.close()));
      }
    }
  });
  return Object.freeze({
    id: CONSOLE_APP_ID,
    basePath,
    server,
    start() {
      if (stopping) throw new FlagManagementDenied();
      ready = true;
    },
    async stop() {
      stopping = true;
      ready = false;
      await closeDevClientHmr(server);
    },
    close() {
      stopping = true;
      ready = false;
      return (closed ??= (async () => {
        await Promise.allSettled([...(commandOperations.get(server) ?? [])]);
        // Keep the retired capability installed until the server/App is
        // collected. Removing it would fall back to the ordinary public shell
        // if a composition owner accidentally dispatched after retirement.
        await retireDevClient(server);
        await registry.closeAll();
        suiteAuth.close();
        secret.fill(0);
      })());
    },
  });
}
