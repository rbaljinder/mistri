/** Called once, on first SDK flags use. Nothing is hydrated from HTML/storage. */
import {
  APP_FLAG_VALUES_PATH,
  EXPERIMENT_VISITOR_PATH,
  EXPERIMENT_FORM_HEADER,
  EXPERIMENT_ADDRESS_HEADER,
  type ExperimentVisitorSelection,
  captureAppFlagValues,
  type AppFlagReader,
  type AppFlagValues,
} from '../shared/appFlagValues.js';
import {
  assertSessionCurrent,
  captureTenantLease,
  sessionIdentity,
  subscribeSessionIdentity,
  subscribeTenantLease,
  tenantLeaseActive,
} from '@mistriwork/kit/client/sessionIdentity.js';
import { appPresentation, subscribeAppPresentation } from '@mistriwork/kit/client/connectionTransition.js';
import type { createExperimentExposureQueue, ExposureCoverage } from './experimentExposure.js';
import { say } from './copy/shell/appFlags.js';
import { fetchServer } from '@mistriwork/kit/client/transport.js';

const emptyExposureCoverage = (): ExposureCoverage => ({
  queued: 0,
  inFlight: 0,
  recorded: 0,
  duplicate: 0,
  failed: 0,
  unknown: 0,
  dropped: 0,
});
type ExposureSender = Parameters<typeof createExperimentExposureQueue>[0];

export interface AppFlagsSource extends AppFlagReader {
  snapshot(): AppFlagReader;
  subscribe(listener: () => void): () => void;
  load(): Promise<void>;
  /** Explicit browser actual-use lifecycle port. get/snapshot/load are passive;
   * only a committed render (or an explicit consumed feature) calls this. */
  commitUse?(reader: AppFlagReader, keys: readonly string[]): void;
  exposureCoverage?(): ExposureCoverage;
  /** Explicit user action only. Never called by flag reads or rendering. */
  establishVisitor?(selection?: ExperimentVisitorSelection): Promise<void>;
}

export function createPageAppFlags(active: () => string | null) {
  let disposed = false;
  let visitorSelection: ExperimentVisitorSelection = Object.freeze({});
  const visitorHeaders = () => ({
    ...(visitorSelection.form ? { [EXPERIMENT_FORM_HEADER]: visitorSelection.form } : {}),
    ...(visitorSelection.address ? { [EXPERIMENT_ADDRESS_HEADER]: visitorSelection.address } : {}),
  });
  const source = createAppFlagsState({
    async exposure(owner, signal) {
      // Capture native ownership before loading optional experiment delivery.
      const identity = sessionIdentity(),
        lease = captureTenantLease(identity);
      if (identity.mode !== 'authenticated' && identity.mode !== 'anonymous') return;
      const { captureExperimentExposureSender } = await import('./experimentExposure.js');
      if (signal.aborted || !owner.current() || identity !== sessionIdentity() || lease !== captureTenantLease(identity)) return;
      return captureExperimentExposureSender(owner, { visitor: identity.mode === 'anonymous', selection: visitorSelection });
    },
    capture() {
      const appId = active(),
        identity = sessionIdentity(),
        presentation = appPresentation(),
        selection = visitorSelection;
      if (disposed || !appId || !presentation.available || identity.appId !== appId) throw new Error(say('ownerUnavailable'));
      assertSessionCurrent(identity);
      return {
        appId,
        current: () =>
          !disposed &&
          visitorSelection === selection &&
          active() === appId &&
          identity === sessionIdentity() &&
          presentation.generation === appPresentation().generation &&
          appPresentation().available &&
          (!identity.tenantRequired || tenantLeaseActive(identity)),
      };
    },
    async read(owner, signal) {
      const identity = sessionIdentity();
      if (!owner.current()) throw new Error(say('requestOwnerRetired'));
      const path = `${APP_FLAG_VALUES_PATH}?${new URLSearchParams({ app: owner.appId })}`;
      if (identity.tenantRequired) {
        const { tenantReadApi } = await import('./tenantTransport.js');
        if (!owner.current() || signal.aborted) throw new Error(say('requestOwnerRetired'));
        return tenantReadApi(path, undefined, owner.appId, signal);
      }
      const response = await fetchServer(path, {
        signal,
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: identity.mode === 'authenticated' ? { 'x-mistri-account': identity.accountId! } : visitorHeaders(),
      });
      if (!owner.current() || signal.aborted) throw new Error(say('requestOwnerRetired'));
      try {
        assertSessionCurrent(identity, response.headers.get('x-mistri-account'));
        if (
          (identity.mode === 'anonymous' && response.headers.get('x-mistri-account')) ||
          response.status === 401 ||
          response.headers.get('x-mistri-app') !== owner.appId
        )
          throw new Error(say('responseOwnerChanged'));
      } catch (error) {
        const { invalidateSession } = await import('@mistriwork/kit/client/sessionLifecycle.js');
        if (owner.current()) invalidateSession('account-changed');
        throw error;
      }
      if (!response.ok) throw new Error(say('valuesUnavailable'));
      const text = await response.text();
      if (text.length > 1024 * 1024) throw new Error(say('responseTooLarge'));
      return JSON.parse(text) as unknown;
    },
  });
  const unsubscribe = [
    subscribeSessionIdentity(source.retire),
    subscribeTenantLease(source.retire),
    subscribeAppPresentation(source.retire),
  ];
  return Object.freeze({
    ...source,
    get ready() {
      return source.ready;
    },
    async establishVisitor(selection: ExperimentVisitorSelection = {}) {
      if (
        Object.keys(selection).some((key) => !['form', 'address'].includes(key)) ||
        (selection.form !== undefined && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(selection.form)) ||
        (selection.address !== undefined &&
          (!selection.form ||
            typeof selection.address !== 'string' ||
            selection.address.length > 512 ||
            /[\p{Cc}\p{Cs}]/u.test(selection.address)))
      )
        throw new Error(say('visitorUnavailable'));
      const selected = Object.freeze({ ...selection });
      visitorSelection = selected;
      source.retire();
      const identity = sessionIdentity(),
        appId = active(),
        presentation = appPresentation();
      if (disposed || !appId || identity.appId !== appId || identity.mode !== 'anonymous' || !presentation.available)
        throw new Error(say('visitorUnavailable'));
      const current = () =>
        !disposed &&
        visitorSelection === selected &&
        active() === appId &&
        identity === sessionIdentity() &&
        presentation.generation === appPresentation().generation &&
        appPresentation().available;
      const response = await fetchServer(EXPERIMENT_VISITOR_PATH, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json', 'x-mistri-visitor': 'establish', ...visitorHeaders() },
        body: '{}',
        signal: AbortSignal.timeout(10000),
      });
      if (!current() || !response.ok || response.headers.get('x-mistri-app') !== appId || response.headers.has('x-mistri-account'))
        throw new Error(say('visitorUnavailable'));
      const text = await response.text();
      if (!current() || text.length > 128) throw new Error(say('visitorUnavailable'));
      const reply = JSON.parse(text) as unknown;
      if (!reply || typeof reply !== 'object' || Object.keys(reply).length !== 1 || (reply as { ready?: unknown }).ready !== true)
        throw new Error(say('visitorUnavailable'));
      source.retire();
      await source.load();
    },
    dispose() {
      disposed = true;
      for (const stop of unsubscribe) stop();
      source.retire();
    },
  });
}
interface AppFlagsOwner {
  readonly appId: string;
  current(): boolean;
}

/** SDK-only state. The host supplies ordinary transport and synchronous owner
 * retirement. No persistence, SSR adoption or client targeting. Imperative get
 * is passive; reporting requires the explicit commitUse lifecycle port. */
export function createAppFlagsState(port: {
  capture(): AppFlagsOwner;
  read(owner: AppFlagsOwner, signal: AbortSignal): Promise<unknown>;
  exposure?(owner: AppFlagsOwner, signal: AbortSignal): ExposureSender | undefined | Promise<ExposureSender | undefined>;
}) {
  const listeners = new Set<() => void>();
  let generation = 0,
    controller: AbortController | undefined,
    pending: Promise<void> | undefined;
  let attempted = false;
  let exposures: ReturnType<typeof createExperimentExposureQueue> | undefined;
  let assignmentReceipts: AppFlagValues['assignmentReceipts'];
  let retiredCoverage = emptyExposureCoverage();
  const unavailable = () => new Error(say('valuesNotReady'));
  const reader = (data?: AppFlagValues, owner?: AppFlagsOwner, failure?: unknown): AppFlagReader => {
    const captured = generation,
      values = data?.values;
    const current = () => captured === generation && !!owner?.current();
    return Object.freeze({
      get ready() {
        return !!values && current();
      },
      get(key: string) {
        if (!values || !current()) throw failure instanceof Error ? failure : unavailable();
        if (!Object.hasOwn(values, key)) throw new Error(say('undeclaredFlag', { key }));
        return values[key];
      },
    });
  };
  let snapshot = reader();
  const notify = () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        /* Observers cannot veto retirement. */
      }
    }
  };
  const retire = () => {
    ++generation;
    assignmentReceipts = undefined;
    if (exposures) {
      exposures.retire();
      const ended = exposures.coverage();
      retiredCoverage = Object.fromEntries(
        Object.entries(retiredCoverage).map(([key, value]) => [key, value + ended[key as keyof ExposureCoverage]]),
      ) as unknown as ExposureCoverage;
      exposures = undefined;
    }
    controller?.abort();
    controller = undefined;
    pending = undefined;
    attempted = false;
    snapshot = reader();
    notify();
  };
  return Object.freeze({
    get ready() {
      return snapshot.ready;
    },
    get: (key: string) => snapshot.get(key),
    snapshot: () => snapshot,
    commitUse(reader: AppFlagReader, keys: readonly string[]) {
      if (reader !== snapshot || !reader.ready) return;
      for (const key of keys) {
        const receipt = assignmentReceipts && Object.hasOwn(assignmentReceipts, key) ? assignmentReceipts[key] : undefined;
        if (receipt) exposures?.consume(receipt);
      }
    },
    exposureCoverage(): ExposureCoverage {
      const active = exposures?.coverage() ?? emptyExposureCoverage();
      return Object.freeze(
        Object.fromEntries(Object.entries(retiredCoverage).map(([key, value]) => [key, value + active[key as keyof ExposureCoverage]])),
      ) as unknown as ExposureCoverage;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    retire,
    load(): Promise<void> {
      if (pending) return pending;
      if (attempted) return Promise.resolve();
      attempted = true;
      const started = generation,
        abort = (controller = new AbortController());
      pending = (async () => {
        let owner: AppFlagsOwner | undefined;
        try {
          owner = port.capture();
          if (!owner.current()) throw unavailable();
          const raw = await port.read(owner, abort.signal);
          if (started !== generation || abort.signal.aborted || !owner.current()) return;
          const data = captureAppFlagValues(raw);
          if (started !== generation || abort.signal.aborted || !owner.current()) return;
          if (port.exposure && data.assignmentReceipts && Object.keys(data.assignmentReceipts).length) {
            const sender = await port.exposure(owner, abort.signal);
            if (started !== generation || abort.signal.aborted || !owner.current()) return;
            if (sender) {
              const { createExperimentExposureQueue } = await import('./experimentExposure.js');
              if (started !== generation || abort.signal.aborted || !owner.current()) return;
              assignmentReceipts = data.assignmentReceipts;
              exposures = createExperimentExposureQueue(sender);
            }
          }
          snapshot = reader(data, owner);
          notify();
        } catch (error) {
          if (started !== generation || abort.signal.aborted || (owner && !owner.current())) return;
          snapshot = reader(undefined, undefined, error);
          notify();
        } finally {
          if (started === generation) pending = undefined;
        }
      })();
      return pending;
    },
  });
}
