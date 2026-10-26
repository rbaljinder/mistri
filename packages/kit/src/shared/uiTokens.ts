/**
 * The custom properties a custom component may read: `@mistriwork/mistri/ui` exports
 * them as `tokens`, and `mistri check` holds a component's `var(--…)` to
 * them. They are not listed by hand a second time — the theme's roles, faces
 * and corners are read off the tables the theme wears them from
 * (themeTokens.ts), so a role added there is a token here. Only the sheets'
 * own steps (space, type sizes, motion, depth, the larger corners) are named below,
 * because no theme role carries them.
 */
import { FONT_TOKENS, PALETTE_TOKENS, RADIUS_TOKENS } from '@mistriwork/engine/shared/themeTokens.js';

const SHEET_TOKENS = [
  '--radius-lg',
  '--radius-pop',
  '--radius-panel',
  '--radius-dialog',
  '--radius-item',
  '--type-ui',
  '--type-display',
  '--type-list-title',
  '--type-record-title',
  '--space-1',
  '--space-2',
  '--space-3',
  '--space-4',
  '--space-5',
  '--space-6',
  '--space-7',
  '--space-8',
  '--space-2h',
  '--space-3h',
  '--space-4h',
  '--section-seam',
  '--page-measure',
  '--room-inset',
  '--row-h',
  '--text-xs',
  '--text-sm',
  '--text-base',
  '--text-md',
  '--text-lg',
  '--text-xl',
  '--heading-weight',
  '--track-caps',
  '--track-display',
  '--track-title',
  '--t-hover',
  '--t-press',
  '--t-popover',
  '--t-panel',
  '--ease-out',
  '--ease-in-out',
  '--shadow-pop',
  '--shadow-panel',
  '--shadow-modal',
  '--scrim',
  '--scrim-light',
  '--focus-width',
  '--focus-offset',
] as const;

/** Every token a component may name, theme roles first, then faces, corners and the sheets' own steps. */
export const UI_TOKENS = [
  ...Object.values(PALETTE_TOKENS),
  ...Object.values(FONT_TOKENS),
  ...Object.values(RADIUS_TOKENS),
  ...SHEET_TOKENS,
] as readonly string[];

/** What a reader reaches for from another system's vocabulary, and the token that says it here. */
const WORDS: Record<string, string> = {
  negative: '--status-critical',
  danger: '--status-critical',
  error: '--status-critical',
  destructive: '--status-critical',
  red: '--status-critical',
  positive: '--status-good',
  success: '--status-good',
  green: '--status-good',
  warning: '--status-warning',
  caution: '--status-warning',
  info: '--status-info',
  text: '--ink',
  foreground: '--ink',
  fg: '--ink',
  'text-muted': '--ink-muted',
  muted: '--ink-muted',
  secondary: '--ink-muted',
  subtle: '--ink-subtle',
  background: '--ground',
  bg: '--ground',
  page: '--ground',
  card: '--surface',
  panel: '--surface',
  border: '--line',
  divider: '--line',
  primary: '--accent',
  brand: '--accent',
  'accent-color': '--accent',
  font: '--sans',
  'font-family': '--sans',
  'font-mono': '--mono',
  'border-radius': '--radius',
  rounded: '--radius',
  // Renamed before 1.0, with `nav.currentInk`: words on a fill are on<Fill>.
  'nav-current-ink': '--nav-on-current',
};

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length]!;
}

/** The token a name was most likely meant to be: the word another system uses for it, else the nearest spelling. */
export function nearestToken(name: string): string | undefined {
  const bare = name.replace(/^--/, '').toLowerCase();
  const said = WORDS[bare];
  if (said) return said;
  let best: string | undefined;
  let bestDistance = 3;
  for (const token of UI_TOKENS) {
    const gap = distance(bare, token.slice(2));
    if (gap < bestDistance) [best, bestDistance] = [token, gap];
  }
  return best;
}
