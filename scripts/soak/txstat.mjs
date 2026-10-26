// Statements per write transaction, from a postgres.log made with SOAK_PG_LOG_STATEMENTS=1: node scripts/soak/txstat.mjs <postgres.log>
import { readFileSync } from 'node:fs';
const lines = readFileSync(process.argv[2], 'utf8').split('\n');
const open = new Map(),
  done = [];
let cur = null;
for (const l of lines) {
  const m = l.match(/^\d+\/(\d+):LOG:  (statement|execute [^:]*): (.*)$/);
  if (!m) {
    if (cur && /^\s/.test(l)) cur.q += ' ' + l.trim();
    continue;
  }
  const [, pid, , q] = m;
  cur = { q };
  if (q.startsWith('BEGIN')) open.set(pid, []);
  else if (/^COMMIT|^ROLLBACK/.test(q)) {
    const t = open.get(pid);
    if (t) {
      done.push(t);
      open.delete(pid);
    }
  } else if (open.has(pid)) open.get(pid).push(cur);
}
const kinds = {};
for (const t of done) {
  const w = t.find((s) => /^(INSERT|UPDATE|DELETE)/.test(s.q));
  if (!w) continue;
  const k = w.q.split(/\s+/).slice(0, 3).join(' ');
  (kinds[k] ??= []).push(t);
}
for (const [k, ts] of Object.entries(kinds)) {
  const counts = ts.map((t) => t.length + 2); // BEGIN and COMMIT
  const shapes = {};
  for (const t of ts)
    for (const s of t) {
      const key = s.q.slice(0, 70);
      shapes[key] = (shapes[key] ?? 0) + 1;
    }
  console.log(k, 'n=' + ts.length, 'statements incl BEGIN/COMMIT: min', Math.min(...counts), 'max', Math.max(...counts));
  for (const [s, n] of Object.entries(shapes)) console.log('   ', (n / ts.length).toFixed(2), s);
}
