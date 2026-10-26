/**
 * The writer and reader pools' own meters (poolMetrics.ts): how long a checkout waited for a
 * connection and how long it held one, as p50/p95/p99 bucket bounds. The server reports them in
 * its last http.metrics line when run with SOAK_DIAGNOSTICS=1 and shut down cleanly.
 *   node scripts/soak/pools.mjs <dir>   -> <dir>/pools.json
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
const file = join(dir, 'diagnostics.jsonl');
if (!existsSync(file)) process.exit(0);
const last = readFileSync(file, 'utf8')
  .split('\n')
  .filter((l) => l.includes('"http.metrics"'))
  .at(-1);
if (!last) process.exit(0);
const bounds = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000];
const q = (b, p) => {
  const n = b.reduce((x, y) => x + y, 0);
  if (!n) return null;
  let c = 0;
  for (let i = 0; i < b.length; i++) {
    c += b[i];
    if (c >= (p / 100) * n) return i < bounds.length ? `<=${bounds[i]}ms` : '>30000ms';
  }
};
const view = (b) => ({ p50: q(b, 50), p95: q(b, 95), p99: q(b, 99), buckets: b });
const pools = (JSON.parse(last).capacity?.pools ?? []).map((p) => ({
  role: p.role,
  size: p.size,
  checkouts: p.checkouts,
  queued: p.queued,
  timedOut: p.timedOut,
  wait: view(p.waitBuckets),
  hold: view(p.holdBuckets),
  boundsMs: bounds,
}));
writeFileSync(join(dir, 'pools.json'), JSON.stringify(pools, null, 1));
