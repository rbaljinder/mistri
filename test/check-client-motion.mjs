/**
 * One static check over the client stylesheets: does the motion follow docs/design.md (Motion doctrine)?
 *
 * Refused: `transition: all` (it animates what nobody chose, layout included), `ease-in` (it starts slow, so a
 * press feels late; `ease-in-out` and the house `--ease-out` are fine), `scale(0)` (nothing appears from nothing),
 * a literal transition or animation longer than 300ms (chrome never earns more; tokens are checked where they are
 * declared), and a `:hover` rule outside `@media (hover: hover)` (a touch screen sticks in hover after a tap).
 *
 * What is on purpose says why beside it: `/* motion-ok: <why> *\/` on the line or within the two lines above. The
 * line that counts is the declaration, or for `:hover` the selector's.
 *
 * The `:hover` rules that predate the check are too many to wrap in one commit (some three hundred, most in the
 * Workbench's own sheets): they are counted per file in `client-motion.allow.json`. A file may hold fewer, never more,
 * and a count that fell is lowered with `node test/check-client-motion.mjs --write`, so the list only shrinks. A new
 * hover rule goes inside `@media (hover: hover)` and is not counted.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { relative } from 'node:path';
import { treeFiles } from '../scripts/workspace.mjs';

const files = [...treeFiles('src/client'), ...treeFiles('src', { recursive: false }).filter(({ pkg }) => pkg.dir === 'packages/ui')].filter(
  ({ rel }) => rel.endsWith('.css'),
);

const MOTION_PROP = /^(?:transition|transition-duration|transition-delay|animation|animation-duration)$/;
const ROOT = new URL('../', import.meta.url).pathname;
const ALLOW = `${ROOT}test/client-motion.allow.json`;
const failures = [];
const hovers = {};

/** The longest literal duration in a value, in ms (0 when it holds only tokens). */
function longest(value) {
  let max = 0;
  for (const m of value.matchAll(/(?<![\w.-])(\d*\.?\d+)(ms|s)\b/g)) max = Math.max(max, Number(m[1]) * (m[2] === 's' ? 1000 : 1));
  return max;
}

for (const { path, rel } of files) {
  const raw = readFileSync(path, 'utf8');
  /* Comments are blanked, not removed, so line numbers hold; the marker is read from the raw text. */
  const text = raw.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  const rawLines = raw.split('\n');
  const ok = (line) => rawLines.slice(Math.max(0, line - 3), line).some((l) => l.includes('motion-ok:'));
  const fail = (line, why) => {
    if (ok(line)) return;
    if (why.startsWith('`:hover`')) (hovers[relative(ROOT, path)] ??= []).push(line);
    else failures.push(`${rel}:${line}: ${why}: ${rawLines[line - 1].trim()}`);
  };

  /* A stack of open blocks: the prelude that opened each, for the at-rule context. */
  const stack = [];
  let prelude = '';
  let preludeLine = 1;
  let line = 1;
  let decl = '';
  let declLine = 1;
  const flushDecl = () => {
    const m = /^\s*([-\w]+)\s*:\s*([\s\S]*?)\s*$/.exec(decl);
    if (m) {
      const [, prop, value] = m;
      if (/^transition(?:-property)?$/.test(prop) && /(?<![-\w])all(?![-\w])/.test(value)) fail(declLine, '`transition: all`');
      if (/(?<![-\w])ease-in(?![-\w])/.test(value)) fail(declLine, '`ease-in`');
      if (/scale\(\s*0\s*[,)]/.test(value)) fail(declLine, '`scale(0)`');
      if (MOTION_PROP.test(prop) && longest(value) > 300) fail(declLine, 'duration over 300ms');
    }
    decl = '';
  };
  for (const ch of text) {
    if (ch === '{') {
      stack.push(prelude.trim());
      const p = prelude.trim();
      const inHover = stack.some((s) => /^@media[^{]*\(\s*hover\s*:\s*hover\s*\)/.test(s));
      if (!p.startsWith('@') && /:hover\b/.test(p) && !inHover) fail(preludeLine, '`:hover` outside `@media (hover: hover)`');
      prelude = '';
      decl = '';
    } else if (ch === '}') {
      flushDecl();
      stack.pop();
      prelude = '';
    } else if (ch === ';') {
      flushDecl();
      prelude = '';
    } else {
      if (!prelude.trim()) preludeLine = line;
      if (!decl.trim()) declLine = line;
      prelude += ch;
      decl += ch;
    }
    if (ch === '\n') line++;
  }
}

if (process.argv.includes('--write')) {
  const out = Object.fromEntries(
    Object.entries(hovers)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, v.length]),
  );
  writeFileSync(ALLOW, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`✓ wrote ${relative(ROOT, ALLOW)}`);
  process.exit(0);
}
const allowed = JSON.parse(readFileSync(ALLOW, 'utf8'));
for (const [file, at] of Object.entries(hovers)) {
  const may = allowed[file] ?? 0;
  if (at.length > may)
    failures.push(`${file}:${at.join(',')}: \`:hover\` outside \`@media (hover: hover)\` (${at.length}, ${may} allowed)`);
}
for (const [file, may] of Object.entries(allowed)) {
  const at = hovers[file]?.length ?? 0;
  if (at < may) failures.push(`${file}: ${at} unwrapped :hover rules, ${may} allowed: lower it (--write)`);
}

if (failures.length) {
  console.error('✗ motion outside the doctrine (docs/design.md, Motion doctrine):\n');
  for (const f of failures) console.error(`  ${f}`);
  console.error('\nFix it, or — only where it is on purpose — add `/* motion-ok: <why> */` on the line or just above.');
  process.exit(1);
}
const held = Object.values(allowed).reduce((a, b) => a + b, 0);
console.log(`✓ motion: ${files.length} stylesheets, ${held} older :hover rules still to wrap`);
