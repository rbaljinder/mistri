/**
 * The measuring side of `scripts/capacity-harness.mjs`, inside the served
 * process: a control port that opens and closes windows and, over each one,
 * reports CPU, an estimate of the bytes allocated, GC pause time, event-loop
 * utilization and the requests answered; on request it records a CPU profile
 * and a sampling allocation profile that keeps collected objects, so
 * short-lived garbage is named too.
 *
 * Why a process says this about itself: CPU per request is exact here —
 * `process.cpuUsage()` over a window, divided by the requests answered in it —
 * where a request's own `Server-Timing` cpu is only approximate under
 * concurrency. Allocation comes from V8's own GC statistics (what each
 * collection found minus what the one before left).
 *
 * Memory over a long run: `/memory` says the heap and the resident set now,
 * cheaply enough to ask every few seconds (the lowest readings in a window are
 * its floor, what survived the collections in it), and `/snapshot?label=`
 * writes a heap snapshot, after the full collection V8 makes for one, into the
 * output directory — two of them, early and late, diffed by constructor, say
 * what the process kept between them.
 *
 * Two ways in: `capacityServer.ts` (Ignition, deployed by the fixture) calls
 * `openCapacityControl` itself; any other App is served by the ordinary CLI
 * with `--import test/support/capacityPreload.ts`, so what is measured is the
 * server as it runs, with nothing of the harness on its request path but a
 * diagnostics-channel counter.
 */
import { subscribe } from 'node:diagnostics_channel';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { SourceMap } from 'node:module';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { Session } from 'node:inspector/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { GCProfiler, getHeapStatistics, writeHeapSnapshot } from 'node:v8';

interface Window {
  started: number;
  cpu: NodeJS.CpuUsage;
  elu: ReturnType<typeof performance.eventLoopUtilization>;
  heapUsed: number;
  gc: InstanceType<typeof GCProfiler>;
  requests: Map<string, number>;
  session?: Session;
  profiles: { cpu: boolean; heap: boolean };
}

interface Frame {
  scriptId: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
}

/* tsx hands V8 its transformed code, so a profile's positions are that code's. Each frame is pointed at the
   TypeScript line it came from, read from the inline source map tsx leaves in the script, once the profile is
   taken — not by turning on source-map support for the run, which makes every stack trace the server builds
   parse maps and would be measured as the server's own cost. */
async function originals(session: Session, frames: Frame[]) {
  const maps = new Map<string, SourceMap | undefined>();
  await session.post('Debugger.enable');
  try {
    for (const frame of frames) {
      if (!frame.url.startsWith('file://') || frame.lineNumber < 0) continue;
      if (!maps.has(frame.scriptId)) {
        let map: SourceMap | undefined;
        try {
          const { scriptSource } = await session.post('Debugger.getScriptSource', { scriptId: frame.scriptId });
          const inline = /\/\/# sourceMappingURL=data:application\/json;(?:charset=utf-8;)?base64,([A-Za-z0-9+/=]+)\s*$/.exec(scriptSource);
          if (inline) map = new SourceMap(JSON.parse(Buffer.from(inline[1], 'base64').toString('utf8')));
        } catch {
          // A script without a map keeps its own positions.
        }
        maps.set(frame.scriptId, map);
      }
      const entry = maps.get(frame.scriptId)?.findEntry(frame.lineNumber, frame.columnNumber);
      if (!entry || !('originalSource' in entry)) continue;
      frame.url = entry.originalSource;
      frame.lineNumber = entry.originalLine;
      frame.columnNumber = entry.originalColumn;
    }
  } finally {
    await session.post('Debugger.disable');
  }
}
function framesOf(node: { callFrame: Frame; children?: unknown[] }, into: Frame[] = []): Frame[] {
  into.push(node.callFrame);
  for (const child of (node.children ?? []) as Array<typeof node>) framesOf(child, into);
  return into;
}

/** A request's route with its trailing id folded, so a report counts endpoints rather than records. */
const routeOf = (req: IncomingMessage) => (req.url ?? '').split('?')[0].replace(/\/[^/]*\d[^/]*$/, '/:id');

export async function openCapacityControl(options: { port: number; out: string; ready: () => unknown | Promise<unknown> }) {
  let window: Window | undefined;
  let control: Server | undefined;
  /* Every server in the process is counted but this one: an App serves its pages, its API and its public routes
     from more than one listener in some deployments, and each is a request a person waits on. The live stream is
     left out, being one long request per tab; its cost is still in the window's CPU, which is the point. */
  subscribe('http.server.request.start', (message) => {
    const { request, server } = message as { request: IncomingMessage; server: Server };
    if (!window || server === control) return;
    const route = routeOf(request);
    if (route === '/api/live') return;
    window.requests.set(route, (window.requests.get(route) ?? 0) + 1);
  });

  async function begin(profiles: { cpu: boolean; heap: boolean }) {
    if (window) throw new Error('a window is already open');
    let session: Session | undefined;
    if (profiles.cpu || profiles.heap) {
      session = new Session();
      session.connect();
      if (profiles.cpu) {
        await session.post('Profiler.enable');
        await session.post('Profiler.setSamplingInterval', { interval: 200 });
        await session.post('Profiler.start');
      }
      if (profiles.heap)
        await session.post('HeapProfiler.startSampling', {
          samplingInterval: 16384,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
    }
    const gc = new GCProfiler();
    gc.start();
    window = {
      started: performance.now(),
      cpu: process.cpuUsage(),
      elu: performance.eventLoopUtilization(),
      heapUsed: getHeapStatistics().used_heap_size,
      gc,
      requests: new Map(),
      session,
      profiles,
    };
  }

  async function end(label: string) {
    const open = window;
    if (!open) throw new Error('no window is open');
    window = undefined;
    const cpu = process.cpuUsage(open.cpu);
    const elu = performance.eventLoopUtilization(open.elu);
    const wallMs = performance.now() - open.started;
    const heapNow = getHeapStatistics().used_heap_size;
    const stats = open.gc.stop()?.statistics ?? [];
    /* Allocated ≈ what each collection found above what the previous one left, and what is above the last one now. */
    let allocated = 0,
      previous = open.heapUsed,
      gcMicros = 0;
    for (const s of stats) {
      allocated += Math.max(0, s.beforeGC.heapStatistics.usedHeapSize - previous);
      previous = s.afterGC.heapStatistics.usedHeapSize;
      gcMicros += s.cost;
    }
    allocated += Math.max(0, heapNow - previous);
    const files: string[] = [];
    if (open.session) {
      mkdirSync(options.out, { recursive: true });
      if (open.profiles.cpu) {
        const { profile } = await open.session.post('Profiler.stop');
        await originals(
          open.session,
          profile.nodes.map((node) => node.callFrame),
        );
        const file = join(options.out, `${label}.cpuprofile`);
        writeFileSync(file, JSON.stringify(profile));
        files.push(file);
      }
      if (open.profiles.heap) {
        const { profile } = await open.session.post('HeapProfiler.stopSampling');
        await originals(open.session, framesOf(profile.head as never));
        const file = join(options.out, `${label}.heapprofile`);
        writeFileSync(file, JSON.stringify(profile));
        files.push(file);
      }
      open.session.disconnect();
    }
    const requests = [...open.requests.values()].reduce((a, b) => a + b, 0);
    return {
      label,
      wallMs,
      cpuMs: (cpu.user + cpu.system) / 1000,
      userMs: cpu.user / 1000,
      systemMs: cpu.system / 1000,
      requests,
      byRoute: Object.fromEntries([...open.requests].sort((a, b) => b[1] - a[1])),
      allocatedBytes: allocated,
      gcMs: gcMicros / 1000,
      gcCount: stats.length,
      elu: elu.utilization,
      heapUsedBytes: heapNow,
      rssBytes: process.memoryUsage().rss,
      files,
    };
  }

  control = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://control');
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      if (url.pathname === '/ready') {
        const ready = await options.ready();
        return ready === undefined ? reply(503, { error: 'not ready' }) : reply(200, ready);
      }
      if (url.pathname === '/begin') {
        const asked = (url.searchParams.get('profile') ?? '').split(',');
        await begin({ cpu: asked.includes('cpu'), heap: asked.includes('heap') });
        return reply(200, { ok: true });
      }
      if (url.pathname === '/end') return reply(200, await end(url.searchParams.get('label') ?? 'window'));
      if (url.pathname === '/memory')
        return reply(200, { heapUsedBytes: getHeapStatistics().used_heap_size, rssBytes: process.memoryUsage().rss });
      if (url.pathname === '/snapshot') {
        const label = (url.searchParams.get('label') ?? 'heap').replace(/[^\w.-]/g, '');
        mkdirSync(options.out, { recursive: true });
        return reply(200, {
          file: writeHeapSnapshot(join(options.out, `${label}.heapsnapshot`)),
          heapUsedBytes: getHeapStatistics().used_heap_size,
        });
      }
      if (url.pathname === '/gc') {
        globalThis.gc?.();
        return reply(200, { ok: typeof globalThis.gc === 'function' });
      }
      reply(404, { error: 'not found' });
    } catch (error) {
      reply(500, { error: String((error as Error)?.message ?? error) });
    }
  });
  /* Not a reason to stay up: the served process exits when its own servers close. */
  control.unref();
  control.listen(options.port, '0.0.0.0');
  await once(control, 'listening');
  return control;
}
