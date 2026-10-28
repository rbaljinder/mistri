import {
  PLATFORM_TENANT_ID,
  TENANT_HTTP_HEADERS as names,
  type TenantContextReply,
  type TenantContextRecovery,
} from '../shared/tenantContext.js';
import {
  assertSessionCurrent,
  captureSessionIdentity,
  captureTenantLease,
  tenantLeaseActive,
  suspendTenantLease,
  type SessionIdentitySnapshot,
} from '@mistriwork/kit/client/sessionIdentity.js';
import { invalidateSession, invalidateTenantContext } from '@mistriwork/kit/client/sessionLifecycle.js';
import { recordKey, writeValues } from '@mistriwork/kit/client/resourceRequests.js';
import { historyToken } from '@mistriwork/kit/client/historyToken.js';
import { SUPPORT_LOG_PATH, SUPPORT_SESSIONS_PATH } from '../shared/tenantSupportLog.js';
import { IMPORT_LIMITS } from '../shared/appImportDeclaration.js';
import { say } from './copy/tenancy/tenantTransport.js';
import { MUTATION_PATHS } from '@mistriwork/kit/client/writePaths.js';
import { isTenantName, replaceTenantNames } from './tenantNames.js';
import { fetchServer } from '@mistriwork/kit/client/transport.js';
import { fileReads } from '@mistriwork/kit/client/liveReads.js';
import { firstPaintRead } from '@mistriwork/kit/client/firstPaint.js';
import {
  TENANT_BATCH_MOST,
  TENANT_BATCH_READS,
  TENANT_BOOT_PATH,
  TENANT_ENTER_PATH,
  soleTenant,
  type TenantBatchRead,
} from '../shared/tenantBoot.js';
import { readKey } from '@mistriwork/engine/shared/firstPaint.js';
import { gatheringReads } from '@mistriwork/kit/client/readGathering.js';

/* The file travels as JSON text, where a quote or a line break is two characters (server/http/importRoutes.ts). */
const IMPORT_BODY = IMPORT_LIMITS.bytes * 2 + 64 * 1024;
/* Base64 of the most a tenant upload carries, 10 MiB, and room for the rest (server/http/reply.ts TENANT_FILE_UPLOAD_BODY). */
const FILE_UPLOAD_BODY = Math.ceil((10 * 1024 * 1024) / 3) * 4 + 64 * 1024;

const reads = new Set([
  '/api/query',
  '/api/count',
  '/api/counts',
  '/api/run',
  '/api/view/run',
  '/api/breakdown',
  '/api/breakdowns',
  '/api/flags/evaluate',
  '/api/schema',
  '/api/runtime',
  '/api/app',
  '/api/pages',
  '/api/pages/suggested',
  '/api/pages/plan',
  '/api/references',
  // A record page whole, its parts read on the lease's one context (tenantCompose.ts).
  '/api/pages/compose',
  // A free-form page's loader, run for the lease's member on its one context (tenantHttp.ts).
  '/api/pages/load',
  '/api/commands/availability',
  // A record's history, read on the lease like its page: the tenant host derives the owner from the lease.
  '/api/record-history',
  // A record's suggestions, its list's marks, "Why this?" and settling one: the tenant host reads them on the lease,
  // its own tenant's alone, for a member granted the answer command (server http/decisionRoutes.ts).
  '/api/record-decisions',
  '/api/record-decisions/marks',
  '/api/record-decisions/why',
  '/api/record-decisions/settle',
  // The lease's own inbox, and marking its notices read: the lease names whose inbox it is.
  '/api/inbox',
  '/api/inbox/read',
  // The lease's tenant's branding, and its admins' save of it (server tenantBranding.ts): the lease names the tenant.
  '/api/branding',
  '/api/branding/save',
  // Its integrations' secrets, set or not, never a value, and its admins' save (server tenantIntegrations.ts).
  '/api/integrations',
  '/api/integrations/save',
  // A dealer's own log of support visits into it: a read on the dealer's
  // ordinary tenant lease, which the selector below addresses like any other.
  SUPPORT_LOG_PATH,
  // Every tenant's support sessions, on a platform lease, for a role granted `supportAudit` (tenantHttp.ts).
  SUPPORT_SESSIONS_PATH,
  // A member's own API tokens on their tenant's lease: the lease names the membership a token binds (tenantHttp.ts).
  '/api/tokens',
  '/api/tokens/issue',
  '/api/tokens/revoke',
  // One file's bytes, as base64 on the lease: a tenant's file is never a link (server/http/reply.ts FILE_READ_PATH).
  '/api/file/read',
]);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 1024 && value === value.trim() && !/\p{Cc}/u.test(value);
const unavailable = () => new Error(say('theTenantContextIsUnavailable'));

function account(snapshot: SessionIdentitySnapshot): void {
  assertSessionCurrent(snapshot);
  if (snapshot.mode !== 'authenticated' || !snapshot.tenantRequired || !snapshot.appId || !snapshot.accountId) throw unavailable();
}
export function selected(snapshot: SessionIdentitySnapshot): TenantContextReply {
  account(snapshot);
  const lease = captureTenantLease(snapshot);
  if (!lease || !tenantLeaseActive(snapshot)) throw unavailable();
  return lease;
}
export function owns(headers: Headers, context: TenantContextReply): boolean {
  return (
    headers.get(names.app) === context.appId &&
    headers.get(names.account) === context.accountId &&
    headers.get(names.tenant) === context.tenantId &&
    headers.get(names.tab) === context.tabId &&
    headers.get(names.context) === context.context &&
    headers.get(names.revision) === String(context.revision) &&
    headers.get(names.realm) === (context.realm === 'platform' ? 'platform' : null)
  );
}
/** The selector a captured context names: the platform realm, or one tenant. */
export const selector = (tenantId: string): Record<string, string> =>
  tenantId === PLATFORM_TENANT_ID ? { realm: 'platform' } : { tenant: tenantId };
function context(value: unknown, snapshot: SessionIdentitySnapshot, response: Response, allowExpired = false): TenantContextReply {
  const now = Date.now();
  if (
    !object(value) ||
    Object.keys(value).some(
      (key) => !['tabId', 'context', 'appId', 'accountId', 'tenantId', 'revision', 'expiresAt', 'realm'].includes(key),
    ) ||
    (value.realm === 'platform') !== (value.tenantId === PLATFORM_TENANT_ID) ||
    ('realm' in value && value.realm !== 'platform') ||
    !['tabId', 'context', 'appId', 'accountId', 'tenantId'].every((key) => id(value[key])) ||
    value.appId !== snapshot.appId ||
    value.accountId !== snapshot.accountId ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 1 ||
    typeof value.expiresAt !== 'number' ||
    !Number.isFinite(value.expiresAt) ||
    value.expiresAt <= 0 ||
    !Number.isFinite(now) ||
    (!allowExpired && value.expiresAt <= now)
  )
    throw unavailable();
  const captured = Object.freeze({ ...value }) as unknown as TenantContextReply;
  if (!owns(response.headers, captured)) throw unavailable();
  return captured;
}

function currentLease(snapshot: SessionIdentitySnapshot, lease?: TenantContextReply): boolean {
  return snapshot === captureSessionIdentity() && (!lease || captureTenantLease(snapshot)?.revision === lease.revision);
}
function unverified(snapshot: SessionIdentitySnapshot, lease?: TenantContextReply): void {
  if (currentLease(snapshot, lease)) invalidateSession('unavailable', false);
}
const transient = (response: Response): boolean => response.status >= 500 || response.status === 408 || response.status === 429;
function refused(
  snapshot: SessionIdentitySnapshot,
  lease: TenantContextReply | undefined,
  response: Response,
  value: Record<string, unknown>,
): void {
  if (!currentLease(snapshot, lease)) return;
  if (response.status === 401) invalidateSession('expired');
  else if (lease && value.code === 'tenant_context_unavailable') invalidateTenantContext(snapshot);
  else if (lease && (value.code === 'tenant_lease_stale' || value.code === 'tenant_lease_expired')) suspendTenantLease(snapshot);
}
/* A server too slow or too busy to answer — a network error, a 5xx, a 408 or
   429, a body that broke off — decided nothing about the context: the server's
   own 503 says so (tenantContexts.ts denyTenantFor). Fencing the lease on one
   of them paused the whole page under load and turned every read in flight
   into "the tenant context is unavailable" (G172), so request() only tags
   them; a read retries before it fences, renewal retries while its lease
   lasts, and a write fences at once because its outcome is unknown. */
const slow = <E extends Error>(error: E): E => Object.assign(error, { transient: true as const });
export const isTransientTenantFailure = (error: unknown): boolean =>
  !!error && typeof error === 'object' && (error as { transient?: unknown }).transient === true;
const fence = (snapshot: SessionIdentitySnapshot, lease: TenantContextReply | undefined) => {
  if (lease && currentLease(snapshot, lease)) suspendTenantLease(snapshot);
};
/** Renewal cannot extend an invocation already on the wire. */
function publishable(snapshot: SessionIdentitySnapshot, lease: TenantContextReply): void {
  selected(snapshot);
  const now = Date.now();
  if (!Number.isFinite(now) || now >= lease.expiresAt) throw unavailable();
}

async function request(
  snapshot: SessionIdentitySnapshot,
  path: string,
  body?: Record<string, unknown>,
  tenant?: TenantContextReply,
  signal?: AbortSignal,
  deferFailure = false,
  failureOwner = tenant,
) {
  account(snapshot);
  let response: Response;
  try {
    response = await fetchServer(path, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...(signal ? { signal } : {}),
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        [names.account]: snapshot.accountId!,
        [names.app]: snapshot.appId!,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(tenant ? { [names.tab]: tenant.tabId, [names.context]: tenant.context, [names.revision]: String(tenant.revision) } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    // The caller giving up on its own read says nothing about the server at all.
    if (signal?.aborted) throw error;
    throw error instanceof Error ? slow(error) : slow(new Error(String(error)));
  }
  account(snapshot);
  let value: unknown;
  try {
    value = await response.json();
  } catch (error) {
    if (response.status === 401) {
      if (currentLease(snapshot, failureOwner)) invalidateSession('expired');
    } else if (transient(response) || error instanceof TypeError || (error instanceof Error && error.name === 'AbortError')) {
      if (!signal?.aborted) throw slow(new Error(say('theTenantResponseCould')));
    } else if (failureOwner) unverified(snapshot, failureOwner);
    throw new Error(say('theTenantResponseCould'));
  }
  account(snapshot);
  if (!object(value)) {
    if (transient(response)) throw slow(unavailable());
    if (response.status === 401) refused(snapshot, failureOwner, response, {});
    else if (failureOwner) unverified(snapshot, failureOwner);
    throw unavailable();
  }
  if (!response.ok && !deferFailure) {
    refused(snapshot, failureOwner, response, value);
    const failure = Object.assign(new Error(typeof value.error === 'string' ? value.error : say('theTenantRequestWasRefused')), {
      status: response.status,
      ...(typeof value.code === 'string' ? { code: value.code } : {}),
    });
    throw transient(response) ? slow(failure) : failure;
  }
  return { response, value };
}

/** Discovery identifies choices, never a selected context or implicit grant. */
export async function discoverTenants(): Promise<readonly string[]> {
  const snapshot = captureSessionIdentity();
  const { value } = await request(snapshot, `/api/tenant/bootstrap?${new URLSearchParams({ app: snapshot.appId! })}`);
  return discovered(value, snapshot, false).tenants;
}

/** Discovery's answer, checked: the choices, and whether the platform realm is one of them. */
function discovered(
  value: Record<string, unknown>,
  snapshot: SessionIdentitySnapshot,
  entering: boolean,
): { tenants: readonly string[]; memberships: readonly string[]; platform: boolean } {
  if (value.status === 'signed_out') {
    invalidateSession('expired');
    throw unavailable();
  }
  if (
    value.status !== 'ready' ||
    value.appId !== snapshot.appId ||
    value.accountId !== snapshot.accountId ||
    !Array.isArray(value.memberships) ||
    value.memberships.length > 256 ||
    Object.keys(value).some(
      (key) => !['status', 'appId', 'accountId', 'memberships', 'platform', ...(entering ? ['entered'] : [])].includes(key),
    ) ||
    ('platform' in value && value.platform !== true)
  )
    throw unavailable();
  const named: [string, string][] = [];
  const sandboxed: string[] = [];
  const result = value.memberships.map((member) => {
    if (
      !object(member) ||
      Object.keys(member).some((key) => key !== 'tenantId' && key !== 'name' && key !== 'sandbox') ||
      !id(member.tenantId) ||
      member.tenantId === PLATFORM_TENANT_ID ||
      ('name' in member && !isTenantName(member.name)) ||
      ('sandbox' in member && member.sandbox !== true)
    )
      throw unavailable();
    if (typeof member.name === 'string') named.push([member.tenantId, member.name]);
    if (member.sandbox === true) sandboxed.push(member.tenantId);
    return member.tenantId as string;
  });
  if (new Set(result).size !== result.length) throw unavailable();
  // What each is called, for the chooser and the bar to say (tenantNames.ts).
  replaceTenantNames(named, sandboxed);
  // The platform realm is one more choice, under its reserved id.
  const platform = value.platform === true;
  return { tenants: Object.freeze(platform ? [...result, PLATFORM_TENANT_ID] : result), memberships: result, platform };
}

/** What entering answered: the choices, and where the person was entered without being asked, the lease and its boot. */
export interface TenantEntry {
  readonly tenants: readonly string[];
  readonly lease?: TenantContextReply;
  /** The page's boot on that lease (shared/tenantBoot.ts), when the host could read it. */
  readonly boot?: Record<string, unknown>;
}

/**
 * Discovery, and for someone with one tenant, the lease in it and the page's boot on that lease, in one request
 * (shared/tenantBoot.ts `TENANT_ENTER_PATH`). The lease is taken only where it is the very one discovery's own answer
 * would have the chooser enter (shared `soleTenant`): this tab's kept context resumed, or a new one.
 */
export async function enterTenant(
  page: { readonly path: string; readonly search: string },
  requested?: string,
  kept?: { readonly tenantId: string; readonly tabId: string },
): Promise<TenantEntry> {
  const snapshot = captureSessionIdentity();
  account(snapshot);
  if (snapshot.tenant || requested === PLATFORM_TENANT_ID) throw unavailable();
  const { value, response } = await request(snapshot, `${TENANT_ENTER_PATH}?${new URLSearchParams({ app: snapshot.appId! })}`, {
    path: page.path,
    search: page.search,
    ...(requested === undefined ? {} : { tenant: requested }),
    ...(kept ? { kept: { tenantId: kept.tenantId, tabId: kept.tabId } } : {}),
  });
  const found = discovered(value, snapshot, true);
  if (!('entered' in value)) return { tenants: found.tenants };
  const entered = value.entered;
  if (
    !object(entered) ||
    Object.keys(entered).some((key) => key !== 'context' && key !== 'boot') ||
    ('boot' in entered && !object(entered.boot))
  )
    throw unavailable();
  const lease = context(entered.context, snapshot, response);
  const sole = soleTenant(found.memberships, found.platform, requested);
  if (
    sole === undefined ||
    lease.tenantId !== sole ||
    lease.realm !== undefined ||
    (kept?.tenantId === sole && lease.tabId === kept.tabId ? lease.revision < 1 : lease.revision !== 1)
  )
    throw unavailable();
  return { tenants: found.tenants, lease, ...(object(entered.boot) ? { boot: entered.boot } : {}) };
}

/** The caller retires browser state before dispatch. A lost acknowledgement
 * stays unselected until explicit recovery; never reopen the old context. */
export async function chooseTenant(tenantId: string, previous?: TenantContextReply): Promise<TenantContextReply> {
  const snapshot = captureSessionIdentity();
  account(snapshot);
  if (!id(tenantId) || snapshot.tenant || (previous && (previous.appId !== snapshot.appId || previous.accountId !== snapshot.accountId)))
    throw unavailable();
  const path = previous ? '/api/tenant/context/switch' : '/api/tenant/context/open';
  const { value, response } = await request(
    snapshot,
    `${path}?${new URLSearchParams({ app: snapshot.appId!, ...selector(tenantId) })}`,
    previous ? { tabId: previous.tabId, expectedContext: previous.context, expectedRevision: previous.revision } : {},
  );
  const reply = context(value, snapshot, response);
  if (reply.revision !== 1 || reply.tenantId !== tenantId || (previous && reply.tabId !== previous.tabId)) throw unavailable();
  return reply;
}

export async function recoverTenant(tabId: string): Promise<TenantContextRecovery> {
  const snapshot = captureSessionIdentity();
  account(snapshot);
  if (!id(tabId) || snapshot.tenant) throw unavailable();
  const { value, response } = await request(snapshot, `/api/tenant/context/recover?${new URLSearchParams({ app: snapshot.appId! })}`, {
    tabId,
  });
  if (value.status === 'inactive' && value.tabId === tabId && Object.keys(value).length === 2)
    return Object.freeze({ tabId, status: 'inactive' });
  const reply = context(value, snapshot, response);
  if (reply.tabId !== tabId) throw unavailable();
  return reply;
}

/**
 * The same browser tab's next page taking back the context its last page let
 * go (releaseTenant), for the tenant the reader chose again: the server
 * resumes only a released context of this session, and only once, so a
 * reload opens nothing new and a context another page holds is never shared.
 */
export async function resumeTenant(tenantId: string, tabId: string): Promise<TenantContextReply> {
  const snapshot = captureSessionIdentity();
  account(snapshot);
  if (!id(tenantId) || !id(tabId) || snapshot.tenant) throw unavailable();
  const { value, response } = await request(
    snapshot,
    `/api/tenant/context/resume?${new URLSearchParams({ app: snapshot.appId!, ...selector(tenantId) })}`,
    { tabId },
  );
  const reply = context(value, snapshot, response);
  if (reply.revision < 1 || reply.tenantId !== tenantId || reply.tabId !== tabId) throw unavailable();
  return reply;
}

/**
 * A page letting its context go as it leaves (pagehide): sent with keepalive
 * so it goes out as the page does, and never awaited. The server keeps the
 * context a moment for this tab's next page to resume, then lets it go, so
 * contexts no longer pile up against the account's limit.
 */
export function releaseTenant(lease: TenantContextReply): void {
  try {
    void fetchServer(`/api/tenant/context/release?${new URLSearchParams({ app: lease.appId })}`, {
      method: 'POST',
      keepalive: true,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { [names.account]: lease.accountId, [names.app]: lease.appId, 'content-type': 'application/json' },
      body: JSON.stringify({ tabId: lease.tabId, expectedContext: lease.context, expectedRevision: lease.revision }),
    }).catch(() => {});
  } catch {
    /* A page that cannot say it is leaving leaves its context to expire, as before. */
  }
}

/** Exact renewal recovery is a control request, including while suspended or
 * expired. An expired duplicate receipt may advance CAS, never data authority. */
export async function renewTenant(
  snapshot: SessionIdentitySnapshot,
  expected: TenantContextReply,
  signal?: AbortSignal,
): Promise<TenantContextReply> {
  account(snapshot);
  const lease = captureTenantLease(snapshot);
  if (
    !lease ||
    !object(expected) ||
    !['tabId', 'context', 'appId', 'accountId', 'tenantId', 'revision', 'expiresAt'].every(
      (key) => expected[key as keyof TenantContextReply] === lease[key as keyof TenantContextReply],
    ) ||
    lease.revision === Number.MAX_SAFE_INTEGER
  )
    throw unavailable();
  const { value, response } = await request(
    snapshot,
    `/api/tenant/context/renew?${new URLSearchParams({ app: lease.appId, ...selector(lease.tenantId) })}`,
    { tabId: lease.tabId, expectedContext: lease.context, expectedRevision: lease.revision },
    undefined,
    signal,
    false,
    lease,
  );
  try {
    const reply = context(value, snapshot, response, true);
    if (
      reply.revision !== lease.revision + 1 ||
      !['tabId', 'context', 'appId', 'accountId', 'tenantId'].every(
        (key) => reply[key as keyof TenantContextReply] === lease[key as keyof TenantContextReply],
      )
    )
      throw unavailable();
    return reply;
  } catch (error) {
    unverified(snapshot, lease);
    throw error;
  }
}

/* How long a read waits before asking again after a slow or busy answer: about
   four seconds in all, long enough for a loaded server to drain, short enough
   that a server truly down still pauses the page soon. */
const READ_RETRY_MS = [250, 1000, 3000] as const;
const pause = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error(say('theTenantRequestWasRefused')));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error(say('theTenantRequestWasRefused')));
    };
    signal?.addEventListener('abort', stop, { once: true });
  });

/* Each answer a boot carried, by its body, with the lease it was read on: taken only under that very lease (a
   renewal's is another), and so only on its context, by its account. */
const boots = new WeakMap<object, TenantContextReply>();

/**
 * The page's boot (client tenantBootLoad.ts asks it, shared/tenantBoot.ts says
 * why), on the lease just opened: its reply, and the lease it attests, or
 * none. Its refusal is nobody's: no lease is fenced or ended over it, and each
 * read it would have answered is asked alone, where a read the lease truly
 * refuses is refused in its own words.
 */
export async function tenantBootReply(
  path: string,
  search: string,
): Promise<{ value: Record<string, unknown>; owner: TenantContextReply } | undefined> {
  const snapshot = captureSessionIdentity();
  const owner = selected(snapshot);
  const address = `${TENANT_BOOT_PATH}?${new URLSearchParams({ app: owner.appId, ...selector(owner.tenantId) })}`;
  const { response, value } = await request(snapshot, address, { path, search }, owner, undefined, true, undefined);
  return response.ok && currentLease(snapshot, owner) && owns(response.headers, owner) ? { value, owner } : undefined;
}
/** An answer the boot carried, read on `owner`'s context: taken only on that same context. */
export const carriedOn = (body: object, owner: TenantContextReply): void => void boots.set(body, owner);

/* ---------- reads asked in one moment go as one (shared/tenantBoot.ts TENANT_BATCH_READS) ---------- */

type Batched = { body: Record<string, unknown>; reads?: string } | undefined;
interface Gathered {
  readonly snapshot: SessionIdentitySnapshot;
  readonly owner: TenantContextReply;
  readonly asked: Array<{ read: TenantBatchRead; key: string; answer: (value: Batched) => void }>;
}
/* The reads of each lease asked in this moment, gathered until it ends. */
const gathering = new Map<TenantContextReply, Gathered>();
/* A lease whose host would not batch (a support lease answers 404): each of its reads is asked alone from then on. */
const unbatched = new WeakSet<TenantContextReply>();

/**
 * This read's answer, when other reads of the same lease are asked in the same moment, one whose reads belong
 * together (kit client/readGathering.ts: a write's refresh): they go as one request
 * (`POST /api/boot` with `reads`), read by the host on one context and one snapshot, and each takes its own answer
 * from it. Undefined — the read is asked alone, as ever — when it was the only one, or the batch could not answer
 * it: refused, failed, a lease that moved on, or a read the host would not carry. A batch's failure is nobody's:
 * nothing is fenced over it, and each of its reads hears its own answer by asking.
 */
function batched(
  snapshot: SessionIdentitySnapshot,
  owner: TenantContextReply,
  read: TenantBatchRead,
  address: string,
  signal?: AbortSignal,
): Promise<Batched> {
  if (!TENANT_BATCH_READS.has(read.path.split('?')[0]) || unbatched.has(owner) || signal?.aborted) return Promise.resolve(undefined);
  return new Promise((answer) => {
    let group = gathering.get(owner);
    if (group && (group.snapshot !== snapshot || group.asked.length >= TENANT_BATCH_MOST)) {
      gathering.delete(owner);
      void sendGathered(group);
      group = undefined;
    }
    if (!group) {
      const opened: Gathered = { snapshot, owner, asked: [] };
      group = opened;
      gathering.set(owner, opened);
      /* The moment: what the same task and its promises ask, and a timer's turn after. */
      setTimeout(() => {
        if (gathering.get(owner) === opened) gathering.delete(owner);
        void sendGathered(opened);
      }, 0);
    }
    group.asked.push({ read, key: readKey(read.method, address, read.body), answer });
  });
}

async function sendGathered(group: Gathered): Promise<void> {
  const { snapshot, owner, asked } = group;
  if (asked.length < 2 || !currentLease(snapshot, owner)) {
    for (const each of asked) each.answer(undefined);
    return;
  }
  let answers: Record<string, unknown> = {};
  try {
    const address = `${TENANT_BOOT_PATH}?${new URLSearchParams({ app: owner.appId, ...selector(owner.tenantId) })}`;
    const { response, value } = await request(
      snapshot,
      address,
      { reads: asked.map((each) => each.read) },
      owner,
      undefined,
      true,
      undefined,
    );
    if (response.status === 404) unbatched.add(owner);
    if (response.ok && currentLease(snapshot, owner) && owns(response.headers, owner) && object(value.reads)) answers = value.reads;
  } catch {
    /* Each read asks alone. */
  }
  for (const each of asked) {
    const carried = Object.hasOwn(answers, each.key) ? answers[each.key] : undefined;
    each.answer(
      object(carried) && object(carried.body)
        ? { body: carried.body, ...(typeof carried.reads === 'string' ? { reads: carried.reads } : {}) }
        : undefined,
    );
  }
}

/** The metadata gate is read-only. Unsupported authoring/SQL/export/write paths
 * refuse locally; they cannot fall through to the ordinary connection protocol. */
export async function tenantReadApi(
  path: string,
  body?: Record<string, unknown>,
  active?: string | null,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const snapshot = captureSessionIdentity();
  let owner = selected(snapshot);
  const url = new URL(path, 'http://mistri.invalid');
  if (!path.startsWith('/api/') || url.hash || url.pathname !== path.split('?')[0] || !reads.has(url.pathname))
    throw new Error(say('thisOperationIsNotEnabled'));
  if (active && active !== owner.appId) throw unavailable();
  const payload = body === undefined ? undefined : { ...body };
  if (url.searchParams.has('conn') || payload?.conn !== undefined) throw unavailable();
  const claims = [...url.searchParams.getAll('app'), ...(payload?.app === undefined ? [] : [payload.app])];
  if (claims.some((value) => value !== owner.appId) || url.searchParams.getAll('app').length > 1) throw unavailable();
  url.searchParams.delete('app');
  if (payload) delete payload.app;
  if (
    url.searchParams.has('tenant') ||
    url.searchParams.has('realm') ||
    (payload && ['tenant', 'tenantId', 'realm', 'tabId', 'expectedContext', 'expectedRevision', 'revision'].some((key) => key in payload))
  )
    throw unavailable();
  if (
    [...url.searchParams.keys()].some((key) => url.pathname !== '/api/pages/suggested' || key !== 'table') ||
    url.searchParams.getAll('table').length > 1
  )
    throw unavailable();
  /* As a batch names it (shared/tenantBoot.ts TenantBatchRead): before the lease is named in it. */
  const bare = `${url.pathname}${url.search}`;
  url.searchParams.set('app', owner.appId);
  for (const [key, named] of Object.entries(selector(owner.tenantId))) url.searchParams.set(key, named);
  /* As the server keys what the page's boot carried (shared/tenantBoot.ts `tenantReadAddress`). */
  const address = `${url.pathname}${url.search}`;
  /* The page's boot answered this request on this very lease (tenantBootLoad.ts): its answer, once. */
  const carried = firstPaintRead(payload === undefined ? 'GET' : 'POST', address, payload);
  if (carried && boots.get(carried.body as object) === owner && currentLease(snapshot, owner)) {
    publishable(snapshot, owner);
    fileReads(carried.body, carried.reads);
    return carried.body as Record<string, unknown>;
  }
  /* Asked in the same moment as other reads of this lease — a write's refresh, a room's reads — it goes with them. */
  /* Outside such a moment a read goes at once, as ever: not even a turn later. */
  const together = gatheringReads()
    ? await batched(
        snapshot,
        owner,
        payload === undefined ? { method: 'GET', path: bare } : { method: 'POST', path: bare, body: payload },
        address,
        signal,
      )
    : undefined;
  if (together && currentLease(snapshot, owner)) {
    publishable(snapshot, owner);
    fileReads(together.body, together.reads);
    return together.body;
  }
  let delivered: Awaited<ReturnType<typeof request>>;
  for (let attempt = 0; ; attempt++) {
    try {
      delivered = await request(snapshot, address, payload, owner, signal);
      break;
    } catch (error) {
      // An old revision's slow answer is that revision's alone: no retry, no fence (as for any of its answers).
      if (!isTransientTenantFailure(error) || !currentLease(snapshot, owner)) throw error;
      // Out of patience: fence as before, and renewal decides whether the context stands.
      if (attempt >= READ_RETRY_MS.length) {
        fence(snapshot, owner);
        throw error;
      }
      await pause(READ_RETRY_MS[attempt], signal);
      // A read is idempotent, so it is asked again under the lease current now: renewed
      // in the wait, it carries the new revision; fenced or switched, it is refused here.
      owner = selected(snapshot);
    }
  }
  const { response, value } = delivered;
  publishable(snapshot, owner);
  // Parser errors deliberately carry no owner or row data. A successful data
  // reply must attest the whole captured tuple, not merely the account.
  const failure = typeof value.error === 'string' || (Array.isArray(value.errors) && value.errors.length > 0);
  if (failure)
    return {
      ...(typeof value.error === 'string' ? { error: value.error } : {}),
      ...(Array.isArray(value.errors) ? { errors: value.errors } : {}),
    };
  if (!failure && !owns(response.headers, owner)) {
    unverified(snapshot, owner);
    throw unavailable();
  }
  /* The tables it answered from, as an App's own reads say them: live sync asks it again only when one changes. */
  fileReads(value, response.headers.get('mistri-reads'));
  return value;
}

const mutationFields: Record<(typeof MUTATION_PATHS)[number], readonly string[]> = {
  /* A record's lines (`form.lines`) go with its save; the row policy judges each one (scopedWrites.ts). */
  '/api/update': ['table', 'key', 'values', 'column', 'value', 'expected', 'lines'],
  '/api/insert': ['table', 'values', 'lines'],
  // A file into a file resource: the bytes as base64, the row they belong to in `values`.
  '/api/file/upload': ['table', 'values', 'file'],
  '/api/delete': ['table', 'key', 'confirm'],
  '/api/revert': ['limit', 'confirm', 'expectedId'],
  // A CSV file into a resource this member writes: checked, then written in one transaction of the lease's tenant.
  '/api/import': ['table', 'view', 'name', 'csv', 'mapping', 'mode', 'skipRefused'],
  '/api/commands/prepare': ['command', 'commandVersion', 'key'],
  '/api/commands/execute': ['command', 'commandVersion', 'key', 'expectedVersion', 'idempotencyKey', 'input'],
  '/api/commands/status': ['command', 'commandVersion', 'key', 'expectedVersion', 'idempotencyKey', 'input'],
};
export const isTenantMutationPath = (path: string): boolean => (MUTATION_PATHS as readonly string[]).includes(path);
const mutationError = (message: string, outcome: 'not_applied' | 'rejected' | 'unknown', detail: Record<string, unknown> = {}) =>
  Object.assign(new Error(message), detail, { outcome });

/** Capture only inert JSON data before dispatch. Accessors, hidden properties,
 * cycles and lossy JSON coercion must not turn a submitted attempt into another. */
function mutationData(value: unknown, ancestors = new Set<object>(), depth = 0): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))
    return value;
  if (depth > 32 || !value || typeof value !== 'object' || ancestors.has(value)) throw new Error(say('invalidMutationData'));
  const array = Array.isArray(value),
    prototype = Object.getPrototypeOf(value);
  if (!array && prototype !== Object.prototype && prototype !== null) throw new Error(say('invalidMutationData'));
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length) throw new Error(say('invalidMutationData'));
  ancestors.add(value);
  try {
    const pairs = Object.entries(descriptors)
      .filter(([key]) => !array || key !== 'length')
      .map(([key, descriptor]) => {
        if (!descriptor.enumerable || !('value' in descriptor)) throw new Error(say('invalidMutationData'));
        return [key, mutationData(descriptor.value, ancestors, depth + 1)] as const;
      });
    if (!array) return Object.fromEntries(pairs);
    if (pairs.length !== value.length || pairs.some(([key], index) => key !== String(index))) throw new Error(say('invalidMutationData'));
    return pairs.map(([, item]) => item);
  } finally {
    ancestors.delete(value);
  }
}

function mutationBody(path: string, body: Record<string, unknown>): void {
  if (Object.keys(body).some((key) => !mutationFields[path as keyof typeof mutationFields].includes(key)))
    throw new Error(say('invalidMutationFields'));
  if (path === '/api/revert') {
    if (
      (body.confirm !== undefined && typeof body.confirm !== 'boolean') ||
      (body.expectedId !== undefined && historyToken(body.expectedId, true) === undefined) ||
      (body.confirm === true && historyToken(body.expectedId, true) === undefined) ||
      (body.limit !== undefined && (!Number.isSafeInteger(body.limit) || (body.limit as number) < 1))
    )
      throw new Error(say('invalidUndoRequest'));
    return;
  }
  if (path === '/api/import') {
    if (
      !id(body.table) ||
      typeof body.csv !== 'string' ||
      !Array.isArray(body.mapping) ||
      (body.mode !== 'check' && body.mode !== 'commit')
    ) {
      throw new Error(say('invalidImportRequest'));
    }
    return;
  }
  if (path.startsWith('/api/commands/')) {
    if (!id(body.command) || !Number.isSafeInteger(body.commandVersion) || (body.commandVersion as number) < 1)
      throw new Error(say('invalidCommandRequest'));
    /* A command that names no record (`targets: 'none'`: a signed-in form's)
       sends an empty key, as on a single App. Which commands may, and under
       what authority, is the server's to decide for this one as for a keyed
       one; anything else that is not a usable key stays refused here. */
    if (!(object(body.key) && Object.keys(body.key).length === 0)) recordKey(body.key);
    if (
      path !== '/api/commands/prepare' &&
      (!Number.isSafeInteger(body.expectedVersion) ||
        (body.expectedVersion as number) < 0 ||
        !id(body.idempotencyKey) ||
        !object(body.input))
    )
      throw new Error(say('invalidCommandRequest'));
    return;
  }
  if (!id(body.table)) throw new Error(say('invalidRecordRequest'));
  if (path === '/api/file/upload') {
    const file = body.file;
    if (
      !object(file) ||
      Object.keys(file).some((key) => !['name', 'type', 'data'].includes(key)) ||
      typeof file.name !== 'string' ||
      (file.type !== undefined && typeof file.type !== 'string') ||
      typeof file.data !== 'string' ||
      !object(body.values)
    )
      throw new Error(say('invalidWriteValues'));
    writeValues(body.values);
    return;
  }
  if (path !== '/api/insert') recordKey(body.key);
  if (path === '/api/delete') {
    if (body.confirm !== undefined && typeof body.confirm !== 'boolean') throw new Error(say('invalidDeleteRequest'));
  } else {
    if (body.values !== undefined) {
      if (!object(body.values)) throw new Error(say('invalidWriteValues'));
      writeValues(body.values);
    } else if (path === '/api/update' && id(body.column)) writeValues({ [body.column]: body.value ?? null });
    else throw new Error(say('invalidWriteValues'));
    if (body.expected !== undefined) {
      if (!object(body.expected)) throw new Error(say('invalidExpectedValues'));
      writeValues(body.expected);
    }
  }
}

/** Private mutation transport. URL/context claims come only from the captured
 * selection. A lost or unowned acknowledgement never becomes safe-to-retry. */
export async function tenantMutationApi(
  path: string,
  body: unknown,
  active?: string | null,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const snapshot = captureSessionIdentity();
  let owner: TenantContextReply, target: string, payload: Record<string, unknown>;
  try {
    owner = selected(snapshot);
    const url = new URL(path, 'http://mistri.invalid');
    if (!path.startsWith('/api/') || url.hash || url.pathname !== path.split('?')[0] || !isTenantMutationPath(url.pathname))
      throw new Error(say('thisMutationIsNotEnabled'));
    if (active && active !== owner.appId) throw unavailable();
    const captured = mutationData(body);
    if (!object(captured)) throw new Error(say('invalidMutationBody'));
    payload = captured;
    if (url.searchParams.has('conn') || payload.conn !== undefined) throw unavailable();
    const claims = [...url.searchParams.getAll('app'), ...(payload.app === undefined ? [] : [payload.app])];
    if (claims.some((value) => value !== owner.appId) || url.searchParams.getAll('app').length > 1) throw unavailable();
    url.searchParams.delete('app');
    delete payload.app;
    if (url.searchParams.size) throw new Error(say('invalidMutationSelector'));
    mutationBody(url.pathname, payload);
    const bound = url.pathname.startsWith('/api/commands/')
      ? 65536
      : url.pathname === '/api/import'
        ? IMPORT_BODY
        : url.pathname === '/api/file/upload'
          ? FILE_UPLOAD_BODY
          : 262144;
    if (new TextEncoder().encode(JSON.stringify(payload)).length > bound) throw new Error(say('theMutationIsToo'));
    // The platform realm changes rows through its commands, and its own rows by Save, New and Delete
    //; an import, an Undo or an upload has no platform answer, so none is sent.
    if (
      owner.tenantId === PLATFORM_TENANT_ID &&
      !url.pathname.startsWith('/api/commands/') &&
      !['/api/update', '/api/insert', '/api/delete'].includes(url.pathname)
    )
      throw new Error(say('thisChangeIsNotEnabled'));
    url.searchParams.set('app', owner.appId);
    for (const [key, named] of Object.entries(selector(owner.tenantId))) url.searchParams.set(key, named);
    target = url.pathname + url.search;
    if (signal?.aborted) throw new Error(say('theMutationWasCancelled'));
  } catch (error) {
    throw mutationError(error instanceof Error ? error.message : say('theMutationWasNotSent'), 'not_applied');
  }

  let delivered: Awaited<ReturnType<typeof request>>;
  try {
    delivered = await request(snapshot, target, payload, owner, signal, true);
  } catch (error) {
    if (isTransientTenantFailure(error)) fence(snapshot, owner);
    throw mutationError(error instanceof Error ? error.message : say('theChangeCouldNotBeConfirmed'), 'unknown');
  }
  const { response, value } = delivered;
  // Failure-only replies may omit ownership; a contradictory ownership claim
  // cannot prove anything about this attempt, including that it was rejected.
  if (Object.values(names).some((name) => response.headers.has(name)) && !owns(response.headers, owner)) {
    unverified(snapshot, owner);
    throw mutationError(say('theChangeResponseBelongs'), 'unknown');
  }
  refused(snapshot, owner, response, value);
  if (transient(response)) fence(snapshot, owner);
  /* An import's report is its answer whether or not it applied: the rows it
     refused and why, beside an `error` when nothing landed. Owned like any
     success, and handed back whole. */
  if (response.ok && path.split('?')[0] === '/api/import') {
    if (!owns(response.headers, owner)) {
      unverified(snapshot, owner);
      throw mutationError(say('theImportResponseHasNoVerified'), 'unknown');
    }
    try {
      publishable(snapshot, owner);
    } catch (error) {
      throw mutationError(error instanceof Error ? error.message : say('theImportCouldNotBeConfirmed'), 'unknown');
    }
    return value;
  }
  const failed = !response.ok || typeof value.error === 'string' || (Array.isArray(value.errors) && value.errors.length > 0);
  if (failed) {
    // Server admission/completion errors deliberately have no data-owner headers.
    // Accept only their failure envelope, never attached rows or success fields.
    const outcome = value.outcome === 'not_applied' || value.outcome === 'rejected' ? value.outcome : 'unknown';
    const message =
      typeof value.error === 'string'
        ? value.error
        : typeof value.message === 'string'
          ? value.message
          : say('theChangeCouldNotBeConfirmed');
    const diagnostics = Array.isArray(value.errors)
      ? value.errors
          .filter(object)
          .filter((item) => typeof item.message === 'string')
          .map((item) => ({ message: item.message, ...(typeof item.code === 'string' ? { code: item.code } : {}) }))
      : [];
    /* A write the App's rules refused is answered, not failed, whatever its status (core.js request): a line's
       `consumes` says it at 422, in the same envelope a 200 refusal has. */
    const rejected = response.status === 422 && outcome === 'rejected' && diagnostics.length > 0;
    if (!response.ok && !rejected)
      throw mutationError(message, outcome, { status: response.status, ...(typeof value.code === 'string' ? { code: value.code } : {}) });
    return {
      error: message,
      errors: diagnostics.length ? diagnostics : [{ message }],
      outcome,
      ...(path.split('?')[0] === '/api/revert'
        ? { reverted: false }
        : path.split('?')[0] === '/api/delete'
          ? { deleted: outcome === 'unknown' ? null : false }
          : {}),
    };
  }
  if (!owns(response.headers, owner)) {
    unverified(snapshot, owner);
    throw mutationError(say('theChangeResponseHasNoVerified'), 'unknown');
  }
  try {
    publishable(snapshot, owner);
  } catch (error) {
    throw mutationError(error instanceof Error ? error.message : say('theChangeCouldNotBeConfirmed'), 'unknown');
  }
  return value;
}
