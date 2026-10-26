/**
 * One static check over the client modules: does everything that measures
 * the screen use the zoom-aware ruler?
 *
 * The density preference puts a CSS `zoom` on the root element, which
 * splits the client into two coordinate systems: getBoundingClientRect
 * (and window.innerWidth/Height) answer in real screen pixels, while a
 * `top`/`left` set on a fixed element — and scrollTop, offsetTop, spacer
 * heights — live in layout pixels. Mixing the two puts an overlay a room
 * away from its anchor, or makes a virtualised scrollbar disagree with its
 * rows by 12% per row. There is one ruler (`viewportScale`, `viewportBox`,
 * `viewportSize`: packages/ui/src/ruler.ts, which core.js re-exports); this check makes using it the default
 * rather than the remembered extra. The rule lived in prose first, and the
 * same commit that wrote it down missed two files — which is exactly the
 * kind of mistake these checks exist for.
 *
 * A raw read is allowed only when it is genuinely same-ruler — compared
 * against another raw read or an event's clientX/Y, never fed to a style
 * or a scroll position — and says so: a comment containing `screen-px:`
 * on the offending line or within the two lines above it.
 */
import { readFileSync } from 'node:fs';
import { treeFiles } from '../scripts/workspace.mjs';

/* Nothing is exempt wholesale: the ruler itself is the ui package's, outside
   these trees. diagram.js looked like a closed screen-pixel system and was
   not: its numbers end in an SVG transform, which is layout units. */
const ALLOWLISTED_FILES = new Set();

const RAW = /\.getBoundingClientRect\(|window\.inner(?:Width|Height)\b/;

const failures = [];
for (const { path, rel: file } of treeFiles('src/client', { recursive: false }).filter((f) => f.rel.endsWith('.js'))) {
  if (ALLOWLISTED_FILES.has(file)) continue;
  const lines = readFileSync(path, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (!RAW.test(line)) return;
    const context = lines.slice(Math.max(0, i - 2), i + 1).join('\n');
    if (context.includes('screen-px:')) return;
    failures.push(`${file}:${i + 1}: ${line.trim()}`);
  });
}

if (failures.length) {
  console.error('✗ raw screen-pixel reads outside the zoom-aware ruler:\n');
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    '\nUse viewportBox/viewportSize from core.js (layout pixels, the ruler ' +
      'style.top and scrollTop speak), or — only for a genuinely same-ruler ' +
      'comparison — add a comment containing `screen-px: <why>` beside the read.',
  );
  process.exit(1);
}
console.log('✓ client geometry: every screen measurement goes through the zoom-aware ruler');
