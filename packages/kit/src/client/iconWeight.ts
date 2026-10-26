/**
 * The weight a worn theme draws its icons in (`type.icons`, the root's `data-icons`). Regular and bold are in every
 * glyph the page has (components/Icon.tsx); a theme that picks light or fill fetches those drawings once, as a chunk
 * of their own (shared/iconWeights.ts), and boot waits for them as it waits for the look's sheets (visualTheme.ts), so
 * the page is never shown in one weight and redrawn in another. An icon given its own weight (a logo's bold) keeps it.
 */
import type { ThemeIconWeight } from '@mistriwork/engine/schema/theme.js';
import type { IconWeightGlyph } from '@mistriwork/engine/shared/iconWeights.js';

let worn: ThemeIconWeight = 'regular';
let drawings: Readonly<Record<string, IconWeightGlyph>> | undefined;
let loading: Promise<void> | undefined;
let version = 0;
const listeners = new Set<() => void>();

function changed() {
  version += 1;
  for (const listener of listeners) listener();
}

/** Wear `weight`: undefined when every glyph already carries it, else settled once its drawings are here (or could
    not come, when the icons stay regular). */
export function wearIconWeight(weight: ThemeIconWeight | undefined): Promise<void> | undefined {
  const next = weight ?? 'regular';
  if (next !== worn) {
    worn = next;
    changed();
  }
  if (next !== 'light' && next !== 'fill') return undefined;
  loading ??= import('@mistriwork/engine/shared/iconWeights.js').then(
    (module) => {
      drawings = module.ICON_WEIGHT_GLYPHS;
      changed();
    },
    (error: unknown) => {
      loading = undefined;
      console.error("The theme's icon weight did not load.", error);
    },
  );
  return loading;
}

/** The worn weight's drawing of `name`, when it is not one every glyph carries; undefined draws the glyph's own. */
export function weightedDrawing(name: string): readonly string[] | undefined {
  if (worn !== 'light' && worn !== 'fill') return undefined;
  return drawings?.[name]?.[worn === 'light' ? 0 : 1];
}

/** The worn weight, for an icon that says none of its own. */
export const iconWeight = (): ThemeIconWeight => worn;

export const subscribeIconWeight = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const iconWeightVersion = () => version;
