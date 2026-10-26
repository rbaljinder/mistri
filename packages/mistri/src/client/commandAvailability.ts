/** Batched, surface-owned command visibility; never execution authority. */
import { useEffect, useId, useMemo, useSyncExternalStore } from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { api, state } from '@mistriwork/kit/client/core.js';
import { appRequestScope, ownedBy } from '@mistriwork/kit/client/requestIdentity.js';
import { recordKey } from '@mistriwork/kit/client/resourceRequests.js';
import { commandKeyText } from '../shared/command.js';
import { composeUnderway, composedCheck } from '@mistriwork/kit/client/composedReads.js';
import {
  captureTenantLease,
  sessionIdentity,
  subscribeSessionIdentity,
  subscribeTenantLease,
  tenantLeaseActive,
} from '@mistriwork/kit/client/sessionIdentity.js';

interface Check {
  command: string;
  commandVersion: number;
  key: Record<string, unknown>;
}
type Identity = ReturnType<typeof sessionIdentity>;
interface Pending {
  check: Check;
  identity: Identity;
  connection: string | null;
  scope: ReturnType<typeof appRequestScope>;
  lease: ReturnType<typeof captureTenantLease>;
  resolve: (value: boolean) => void;
}
let pending: Pending[] = [];
let nextSurface = 0;
const current = (identity: Identity, connection: string | null) =>
  identity === sessionIdentity() &&
  identity.mode === 'authenticated' &&
  identity.appId === connection &&
  (state.activeConnection ?? null) === connection &&
  (!identity.tenantRequired || tenantLeaseActive(identity));
const pendingCurrent = (item: Pending) =>
  current(item.identity, item.connection) && item.scope === appRequestScope() && item.lease === captureTenantLease(item.identity);

/** Fresh reads only: pending callers share one microtask batch, never a result cache. */
export function commandAvailable(check: Check): Promise<boolean> {
  const identity = sessionIdentity(),
    connection = state.activeConnection ?? null;
  if (!current(identity, connection)) return Promise.resolve(false);
  let captured: Check;
  try {
    captured = { command: check.command, commandVersion: check.commandVersion, key: recordKey(check.key) };
  } catch {
    return Promise.resolve(false);
  }
  /* A record page's compose asked its verbs already (composedReads.ts). One still on its way is waited for: a
     record refreshed after a command asks its verbs in the same moment it composes, and asked beside the compose
     they went out on their own (G173). */
  const underway = composeUnderway(connection);
  if (underway) return underway.then(() => commandAvailable(check));
  const composed = composedCheck(connection, captured.command, captured.commandVersion, captured.key);
  if (composed !== undefined) return Promise.resolve(composed);
  return new Promise((resolve) => {
    if (!pending.length) queueMicrotask(flush);
    pending.push({ check: captured, identity, connection, scope: appRequestScope(), lease: captureTenantLease(identity), resolve });
  });
}

function flush() {
  const work = pending;
  pending = [];
  while (work.length) {
    const first = work.shift()!;
    if (!pendingCurrent(first)) {
      first.resolve(false);
      continue;
    }
    const batch = [first];
    for (let i = 0; i < work.length;) {
      if (
        work[i].identity === first.identity &&
        work[i].connection === first.connection &&
        work[i].scope === first.scope &&
        work[i].lease === first.lease
      )
        batch.push(...work.splice(i, 1));
      else i++;
    }
    while (batch.length) {
      const groups: Array<{ command: string; commandVersion: number; keys: Record<string, unknown>[]; callers: Pending[][] }> = [];
      let keys = 0;
      for (let i = 0; i < batch.length;) {
        const item = batch[i],
          existing = groups.find((group) => group.command === item.check.command);
        if ((existing && existing.commandVersion !== item.check.commandVersion) || (!existing && groups.length >= 16)) {
          i++;
          continue;
        }
        const index = existing?.keys.findIndex((key) => commandKeyText(key) === commandKeyText(item.check.key)) ?? -1;
        if (index < 0 && keys >= 200) {
          i++;
          continue;
        }
        const group = existing ?? { command: item.check.command, commandVersion: item.check.commandVersion, keys: [], callers: [] };
        if (!existing) groups.push(group);
        if (index >= 0) group.callers[index].push(item);
        else {
          group.keys.push(item.check.key);
          group.callers.push([item]);
          keys++;
        }
        batch.splice(i, 1);
      }
      const checks = groups.map(({ command, commandVersion, keys }) => ({ command, commandVersion, keys }));
      /** One request, and its answers only if the reply is exactly about it. */
      const ask = async (asked: typeof checks): Promise<boolean[][] | undefined> => {
        try {
          if (!pendingCurrent(first)) return undefined;
          const reply: unknown = await api('/api/commands/availability', { ...ownedBy(first.connection), checks: asked });
          if (
            !pendingCurrent(first) ||
            !reply ||
            typeof reply !== 'object' ||
            Array.isArray(reply) ||
            Object.keys(reply).length !== 1 ||
            !('checks' in reply) ||
            !Array.isArray(reply.checks) ||
            reply.checks.length !== asked.length
          )
            return undefined;
          const results = reply.checks;
          if (
            Array.from(results).some(
              (result, i) =>
                !result ||
                typeof result !== 'object' ||
                Array.isArray(result) ||
                Object.keys(result).sort().join(',') !== 'available,command,commandVersion' ||
                result.command !== asked[i].command ||
                result.commandVersion !== asked[i].commandVersion ||
                !Array.isArray(result.available) ||
                result.available.length !== asked[i].keys.length ||
                result.available.some((value: unknown) => typeof value !== 'boolean'),
            )
          )
            return undefined;
          return results.map((result) => result.available as boolean[]);
        } catch {
          return undefined; /* Visibility is false on any transport or protocol failure. */
        }
      };
      void (async () => {
        let available: boolean[][] | undefined;
        try {
          available = await ask(checks);
          /* One verb whose visibility cannot be answered must hide itself and
             nothing else. A refusal answers the whole request, so a record
             offering several commands lost its entire action bar to one of
             them — ask the rest again, a command at a time. Only after a
             failure, so an ordinary bar is still one request. */
          if (!available && checks.length > 1) {
            const answers = await Promise.all(checks.map(async (check) => ask([check])));
            available = answers.map((answer, i) => answer?.[0] ?? checks[i].keys.map(() => false));
          }
        } finally {
          groups.forEach((group, i) =>
            group.callers.forEach((callers, k) => callers.forEach((caller) => caller.resolve(available?.[i][k] === true))),
          );
        }
      })();
    }
  }
}

/** Hide while pending/refetching. Instance-owned queries retire with their
 * record surface; invalidating data after any write also invalidates visibility. */
export function useCommandAvailability(checks: Check[], enabled = true, surface?: object): boolean[] {
  return useCommandAnswers(checks, enabled, surface).available;
}

/** The same, and whether any is still being asked: a bar holds a verb's place until it knows. */
export function useCommandAnswers(checks: Check[], enabled = true, surface?: object): { available: boolean[]; asking: boolean } {
  const identity = useSyncExternalStore(subscribeSessionIdentity, sessionIdentity, sessionIdentity);
  const leaseSnapshot = () => {
    const lease = captureTenantLease(identity);
    return `${lease?.revision}:${lease?.expiresAt}:${!identity.tenantRequired || tenantLeaseActive(identity)}`;
  };
  useSyncExternalStore(subscribeTenantLease, leaseSnapshot, leaseSnapshot);
  const lease = captureTenantLease(identity);
  const client = useQueryClient(),
    instance = useId();
  const surfaceKey = useMemo(() => ++nextSurface, [surface]);
  useEffect(() => {
    if (!lease) return;
    const timer = setTimeout(
      () => {
        tenantLeaseActive(identity);
      },
      Math.max(0, lease.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [identity, lease]);
  const checking = checks.length > 0;
  useEffect(() => {
    if (!checking) return;
    let mounted = true,
      queued = false;
    const unsubscribe = client.getQueryCache().subscribe((event) => {
      if (
        event.type !== 'updated' ||
        event.action.type !== 'invalidate' ||
        !['run', 'count', 'when'].includes(String(event.query.queryKey[0])) ||
        queued
      )
        return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        // A broad invalidation already marks these queries itself. Do not
        // cancel/restart its in-flight refetch in this coalesced follow-up.
        if (mounted) {
          const targets = new Set(
            client
              .getQueryCache()
              .findAll({ queryKey: ['command-availability', instance] })
              .filter((query) => !query.state.isInvalidated)
              .map((query) => query.queryHash),
          );
          void client.invalidateQueries({ predicate: (query) => targets.has(query.queryHash) });
        }
      });
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [client, instance, checking]);
  const active = enabled && current(identity, state.activeConnection ?? null);
  const results = useQueries({
    queries: checks.map((check) => ({
      queryKey: [
        'command-availability',
        instance,
        surfaceKey,
        identity.epoch,
        state.activeConnection,
        lease?.revision,
        active,
        check.command,
        check.commandVersion,
        check.key,
      ],
      queryFn: () => commandAvailable(check),
      enabled: active,
      retry: false,
      staleTime: 0,
      gcTime: 0,
    })),
  });
  return {
    available: results.map((result) => active && !result.isFetching && result.data === true),
    asking: active && results.some((result) => result.isFetching),
  };
}
