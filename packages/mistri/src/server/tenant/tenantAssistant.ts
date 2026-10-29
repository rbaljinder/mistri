/**
 * The in-App assistant on a tenant App's host (docs/tenant-apps.md, "The
 * assistant"). The routes are the ordinary App's (http/assistantRoutes.ts);
 * what differs is whose they are and how the assistant reads.
 *
 * A conversation belongs to one tenant. The tenant is never a request's to
 * name: the browser sends its tab's context lease, the host asks the data
 * server to recover that lease as this login (which admits the membership
 * again), and the tenant is the one the lease holds. A platform or support
 * lease is refused. Every read the assistant makes — run, measure, the
 * catalog, a record, the App itself — is then a request to the data server
 * on that lease, admitted per call by its `withContext` with the same
 * membership check and read scope a page's own fetch gets: a person removed
 * mid-conversation is refused at the next call. A renewal that moved the
 * lease on is followed once; a lease now in another tenant is not.
 *
 * Whether a tenant has the assistant at all is its switch, held by the
 * platform owner in Manage tenants (tenantAdministration.ts) and read on every
 * request and before every model call: off, the panel is not drawn
 * (tenantHttp.ts strips it from the App) and these routes answer 403.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { AssistantStore } from '../../adapters/assistant/assistantStore.js';
import type { AppDef } from '../../shared/appModel.js';
import type { AppPayloadApp } from '../../shared/appPayload.js';
import { PLATFORM_TENANT_ID, TENANT_HTTP_HEADERS as headers } from '../../shared/tenantContext.js';
import { assistantModel } from '../assistant/assistantModel.js';
import { assistantStoreAt, storeUnavailableReply } from '../assistant/assistantStores.js';
import { purgeOnSchedule, retentionCutoff } from '../assistant/assistantRetention.js';
import { answerAssistant, ASSISTANT_PATHS } from '../http/assistantRoutes.js';
import { CapturedReply } from '@mistriwork/engine/server/http/captured.js';
import type { Loop, LoopAnswer } from '@mistriwork/engine/server/http/firstPaint.js';
import { HttpError } from '@mistriwork/engine/server/http/reply.js';
import { doorRefusal, type Bound } from '@mistriwork/engine/server/http/trust.js';
import { TENANT_ASSISTANT_RETENTION_DAYS, type TenantAssistantPolicy } from '../policy/appTenantPolicy.js';
import { tenantHttpHeader } from './tenantHttp.js';

interface TenantAssistantOptions {
  readonly app: AppDef;
  /** The data server's listener: every read, and the lease's recovery, is a request to it. */
  readonly dispatch: (req: IncomingMessage, res: ServerResponse) => void;
  readonly binding: () => Bound;
  /** The tenant source, where the assistant store is kept beside the records. */
  readonly where: { readonly path: string } | { readonly url: string };
  readonly policy?: TenantAssistantPolicy;
  readonly now?: () => number;
}

interface Lease {
  readonly tabId: string;
  readonly context: string;
  readonly revision: number;
  readonly tenantId: string;
  readonly accountId: string;
}

/* What a browser request carries that the data server reads to admit it: who and from where. Nothing else is
   passed on, and the lease's own headers are set from the recovered lease, never copied. */
const CARRIED = ['host', 'origin', 'cookie', 'user-agent'];

/** A request to the data server, made inside this one: its admission headers and the lease's, a JSON body. */
function forwarded(page: IncomingMessage, method: 'GET' | 'POST', target: string, body: unknown, extra: Record<string, string>) {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
  const pairs: Array<[string, string]> = [];
  for (const name of CARRIED) {
    const value = page.headers[name];
    if (typeof value === 'string') pairs.push([name, value]);
  }
  for (const [name, value] of Object.entries(extra)) pairs.push([name, value]);
  pairs.push(['sec-fetch-site', 'same-origin'], ['sec-fetch-mode', 'cors'], ['sec-fetch-dest', 'empty']);
  if (payload) pairs.push(['content-type', 'application/json'], ['content-length', String(payload.length)]);
  const socket = page.socket;
  return Object.assign(Readable.from(payload ? [payload] : []), {
    method,
    url: target,
    headers: Object.fromEntries(pairs),
    rawHeaders: pairs.flat(),
    httpVersion: page.httpVersion,
    httpVersionMajor: page.httpVersionMajor,
    httpVersionMinor: page.httpVersionMinor,
    complete: true,
    aborted: false,
    socket: { remoteAddress: socket?.remoteAddress, remotePort: socket?.remotePort, remoteFamily: socket?.remoteFamily },
  }) as unknown as IncomingMessage;
}

export function createTenantAssistant(options: TenantAssistantOptions) {
  const { app, dispatch, binding, where, policy } = options;
  const now = options.now ?? Date.now;
  let store: Promise<AssistantStore> | undefined;
  const storeOf = (): Promise<AssistantStore> => {
    if (!store) {
      store = assistantStoreAt(app, where);
      // A failed open is tried again on the next request: the operator may provision in between.
      store.catch(() => (store = undefined));
    }
    return store;
  };
  /** The tenant has the assistant: a model to talk to, and its switch on. Read each time; never cached. */
  const offered = async (tenantId: string): Promise<boolean> => {
    if (!app.assistant || !assistantModel() || !tenantId || tenantId === PLATFORM_TENANT_ID) return false;
    try {
      return await (await storeOf()).tenantEnabled(app.id, tenantId);
    } catch {
      return false;
    }
  };

  /** One request to the data server, answered in memory; undefined when it sent nothing or was stopped. */
  const ask = (request: IncomingMessage, signal?: AbortSignal): Promise<LoopAnswer | undefined> =>
    new Promise((resolve) => {
      if (signal?.aborted) return resolve(undefined);
      const reply = new CapturedReply();
      const stop = () => reply.destroy();
      signal?.addEventListener('abort', stop, { once: true });
      const settle = () => {
        signal?.removeEventListener('abort', stop);
        const answer = reply.answer();
        resolve(answer && { ...answer, carriable: false });
      };
      reply.once('finish', settle);
      reply.once('close', settle);
      // A turn's reads stop with its stream (the core's signal); the short admission reads run to their end.
      dispatch(request, reply.asResponse());
    });

  /** The tab's lease as the data server holds it now, admitted again for this login; refused unless a tenant's. */
  const recover = async (req: IncomingMessage, account: string, tabId: string, signal?: AbortSignal): Promise<Lease> => {
    const answer = await ask(
      forwarded(
        req,
        'POST',
        `/api/tenant/context/recover?app=${encodeURIComponent(app.id)}`,
        { tabId },
        {
          [headers.account]: account,
          [headers.app]: app.id,
        },
      ),
      signal,
    );
    const lease = answer?.status === 200 ? (answer.body as Record<string, unknown> | null) : null;
    if (!lease || typeof lease.context !== 'string' || typeof lease.tenantId !== 'string' || !Number.isSafeInteger(lease.revision))
      throw new HttpError(403, 'Choose a customer first.');
    if (lease.realm !== undefined || lease.tenantId === PLATFORM_TENANT_ID)
      throw new HttpError(403, 'The assistant answers inside one customer, not here.');
    if (lease.accountId !== account || lease.appId !== app.id || lease.tabId !== tabId)
      throw new HttpError(403, 'Choose a customer first.');
    return {
      tabId,
      context: lease.context,
      revision: lease.revision as number,
      tenantId: lease.tenantId,
      accountId: account,
    };
  };

  /** Reads on the lease, each admitted by the data server; a lease renewed meanwhile is followed once, in its tenant. */
  const leaseLoop = (req: IncomingMessage, first: Lease): Loop => {
    let lease = first;
    return async (method, target, body, signal) => {
      for (let attempt = 0; ; attempt++) {
        const answer = await ask(
          forwarded(req, method, `${target}${target.includes('?') ? '&' : '?'}tenant=${encodeURIComponent(first.tenantId)}`, body, {
            [headers.account]: lease.accountId,
            [headers.app]: app.id,
            [headers.tab]: lease.tabId,
            [headers.context]: lease.context,
            [headers.revision]: String(lease.revision),
          }),
          signal,
        );
        const code = (answer?.body as { code?: unknown } | null | undefined)?.code;
        if (attempt > 0 || answer?.status !== 409 || (code !== 'tenant_lease_stale' && code !== 'tenant_lease_expired')) return answer;
        let renewed: Lease;
        try {
          renewed = await recover(req, lease.accountId, lease.tabId, signal);
        } catch {
          return answer;
        }
        // The tab moved to another customer: this conversation's reads stop rather than follow it there.
        if (renewed.tenantId !== first.tenantId) return answer;
        lease = renewed;
      }
    };
  };

  const scopeOf = async (req: IncomingMessage, appId: unknown) => {
    if (appId !== app.id || !app.assistant) throw new HttpError(404, 'This App has no assistant.');
    const header = (name: string) => {
      try {
        return tenantHttpHeader(req, name);
      } catch {
        throw new HttpError(400, 'Invalid assistant request.');
      }
    };
    // A bearer token belongs to the App API, and a tenant or realm is never a request's to name here.
    if (req.headers.authorization !== undefined || header(headers.tenant) !== undefined || header(headers.realm) !== undefined)
      throw new HttpError(403, 'The assistant is not offered to you here.');
    const account = header(headers.account),
      tabId = header(headers.tab),
      context = header(headers.context),
      revision = header(headers.revision);
    if (header(headers.app) !== app.id || !account || !tabId || !context || !revision) throw new HttpError(403, 'Choose a customer first.');
    const lease = await recover(req, account, tabId);
    // The tab's own context, as it said it holds it: a token from another tab or a past one is not this one.
    if (lease.context !== context) throw new HttpError(403, 'Choose a customer first.');
    const loop = leaseLoop(req, lease);
    /* The App as this person is served it in this tenant: the assistant is in it only where its role is offered
       one, a model is set up and the tenant's switch is on (tenantHttp.ts). Asked on every request. */
    const served = await loop('GET', `/api/app?app=${encodeURIComponent(app.id)}`);
    const payload = (served?.body as { app?: AppPayloadApp | null } | undefined)?.app;
    if (served?.status !== 200 || !payload?.assistant) throw new HttpError(403, 'The assistant is not offered to you here.');
    let opened: AssistantStore;
    try {
      opened = await storeOf();
    } catch (error) {
      throw storeUnavailableReply(error);
    }
    const tenantId = lease.tenantId;
    return {
      app,
      owner: { app: app.id, tenant: tenantId, account },
      store: opened,
      loop: () => loop,
      ...(policy?.tokensPerTenantPerDay === undefined ? {} : { tokensPerTenantPerDay: policy.tokensPerTenantPerDay }),
      withdrawn: async () => ((await offered(tenantId)) ? undefined : 'The assistant was turned off for this customer.'),
    };
  };

  let stopPurging: (() => void) | undefined;
  /** Conversations untouched for the retention period, gone; how many. */
  const purge = async (): Promise<number> => {
    const days = policy?.retentionDays ?? TENANT_ASSISTANT_RETENTION_DAYS;
    return (await storeOf()).purge(app.id, retentionCutoff(now(), days));
  };

  return Object.freeze({
    offered,
    handles: (path: string) => ASSISTANT_PATHS.has(path),
    async handle(req: IncomingMessage, res: ServerResponse, url: URL, path: string): Promise<void> {
      const bound = binding();
      // A HEAD is held as a write here, as it always was: the assistant answers no HEAD.
      if (doorRefusal(req, bound, { writing: req.method !== 'GET' })) {
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ error: 'Refused.' }));
        return;
      }
      await answerAssistant(req, res, url, path, (appId) => scopeOf(req, appId));
    },
    /** At startup, where a model is set up: the store is attested now, so a missing one refuses the start. */
    async attest(): Promise<void> {
      if (app.assistant && assistantModel()) await storeOf();
    },
    purge,
    /** Purge now and then every six hours, while the host runs. A failed purge is tried again at the next. */
    start(): void {
      if (!app.assistant || stopPurging) return;
      stopPurging = purgeOnSchedule(purge);
    },
    async close(): Promise<void> {
      stopPurging?.();
      stopPurging = undefined;
      const opened = store;
      store = undefined;
      if (opened) await opened.then((each) => each.close()).catch(() => {});
    },
  });
}
export type TenantAssistant = ReturnType<typeof createTenantAssistant>;
