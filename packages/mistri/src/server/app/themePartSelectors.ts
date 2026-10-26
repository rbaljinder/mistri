/**
 * Which elements each published part names (themeParts.ts): the platform's half of the parts contract. A theme says
 * `stat` and `[data-part="stat"]`; the platform says where a stat is drawn. Kept as one map instead of a `data-part`
 * attribute on each component, so the hooks cost the page nothing and a part follows its markup when a component is
 * rewritten — test/theme-parts.test.ts holds partsLook.css to what it generates, and e2e/theme-expression.spec.ts holds that every
 * part still matches an element on a page that draws it, so a hook cannot vanish silently.
 *
 * Each selector is under `.app-mode`: parts dress an App, never the database browser's chrome.
 */
import type { ThemePart } from '@mistriwork/engine/schema/theme.js';

const app = (...selectors: string[]) => selectors.map((selector) => `.app-mode ${selector}`).join(', ');

export const PART_SELECTORS: Record<ThemePart, string> = {
  ground: '.app-mode .content',
  bar: app('.topbar'),
  'bar.search': app('.tn-search'),
  nav: app('.sidebar', '.tn-wide'),
  'nav.item': app('.sidebar .app-nav-target:not([aria-current="true"])', '.tn-item:not([aria-current="true"])'),
  'nav.current': app('.sidebar .app-nav-target[aria-current="true"]', '.tn-item[aria-current="true"]'),
  'nav.group': app('.sidebar .nav-group', '.tn-group'),
  logo: app('.brand-mark'),
  'page.title': app('.root-current', '.applist-title'),
  tabs: app('.page-tabstrip'),
  'tab.current': app('.page-tab[aria-selected="true"]'),
  section: app('.page-section'),
  'section.title': app('.page-section-title'),
  stat: app('.home-card'),
  'stat.figure': app('.home-card-value', '.page-headline-figure'),
  fields: app('.page-fields'),
  'field.label': app('.page-field > dt', '.applist-field-label', '.form-field-label'),
  table: app('.table-wrap'),
  'table.head': app('.table-wrap thead th'),
  'table.row': app('.table-wrap tbody tr'),
  status: app('.tone'),
  tag: app('.record-tag'),
  'button.primary': app('.btn-primary'),
  'button.secondary': app('.btn-secondary'),
  'button.quiet': app('.btn-quiet'),
  link: app('.reflink', '.ref-jump', '.value-link'),
  'board.lane': app('.board-lane'),
  'board.card': app('.board-card', '.triage-card'),
  'workflow.step': app('.workflow-steps > li'),
  banner: app('.dashboard-note'),
  'steps.step': app('.dash-step'),
  avatar: app('.page-record-avatar', '.account-avatar'),
  menu: app('.tn-pop', '.th-menu', '.page-actions-menu'),
  dialog: app('.modal'),
  chart: app('.chart-host'),
};

/** The selectors a part is drawn with. */
export const partSelector = (part: string): string => PART_SELECTORS[part as ThemePart];

/** What each property a part style says is drawn as: the CSS properties, each reading its `--part-*` token. */
const DRAWN: Record<string, readonly (readonly [string, string])[]> = {
  ground: [['background', 'ground']],
  ink: [['color', 'ink']],
  edge: [['border-color', 'edge']],
  radius: [['border-radius', 'radius']],
  lift: [['box-shadow', 'lift']],
  face: [['font-family', 'face']],
  weight: [['font-weight', 'weight']],
  case: [
    ['text-transform', 'transform'],
    ['font-variant-caps', 'caps'],
    ['letter-spacing', 'tracking'],
  ],
};
/** The page's and the menu's grounds are a color under the theme's pattern (surface), never in place of it. */
const UNDER_PATTERN: ReadonlySet<string> = new Set(['ground', 'nav', 'bar']);
/** The parts a pointer lights: a hover is the part's ground a step toward its ink, so it still shows. */
const HOVERED: ReadonlySet<string> = new Set(['nav.item', 'button.primary', 'button.secondary', 'button.quiet', 'board.card', 'table.row']);

/**
 * partsLook.css, generated: one rule per part and property, on only while a worn theme's `data-parts` says that
 * word, in the `theme` layer. test/theme-parts.test.ts holds the committed file to this
 * (`node --import tsx scripts/theme-parts-css.mjs` writes it).
 */
export function partsSheet(): string {
  const rules: string[] = [];
  for (const [part, selectors] of Object.entries(PART_SELECTORS)) {
    const slug = part.replace(/\./g, '-');
    const on = (word: string, list = selectors) =>
      list
        .split(', ')
        .map((selector) => `:root[data-parts~="${part}:${word}"] ${selector}`)
        .join(',\n    ');
    for (const [word, drawn] of Object.entries(DRAWN)) {
      const declarations = drawn.map(([property, token]) => {
        const name = property === 'background' && UNDER_PATTERN.has(part) ? 'background-color' : property;
        return `${name}: var(--part-${slug}-${token});`;
      });
      rules.push(`  ${on(word)} {\n    ${declarations.join('\n    ')}\n  }`);
    }
    if (HOVERED.has(part)) {
      const hovered = selectors
        .split(', ')
        .map((selector) => `${selector}:hover`)
        .join(', ');
      rules.push(
        `  ${on('ground', hovered)} {\n    background: color-mix(in srgb, var(--part-${slug}-ground) 90%, var(--part-${slug}-ink, currentcolor));\n  }`,
      );
    }
  }
  return `/* Generated from packages/mistri/src/server/app/themePartSelectors.ts by scripts/theme-parts-css.mjs: do not edit. A theme's part
   styles (parts in a theme, docs/theming.md), each rule on only while the worn theme's data-parts names it, so
   a theme without parts fetches nothing and draws as its look does. */
@layer theme {
${rules.join('\n')}
}
`;
}
