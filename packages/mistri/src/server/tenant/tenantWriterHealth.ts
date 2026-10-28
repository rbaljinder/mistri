/**
 * The tenant writers an uncertain write has closed and that have not yet
 * reopened (tenantWriterLifecycle.ts). Kept apart from the write
 * source so the serve command's `/readyz` can ask without loading the tenant
 * runtime.
 */
const paused = new Map<object, string>();

/** Mark one writer closed, by its owner's key and `app/source` name; returns the way to mark it open again. */
export function markTenantWriterPaused(key: object, name: string): () => void {
  paused.set(key, name);
  return () => {
    paused.delete(key);
  };
}

/** The writers closed by an uncertain write and not yet reopened, as `app/source`: `/readyz` is 503 while any is. */
export function pausedTenantWriters(): readonly string[] {
  return [...paused.values()];
}

/** Whether the writer named `app/source` is closed and reopening: what it refuses meanwhile is unavailable, not off. */
export function tenantWriterPaused(name: string): boolean {
  for (const value of paused.values()) if (value === name) return true;
  return false;
}
