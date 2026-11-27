import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import postcss from 'postcss';
import { PART_SELECTORS } from '../packages/mistri/src/server/app/themePartSelectors.js';

/**
 * A theme's part rule is in `@layer theme`, and `@layer structure` comes after it: a structure rule that sets the
 * same property on the same element wins, whatever the theme declared. A field report found a declared page
 * ground (`parts: { ground: { ground: … } }`) drawn in the sidebar shell as the plain surface, because the pane's
 * structure said `background: var(--surface)`. Structure is where the shell's geometry lives and it stays last, so
 * a property a part may set is said there through the part's own token (`var(--part-ground-ground, var(--surface))`),
 * and the declared part wins without any layer moving.
 *
 * Honest and simple, not a selector engine: a part's subject is its last compound (`.content` of
 * `.app-mode .content`); a structure rule meets it when its own last compound shares a class (or the id, or the
 * element when neither has a class) and does not say the opposite of an attribute the part's says. That
 * over-reaches on purpose (ancestors are ignored, so a rule for a context the part never reaches still counts); a
 * rule that truly cannot meet the part's element goes in ALLOWED with the reason.
 */

const ROOT = new URL('..', import.meta.url).pathname;
const SHEETS = ['packages/kit/src/client', 'packages/mistri/src/client', 'packages/ui/src/styles'];

/** Which of the properties a part rule sets (themePartSelectors.ts DRAWN), as longhands, a declaration sets. A border said away (`border: 0`) draws no line for a part's edge to
    color, so it sets none: a part's edge colors a line, it never draws one. */
const touches = (property: string, value: string): string[] => {
  const p = property.toLowerCase();
  if (p.startsWith('--')) return [];
  const out: string[] = [];
  if (p === 'background' || p === 'background-color') out.push('background-color');
  if (p === 'color') out.push('color');
  if (/^border(-(top|right|bottom|left|block|inline)(-(start|end))?)?(-color)?$/.test(p) && !/^(0|none)$/.test(value.trim()))
    out.push('border-color');
  if (/^border(-(top|bottom|start|end)-(left|right|start|end))?-radius$/.test(p)) out.push('border-radius');
  if (p === 'box-shadow') out.push('box-shadow');
  if (p === 'font') out.push('font-family', 'font-weight', 'font-variant-caps');
  if (p === 'font-family' || p === 'font-weight' || p === 'text-transform' || p === 'letter-spacing') out.push(p);
  if (p === 'font-variant' || p === 'font-variant-caps') out.push('font-variant-caps');
  return out;
};

/** Words that let a structure rule through: it reads a part's token, so the declared part wins where it is said. */
const readsPart = (value: string, slug: string) => value.includes(`var(--part-${slug}-`);

/**
 * Rules that meet a part's selector here but never its element, or that the part does not mean to move. Each
 * says why. Keyed `file :: selector :: property`.
 */
const ALLOWED: Record<string, string> = {
  'packages/kit/src/client/structure.css :: .tone.tone-figure :: border-radius':
    "A toned figure is its tone's ink and nothing else, whatever a status is drawn as: no pill, no tint, no lift.",
  'packages/kit/src/client/structure.css :: .tone.tone-figure :: background': 'As above: a figure is never a pill.',
  'packages/kit/src/client/structure.css :: .tone.tone-figure :: box-shadow': 'As above: a figure is never a pill.',
  'packages/kit/src/client/structure.css :: .tone.tone-figure :: font': 'As above: a figure keeps the face of the line it stands in.',
  'packages/kit/src/client/structure.css :: .calendar-card-mark .tone :: background':
    "A calendar card's status is a dot (its ::before), not the part's pill.",
  'packages/kit/src/client/structure.css :: .calendar-card-mark .tone :: box-shadow': "As above: the card's mark is a dot.",
  'packages/kit/src/client/structure.css :: .calendar-card-mark .tone::before :: border-radius': 'The dot itself: round, in its tone.',
  'packages/kit/src/client/structure.css :: .calendar-card-mark .tone::before :: background': 'The dot itself: round, in its tone.',
  'packages/kit/src/client/structure.css :: .table-wrap tbody tr.grid-group-head :: background':
    "A group's head is a hairline between rows, not a row a reader opens: the row part's fill is not meant for it.",
  'packages/kit/src/client/structure.css :: .table-wrap tbody tr.grid-group-head > td :: background':
    "As above: a group's head cell is not a data row's primary cell.",
  'packages/kit/src/client/structure.css :: .app-mode .calendar-grid tbody tr:hover > td.calendar-day :: background':
    'A calendar grid is not in a .table-wrap; it shares only .app-mode with table.primary.',
  'packages/kit/src/client/structure.css :: .app-mode .calendar-grid tbody tr:hover > td.calendar-day.is-outside :: background':
    'As above: a calendar day cell, never inside .table-wrap.',
  'packages/mistri/src/client/components/CalendarList.css :: .app-mode .calendar-grid tbody tr:hover > td.calendar-day[data-backdrop] :: background':
    'As above: a calendar day cell, never inside .table-wrap.',
  'packages/mistri/src/client/components/DashboardBlocks.css :: .kit-card-part > .page-section :: border-radius':
    "A block inside a kit Card is not a section: the Card is its frame, and a theme's section dressing it drew a panel inside the panel.",
  'packages/mistri/src/client/components/DashboardBlocks.css :: .kit-card-part > .page-section :: background': 'As above.',
  'packages/mistri/src/client/components/DashboardBlocks.css :: .kit-card-part > .page-section :: box-shadow': 'As above.',
  'packages/mistri/src/client/components/DashboardBlocks.css :: .kit-card-part > .page-section > .home-cards > .home-card :: border-radius':
    "A metric inside a kit Card is the Card's figure, not a stat card of its own inside it.",
  'packages/mistri/src/client/components/DashboardBlocks.css :: .kit-card-part > .page-section > .home-cards > .home-card :: background':
    'As above.',
  'packages/mistri/src/client/components/DashboardBlocks.css :: .kit-card-part > .page-section > .home-cards > .home-card :: box-shadow':
    'As above.',
};

type Compound = {
  classes: Set<string>;
  ids: Set<string>;
  tag: string;
  attrs: Map<string, string | null>;
  negated: Map<string, string | null>;
  /** Every class the whole selector names: a bare element (`th`) is told apart by the ancestor that names it. */
  context: Set<string>;
};

/** The last compound of a selector, read for what it names. */
function subject(selector: string): Compound {
  // Drop pseudo-elements and functional pseudo-classes except :not(), whose attributes say what the element is not.
  const parts = selector.trim().split(/\s*[\s>+~]\s*(?![^([]*[)\]])/);
  const last = parts[parts.length - 1] ?? '';
  const negated = new Map<string, string | null>();
  const withoutNot = last.replace(/:not\(([^()]*(?:\([^()]*\))?[^()]*)\)/g, (_m, inner: string) => {
    for (const attr of inner.matchAll(/\[([\w-]+)(?:[~|^$*]?=["']?([^"'\]]*)["']?)?\]/g)) negated.set(attr[1]!, attr[2] ?? null);
    return '';
  });
  const bare = withoutNot.replace(/:{1,2}[\w-]+(\((?:[^()]|\([^()]*\))*\))?/g, '');
  const attrs = new Map<string, string | null>();
  for (const attr of bare.matchAll(/\[([\w-]+)(?:[~|^$*]?=["']?([^"'\]]*)["']?)?\]/g)) attrs.set(attr[1]!, attr[2] ?? null);
  const plain = bare.replace(/\[[^\]]*\]/g, '');
  return {
    classes: new Set([...plain.matchAll(/\.([\w-]+)/g)].map((m) => m[1]!)),
    ids: new Set([...plain.matchAll(/#([\w-]+)/g)].map((m) => m[1]!)),
    tag: /^[a-z][\w-]*/i.exec(plain)?.[0]?.toLowerCase() ?? '',
    attrs,
    negated,
    context: new Set([...selector.matchAll(/\.([\w-]+)/g)].map((m) => m[1]!)),
  };
}

/** Whether a structure compound may land on a part's element. */
function meets(part: Compound, rule: Compound): boolean {
  for (const [name, value] of part.attrs) if (rule.negated.has(name) && (rule.negated.get(name) ?? null) === value) return false;
  for (const [name, value] of rule.attrs) if (part.negated.has(name) && (part.negated.get(name) ?? null) === value) return false;
  for (const [name, value] of part.attrs)
    if (rule.attrs.has(name) && value !== null && rule.attrs.get(name) !== null && rule.attrs.get(name) !== value) return false;
  if (part.classes.size) return [...part.classes].some((name) => rule.classes.has(name));
  if (part.ids.size) return [...part.ids].some((name) => rule.ids.has(name));
  if (part.attrs.size && !part.tag) return [...part.attrs.keys()].every((name) => rule.attrs.has(name)) && rule.classes.size === 0;
  /* A bare element is the part's only inside the ancestor the part names (`.table-wrap thead th`). */
  return part.tag !== '' && part.tag === rule.tag && [...part.context].some((name) => rule.context.has(name));
}

/** Every selector a nested rule stands for, `&` resolved against its parent rules. */
function selectorsOf(rule: postcss.Rule): string[] {
  const own = rule.selectors;
  const parent = rule.parent;
  if (!parent || parent.type !== 'rule') return own;
  const outer = selectorsOf(parent as postcss.Rule);
  return outer.flatMap((above) => own.map((selector) => (selector.includes('&') ? selector.replace(/&/g, above) : `${above} ${selector}`)));
}

/** Whether a node sits in `@layer structure`. */
function inStructure(node: postcss.Node): boolean {
  for (let at = node.parent; at; at = at.parent) {
    if (at.type === 'atrule' && (at as postcss.AtRule).name === 'layer') return (at as postcss.AtRule).params.trim() === 'structure';
  }
  return false;
}

const sheets = (dir: string): string[] =>
  readdirSync(join(ROOT, dir)).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(join(ROOT, path)).isDirectory()) return sheets(path);
    return name.endsWith('.css') ? [path] : [];
  });

test("a structure rule never sets, on a part's element, a property the part's theme rule sets, except through the part's token", () => {
  const parts = Object.entries(PART_SELECTORS).map(([part, selectors]) => ({
    part,
    slug: part.replace(/\./g, '-'),
    subjects: selectors.split(', ').map(subject),
  }));
  const found: string[] = [];
  let structureRules = 0;
  for (const file of SHEETS.flatMap(sheets)) {
    const root = postcss.parse(readFileSync(join(ROOT, file), 'utf8'), { from: file });
    root.walkRules((rule) => {
      if (!inStructure(rule)) return;
      structureRules++;
      for (const selector of selectorsOf(rule)) {
        const compound = subject(selector);
        for (const { part, slug, subjects } of parts) {
          if (!subjects.some((own) => meets(own, compound))) continue;
          rule.each((node) => {
            if (node.type !== 'decl') return;
            for (const property of touches(node.prop, node.value)) {
              if (readsPart(node.value, slug)) continue;
              const key = `${file} :: ${selector} :: ${node.prop}`;
              if (key in ALLOWED) continue;
              found.push(`${key} — sets ${property}, which the ${part} part sets`);
            }
          });
        }
      }
    });
  }
  assert.ok(structureRules > 100, `the structure layer was read (${structureRules} rules)`);
  assert.deepEqual(found, []);
});

test("a declared page ground is read by the sidebar shell's pane and its bar, in every pane recipe", () => {
  const css = ['packages/kit/src/client/structure.css', 'packages/kit/src/client/themeFamilies.css']
    .map((file) => readFileSync(join(ROOT, file), 'utf8'))
    .join('\n');
  for (const pane of ['.layout > .content {', '.layout > .pane-bar {']) {
    const at = css.indexOf(`body.app-sidebar-shell ${pane}`);
    assert.ok(at >= 0, pane);
    assert.match(css.slice(at, css.indexOf('}', at)), /background: var\(--part-ground-ground, var\(--surface\)\)/, pane);
  }
});
