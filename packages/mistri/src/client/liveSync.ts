/**
 * The page follows changes other people make (DESIGN-LIVE-SYNC §3.3-3.4).
 *
 * `GET /api/live` is a server-sent event stream read with `fetch` rather than
 * `EventSource`, since the tenant's lease and an embed's bearer travel as
 * request headers. The stream says which records changed, never their values:
 * each event is a notification, merged for 150 ms and handed to
 * liveInvalidate.ts, which asks the affected queries again through their own
 * paths. Nothing is reloaded, re-walked or patched.
 *
 * It lives while the tab is shown. A tab hidden for 30 s lets the stream go
 * and keeps its cursor; coming back it reconnects from the cursor, and the
 * server answers with one summary of what was missed (or a `reset`), so each
 * affected query asks once. A server that answers 204 has live sync off
 * (`--no-live`, or no change store) and the page works as it did.
 */
import { readEvents } from './components/assistantStream.js';
import {
  captureSessionIdentity,
  captureTenantLease,
  subscribeSessionIdentity,
  subscribeTenantLease,
} from '@mistriwork/kit/client/sessionIdentity.js';
import { connectionGeneration } from '@mistriwork/kit/client/connectionTransition.js';
import { scopeApiRequest } from '@mistriwork/kit/client/requestIdentity.js';
import { fetchServer } from '@mistriwork/kit/client/transport.js';
import { addChange, emptyBatch, forgetLive, invalidateLive, type LiveBatch } from './liveInvalidate.js';
import { watchEngagement } from './liveEngagement.js';
import { resetLiveState, setLiveActive, setLiveOff } from '@mistriwork/kit/client/liveState.js';
import { addHostListener, removeHostListener } from '@mistriwork/kit/client/shellHost.js';
import { forgetOwnWrites, ownWritesAnswered, ownWritesOut } from '@mistriwork/kit/client/ownWrites.js';

const MERGE_MS = 150;
const HIDDEN_MS = 30_000;
/* The server speaks every 25 s (a comment); a minute without a byte is a stream that is gone. */
const DEAD_MS = 60_000;
const BACKOFF = [2_000, 4_000, 8_000, 16_000, 30_000];

interface LiveOptions {
  /** The App the page is on now. */
  connection: () => string | null | undefined;
  /** A tenant host served the page (who-am-I said `tenant: true`): every stream it opens names a tenant. */
  tenant?: boolean;
}

interface Session {
  readonly identity: object;
  readonly generation: number;
  readonly connection: string | null | undefined;
  readonly tenant: string | undefined;
  cursor: string | undefined;
  stopped: boolean;
  controller?: AbortController;
  /** Wake a loop that is waiting for the tab, the lease or the backoff. */
  wake?: () => void;
}
type Cause = 'hidden' | 'dead' | 'lease' | 'stop';

let session: Session | undefined;
let options: LiveOptions | undefined;
let stopWatching: (() => void) | undefined;
let batch: LiveBatch | undefined;
let mergeTimer: ReturnType<typeof setTimeout> | undefined;
let hiddenTimer: ReturnType<typeof setTimeout> | undefined;
let unsubscribe: Array<() => void> = [];

/* Whether the page is a tenant's is the host's, not the snapshot's: a locked session, or one the who-am-I check has
   just replaced, carries no `tenantRequired` until a tenant is chosen again. Read off the snapshot alone, a restart in
   that moment opened `/api/live` naming no tenant, which a tenant host can only refuse (400). '' is a tenant not known
   yet: the loop waits for its lease rather than asking without one. */
const tenantOf = (): string | undefined => {
  const snapshot = captureSessionIdentity();
  return snapshot.tenantRequired || options?.tenant ? (captureTenantLease(snapshot)?.tenantId ?? '') : undefined;
};
/* A locked session (signed out, another account, a denied context) has no stream to open: the server could only
   refuse it, and the identity that replaces it starts another (onIdentity). */
const locked = (): boolean => captureSessionIdentity().mode === 'locked';

/** Start following changes, or follow the App the page is on now when it moved. Idempotent. */
export function startLiveSync(next: LiveOptions): void {
  options = next;
  const connection = next.connection();
  const identity = captureSessionIdentity();
  if (
    session &&
    !session.stopped &&
    session.identity === identity &&
    session.connection === connection &&
    session.generation === connectionGeneration()
  )
    return;
  stopLiveSync();
  options = next;
  const current: Session = {
    identity,
    generation: connectionGeneration(),
    connection,
    tenant: tenantOf(),
    cursor: undefined,
    stopped: false,
  };
  session = current;
  stopWatching = watchEngagement();
  addHostListener(document, 'visibilitychange', onVisibility);
  unsubscribe = [subscribeSessionIdentity(onIdentity), subscribeTenantLease(onLease)];
  void follow(current);
}

/** Stop, forgetting the cursor and everything the page was told. */
export function stopLiveSync(): void {
  const ending = session;
  session = undefined;
  if (ending) {
    ending.stopped = true;
    ending.controller?.abort('stop' satisfies Cause);
    ending.wake?.();
  }
  clearTimeout(mergeTimer);
  clearTimeout(hiddenTimer);
  mergeTimer = hiddenTimer = undefined;
  batch = undefined;
  removeHostListener(document, 'visibilitychange', onVisibility);
  for (const stop of unsubscribe) stop();
  unsubscribe = [];
  stopWatching?.();
  stopWatching = undefined;
  setLiveActive(false);
  resetLiveState();
  forgetLive();
  forgetOwnWrites();
}

/* ---------- what moves the stream ---------- */

function onVisibility(): void {
  clearTimeout(hiddenTimer);
  if (document.hidden) hiddenTimer = setTimeout(() => session?.controller?.abort('hidden' satisfies Cause), HIDDEN_MS);
  else session?.wake?.();
}

/* Another account or tenant is another stream; the page starts it again when it has an App to show. */
function restart(): void {
  const again = options;
  stopLiveSync();
  if (again) queueMicrotask(() => startLiveSync(again));
}
function onIdentity(): void {
  if (session && session.identity !== captureSessionIdentity()) restart();
}

/* A renewed lease is the same tenant on a new revision: the stream the old one opened ends within 30 s, so reconnect now. */
function onLease(): void {
  if (!session) return;
  if (session.tenant !== undefined && tenantOf() !== session.tenant) return restart();
  session.controller?.abort('lease' satisfies Cause);
  session.wake?.();
}

/* ---------- the loop ---------- */

/** Wait `ms`, or until the session is woken or stopped. */
function pause(current: Session, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      current.wake = undefined;
      resolve();
    };
    const timer = setTimeout(done, ms);
    current.wake = done;
  });
}
/** Wait until woken (the tab shown, a lease adopted) or stopped. */
function untilWoken(current: Session): Promise<void> {
  return new Promise((resolve) => {
    current.wake = () => {
      current.wake = undefined;
      resolve();
    };
  });
}

function open(current: Session, signal: AbortSignal): Promise<Response> {
  if (current.tenant !== undefined)
    return import('./tenantLive.js').then(({ tenantLiveRequest }) => tenantLiveRequest(current.cursor, signal));
  const { url } = scopeApiRequest(
    `/api/live${current.cursor ? `?after=${encodeURIComponent(current.cursor)}` : ''}`,
    undefined,
    current.connection,
  );
  const account = captureSessionIdentity();
  return fetchServer(url, {
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
    headers: account.mode === 'authenticated' ? { 'x-mistri-account': account.accountId! } : {},
  });
}

async function follow(current: Session): Promise<void> {
  let failures = 0;
  while (!current.stopped) {
    if (document.hidden || locked()) {
      await untilWoken(current);
      continue;
    }
    const controller = new AbortController();
    current.controller = controller;
    let dead: ReturnType<typeof setTimeout> | undefined;
    const alive = () => {
      clearTimeout(dead);
      dead = setTimeout(() => controller.abort('dead' satisfies Cause), DEAD_MS);
    };
    let ended: string | undefined;
    try {
      let response: Response;
      try {
        response = await open(current, controller.signal);
      } catch (error) {
        if (current.stopped || controller.signal.aborted) throw error;
        // No lease yet (a tenant picking one) is not a failure: wait for it.
        if (current.tenant !== undefined && !captureTenantLease()) {
          await untilWoken(current);
          continue;
        }
        throw error;
      }
      if (response.status === 204 || response.status === 404) {
        // Off for this page load (204: --no-live, no store; 404: a realm with none); nothing else about the page changes.
        void response.body?.cancel();
        current.stopped = true;
        return void setLiveActive(false);
      }
      if (response.status === 503) {
        void response.body?.cancel();
        await pause(current, Math.max(1, Number(response.headers.get('retry-after')) || 30) * 1000);
        continue;
      }
      if (response.status === 400 || response.status === 401 || response.status === 403) {
        // Until the session or the lease changes.
        void response.body?.cancel();
        await untilWoken(current);
        continue;
      }
      if (!response.ok || !response.body) throw new Error(`live-${response.status}`);
      alive();
      const watched = response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, out) {
            alive();
            out.enqueue(chunk);
          },
        }),
      );
      await readEvents(watched, ({ event, data }) => {
        if (current.stopped) return;
        if (event === 'hello') {
          failures = 0;
          current.cursor ??= typeof data.cursor === 'string' ? data.cursor : undefined;
          setLiveOff(Array.isArray(data.off) ? data.off.filter((table: unknown): table is string => typeof table === 'string') : []);
          setLiveActive(true);
        } else if (event === 'change' || event === 'reset') {
          if (typeof data.cursor === 'string') current.cursor = data.cursor;
          queue(event === 'reset', data);
        } else if (event === 'end') ended = typeof data.reason === 'string' ? data.reason : 'stopping';
      });
    } catch {
      const cause = controller.signal.reason as Cause | undefined;
      if (current.stopped) return;
      // A tab put away, a lease renewed, a silent stream: reconnect without counting it a failure.
      if (cause === 'hidden' || cause === 'lease' || cause === 'dead') {
        clearTimeout(dead);
        continue;
      }
      clearTimeout(dead);
      await pause(current, BACKOFF[Math.min(failures++, BACKOFF.length - 1)]);
      continue;
    }
    clearTimeout(dead);
    if (current.stopped) return;
    // The server's ten minutes are normal: straight back. Anything else waits, so a server going down is not asked at once.
    if (ended !== 'lifetime') await pause(current, BACKOFF[Math.min(failures++, BACKOFF.length - 1)]);
  }
}

/* ---------- what is told ---------- */

function queue(reset: boolean, data: Record<string, unknown>): void {
  batch ??= emptyBatch();
  if (reset) {
    batch.reset = true;
    batch.events++;
  } else addChange(batch, data as Parameters<typeof addChange>[1]);
  mergeTimer ??= setTimeout(flush, MERGE_MS);
}

function flush(): void {
  mergeTimer = undefined;
  const told = batch;
  batch = undefined;
  if (!told || !session || session.stopped) return;
  /* The reader's own write may be this change: it waits for that write's answer, so the write's refresh and its echo
     agree on which reads are fresh (ownWrites.ts). */
  if (!told.self || !ownWritesOut()) return invalidateLive(told);
  const current = session;
  void ownWritesAnswered().then(() => {
    if (session === current && !current.stopped) invalidateLive(told);
  });
}
