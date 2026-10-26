/**
 * Soak report: summarize a run directory into summary.json.
 *   node scripts/soak/report.mjs <run-dir> [--warmup 60] [--threshold-mb 1]
 * Reads server.ndjson (sampler), requests.ndjson, db.ndjson, events.ndjson (load)
 * and any heap-*.heapsnapshot. Prints a short digest; the numbers are in summary.json.
 */
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    warmup: { type: 'string', default: '60' },
    'threshold-mb': { type: 'string', default: '1' },
    out: { type: 'string', default: 'summary.json' },
  },
});
const dir = positionals[0];
if (!dir) throw new Error('usage: report.mjs <run-dir>');
const lines = (name) =>
  existsSync(join(dir, name))
    ? readFileSync(join(dir, name), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
const samplesAll = lines('server.ndjson'),
  snapLines = samplesAll.filter((s) => s.snapshot),
  samples = samplesAll.filter((s) => !s.snapshot && s.up != null); /* not the profile events */
const requests = lines('requests.ndjson'),
  db = lines('db.ndjson'),
  events = lines('events.ndjson');

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : null);
const r = (n, d = 2) => (n == null ? null : +n.toFixed(d));
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return {
    n: s.length,
    p50: r(pct(s, 50)),
    p95: r(pct(s, 95)),
    p99: r(pct(s, 99)),
    max: r(s.at(-1)),
    mean: r(s.reduce((a, b) => a + b, 0) / (s.length || 1)),
  };
};
function fit(points) {
  // least squares y = a + b x, with the slope's standard error
  const n = points.length;
  if (n < 3) return { slope: null, se: null, r2: null, n };
  const mx = points.reduce((s, p) => s + p[0], 0) / n,
    my = points.reduce((s, p) => s + p[1], 0) / n;
  const sxx = points.reduce((s, p) => s + (p[0] - mx) ** 2, 0),
    sxy = points.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0);
  const b = sxy / sxx,
    a = my - b * mx;
  const sse = points.reduce((s, p) => s + (p[1] - a - b * p[0]) ** 2, 0),
    sst = points.reduce((s, p) => s + (p[1] - my) ** 2, 0);
  return { slope: b, se: Math.sqrt(sse / (n - 2) / sxx), r2: sst ? 1 - sse / sst : 1, n };
}

const t0 = events.find((e) => e.phase === 'warmup' || e.phase === 'ramp-up')?.t ?? requests[0]?.t ?? samples[0]?.t;
const warmupMs = Number(opt.warmup) * 1000;
const loadStart = events.find((e) => e.phase === 'load' || e.phase === 'hold')?.t ?? t0 + warmupMs;
const end = events.find((e) => e.phase === 'done')?.t ?? samples.at(-1)?.t;
const windows = []; // the users are paused while a snapshot is written; keep its samples out of the trend
for (const e of events.filter((e) => e.snapshot)) {
  if (e.state === 'start') windows.push({ from: e.t, to: null });
  else if (windows.at(-1)) windows.at(-1).to = e.t + 6000;
}
const inSnap = (t) => windows.some((w) => t >= w.from && t <= (w.to ?? Infinity));
const post = samples.filter((s) => s.t >= loadStart && !inSnap(s.t));
const mins = (s) => (s.t - loadStart) / 60000;
const trend = (key) => {
  const f = fit(post.map((s) => [mins(s), s[key]]));
  if (f.slope == null) return { mbPer10min: null, seMbPer10min: null, r2: null };
  return {
    mbPer10min: r(f.slope * 10, 3),
    seMbPer10min: r(f.se * 10, 3),
    r2: r(f.r2, 3),
    startMB: r(post[0]?.[key]),
    endMB: r(post.at(-1)?.[key]),
  };
};

// Latency, per operation and overall, load phase only.
const load = requests.filter((q) => q.phase === 'load' || q.phase === 'hold'); // a staged run measures its hold
const ops = {};
for (const op of [...new Set(load.map((q) => q.op))]) {
  const rs = load.filter((q) => q.op === op);
  ops[op] = {
    ...stats(rs.map((q) => q.ms)),
    errors: rs.filter((q) => !q.ok).length,
    errorRate: r(rs.filter((q) => !q.ok).length / rs.length, 5),
  };
}
const loadSecs = Math.max(1, ((end ?? loadStart) - loadStart) / 1000);
const perMinute = [];
for (let m = 0; m * 60000 < (end ?? loadStart) - loadStart; m++) {
  const rs = load.filter((q) => q.t >= loadStart + m * 60000 && q.t < loadStart + (m + 1) * 60000);
  if (rs.length) {
    const st = stats(rs.map((q) => q.ms));
    perMinute.push({ minute: m + 1, requests: rs.length, p50: st.p50, p95: st.p95, p99: st.p99, errors: rs.filter((q) => !q.ok).length });
  }
}
// A last partial minute is not a minute: leave it out of the drift comparison.
const medianCount = [...perMinute].map((m) => m.requests).sort((x, y) => x - y)[Math.floor(perMinute.length / 2)] ?? 0;
const full = perMinute.filter((m) => m.requests >= medianCount / 2);
const third = Math.floor(full.length / 3);
const drift =
  third >= 1
    ? {
        firstThirdP50: r(stats(full.slice(0, third).map((m) => m.p50)).mean),
        lastThirdP50: r(stats(full.slice(-third).map((m) => m.p50)).mean),
        firstThirdP99: r(stats(full.slice(0, third).map((m) => m.p99)).mean),
        lastThirdP99: r(stats(full.slice(-third).map((m) => m.p99)).mean),
      }
    : null;
const latency = {
  overall: {
    ...stats(load.map((q) => q.ms)),
    errors: load.filter((q) => !q.ok).length,
    errorRate: r(load.filter((q) => !q.ok).length / (load.length || 1), 5),
    throughputRps: r(load.length / loadSecs, 1),
    requests: load.length,
  },
  perOperation: ops,
  perMinute,
  drift,
  statusCodes: load.reduce((m, q) => ((m[q.status] = (m[q.status] ?? 0) + 1), m), {}),
};

// GC
const gcKinds = {};
for (const s of post.concat(samples.filter((s) => s.t >= loadStart && inSnap(s.t))))
  for (const [k, g] of Object.entries(s.gc ?? {})) {
    gcKinds[k] ??= { pauses: [], totalMs: 0 };
    gcKinds[k].pauses.push(...g.pauses);
    gcKinds[k].totalMs += g.totalMs;
  }
const loadMinutes = Math.max(1 / 60, ((post.at(-1)?.t ?? loadStart) - loadStart) / 60000);
const gc = {
  byKind: Object.fromEntries(
    Object.entries(gcKinds).map(([k, g]) => [
      k,
      { count: g.pauses.length, ...stats(g.pauses), totalMs: r(g.totalMs), msPerMinute: r(g.totalMs / loadMinutes) },
    ]),
  ),
};
const allPauses = Object.values(gcKinds).flatMap((g) => g.pauses);
gc.all = {
  ...stats(allPauses),
  totalMs: r(Object.values(gcKinds).reduce((s, g) => s + g.totalMs, 0)),
  msPerMinute: r(Object.values(gcKinds).reduce((s, g) => s + g.totalMs, 0) / loadMinutes),
  percentOfTime: r(Object.values(gcKinds).reduce((s, g) => s + g.totalMs, 0) / (loadMinutes * 600), 3),
};

const avg = (key) => r(post.reduce((s, x) => s + x[key], 0) / (post.length || 1), 3);
const maxOf = (key) => r(Math.max(...post.map((x) => x[key])), 3);
const process_ = {
  eventLoop: {
    p50MsMean: avg('loopP50Ms'),
    p99MsMean: avg('loopP99Ms'),
    p99MsMax: maxOf('loopP99Ms'),
    maxMsMax: maxOf('loopMaxMs'),
    eluMean: avg('elu'),
    eluMax: maxOf('elu'),
  },
  cpu: { userPctMean: avg('cpuUserPct'), systemPctMean: avg('cpuSystemPct'), totalPctMean: r(avg('cpuUserPct') + avg('cpuSystemPct')) },
  handles: { min: Math.min(...post.map((x) => x.handles)), max: maxOf('handles'), first: post[0]?.handles, last: post.at(-1)?.handles },
  activeRequests: { max: maxOf('requests') },
  detachedContexts: { max: maxOf('detachedContexts') },
};

const memory = {
  rss: trend('rssMB'),
  heapUsed: trend('heapUsedMB'),
  heapFloor: trend('heapFloorMB'),
  external: trend('externalMB'),
  arrayBuffers: trend('arrayBuffersMB'),
  heapTotal: trend('heapTotalMB'),
  series: samples.map((s) => ({
    min: r((s.t - t0) / 60000, 2),
    rssMB: s.rssMB,
    heapUsedMB: s.heapUsedMB,
    heapFloorMB: s.heapFloorMB,
    externalMB: s.externalMB,
  })),
};

const dbSummary = {
  series: db.map((d) => ({
    min: r((d.t - t0) / 60000, 2),
    sizeMB: r(d.dbSizeBytes / 1048576, 2),
    lead: d.counts?.lead,
    freeDiskGB: d.freeDiskGB,
    counts: d.counts,
  })),
  sizeGrowthMB: db.length > 1 ? r((db.at(-1).dbSizeBytes - db[0].dbSizeBytes) / 1048576, 2) : null,
  rowDeltas:
    db.length > 1
      ? Object.fromEntries(
          Object.keys(db[0].counts)
            .map((t) => [t, db.at(-1).counts[t] - db[0].counts[t]])
            .filter(([, d]) => d !== 0),
        )
      : {},
};

// Heap snapshots: aggregate by (type, constructor) and diff in order.
function aggregate(file) {
  const snap = JSON.parse(readFileSync(file, 'utf8'));
  const f = snap.snapshot.meta.node_fields,
    types = snap.snapshot.meta.node_types[0],
    n = f.length;
  const iT = f.indexOf('type'),
    iN = f.indexOf('name'),
    iS = f.indexOf('self_size');
  const map = new Map();
  const nodes = snap.nodes,
    strings = snap.strings;
  let total = 0;
  for (let i = 0; i < nodes.length; i += n) {
    const type = types[nodes[i + iT]];
    if (type === 'synthetic') continue;
    const size = nodes[i + iS];
    total += size;
    const name =
      type === 'string' ||
      type === 'concatenated string' ||
      type === 'sliced string' ||
      type === 'number' ||
      type === 'hidden' ||
      type === 'code'
        ? ''
        : strings[nodes[i + iN]].slice(0, 60);
    const key = name ? `${type}:${name}` : type;
    const e = map.get(key);
    if (e) {
      e.count++;
      e.size += size;
    } else map.set(key, { count: 1, size });
  }
  return { map, total, nodes: nodes.length / n };
}
const snapFiles = readdirSync(dir)
  .filter((f) => f.startsWith('heap-') && f.endsWith('.heapsnapshot'))
  .sort((x, y) => parseInt(x.slice(5)) - parseInt(y.slice(5)));
const snapshots = { files: snapFiles.map((f) => ({ file: f, MB: r(statSync(join(dir, f)).size / 1048576, 1) })), diffs: [] };
if (snapFiles.length >= 2) {
  const aggs = snapFiles.map((f) => ({ f, ...aggregate(join(dir, f)) }));
  snapshots.totals = aggs.map((a) => ({ file: a.f, selfSizeMB: r(a.total / 1048576, 2), nodes: a.nodes }));
  for (const [x, y] of [[0, aggs.length - 1], ...(aggs.length > 2 ? [[aggs.length - 2, aggs.length - 1]] : [])]) {
    const a = aggs[x],
      b = aggs[y];
    const rows = [];
    for (const [k, v] of b.map) {
      const o = a.map.get(k) ?? { count: 0, size: 0 };
      rows.push({
        constructor: k,
        countDelta: v.count - o.count,
        sizeDeltaKB: r((v.size - o.size) / 1024, 1),
        countNow: v.count,
        sizeNowKB: r(v.size / 1024, 1),
      });
    }
    rows.sort((p, q) => q.sizeDeltaKB - p.sizeDeltaKB);
    snapshots.diffs.push({
      from: a.f,
      to: b.f,
      totalDeltaMB: r((b.total - a.total) / 1048576, 2),
      topGrowing: rows.slice(0, 15),
      topGrowingByCount: [...rows].sort((p, q) => q.countDelta - p.countDelta).slice(0, 10),
    });
  }
}

// Verdict.
const th = Number(opt['threshold-mb']);
const floor = memory.heapFloor;
const minutesObserved = r(loadMinutes, 1);
const exceeds = floor.mbPer10min != null && floor.mbPer10min > th;
const significant = floor.mbPer10min != null && floor.mbPer10min - 2 * floor.seMbPer10min > 0;
// The snapshots are taken after a full GC, so their total is the retained heap with no sampling noise;
// the poll-based floor above is the continuous view and is noisier. Either one over the threshold flags it.
const snapTotals = snapshots.totals ?? [];
const snapSpanMin = snapFiles.length >= 2 ? parseInt(snapFiles.at(-1).slice(5)) - parseInt(snapFiles[0].slice(5)) : null;
const snapGrowthPer10 =
  snapTotals.length >= 2 && snapSpanMin ? r(((snapTotals.at(-1).selfSizeMB - snapTotals[0].selfSizeMB) / snapSpanMin) * 10, 3) : null;
const snapOver = snapGrowthPer10 != null && snapGrowthPer10 > th;
const result =
  floor.mbPer10min == null
    ? 'insufficient data'
    : (exceeds && significant) || snapOver
      ? 'LEAK SUSPECTED: retained heap grows over the threshold'
      : exceeds
        ? snapGrowthPer10 != null
          ? 'PASS (snapshot-confirmed): the floor slope is within noise and the retained heap in the snapshots is flat'
          : 'INCONCLUSIVE: slope is over the threshold but within noise'
        : 'PASS: heap floor flat within the threshold';
const verdict = {
  thresholdMbPer10min: th,
  heapFloorSlopeMbPer10min: floor.mbPer10min,
  heapFloorSlopeSeMbPer10min: floor.seMbPer10min,
  snapshotRetainedGrowthMbPer10min: snapGrowthPer10,
  rssSlopeMbPer10min: memory.rss.mbPer10min,
  minutesObserved,
  result,
  caveat: `${minutesObserved} minutes of load only indicates a trend: a 10 minute fit extrapolates to the hour with wide error, and a slow leak, a cache that fills and then evicts, or a V8 heap that is still growing toward its limit can look flat or rising here. The one-hour run is the test.`,
};

const summary = {
  run: {
    dir,
    vus: events.find((e) => e.vus)?.vus,
    warmupS: Number(opt.warmup),
    loadStart,
    end,
    aborted: events.find((e) => e.abort)?.abort ?? null,
    samples: samples.length,
  },
  verdict,
  latency,
  memory,
  gc,
  process: process_,
  db: dbSummary,
  snapshots,
};
writeFileSync(join(dir, opt.out), JSON.stringify(summary, null, 1));
console.log(
  JSON.stringify(
    {
      verdict: verdict.result,
      floorSlope: floor,
      rssSlope: memory.rss,
      overall: latency.overall,
      gc: gc.all,
      cpu: process_.cpu,
      loop: process_.eventLoop,
      dbGrowthMB: dbSummary.sizeGrowthMB,
      rowDeltas: dbSummary.rowDeltas,
    },
    null,
    1,
  ),
);
