/**
 * Turn the profiles a run wrote into flame graphs and top lists.
 *   node scripts/soak/profiles.mjs <dir>
 * For each <dir>/cpu-*.cpuprofile and <dir>/alloc-*.heapprofile writes beside it:
 *   <name>.folded        folded stacks (flamegraph.pl, speedscope and Brendan Gregg's tools read it)
 *   <name>.flame.html    a self-contained interactive flame graph
 *   <name>.top25.json    the 25 heaviest functions by self time (CPU) or bytes allocated (heap)
 * and flame-index.json, which names every file.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cpuTree, flameHtml, folded, heapTree, label, top } from './flame.mjs';

const dir = process.argv[2];
if (!dir) throw new Error('usage: profiles.mjs <dir>');
const index = [];
for (const f of readdirSync(dir).sort()) {
  const cpu = f.endsWith('.cpuprofile'),
    heap = f.endsWith('.heapprofile');
  if (!cpu && !heap) continue;
  const profile = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  const root = cpu ? cpuTree(profile) : heapTree(profile);
  const name = label(f);
  const t = top(root);
  const summary = cpu
    ? {
        kind: 'cpu',
        file: f,
        durationMs: +((profile.endTime - profile.startTime) / 1000).toFixed(0),
        sampledMs: +(t.total / 1000).toFixed(0),
        top: t.top.map(({ self, ...e }) => ({ ...e, selfMs: +(self / 1000).toFixed(1) })),
      }
    : { kind: 'allocation', file: f, sampledBytes: t.total, top: t.top.map(({ self, ...e }) => ({ ...e, bytes: Math.round(self) })) };
  writeFileSync(join(dir, `${name}.folded`), folded(root));
  writeFileSync(
    join(dir, `${name}.flame.html`),
    flameHtml(root, {
      title: `${name} (${cpu ? 'CPU self time' : 'bytes allocated, including freed objects'})`,
      unit: cpu ? 'time' : 'bytes',
    }),
  );
  writeFileSync(join(dir, `${name}.top25.json`), JSON.stringify(summary, null, 2));
  index.push({ name, kind: summary.kind, profile: f, folded: `${name}.folded`, flame: `${name}.flame.html`, top25: `${name}.top25.json` });
}
writeFileSync(join(dir, 'flame-index.json'), JSON.stringify(index, null, 2));
console.log(`${index.length} profiles processed`);
