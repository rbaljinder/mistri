/**
 * The built-in looks' ids and the custom properties a theme's roles, faces
 * and corners are worn as: all the browser needs to wear a theme at first
 * paint, apart from the machinery that builds and checks one.
 */
import type { ThemePalette } from '../../schema/theme.js';

export const THEME_BASES = ['workshop', 'lumen', 'mono', 'sage', 'ledger'] as const;
/** Each role as the custom property it is worn as: its spec path, hyphenated (`nav.ground` is `--nav-ground`, `chart[0]` is `--chart-1`). */
export const PALETTE_TOKENS = {
  ground: '--ground',
  surface: '--surface',
  field: '--field-fill',
  raised: '--raised',
  line: '--line',
  lineStrong: '--line-strong',
  lineControl: '--line-control',
  ink: '--ink',
  inkMuted: '--ink-muted',
  inkSubtle: '--ink-subtle',
  accent: '--accent',
  onAccent: '--on-accent',
  accentInk: '--accent-ink',
  primary: '--primary',
  onPrimary: '--on-primary',
  focus: '--focus',
  accentSoft: '--accent-soft',
  link: '--link',
  statusGood: '--status-good',
  statusWarning: '--status-warning',
  statusCritical: '--status-critical',
  statusInfo: '--status-info',
  navGround: '--nav-ground',
  navInk: '--nav-ink',
  navMuted: '--nav-muted',
  navLine: '--nav-line',
  navAccent: '--nav-accent',
  navCurrent: '--nav-current',
  navOnCurrent: '--nav-on-current',
  rulesSection: '--rules-section',
  rulesHead: '--rules-head',
  shadow: '--shadow-ink',
  band: '--band',
  rulesWeight: '--rules-weight',
  rulesControl: '--control-border-w',
  chart1: '--chart-1',
  chart2: '--chart-2',
  chart3: '--chart-3',
  chart4: '--chart-4',
  chart5: '--chart-5',
  chart6: '--chart-6',
  chart7: '--chart-7',
  chart8: '--chart-8',
} as const satisfies Record<keyof ThemePalette, string>;
export const FONT_TOKENS = { ui: '--sans', data: '--mono', heading: '--heading-font', code: '--code' } as const;
export const RADIUS_TOKENS = { control: '--radius', field: '--field-radius', pill: '--pill-radius', panel: '--panel-radius' } as const;
/** A panel's edge and the focus ring's width; a rule's and a control's ride in each mode's palette (`--rules-weight`). */
const BORDER_TOKENS = { panel: '--panel-border-width', focus: '--focus-ring-width' } as const;

/** Each corner's ceiling in pixels: a control may also be a pill (`round`), and so may a pill's tag. */
export const RADIUS_MAX = { control: 16, field: 12, pill: 12, panel: 20 } as const;
export const ROUND_CORNERS: ReadonlySet<string> = new Set(['control', 'pill']);
/** `round`, compiled: a length past any box's, so a control or a tag draws as a pill whatever its height. */
export const ROUND = '999px';
/** The corner every other box that follows a control's takes when the controls are round: a card is not a pill. */
export const ROUND_BOX = '8px';
/** The widths each edge may take: a rule's, a control's, a panel's (0px draws none) and the focus ring's. */
export const BORDER_MENU = {
  rule: ['1px', '2px', '3px'],
  control: ['0px', '1px', '2px'],
  panel: ['0px', '1px', '2px'],
  focus: ['2px', '3px'],
} as const;

/** A control's height, in whole pixels (`shape.height.control`): a field, a select and a button stand level at it. */
export const CONTROL_HEIGHT = { min: 32, max: 56 } as const;
export function controlHeightFits(length: unknown): boolean {
  if (typeof length !== 'string') return false;
  const match = /^(\d{2})px$/.exec(length);
  return Boolean(match) && Number(match![1]) >= CONTROL_HEIGHT.min && Number(match![1]) <= CONTROL_HEIGHT.max;
}

/** A corner in pixels up to `max`: `6px`, `7.5px`. */
export function cornerFits(length: unknown, max: number): boolean {
  if (typeof length !== 'string') return false;
  const match = /^(\d{1,2}(?:\.\d+)?)px$/.exec(length);
  return Boolean(match) && Number(match![1]) <= max;
}

/**
 * A theme's corners and widths as the custom properties the sheets read. A round control is `--control-radius`,
 * which only a control's own rule reads (customThemes.css), and `--radius` — every other box that follows a
 * control's corner, a card's, a menu's — stays at ROUND_BOX.
 */
export function shapeTokens(theme: {
  radius?: Partial<Record<keyof typeof RADIUS_TOKENS, string>>;
  border?: Partial<Record<keyof typeof BORDER_TOKENS, string>>;
  height?: { control?: string };
}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, token] of Object.entries(RADIUS_TOKENS)) {
    const value = theme.radius?.[key as keyof typeof RADIUS_TOKENS];
    if (value === undefined) continue;
    if (key === 'control' && value === ROUND) {
      out['--radius'] = ROUND_BOX;
      out['--control-radius'] = ROUND;
    } else out[token] = value;
  }
  for (const [key, token] of Object.entries(BORDER_TOKENS)) {
    const value = theme.border?.[key as keyof typeof BORDER_TOKENS];
    if (value !== undefined) out[token] = value;
  }
  if (theme.height?.control !== undefined) out['--control-h'] = theme.height.control;
  return out;
}

/** A role by its name in the spec, for any message an author reads: `statusCritical` is `status.critical`, `chart3`
    is `chart[2]`. The roles are the spec's paths in camel case, so this is the whole map. */
export function rolePath(role: string): string {
  const series = /^chart(\d)$/.exec(role);
  if (series) return `chart[${Number(series[1]) - 1}]`;
  const group = /^(status|nav|rules)([A-Z])(\w*)$/.exec(role);
  return group ? `${group[1]}.${group[2]!.toLowerCase()}${group[3]}` : role;
}
