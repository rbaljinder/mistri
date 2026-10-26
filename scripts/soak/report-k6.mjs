/**
 * Soak report for a k6 run: one summary.json from everything the run left in <dir>.
 *   node scripts/soak/report-k6.mjs <dir> [--stages 60:150,180:150,60:0]
 * Reads points.json.gz (k6's per-request points), k6-summary.json, server.ndjson (sampler),
 * db.ndjson, pgact.ndjson, pgstat-*.json, events.ndjson, diagnostics.jsonl (when the run had it),
 * the profile top lists and flame graphs (profiles.mjs), and runs report.mjs for the memory
 * and GC verdict and the heap snapshot diff (soak-process.json).
 */
import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { parseArgs } from 'node:util';

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: { stages: { type: 'string', default: '60:150,180:150,60:0' }, bucket: { type: 'string', default: '10' } },
});
const dir = positionals[0];
if (!dir) throw new Error('usage: report-k6.mjs <dir>');
const lines = (name) =>
  existsSync(join(dir, name))
    ? readFileSync(join(dir, name), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
const json = (name) => (existsSync(join(dir, name)) ? JSON.parse(readFileSync(join(dir, name), 'utf8')) : null);
const r = (n, d = 2) => (n == null || Number.isNaN(n) ? null : +n.toFixed(d));
const pct = (s, p) => (s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : null);
const stats = (xs) => {
  const s = Float64Array.from(xs).sort();
  const n = s.length;
  return {
    n,
    avg: r(s.reduce((a, b) => a + b, 0) / (n || 1)),
    min: r(s[0]),
    p50: r(pct(s, 50)),
    p90: r(pct(s, 90)),
    p95: r(pct(s, 95)),
    p99: r(pct(s, 99)),
    p999: r(pct(s, 99.9)),
    max: r(s[n - 1]),
  };
};

const stages = opt.stages.split(',').map((x) => {
  const [s, v] = x.split(':').map(Number);
  return { s, v };
});
const total = stages.reduce((t, x) => t + x.s, 0);
let at = 0,
  from = 0,
  hold = { from: 0, to: total };
for (const st of stages) {
  if (st.v === from && st.v > 0) hold = { from: at, to: at + st.s };
  at += st.s;
  from = st.v;
}
const events = lines('events.ndjson');
const k6Start = events.find((e) => e.phase === 'k6')?.t;

// ---- k6 points -------------------------------------------------------------
const dur = { scenario: {}, ep: {}, all: [] },
  durHold = { scenario: {}, ep: {}, all: [] };
const buckets = new Map(); // second bucket -> { scenario -> {n, bad, d: []} }
const fails = { scenario: {}, ep: {} };
const vitals = {},
  wrong = { ep: {}, total: 0 };
let t0 = null;
const push = (m, k, v) => (m[k] ??= []).push(v);
const bucketMs = Number(opt.bucket) * 1000;
if (existsSync(join(dir, 'points.json.gz'))) {
  const rl = createInterface({ input: createReadStream(join(dir, 'points.json.gz')).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('"Point"')) continue;
    const o = JSON.parse(line);
    const m = o.metric;
    const d = o.data;
    const tags = d.tags ?? {};
    const time = Date.parse(d.time);
    if (t0 == null) t0 = k6Start ?? time;
    const sec = (time - t0) / 1000;
    if (m === 'http_req_duration') {
      const sc = tags.scenario ?? 'setup',
        ep = tags.ep ?? 'other';
      push(dur.scenario, sc, d.value);
      push(dur.ep, ep, d.value);
      dur.all.push(d.value);
      if (sec >= hold.from && sec < hold.to) {
        push(durHold.scenario, sc, d.value);
        push(durHold.ep, ep, d.value);
        durHold.all.push(d.value);
      }
      const key = Math.floor((sec * 1000) / bucketMs);
      const b = buckets.get(key) ?? buckets.set(key, {}).get(key);
      const e = b[sc] ?? (b[sc] = { n: 0, bad: 0, d: [] });
      e.n += 1;
      e.d.push(d.value);
      if (tags.status && !/^[23]/.test(tags.status)) e.bad += 1;
    } else if (m === 'http_req_failed') {
      const sc = tags.scenario ?? 'setup',
        ep = tags.ep ?? 'other';
      fails.scenario[sc] ??= { n: 0, bad: 0 };
      fails.scenario[sc].n += 1;
      fails.scenario[sc].bad += d.value;
      fails.ep[ep] ??= { n: 0, bad: 0 };
      fails.ep[ep].n += 1;
      fails.ep[ep].bad += d.value;
    } else if (m === 'soak_wrong_answer') {
      wrong.total += d.value;
      wrong.ep[tags.ep ?? '?'] = (wrong.ep[tags.ep ?? '?'] ?? 0) + d.value;
    } else if (m.startsWith('browser_web_vital_') || m === 'browser_http_req_duration') {
      push(vitals, m, d.value);
    }
  }
}
const group = (m, hm) =>
  Object.fromEntries(
    Object.keys(m)
      .sort()
      .map((k) => [k, { ...stats(m[k]), hold: hm[k] ? stats(hm[k]) : null }]),
  );
const failRate = (f) =>
  Object.fromEntries(
    Object.entries(f).map(([k, v]) => [k, { requests: v.n, failed: v.bad, rate: r(v.bad / v.n, 5), wrongAnswers: wrong.ep[k] ?? 0 }]),
  );
// Per-scenario error rate: failed requests (non-2xx/3xx) plus answers the check refused.
const scenarioRates = failRate(fails.scenario);
const endpointRates = failRate(fails.ep);
const holdSecs = hold.to - hold.from;
const timeline = [...buckets.entries()]
  .sort((a, b) => a[0] - b[0])
  .map(([k, b]) => {
    const row = { tS: k * Number(opt.bucket), requests: 0, errors: 0, rps: 0, scenarios: {} };
    for (const [sc, e] of Object.entries(b)) {
      row.requests += e.n;
      row.errors += e.bad;
      const s = e.d.sort((x, y) => x - y);
      row.scenarios[sc] = {
        rps: r(e.n / Number(opt.bucket), 1),
        p50: r(pct(s, 50)),
        p95: r(pct(s, 95)),
        p99: r(pct(s, 99)),
        errors: e.bad,
      };
    }
    row.rps = r(row.requests / Number(opt.bucket), 1);
    return row;
  });
const vit = Object.fromEntries(
  Object.entries(vitals).map(([k, v]) => {
    const s = Float64Array.from(v).sort();
    return [
      k.replace('browser_web_vital_', ''),
      {
        n: s.length,
        avg: r(v.reduce((a, b) => a + b, 0) / v.length, 3),
        p50: r(pct(s, 50), 3),
        p75: r(pct(s, 75), 3),
        p95: r(pct(s, 95), 3),
        max: r(s.at(-1), 3),
      },
    ];
  }),
);

// ---- sampler, memory, GC: report.mjs does the fit and the snapshot diff ----------
spawnSync(
  process.execPath,
  [new URL('./report.mjs', import.meta.url).pathname, dir, '--warmup', String(hold.from), '--out', 'soak-process.json'],
  { stdio: 'ignore' },
);
const proc = json('soak-process.json');
// The diff is in soak-process.json; snapshots over 500 MB together are not worth keeping.
const snaps = readdirSync(dir).filter((f) => f.endsWith('.heapsnapshot'));
if (snaps.reduce((t, f) => t + statSync(join(dir, f)).size, 0) > 500 * 2 ** 20) for (const f of snaps) unlinkSync(join(dir, f));
const sampler = lines('server.ndjson')
  .filter((s) => !s.snapshot && s.up != null)
  .map((s) => ({
    tS: r((s.t - t0) / 1000, 0),
    rssMB: s.rssMB,
    heapUsedMB: s.heapUsedMB,
    heapFloorMB: s.heapFloorMB,
    externalMB: s.externalMB,
    gcMs: Object.values(s.gc ?? {}).reduce((t, g) => t + g.totalMs, 0),
    gcMinor: s.gc?.minor?.count ?? 0,
    gcMajor: s.gc?.major?.count ?? 0,
    loopP50Ms: s.loopP50Ms,
    loopP99Ms: s.loopP99Ms,
    elu: s.elu,
    cpuPct: r(s.cpuUserPct + s.cpuSystemPct, 1),
    handles: s.handles,
  }));

// ---- Postgres side ---------------------------------------------------------
const act = lines('pgact.ndjson').filter((x) => x.up >= hold.from && x.up < hold.to);
const state = {},
  waits = {};
let maxXact = 0;
for (const x of act)
  for (const row of x.rows) {
    state[row.state ?? 'background'] = (state[row.state ?? 'background'] ?? 0) + row.n;
    if (row.wait_event)
      waits[`${row.wait_event_type}:${row.wait_event}`] = (waits[`${row.wait_event_type}:${row.wait_event}`] ?? 0) + row.n;
    maxXact = Math.max(maxXact, row.max_xact_s ?? 0);
  }
const samplesN = act.length || 1;
const pgActivity = {
  samples: act.length,
  meanSessionsByState: Object.fromEntries(Object.entries(state).map(([k, v]) => [k, r(v / samplesN, 2)])),
  meanSessionsByWaitEvent: Object.fromEntries(
    Object.entries(waits)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([k, v]) => [k, r(v / samplesN, 2)]),
  ),
  maxTransactionAgeS: r(maxXact, 2),
};
const s0 = json('pgstat-hold-start.json'),
  s1 = json('pgstat-hold-end.json');
let pgStatements = null;
if (s0 && s1) {
  const before = new Map(s0.map((x) => [x.queryid, x]));
  const rows = s1
    .map((x) => {
      const o = before.get(x.queryid);
      const calls = x.calls - (o?.calls ?? 0);
      const ms = x.total_ms - (o?.total_ms ?? 0);
      return { query: x.query, calls, totalMs: r(ms, 1), meanMs: r(calls ? ms / calls : 0, 3), rows: x.rows - (o?.rows ?? 0) };
    })
    .filter((x) => x.calls > 0);
  const writes = [
    'api.create',
    'api.update',
    'api.delete',
    'commands.create',
    'commands.startWorking',
    'commands.markQualified',
    'commands.delete',
  ].reduce((t, k) => t + (durHold.ep[k]?.length ?? 0), 0);
  const isRead = (q) => /^\s*select/i.test(q) && !/for update/i.test(q);
  pgStatements = {
    holdSecs,
    writeRequestsInHold: writes,
    totalCalls: rows.reduce((t, x) => t + x.calls, 0),
    nonSelectCallsPerWriteRequest: writes ? r(rows.filter((x) => !isRead(x.query)).reduce((t, x) => t + x.calls, 0) / writes, 2) : null,
    byTotalTime: rows.sort((a, b) => b.totalMs - a.totalMs).slice(0, 15),
  };
}
// The writer pool, from the server's own per-checkout meters (needs a run with SOAK_DIAGNOSTICS=1).
const pool = json('pools.json');

// ---- profiles --------------------------------------------------------------
const flames = json('flame-index.json') ?? [];
const profiles = Object.fromEntries(flames.map((f) => [f.name, { ...f, ...json(f.top25) }]));

// ---- the verdict on GC and memory, in words ----------------------------------------
const gcAll = proc?.gc?.all,
  cpu = proc?.process?.cpu,
  loop = proc?.process?.eventLoop;
const profiled = events.find((e) => e.monitor === 'start')?.profiled !== false;
const memoryGc = proc && {
  profilersOn: profiled,
  verdict: proc.verdict?.result,
  heapFloorSlopeMbPer10min: proc.verdict?.heapFloorSlopeMbPer10min,
  snapshotRetainedGrowthMbPer10min: proc.verdict?.snapshotRetainedGrowthMbPer10min,
  rssSlopeMbPer10min: proc.verdict?.rssSlopeMbPer10min,
  rssPeakMB: Math.max(...sampler.map((s) => s.rssMB)),
  heapFloorMB: { first: proc.memory?.heapFloor?.startMB, last: proc.memory?.heapFloor?.endMB },
  gcPercentOfHold: gcAll?.percentOfTime,
  gcByKind: proc.gc?.byKind,
  cpuPct: cpu,
  eventLoop: loop,
  snapshots: proc.snapshots?.totals,
  snapshotDiffs: proc.snapshots?.diffs?.map((d) => ({
    from: d.from,
    to: d.to,
    totalDeltaMB: d.totalDeltaMB,
    topGrowing: d.topGrowing?.slice(0, 8),
  })),
  caveat:
    (profiled
      ? 'The CPU and allocation profilers were on during the hold and hold memory of their own (RSS and the heap floor rise with them): this run is not a leak test. Rerun with SOAK_PROFILE_OFF=1. '
      : '') + proc.verdict?.caveat,
};

const k6sum = json('k6-summary.json');
const summary = {
  run: {
    dir,
    stages: opt.stages,
    holdS: hold,
    writePool: events.find((e) => e.phase === 'k6')?.writePool,
    k6Start,
    aborted: events.find((e) => e.abort)?.abort ?? null,
    notRun: {
      sessions: 'Compass declares no auth, so there is no sign-in',
      publicapi: 'Compass declares no `api`, so there is no public App API',
      businessCommands: 'Compass has no commands module; its actions are POST /api/update (scenario commands)',
    },
  },
  throughput: {
    overallRps: r(dur.all.length / total, 1),
    holdRps: r(durHold.all.length / holdSecs, 1),
    requests: dur.all.length,
    holdRequests: durHold.all.length,
    wrongAnswers: wrong.total,
  },
  perScenario: { ...group(dur.scenario, durHold.scenario) },
  scenarioErrors: scenarioRates,
  perEndpoint: group(dur.ep, durHold.ep),
  endpointErrors: endpointRates,
  overall: { ...stats(dur.all), hold: stats(durHold.all) },
  timeline10s: timeline,
  webVitals: vit,
  sampler,
  memoryGc,
  postgres: { activity: pgActivity, statements: pgStatements, writerPool: pool },
  db: proc?.db,
  profiles,
  files: {
    dashboard: 'k6-dashboard.html',
    k6Summary: 'k6-summary.json',
    points: 'points.json.gz',
    flameIndex: 'flame-index.json',
    processSummary: 'soak-process.json',
    flames: flames.map((f) => ({ name: f.name, html: f.flame, folded: f.folded, top25: f.top25, profile: f.profile })),
    snapshots: readdirSync(dir).filter((f) => f.endsWith('.heapsnapshot')),
  },
};
writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 1));
console.log(
  JSON.stringify(
    {
      throughput: summary.throughput,
      perScenario: Object.fromEntries(
        Object.entries(summary.perScenario).map(([k, v]) => [k, { p50: v.hold?.p50, p95: v.hold?.p95, p99: v.hold?.p99 }]),
      ),
      vitals: Object.keys(vit),
      memory: memoryGc?.verdict,
    },
    null,
    1,
  ),
);
