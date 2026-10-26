/**
 * Soak monitor: runs beside k6 (which owns the load) and does what the load
 * driver used to do around it. Appends to <out>:
 *   db.ndjson        row counts, pg_database_size and free disk, every --db-interval s
 *   pgact.ndjson     pg_stat_activity once a second: sessions by state and wait event
 *   pgstat-*.json    pg_stat_statements at the start and the end of the hold
 *   control          commands for sampler.mjs: CPU profiles, the allocation profile, heap snapshots
 *   events.ndjson    what happened when
 * It aborts k6 when free disk falls under the floor.
 *
 *   node scripts/soak/monitor.mjs --pg postgres://... --out <dir> --server-pid <pid> --k6-pid <pid> \
 *     --stages 60:150,180:150,60:0 [--cpu-window 30]
 */
import { appendFileSync, mkdirSync, readFileSync, statfsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import pg from 'pg';

const { values: a } = parseArgs({
  options: {
    pg: { type: 'string' },
    out: { type: 'string' },
    'server-pid': { type: 'string' },
    'k6-pid': { type: 'string' },
    stages: { type: 'string' },
    'cpu-window': { type: 'string', default: '30' },
    'db-interval': { type: 'string', default: '30' },
    'no-profile': { type: 'boolean', default: false },
    'min-free-gb': { type: 'string', default: '4' },
    'min-free-pct': { type: 'string', default: '10' },
    start: { type: 'string' },
  },
});
for (const k of ['pg', 'out', 'stages']) if (!a[k]) throw new Error(`--${k} is required`);
mkdirSync(a.out, { recursive: true });
const stages = a.stages.split(',').map((x) => {
  const [s, v] = x.split(':').map(Number);
  return { s, to: v };
});
const total = stages.reduce((t, x) => t + x.s, 0);
// The hold: the longest stage that neither ramps up nor down.
let at = 0,
  from = 0,
  hold = { from: 0, to: total };
for (const st of stages) {
  if (st.to === from && st.to > 0) hold = { from: at, to: at + st.s };
  at += st.s;
  from = st.to;
}
const start = a.start ? Number(a.start) : Date.now();
const win = Number(a['cpu-window']);
const event = (e) => appendFileSync(join(a.out, 'events.ndjson'), JSON.stringify({ t: Date.now(), ...e }) + '\n');
const control = (line) => {
  appendFileSync(join(a.out, 'control'), line + '\n');
  event({ control: line });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const pool = new pg.Pool({ connectionString: a.pg, max: 2 });
pool.on('error', () => {});
let stopping = false;

async function dbSample() {
  const tables = (await pool.query('select relname from pg_stat_user_tables order by 1')).rows.map((r) => r.relname);
  const counts = {};
  for (const t of tables) counts[t] = Number((await pool.query(`select count(*) c from "${t}"`)).rows[0].c);
  const size = Number((await pool.query('select pg_database_size(current_database()) s')).rows[0].s);
  const fs = statfsSync('/');
  const free = fs.bavail * fs.bsize;
  const line = {
    t: Date.now(),
    up: Math.round((Date.now() - start) / 1000),
    counts,
    dbSizeBytes: size,
    freeDiskGB: +(free / 2 ** 30).toFixed(2),
    freeDiskPct: +((free / (fs.blocks * fs.bsize)) * 100).toFixed(2),
  };
  appendFileSync(join(a.out, 'db.ndjson'), JSON.stringify(line) + '\n');
  if (free / 2 ** 30 < Number(a['min-free-gb']) || line.freeDiskPct < Number(a['min-free-pct'])) {
    event({ abort: `free disk ${line.freeDiskGB} GB / ${line.freeDiskPct}% is under the floor` });
    if (a['k6-pid']) process.kill(Number(a['k6-pid']), 'SIGINT');
  }
}
async function activity() {
  const r =
    await pool.query(`select state, wait_event_type, wait_event, count(*)::int n, coalesce(max(extract(epoch from now()-xact_start)),0)::float max_xact_s
    from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() group by 1,2,3`);
  appendFileSync(
    join(a.out, 'pgact.ndjson'),
    JSON.stringify({ t: Date.now(), up: Math.round((Date.now() - start) / 1000), rows: r.rows }) + '\n',
  );
}
async function pgstat(label) {
  const r =
    await pool.query(`select queryid::text, calls::float, round(total_exec_time::numeric,1)::float total_ms, round(mean_exec_time::numeric,3)::float mean_ms,
    rows::float, left(regexp_replace(query, '\\s+', ' ', 'g'), 220) query from soak_ext.pg_stat_statements where dbid = (select oid from pg_database where datname = current_database())`);
  writeFileSync(join(a.out, `pgstat-${label}.json`), JSON.stringify(r.rows));
}
const P = !a['no-profile']; // profilers hold memory of their own; a leak run turns them off
const timeline = [
  [hold.from - 5, () => control(`snapshot ${Math.round((hold.from - 5) / 60)}min`)],
  [
    hold.from,
    () => {
      event({ phase: 'hold' });
      if (P) {
        control('cpu-start hold-start');
        control('heap-start');
      }
      pgstat('hold-start').catch((e) => event({ pgstatError: String(e) }));
    },
  ],
  [hold.from + win, () => P && control('cpu-stop')],
  [hold.to - win, () => P && control('cpu-start hold-end')],
  [
    hold.to,
    () => {
      if (P) {
        control('cpu-stop');
        control('heap-stop hold');
      }
      pgstat('hold-end').catch((e) => event({ pgstatError: String(e) }));
    },
  ],
  [hold.to + 5, () => control(`snapshot ${Math.round((hold.to + 5) / 60)}min`)],
]
  .filter(([s]) => s >= 0)
  .sort((x, y) => x[0] - y[0]);

event({ monitor: 'start', hold, total, win, profiled: P });
await dbSample().catch((e) => event({ dbError: String(e) }));
let nextDb = Date.now() + Number(a['db-interval']) * 1000;
while (!stopping) {
  await sleep(1000);
  if (a['k6-pid'] && !alive(Number(a['k6-pid']))) break;
  await activity().catch(() => {});
  const up = (Date.now() - start) / 1000;
  while (timeline.length && up >= timeline[0][0]) {
    const [, fn] = timeline.shift();
    fn();
  }
  if (Date.now() >= nextDb) {
    nextDb += Number(a['db-interval']) * 1000;
    await dbSample().catch((e) => event({ dbError: String(e) }));
  }
}
// A profile still open when k6 ends (an aborted run) is closed so the file exists.
if (P) {
  control('cpu-stop');
  control('heap-stop hold');
}
await sleep(3000);
await dbSample().catch(() => {});
await pool.end().catch(() => {});
event({ monitor: 'done' });
event({ phase: 'done' });
