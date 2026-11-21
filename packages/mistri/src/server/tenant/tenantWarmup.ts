/**
 * Every tenant opened once after a start, and `/readyz` held until each has settled.
 *
 * On a hosted Postgres the first request to each tenant pays a connection and
 * the first reads of its anchors, so a load balancer told "ready" at listen
 * sent traffic into that cost (a field report). The opens are started at boot,
 * a few at a time, and readiness waits for each to succeed or fail. A tenant
 * that failed is named in the body (its key only: no error, nothing a probe
 * should expose) and logged, but does not hold readiness for good: it was tried,
 * and an orchestrator that waits on it forever would replace a healthy server
 * for one tenant's database trouble.
 *
 * The open is the reader's own first read of a tenant (its anchors), which
 * admits nobody and writes nothing.
 */
import type { ReadyAnswer } from '@mistriwork/engine/server/http/probes.js';

/** How many tenants open at once: enough to overlap round trips, few enough not to drain the pool a first request needs. */
const CONCURRENCY = 4;

interface WarmupReader {
  readActiveTenants(): Promise<readonly { readonly id: string }[]>;
  readServiceAnchors(tenantId: string | null): Promise<unknown>;
}

interface TenantWarmup {
  /** The `/readyz` answer: false-with-progress while opening, then true, with `failed` when any open failed. */
  answer(): ReadyAnswer;
  /** Settles once every tenant has opened or failed; never rejects. */
  readonly settled: Promise<void>;
  /** Stops starting opens (the server is retiring). */
  stop(): void;
}

export function startTenantWarmup(
  reader: WarmupReader,
  options: { readonly concurrency?: number; readonly log?: (line: string) => void } = {},
): TenantWarmup {
  const log = options.log ?? ((line: string) => console.error(line));
  const failed: string[] = [];
  let total = 0;
  let opened = 0;
  let done = false;
  let stopped = false;
  const settled = (async () => {
    let ids: string[];
    try {
      ids = (await reader.readActiveTenants()).map((tenant) => tenant.id);
    } catch {
      // Not knowing the tenants is not a reason to refuse traffic for ever: each opens on its first request, as before.
      log('mistri: the tenants could not be listed to open at start; each opens on its first request.');
      return;
    }
    total = ids.length;
    let next = 0;
    const worker = async () => {
      while (!stopped && next < ids.length) {
        const id = ids[next++];
        try {
          await reader.readServiceAnchors(id);
        } catch {
          failed.push(id);
          log(`mistri: tenant ${id} did not open at start; it is tried again on its first request.`);
        }
        opened++;
      }
    };
    await Promise.all(Array.from({ length: Math.min(options.concurrency ?? CONCURRENCY, ids.length) }, worker));
  })().finally(() => {
    done = true;
  });
  return {
    settled,
    stop: () => {
      stopped = true;
      done = true;
    },
    answer: () =>
      done
        ? { ok: true, ...(failed.length ? { body: { failed: [...failed] } } : {}) }
        : { ok: false, body: { ready: false, opened, of: total } },
  };
}
