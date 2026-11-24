import type { Page } from './harness';

/**
 * A geometric probe for labels that are drawn over one another, and the wait that makes a geometric probe worth
 * taking.
 *
 * Why it exists: a gallery that asserted a clean console, no sideways scroll and a bounded height shipped a calendar
 * whose hour labels sat on top of each other, and a Gantt ruler, a waterfall axis and a line chart whose tick labels
 * ran into their neighbours. None of that throws, scrolls or grows the page. The labels of one axis or header row are
 * siblings that must each be readable, so two whose ink intersects is a fault whatever the look or the width.
 */

/** One axis or header row: the element that holds the labels, and which of its descendants are labels. */
export interface LabelRow {
  /** What a fault is named by. */
  name: string;
  /** Each match is one row: labels are compared within a row, never across two. */
  row: string;
  /** The labels inside a row. Absent, every descendant that holds text of its own. */
  labels?: string;
}

/** The axis and header rows the UI entry points draw (`@mistriwork/ui` charts and views). */
export const AXIS_ROWS: readonly LabelRow[] = [
  /* A cartesian chart's ticks, both axes: one svg is one row, since an x label under a y label is as unreadable. */
  { name: 'chart axis', row: 'svg', labels: '.nx-chart-axis-text, .nx-radar-axis-label' },
  /* The spans axis under a calendar's hours and a Gantt's ruler. */
  { name: 'spans axis', row: '[data-slot="spans-axis"]', labels: '[data-slot="spans-axis-label"]' },
  { name: 'waterfall axis', row: '.nx-waterfall-axis', labels: '.nx-waterfall-tick' },
  { name: 'waterfall header', row: '.nx-waterfall-header-row', labels: '.nx-waterfall-col-name, .nx-waterfall-col-dur' },
  { name: 'gantt sheet head', row: '.nx-gantt-sheet-head' },
  { name: 'calendar weekdays', row: '.nx-calendar-weekdays' },
  { name: 'heatmap header', row: '.nx-heatmap-header-row' },
];

export interface LabelOverlapReading {
  /** One line per pair of labels whose ink intersects. */
  faults: string[];
  /** The rows that were measured (two labels or more drawn), by name: a spec holds a page to the rows it must show,
      so a renamed class cannot pass by matching nothing. */
  seen: string[];
}

/**
 * Every pair of sibling labels inside one row whose drawn text intersects by more than `slack` pixels both ways.
 * A label is measured by its text's own box (a range over its contents; an SVG text by its bounding box), not its
 * element's, so a cell that is wider than its words does not count as touching its neighbour.
 */
export function overlappingLabels(
  page: Page,
  rows: readonly LabelRow[] = AXIS_ROWS,
  options: { scope?: string; slack?: number } = {},
): Promise<LabelOverlapReading> {
  return page.evaluate(
    ({ rows, scope, slack }) => {
      const root = document.querySelector(scope) ?? document.body;
      const faults: string[] = [];
      const seen = new Set<string>();
      const drawn = (element: Element) => {
        for (let at: Element | null = element; at; at = at.parentElement) {
          const style = getComputedStyle(at);
          if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
        }
        return true;
      };
      const ownText = (element: Element) =>
        [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== '');
      const inkOf = (element: Element): DOMRect | undefined => {
        if (element instanceof SVGElement) return element.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(element);
        const box = range.getBoundingClientRect();
        /* What the element clips is not ink: a label cut by its own cell is measured as the cell shows it. */
        const cell = element.getBoundingClientRect();
        const left = Math.max(box.left, cell.left);
        const top = Math.max(box.top, cell.top);
        const right = Math.min(box.right, cell.right);
        const bottom = Math.min(box.bottom, cell.bottom);
        return right > left && bottom > top ? new DOMRect(left, top, right - left, bottom - top) : undefined;
      };
      for (const { name, row, labels } of rows) {
        for (const holder of root.querySelectorAll(row)) {
          const candidates = labels ? [...holder.querySelectorAll(labels)] : [...holder.querySelectorAll('*')].filter(ownText);
          const measured = candidates.flatMap((element) => {
            const said = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
            if (!said || !drawn(element)) return [];
            const ink = inkOf(element);
            return ink && ink.width > 0 && ink.height > 0 ? [{ element, said, ink }] : [];
          });
          if (measured.length < 2) continue;
          seen.add(name);
          for (let a = 0; a < measured.length; a++) {
            for (let b = a + 1; b < measured.length; b++) {
              const [one, other] = [measured[a]!, measured[b]!];
              /* A label inside another is one label's parts (a day and its number), not two siblings. */
              if (one.element.contains(other.element) || other.element.contains(one.element)) continue;
              const wide = Math.min(one.ink.right, other.ink.right) - Math.max(one.ink.left, other.ink.left);
              const tall = Math.min(one.ink.bottom, other.ink.bottom) - Math.max(one.ink.top, other.ink.top);
              if (wide > slack && tall > slack)
                faults.push(`${name}: "${one.said}" and "${other.said}" overlap by ${Math.round(wide)}x${Math.round(tall)}px`);
            }
          }
        }
      }
      return { faults, seen: [...seen] };
    },
    { rows: rows.map((each) => ({ ...each })), scope: options.scope ?? '.free-page-body', slack: options.slack ?? 1 },
  );
}

/**
 * Waits until a free-form page is drawn as a reader will see it: every linked stylesheet parsed, the faces loaded,
 * the `surfaces` cascade layer holding rules wherever the page draws one of its parts (`.nx-*`: the stylesheets the
 * charts, primitives and views load on demand, kit `sdk/surfaces-*.css`), and the page's height the same across two
 * frames. A geometric probe taken before that measures unstyled or half-arrived parts and passes by luck.
 *
 * Each entry point brings its own sheets (base, then charts, primitives, views as it needs them), all into that one
 * layer. An entry's sheets are linked together before its module runs, so the first of them holding rules, with
 * every link parsed (above), is all of them.
 *
 * It waits on conditions, not on a clock, so a page that is already settled costs two frames.
 * `surfaces: false` is for a page that imports none of the on-demand modules, which never loads that stylesheet.
 */
export async function settleSurfaces(page: Page, scope = '.free-page-body', timeout = 30_000, surfaces = true): Promise<void> {
  await page.waitForFunction(
    ({ scope, surfaces }) => {
      const body = document.querySelector(scope);
      if (!body || !body.querySelector(':scope *')) return false;
      for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) if (!link.sheet) return false;
      if (document.fonts.status !== 'loaded') return false;
      /* A page that imports none of the on-demand modules never asks for the sheet, whatever its kit parts are classed. */
      if (!surfaces || !body.querySelector('[class^="nx-"], [class*=" nx-"]')) return true;
      /* The layer's name alone is always there (the order statement names it): what is waited for is its rules. */
      const holdsSurfaces = (rules: CSSRuleList): boolean => {
        for (const rule of rules) {
          if (rule instanceof CSSLayerBlockRule && rule.name.split('.').includes('surfaces') && rule.cssRules.length) return true;
          if (rule instanceof CSSImportRule) {
            try {
              if (rule.layerName === 'surfaces' && rule.styleSheet?.cssRules.length) return true;
              if (rule.styleSheet && holdsSurfaces(rule.styleSheet.cssRules)) return true;
            } catch {
              /* Another origin's sheet: not ours to read, and not where the layer is. */
            }
          } else if ('cssRules' in rule && holdsSurfaces((rule as CSSGroupingRule).cssRules)) return true;
        }
        return false;
      };
      for (const sheet of document.styleSheets) {
        try {
          if (holdsSurfaces(sheet.cssRules)) return true;
        } catch {
          /* As above. */
        }
      }
      return false;
    },
    { scope, surfaces },
    { timeout },
  );
  /* Two frames with one height: a part that arrived between them has finished laying out. */
  await page.waitForFunction(
    (scope) =>
      new Promise<boolean>((resolve) => {
        const height = () => document.querySelector(scope)?.getBoundingClientRect().height ?? 0;
        const before = height();
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(height() === before)));
      }),
    scope,
    { timeout },
  );
}
