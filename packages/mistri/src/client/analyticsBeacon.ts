/**
 * Behavior events from the page, batched and sent to the App's one beacon
 * route. Nothing here identifies anyone: the server takes the unit from the
 * session or the visitor cookie, so a body carries only a kind, a declared
 * name, the declared fields and how long ago it happened. A failure is
 * dropped, never retried or stored: this is telemetry, not a record.
 */
import { ANALYTICS_BEACON_PATH } from '../shared/appAnalytics.js';
import { addHostListener } from '@mistriwork/kit/client/shellHost.js';
import { fetchServer } from '@mistriwork/kit/client/transport.js';

type AnalyticsFields = Readonly<Record<string, string | number | boolean>>;
interface Queued {
  readonly kind: 'event' | 'view' | 'form';
  readonly name: string;
  readonly at: number;
  readonly fields?: AnalyticsFields;
  readonly step?: string;
  readonly route?: string;
}

const BATCH = 20,
  DELAY_MS = 1500;

export function createAnalyticsBeacon(options: {
  readonly send: (body: string) => void;
  readonly now?: () => number;
  readonly delayMs?: number;
}) {
  const now = options.now ?? Date.now,
    delay = options.delayMs ?? DELAY_MS;
  let queue: Queued[] = [],
    timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (!queue.length) return;
    const at = now(),
      events = queue.map(({ at: when, ...rest }) => ({ ...rest, age: Math.max(0, at - when) }));
    queue = [];
    try {
      options.send(JSON.stringify({ events }));
    } catch {
      /* telemetry is never a reason to fail a page */
    }
  };
  const add = (event: Omit<Queued, 'at'>) => {
    queue.push({ ...event, at: now() });
    if (queue.length >= BATCH) flush();
    else timer ??= setTimeout(flush, delay);
  };
  return Object.freeze({
    /** A component's own event: the name and fields the App declared (the server drops the rest). */
    emit(name: string, fields?: AnalyticsFields) {
      if (typeof name !== 'string' || !name || name.length > 128) throw new Error('An analytics event is named with its declared name.');
      add({ kind: 'event', name, ...(fields ? { fields: { ...fields } } : {}) });
    },
    view(name: string, route?: string) {
      add({ kind: 'view', name, ...(route ? { route } : {}) });
    },
    form(name: string, step?: string) {
      add({ kind: 'form', name, ...(step ? { step } : {}) });
    },
    flush,
  });
}

/** The page's beacon: a keepalive POST to this App's route, so a closing tab still sends. */
export function pageAnalyticsBeacon() {
  const beacon = createAnalyticsBeacon({
    send: (body) => {
      void fetchServer(ANALYTICS_BEACON_PATH, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        keepalive: true,
        headers: { 'content-type': 'application/json' },
        body,
      }).catch(() => {});
    },
  });
  if (typeof document !== 'undefined')
    addHostListener(document, 'visibilitychange', () => {
      if (document.visibilityState === 'hidden') beacon.flush();
    });
  return beacon;
}
