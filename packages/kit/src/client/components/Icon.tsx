/**
 * An icon: a Phosphor glyph (Phosphor Icons, MIT), drawn from path data by
 * @mistriwork/ui's Icon with the glyphs this module lends it.
 *
 * The glyphs are data rather than one component per icon
 * (scripts/generate-icons.mjs says why): each of `@phosphor-icons/react`'s
 * modules carried six weights to draw one, and all 69 of them sat in every
 * first page. Two kinds are known here:
 *
 *   - the chrome's own few (chromeIcons.ts) — a caret, the menu, the gear —
 *     bundled, because every page draws some of them;
 *   - an App's, which the server sends with whatever names them (the App
 *     payload, a look before sign-in) and `registerIcons` adds. An App uses
 *     a handful of the 65 it may name, and the payload carries just those.
 *
 * A name asked for before its glyph is known loads the whole App set once,
 * on demand, and every icon waiting on it draws when it lands; the icon
 * keeps its box meanwhile, so nothing moves.
 */
import type { JSX } from 'react';
import type { AppIconName } from '@mistriwork/engine/shared/appIcons.js';
import {
  Icon as Drawn,
  loadIconsWith,
  onUnknownIcon,
  registerIcons,
  weighIconsWith,
  type IconProps,
  type IconWeight,
} from '@mistriwork/ui/Icon.js';
import { CHROME_ICON_GLYPHS } from './chromeIcons.js';
import { iconWeight, iconWeightVersion, subscribeIconWeight, weightedDrawing } from '../iconWeight.js';

export type IconName = keyof typeof CHROME_ICON_GLYPHS | AppIconName;
export { registerIcons, type IconWeight };

registerIcons(CHROME_ICON_GLYPHS);
loadIconsWith(() => import('@mistriwork/engine/shared/iconGlyphs.js').then((module) => module.APP_ICON_GLYPHS));
weighIconsWith({ weight: iconWeight, drawing: weightedDrawing, subscribe: subscribeIconWeight, version: iconWeightVersion });

/** While an App is being written (`mistri dev`, grade), a name that names no icon is said once in the console with
    the nearest one (unknownIcon.ts, loaded only then) and drawn as a house, so the miss is seen; served, it keeps
    its empty box. A typed name cannot miss: a custom component's or a free-form page's string can. */
export function sayUnknownIcons(authoring: () => boolean): void {
  onUnknownIcon((name, names) => {
    if (!authoring()) return undefined;
    void import('./unknownIcon.js').then((said) => said.sayUnknownIcon(name, names));
    return 'house';
  });
}

/** An icon the kit knows by name: the chrome's, and the 65 an App may name. */
export const Icon: (props: IconProps<IconName>) => JSX.Element = Drawn;
