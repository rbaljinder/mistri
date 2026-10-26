/**
 * Flame graph pieces shared by profiles.mjs: a profile tree to folded stacks,
 * the heaviest functions by self weight, and one self-contained HTML flame graph
 * (no network, no library: it opens from a file). The .cpuprofile and .heapprofile
 * files themselves also load in Chrome DevTools and speedscope.
 */
import { basename } from 'node:path';

/** A frame's readable name and place. `source` is the TypeScript file:line the sampler mapped it to. */
export function frameName(cf) {
  const fn = cf.functionName || (cf.url ? '(anonymous)' : cf.functionName || '(program)');
  const raw =
    cf.source ??
    (cf.url ? `${cf.url.replace(/^file:\/\//, '').replace(/^.*\/node_modules\//, 'node_modules/')}:${(cf.lineNumber ?? 0) + 1}` : '');
  const where = raw.startsWith(process.cwd() + '/') ? raw.slice(process.cwd().length + 1) : raw; // relative to the repository
  return { fn, where, label: where ? `${fn} ${where}` : fn };
}

/** From a V8 CPU profile: nodes with `self` microseconds. */
export function cpuTree(profile) {
  const byId = new Map(profile.nodes.map((n) => [n.id, { cf: n.callFrame, self: 0, kids: [], id: n.id }]));
  for (const n of profile.nodes) for (const c of n.children ?? []) byId.get(n.id).kids.push(byId.get(c));
  const deltas = profile.timeDeltas ?? [];
  profile.samples.forEach((id, i) => {
    const n = byId.get(id);
    if (n) n.self += deltas[i + 1] ?? deltas[i] ?? 0;
  });
  return byId.get(profile.nodes[0].id);
}

/** From a V8 sampling heap profile: nodes with `self` bytes. */
export function heapTree(profile) {
  const conv = (n) => ({ cf: n.callFrame, self: n.selfSize, kids: (n.children ?? []).map(conv) });
  return conv(profile.head);
}

export function folded(root) {
  const lines = [];
  const walk = (n, path) => {
    const here = [...path, frameName(n.cf).label.replace(/;/g, ',')];
    if (n.self > 0) lines.push(`${here.join(';')} ${Math.round(n.self)}`);
    for (const k of n.kids) walk(k, here);
  };
  walk(root, []);
  return lines.join('\n') + '\n';
}

export function top(root, n = 25) {
  const by = new Map();
  const walk = (x) => {
    const f = frameName(x.cf);
    const key = f.fn + '|' + f.where;
    const e = by.get(key) ?? { function: f.fn, location: f.where, self: 0, nodes: 0 };
    e.self += x.self;
    e.nodes += 1;
    by.set(key, e);
    x.kids.forEach(walk);
  };
  walk(root);
  const all = [...by.values()];
  const total = all.reduce((t, e) => t + e.self, 0);
  return {
    total,
    top: all
      .sort((p, q) => q.self - p.self)
      .slice(0, n)
      .map((e) => ({ ...e, pct: +((e.self / total) * 100).toFixed(2) })),
  };
}

function compact(n) {
  const f = frameName(n.cf);
  const kids = n.kids.map(compact).filter((k) => k.v > 0);
  const v = n.self + kids.reduce((t, k) => t + k.v, 0);
  return { n: f.label, s: n.self, v, c: kids.sort((a, b) => b.v - a.v) };
}

export function flameHtml(root, { title, unit }) {
  const data = JSON.stringify(compact(root));
  return `<!doctype html><meta charset=utf-8><title>${title}</title>
<style>body{font:12px system-ui,sans-serif;margin:12px;background:#fff;color:#111}@media(prefers-color-scheme:dark){body{background:#15171a;color:#e6e6e6}}
h1{font-size:15px;margin:0 0 4px}#info{height:18px;margin:6px 0;font-family:ui-monospace,monospace}svg{width:100%}rect{stroke:#0002}text{pointer-events:none;font-size:11px;font-family:ui-monospace,monospace}
button{font:inherit}</style>
<h1>${title}</h1><div>Width is ${unit}; click a frame to zoom, <button id=reset>reset</button>. Frames are file:line of the TypeScript source where it could be mapped.</div><div id=info>&nbsp;</div><svg id=g></svg>
<script>
const root=${data}, W=1600, H=17, fmt=${unit === 'bytes' ? "v=>v>1048576?(v/1048576).toFixed(1)+' MB':(v/1024).toFixed(0)+' KB'" : "v=>(v/1000).toFixed(v>1e6?0:1)+' ms'"};
const svg=document.getElementById('g'), info=document.getElementById('info'); let top=root;
const hue=s=>/node_modules/.test(s)?210:/^\\(/.test(s)?30:/node:/.test(s)?270:(s.length*37)%60+0;
function draw(){svg.innerHTML='';const total=top.v;let maxd=0;const out=[];
 (function w(n,x,d){maxd=Math.max(maxd,d);const wd=n.v/total*W;if(wd<0.6)return;out.push([n,x,d,wd]);let cx=x;for(const c of n.c){w(c,cx,d+1);cx+=c.v/total*W}})(top,0,0);
 svg.setAttribute('viewBox','0 0 '+W+' '+((maxd+1)*H+4));
 for(const [n,x,d,wd] of out){const y=d*H;const r=document.createElementNS('http://www.w3.org/2000/svg','rect');r.setAttribute('x',x);r.setAttribute('y',y);r.setAttribute('width',Math.max(wd-.5,.5));r.setAttribute('height',H-1);
  r.setAttribute('fill','hsl('+hue(n.n)+',75%,'+(60+(n.s/n.v||0)*-20)+'%)');svg.appendChild(r);
  r.onmouseover=()=>info.textContent=n.n+'  total '+fmt(n.v)+' ('+(n.v/root.v*100).toFixed(1)+'%), self '+fmt(n.s);r.onclick=()=>{top=n;draw()};
  if(wd>40){const t=document.createElementNS('http://www.w3.org/2000/svg','text');t.setAttribute('x',x+3);t.setAttribute('y',y+12);t.setAttribute('fill','#000');t.textContent=n.n.slice(0,Math.floor(wd/6.2));svg.appendChild(t)}}}
document.getElementById('reset').onclick=()=>{top=root;draw()};draw();
</script>`;
}

export const label = (p) => basename(p).replace(/\.(cpuprofile|heapprofile)$/, '');
