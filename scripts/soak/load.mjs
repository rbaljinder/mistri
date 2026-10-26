/**
 * Soak load driver: N virtual users, each looping create -> read -> list ->
 * search -> update -> delete against a writable Compass over its own HTTP API
 * (/api/insert, /api/run, /api/update, /api/delete). Each user deletes what it
 * created, so the row count stays flat. Writes to <out>:
 *   requests.ndjson  one line per request {t, op, ms, status, ok, phase}
 *   db.ndjson        one line a minute: row counts, pg_database_size, free disk
 *   events.ndjson    phase changes, snapshot windows, an abort
 *
 *   node scripts/soak/load.mjs --url http://localhost:4777 --pg postgres://... \
 *     --out <dir> --server-pid <pid> [--vus 20] [--warmup 60] [--duration 540]
 *
 * Heap snapshots are asked of the server (SIGUSR2, see sampler.mjs) at
 * --snapshots seconds into the run, with the users paused while it writes.
 */
import { appendFileSync, createWriteStream, mkdirSync, readFileSync, statfsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import pg from 'pg';

const { values: a } = parseArgs({
  options: {
    url: { type: 'string' },
    pg: { type: 'string' },
    out: { type: 'string' },
    'server-pid': { type: 'string' },
    vus: { type: 'string', default: '20' },
    warmup: { type: 'string', default: '60' },
    duration: { type: 'string', default: '540' },
    snapshots: { type: 'string', default: '60,300,600' },
    think: { type: 'string', default: '40' },
    'min-free-gb': { type: 'string', default: '4' },
    'min-free-pct': { type: 'string', default: '10' },
    app: { type: 'string', default: 'compass' },
    'db-interval': { type: 'string', default: '60' },
    stages: { type: 'string', default: '' }, // "60:500,180:500,60:0": seconds:target users, ramped linearly (k6-style); replaces --vus/--warmup/--duration
  },
});
for (const k of ['url', 'pg', 'out']) if (!a[k]) throw new Error(`--${k} is required`);
const stages = a.stages
  ? a.stages.split(',').map((x) => {
      const [s, v] = x.split(':').map(Number);
      return { ms: s * 1000, to: v };
    })
  : null;
const vus = stages ? Math.max(...stages.map((x) => x.to)) : Number(a.vus);
const warmup = stages ? 0 : Number(a.warmup) * 1000;
const total = stages ? stages.reduce((t, x) => t + x.ms, 0) : warmup + Number(a.duration) * 1000,
  think = Number(a.think);
// The number of users that should be running now: linear between stage targets, starting from 0.
function target() {
  if (!stages) return vus;
  let at = Date.now() - start,
    from = 0;
  for (const st of stages) {
    if (at < st.ms) return Math.round(from + (st.to - from) * (at / st.ms));
    at -= st.ms;
    from = st.to;
  }
  return from;
}
function stageName() {
  if (!stages) return null;
  let at = Date.now() - start,
    from = 0;
  for (const st of stages) {
    if (at < st.ms) return st.to > from ? 'ramp-up' : st.to < from ? 'ramp-down' : 'hold';
    at -= st.ms;
    from = st.to;
  }
  return 'done';
}
mkdirSync(a.out, { recursive: true });
const reqs = createWriteStream(join(a.out, 'requests.ndjson'));
const event = (e) => appendFileSync(join(a.out, 'events.ndjson'), JSON.stringify({ t: Date.now(), ...e }) + '\n');

const start = Date.now();
let stopping = false,
  paused = false,
  abort = null,
  inflight = 0,
  active = 0;
const phase = () => (stages ? stageName() : Date.now() - start < warmup ? 'warmup' : 'load');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(op, path, body, check) {
  while (paused && !stopping) await sleep(50);
  const t = Date.now(),
    t0 = performance.now();
  let status = 0,
    ok = false,
    json = null;
  inflight += 1;
  try {
    const res = await fetch(a.url + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app: a.app, ...body }),
    });
    status = res.status;
    json = await res.json().catch(() => null);
    ok = status === 200 && !!json && !json.errors?.length && !json.error && json.outcome !== 'rejected' && (check ? check(json) : true);
  } catch {
    status = 0;
  } finally {
    inflight -= 1;
  }
  const ms = +(performance.now() - t0).toFixed(2);
  reqs.write(JSON.stringify({ t, op, ms, status, ok, phase: phase(), vus: active }) + '\n');
  if (think) await sleep(Math.random() * think * 2); // between requests, so the load is busy rather than saturated
  return { ok, json };
}

const list = (q, exactCount = false) => ({ q, limit: 25, offset: 0, exactCount });
async function user(n) {
  let seq = 0;
  while (!stopping) {
    // A user past the current target idles; it only stops between loops, so it always deletes what it created.
    if (n >= target()) {
      await sleep(100);
      continue;
    }
    active += 1;
    try {
      await loop(n, seq++);
    } finally {
      active -= 1;
    }
  }
}
async function loop(n, seq) {
  {
    const id = 10_000_000 + n * 1_000_000 + seq;
    const token = `soak${n}x${seq}`;
    const created = await call('create', '/api/insert', {
      table: 'lead',
      values: {
        id,
        name: `Pat ${token}`,
        company: `Soak Co ${n}`,
        email: `${token}@soak.test`,
        status: 'new',
        source: 'web',
        owner_id: 1 + (id % 8),
        created_on: '2026-10-04',
      },
    });
    if (created.ok) {
      await call('read', '/api/run', list(`lead id = ${id}`), (j) => j.rows?.length === 1);
      await call('list', '/api/run', list(`lead status = new`, true));
      await call('search', '/api/run', list(`lead name contains ${token}`), (j) => j.rows?.length === 1);
      await call('list-opportunity', '/api/run', list(`opportunity amount > ${50000 + (seq % 5) * 10000}`));
      await call('update', '/api/update', { table: 'lead', key: { id }, values: { status: 'working' } }, (j) => j.affected === 1);
      await call('count', '/api/counts', { items: ['lead status = new', 'lead status = working'] }, (j) => j.results?.length === 2);
      await call('delete', '/api/delete', { table: 'lead', key: { id }, confirm: true }, (j) => j.deleted === true);
    } else await sleep(200); // a refused create is already counted; do not spin
  }
}

const pool = new pg.Pool({ connectionString: a.pg, max: 1 });
async function dbSample() {
  const tables = (await pool.query('select relname from pg_stat_user_tables order by 1')).rows.map((r) => r.relname);
  const counts = {};
  for (const t of tables) counts[t] = Number((await pool.query(`select count(*) c from "${t}"`)).rows[0].c);
  const size = Number((await pool.query('select pg_database_size(current_database()) s')).rows[0].s);
  const fs = statfsSync('/');
  const freeBytes = fs.bavail * fs.bsize,
    totalBytes = fs.blocks * fs.bsize;
  const line = {
    t: Date.now(),
    up: Math.round((Date.now() - start) / 1000),
    counts,
    dbSizeBytes: size,
    freeDiskGB: +(freeBytes / 2 ** 30).toFixed(2),
    freeDiskPct: +((freeBytes / totalBytes) * 100).toFixed(2),
  };
  appendFileSync(join(a.out, 'db.ndjson'), JSON.stringify(line) + '\n');
  if (freeBytes / 2 ** 30 < Number(a['min-free-gb']) || line.freeDiskPct < Number(a['min-free-pct'])) {
    abort = `free disk ${line.freeDiskGB} GB / ${line.freeDiskPct}% is under the floor`;
    event({ abort });
    stopping = true;
  }
}

async function snapshot(label) {
  const sampleFile = join(a.out, 'server.ndjson');
  paused = true;
  while (inflight > 0) await sleep(20);
  writeFileSync(join(a.out, 'snapshot.label'), label);
  event({ snapshot: label, state: 'start' });
  process.kill(Number(a['server-pid']), 'SIGUSR2');
  for (let i = 0; i < 1200; i++) {
    // up to 2 minutes
    await sleep(100);
    if (readFileSync(sampleFile, 'utf8').includes(`heap-${label}.heapsnapshot`)) break;
  }
  event({ snapshot: label, state: 'end' });
  paused = false;
}

event({ phase: stages ? 'ramp-up' : 'warmup', vus, warmupS: warmup / 1000, totalS: total / 1000, stages: a.stages || null });
await dbSample();
const users = Array.from({ length: vus }, (_, n) => user(n));
let lastPhase = phase();
const snaps = a.snapshots ? a.snapshots.split(',').map(Number).filter(Boolean) : [];
let nextDb = Date.now() + Number(a['db-interval']) * 1000;
while (!stopping && Date.now() - start < total) {
  await sleep(250);
  if (phase() !== lastPhase) {
    lastPhase = phase();
    event({ phase: lastPhase });
  }
  if (stages && Date.now() - (globalThis.lastVuEvent ?? 0) >= 5000) {
    globalThis.lastVuEvent = Date.now();
    event({ vus: target(), active });
  }
  if (Date.now() >= nextDb) {
    nextDb += Number(a['db-interval']) * 1000;
    await dbSample().catch((e) => event({ dbError: String(e) }));
  }
  if (snaps.length && Date.now() - start >= snaps[0] * 1000) {
    const s = snaps.shift();
    if (a['server-pid']) await snapshot(`${Math.round(s / 60)}min`);
  }
}
stopping = true;
await Promise.all(users);
await dbSample().catch(() => {});
await pool.end();
reqs.end();
event({ phase: 'done', abort });
process.exit(abort ? 3 : 0);
