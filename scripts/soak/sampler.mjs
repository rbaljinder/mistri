/**
 * Soak sampler: load it into a tablewalk server with `node --import`.
 *
 *   SOAK_OUT=<dir> node --expose-gc --import ./scripts/soak/sampler.mjs ...
 *
 * Every SOAK_INTERVAL_MS (5000) it appends one NDJSON line to <dir>/server.ndjson.
 * SIGUSR2 writes a heap snapshot to <dir>/heap-<label>.heapsnapshot, where the
 * label is read from <dir>/snapshot.label (the load driver writes it first).
 *
 * Profiles: the load driver appends commands to <dir>/control (one per line) and
 * this module runs them, so a profile can start and stop at chosen moments of a run:
 *   cpu-start <label> | cpu-stop     V8 CPU profile -> <dir>/cpu-<label>.cpuprofile
 *   heap-start | heap-stop <label>   sampling allocation profile (objects freed by
 *                                    minor and major GC included, which is what
 *                                    the GC time is spent on; one sample per 128 KB,
 *                                    a finer interval costs gigabytes of profiler memory) -> <dir>/heap-<label>.heapprofile
 *   snapshot <label>                 the same as SIGUSR2
 * Where --enable-source-maps is on, each call frame also carries `source`, the
 * TypeScript file:line that tsx's transform came from.
 * Nothing here ships: scripts/ is outside package.json `files`.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector';
import { findSourceMap } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { monitorEventLoopDelay, performance, PerformanceObserver, constants } from 'node:perf_hooks';
import v8 from 'node:v8';

const out = process.env.SOAK_OUT;
if (!out) throw new Error('SOAK_OUT is not set');
mkdirSync(out, { recursive: true });
const file = join(out, 'server.ndjson');
const interval = Number(process.env.SOAK_INTERVAL_MS ?? 5000);

const KINDS = new Map([
  [constants.NODE_PERFORMANCE_GC_MAJOR, 'major'],
  [constants.NODE_PERFORMANCE_GC_MINOR, 'minor'],
  [constants.NODE_PERFORMANCE_GC_INCREMENTAL, 'incremental'],
  [constants.NODE_PERFORMANCE_GC_WEAKCB, 'weakcb'],
]);
const fresh = () => ({ count: 0, totalMs: 0, maxMs: 0, pauses: [] });
let gc = {};
const obs = new PerformanceObserver((list) => {
  for (const e of list.getEntries()) {
    const kind = KINDS.get(e.detail?.kind ?? e.kind) ?? 'other';
    const g = (gc[kind] ??= fresh());
    g.count += 1;
    g.totalMs += e.duration;
    g.maxMs = Math.max(g.maxMs, e.duration);
    g.pauses.push(+e.duration.toFixed(3));
  }
});
obs.observe({ entryTypes: ['gc'] });

const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();
let lastElu = performance.eventLoopUtilization();
let lastCpu = process.cpuUsage();
let lastAt = performance.now();
// The heap floor: a cheap fast poll records the lowest heapUsed inside each
// window, which approximates the live set once a major GC has run.
let floor = Infinity;
setInterval(() => {
  floor = Math.min(floor, process.memoryUsage().heapUsed);
}, 250).unref();

const mb = (n) => +(n / 1048576).toFixed(2);
const t0 = Date.now();
function sample() {
  const now = performance.now();
  const m = process.memoryUsage();
  const cpu = process.cpuUsage(lastCpu);
  const elu = performance.eventLoopUtilization(lastElu);
  const dt = (now - lastAt) / 1000;
  const heap = v8.getHeapStatistics();
  const line = {
    t: Date.now(),
    up: +((Date.now() - t0) / 1000).toFixed(1),
    rssMB: mb(m.rss),
    heapUsedMB: mb(m.heapUsed),
    heapTotalMB: mb(m.heapTotal),
    externalMB: mb(m.external),
    arrayBuffersMB: mb(m.arrayBuffers),
    heapFloorMB: mb(Number.isFinite(floor) ? Math.min(floor, m.heapUsed) : m.heapUsed),
    mallocedMB: mb(heap.malloced_memory),
    detachedContexts: heap.number_of_detached_contexts,
    gc: Object.fromEntries(
      Object.entries(gc).map(([k, g]) => [
        k,
        { count: g.count, totalMs: +g.totalMs.toFixed(3), maxMs: +g.maxMs.toFixed(3), pauses: g.pauses },
      ]),
    ),
    loopP50Ms: +(loop.percentile(50) / 1e6).toFixed(3),
    loopP99Ms: +(loop.percentile(99) / 1e6).toFixed(3),
    loopMaxMs: +(loop.max / 1e6).toFixed(3),
    elu: +elu.utilization.toFixed(4),
    cpuUserPct: +(cpu.user / 1e4 / dt).toFixed(2),
    cpuSystemPct: +(cpu.system / 1e4 / dt).toFixed(2),
    handles: process._getActiveHandles?.().length ?? null,
    requests: process._getActiveRequests?.().length ?? null,
  };
  appendFileSync(file, JSON.stringify(line) + '\n');
  gc = {};
  loop.reset();
  floor = Infinity;
  lastElu = performance.eventLoopUtilization();
  lastCpu = process.cpuUsage();
  lastAt = now;
}
setInterval(sample, interval).unref();

process.on('SIGUSR2', () => {
  let label = 'snap';
  try {
    label = readFileSync(join(out, 'snapshot.label'), 'utf8').trim() || label;
  } catch {
    /* default label */
  }
  // A full GC first, so the snapshot holds what is retained, not what is merely unswept.
  globalThis.gc?.();
  const path = v8.writeHeapSnapshot(join(out, `heap-${label}.heapsnapshot`));
  appendFileSync(file, JSON.stringify({ t: Date.now(), snapshot: path }) + '\n');
});

// ---- profiles, by command file --------------------------------------------
const session = new Session();
session.connect();
const post = (method, params) => new Promise((res, rej) => session.post(method, params, (e, r) => (e ? rej(e) : res(r))));
const log = (e) => appendFileSync(file, JSON.stringify({ t: Date.now(), ...e }) + '\n');
const maps = new Map();
// Map a call frame in tsx's transformed output back to the TypeScript it came from.
function annotate(node) {
  const cf = node.callFrame;
  if (!cf.url?.startsWith('file://')) return;
  const path = fileURLToPath(cf.url);
  if (!maps.has(path)) {
    try {
      maps.set(path, findSourceMap(path));
    } catch {
      maps.set(path, undefined);
    }
  }
  const entry = maps.get(path)?.findEntry(Math.max(0, cf.lineNumber), Math.max(0, cf.columnNumber));
  if (entry?.originalSource) cf.source = `${entry.originalSource.replace(/^file:\/\//, '')}:${entry.originalLine + 1}`;
}
const walk = (head, fn) => {
  const stack = [head];
  while (stack.length) {
    const n = stack.pop();
    fn(n);
    for (const c of n.children ?? []) stack.push(c);
  }
};
let cpuLabel = null,
  heapOn = false;
async function command(line) {
  const [cmd, arg] = line.trim().split(/\s+/);
  if (cmd === 'cpu-start' && !cpuLabel) {
    await post('Profiler.enable');
    await post('Profiler.setSamplingInterval', { interval: 1000 });
    await post('Profiler.start');
    cpuLabel = arg || 'cpu';
    log({ profile: 'cpu', state: 'start', label: cpuLabel });
  } else if (cmd === 'cpu-stop' && cpuLabel) {
    const { profile } = await post('Profiler.stop');
    const label = cpuLabel;
    cpuLabel = null;
    for (const n of profile.nodes) annotate(n);
    const path = join(out, `cpu-${label}.cpuprofile`);
    writeFileSync(path, JSON.stringify(profile));
    log({ profile: 'cpu', state: 'end', label, path });
  } else if (cmd === 'heap-start' && !heapOn) {
    await post('HeapProfiler.enable');
    await post('HeapProfiler.startSampling', {
      samplingInterval: 131072,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    heapOn = true;
    log({ profile: 'heap', state: 'start' });
  } else if (cmd === 'heap-stop' && heapOn) {
    const { profile } = await post('HeapProfiler.stopSampling');
    heapOn = false;
    // V8 sends one record per sampled allocation (millions over a hold); the tree already has the totals.
    delete profile.samples;
    walk(profile.head, annotate);
    const path = join(out, `alloc-${arg || 'hold'}.heapprofile`);
    writeFileSync(path, JSON.stringify(profile));
    log({ profile: 'heap', state: 'end', path });
  } else if (cmd === 'snapshot') {
    writeFileSync(join(out, 'snapshot.label'), arg || 'snap');
    process.emit('SIGUSR2');
  }
}
const control = join(out, 'control');
let controlAt = 0;
setInterval(async () => {
  if (!existsSync(control)) return;
  const lines = readFileSync(control, 'utf8').split('\n').filter(Boolean);
  while (controlAt < lines.length) {
    const l = lines[controlAt++];
    try {
      await command(l);
    } catch (e) {
      log({ controlError: String(e), line: l });
    }
  }
}, 500).unref();
