/**
 * Bytes this process allocated since the meter started, for a test's budget.
 * V8 keeps no running total, but every collection reports the heap before and
 * after it: what was allocated is each rise between one collection's end and
 * the next one's start, and the rise since the last. Sampling profilers miss
 * small objects and slow the code they watch; this misses nothing and costs
 * a callback per collection.
 */
import { GCProfiler, getHeapStatistics } from 'node:v8';

export function allocationMeter(): { allocated(): number } {
  const profiler = new GCProfiler();
  const started = getHeapStatistics().used_heap_size;
  profiler.start();
  return {
    allocated() {
      const now = getHeapStatistics().used_heap_size;
      const collections = profiler.stop()?.statistics ?? [];
      let total = 0,
        after = started;
      for (const collection of collections) {
        total += Math.max(0, collection.beforeGC.heapStatistics.usedHeapSize - after);
        after = collection.afterGC.heapStatistics.usedHeapSize;
      }
      return total + Math.max(0, now - after);
    },
  };
}
