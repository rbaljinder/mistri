/** Private restart-only lifetime owner. The serving composition supplies its
 * original AppHost, and retires this owner before reload or auth/Registry close.
 * Acquiring a reader is lazy; construction never provisions token storage. */
import type { Registry } from '@mistriwork/engine/server/connections.js';
import type { AppHost } from '../app/apps.js';
import { createSqliteApiReadOwner } from './sqliteApiReadOwner.js';
import { ApiReadFailure } from './apiReadFailure.js';
import type { BusinessCommandRegistry } from '../commands/businessCommands.js';
import { throwIfCancelled, withoutCancellation } from '@mistriwork/engine/adapters/statementControl.js';

type Reader = Awaited<ReturnType<typeof createSqliteApiReadOwner>>;
const refuse = (): never => {
  throw new Error('The API item host is unavailable.');
};

export function createSqliteApiReadHost(
  registry: Registry,
  host: AppHost,
  integers: 'decimal-string' | 'number',
  commands?: BusinessCommandRegistry,
) {
  let retired = false;
  let reader: Reader | undefined;
  let acquisition: Promise<Reader> | undefined;
  const pending = new Set<Promise<unknown>>();
  const acquire = () => {
    if (retired) return refuse();
    // Register before acquisition can yield/reenter. A failed acquisition is
    // not retried against a possibly different deployment in this lifetime.
    acquisition ??= withoutCancellation(() =>
      Promise.resolve().then(async () => {
        if (retired) return refuse();
        const opened = await createSqliteApiReadOwner(registry, host, integers, commands);
        if (retired) {
          await opened.retire();
          return refuse();
        }
        reader = opened;
        return opened;
      }),
    );
    return acquisition;
  };
  const read = (
    credential: unknown,
    operationId: string,
    input: { key: string } | { query: string } | { spec: true } | { events: string } | { asyncapi: true },
    signal?: AbortSignal,
  ) => {
    const work = Promise.resolve().then(async () => {
      try {
        if (signal) throwIfCancelled(signal);
        // Do not run the shared factory in request cancellation context.
        const active = await acquire();
        if (retired) return refuse();
        if (signal) throwIfCancelled(signal);
        const result =
          'spec' in input
            ? await active.readSpec(credential, signal)
            : 'events' in input
              ? await active.readEvents(credential, input.events, signal)
              : 'asyncapi' in input
                ? await active.readAsyncApi(credential, signal)
                : 'key' in input
                  ? await active.readItem(credential, operationId, input.key, signal)
                  : await active.readList(credential, operationId, input.query, signal);
        if (signal?.aborted) {
          active.discardResult(result);
          return refuse();
        }
        if (retired) return refuse();
        return result;
      } catch (error) {
        if (error instanceof ApiReadFailure) throw error;
        return refuse();
      }
    });
    pending.add(work);
    void work.then(
      () => pending.delete(work),
      () => pending.delete(work),
    );
    return work;
  };
  return Object.freeze({
    /** Validate the same owner that will serve requests, not a throwaway
     * readiness reader with a different adapter/auth lifetime. */
    prepare: async (): Promise<void> => {
      await acquire();
      if (retired) return refuse();
    },
    /** The one owner, for the App MCP beside these reads: never a second one. */
    owner: async (): Promise<Reader> => {
      const active = await acquire();
      if (retired) return refuse();
      return active;
    },
    readItem: (credential: unknown, operationId: string, key: string, signal?: AbortSignal) =>
      read(credential, operationId, { key }, signal),
    readList: (credential: unknown, operationId: string, query: string, signal?: AbortSignal) =>
      read(credential, operationId, { query }, signal),
    readSpec: (credential: unknown, signal?: AbortSignal) => read(credential, '$openapi', { spec: true }, signal),
    readEvents: (credential: unknown, query: string, signal?: AbortSignal) => read(credential, '$events', { events: query }, signal),
    readAsyncApi: (credential: unknown, signal?: AbortSignal) => read(credential, '$asyncapi', { asyncapi: true }, signal),
    /** Consume synchronously adjacent to the transport's response handoff. */
    consumeResult: (handle: unknown) => {
      if (retired || !reader) return refuse();
      return reader.consumeResult(handle);
    },
    discardResult: (handle: unknown) => {
      reader?.discardResult(handle);
    },
    retire: async () => {
      retired = true;
      await reader?.retire();
      // A factory resolving after retirement retires its own new reader.
      await Promise.allSettled([...(acquisition ? [acquisition] : []), ...pending]);
    },
  });
}
