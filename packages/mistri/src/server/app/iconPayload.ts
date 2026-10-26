/**
 * The glyphs of the icons an answer names, sent with it.
 *
 * An App's icons are words in its definition (packages/engine/src/shared/appIcons.ts); the
 * browser needs their drawings. It used to bundle all 65 in every first
 * page, in six weights, to draw the handful a given App names. Now the answer
 * that names them — the App payload, a look before sign-in — carries just
 * those, as path data (packages/engine/src/shared/iconGlyphs.ts), and the client adds them to
 * what it can draw (components/Icon.tsx). An icon is named under `icon` (a
 * view, a nav group, a dashboard note, a form), `logo` (`ui.logo`, a look)
 * or as the values of a display rule's `icons`.
 */
import { isAppIcon, type AppIconName } from '@mistriwork/engine/shared/appIcons.js';
import { APP_ICON_GLYPHS, type IconGlyph } from '@mistriwork/engine/shared/iconGlyphs.js';

type IconGlyphs = Partial<Record<AppIconName, IconGlyph>>;

/** Every App icon named anywhere in `value`, with its glyph; undefined when none is. */
export function iconGlyphsIn(value: unknown): IconGlyphs | undefined {
  const found: IconGlyphs = {};
  let any = false;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [key, item] of Object.entries(node)) {
      if ((key === 'icon' || key === 'logo') && isAppIcon(item)) {
        found[item] = APP_ICON_GLYPHS[item];
        any = true;
      }
      // A display rule's value → icon map (`icons: { high: 'cell-signal-high' }`).
      else if (key === 'icons' && item && typeof item === 'object' && !Array.isArray(item)) {
        for (const each of Object.values(item))
          if (isAppIcon(each)) {
            found[each] = APP_ICON_GLYPHS[each];
            any = true;
          }
      } else walk(item);
    }
  };
  walk(value);
  return any ? found : undefined;
}

/** `value` with the glyphs of the icons it names beside them, as `icons`. */
export function withIconGlyphs<T extends object>(value: T): T & { icons?: IconGlyphs } {
  const icons = iconGlyphsIn(value);
  return icons ? { ...value, icons } : value;
}
