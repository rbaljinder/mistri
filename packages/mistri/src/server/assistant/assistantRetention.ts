/**
 * How long an App's conversations are kept: untouched for the retention
 * period, a conversation and its events are purged every six hours while the
 * host runs. Ordinary Apps keep the default; a tenant App's policy may set
 * its own (`assistant.retentionDays`, tenantAssistant.ts). Token counts are
 * not conversations and stay: they are what the caps and the bill read.
 */
import { ASSISTANT_RETENTION_DAYS } from '../../shared/appAssistant.js';
import type { AppHost } from '../app/apps.js';
import type { Registry } from '@mistriwork/engine/server/connections.js';
import { assistantStoreFor } from './assistantStores.js';
const PURGE_EVERY_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The instant before which an untouched conversation is gone, as the store compares it. */
export const retentionCutoff = (now: number, days: number = ASSISTANT_RETENTION_DAYS): string =>
  new Date(now - days * DAY_MS).toISOString();

/** Run `purge` now and every six hours, unreferenced, until the returned stop. A failed purge is tried again at the next. */
export function purgeOnSchedule(purge: () => Promise<unknown>): () => void {
  const run = () => void purge().catch(() => {});
  run();
  const timer = setInterval(run, PURGE_EVERY_MS);
  timer.unref();
  return () => clearInterval(timer);
}

/** Every served App that declares an assistant: its conversations past the default period, gone; how many in all.
 * An App whose store will not open is skipped here: its requests already refuse, naming the call that provisions it. */
export async function purgeAppAssistants(registry: Registry, hosts: readonly AppHost[], now: number): Promise<number> {
  let purged = 0;
  for (const host of hosts) {
    if (!host.app.app.assistant) continue;
    try {
      purged += await (await assistantStoreFor(registry, host)).purge(host.app.app.id, retentionCutoff(now));
    } catch {
      // The next run tries again.
    }
  }
  return purged;
}
