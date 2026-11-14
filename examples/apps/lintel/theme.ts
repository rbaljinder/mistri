import { defineTheme } from '@mistriwork/mistri/app';

/* Lumen in Lintel's blue, said once as `brand`: the accent, links, the ring and the first chart series are it, and
   the shell's neutrals (the menu's ground, the raised ground, hairlines, muted words) lean to its hue, so the App
   is Lintel's and not Lumen's stone. With one recipe and one part of its own: a list's filters not yet asked for stand on a solid edge, a key as
   the search beside them is, where Lumen fills them; and the menu's current room is a quiet fill under ink,
   where Lumen tints it in the accent, so the one blue thing on a page is what can be pressed. Everything else is
   Lumen's, so a page's head is on the page's ground (`header: 'band'` here would put it on a strip of the raised
   ground). */
export const lintel = defineTheme({
  id: 'lintel',
  label: 'Lintel',
  extends: 'lumen',
  brand: '#2d4fd6',
  recipes: { filters: 'solid' },
  parts: { 'nav.current': { ground: 'raised', ink: 'ink', weight: 600 } },
});

/* Three more themes a reader may pick: blueprint.ts, written from scratch; hearth.ts, one question at a time; and
   tidelight.ts, a brand in one block over Mono. */
export { blueprint } from './blueprint.ts';
export { hearth } from './hearth.ts';
export { tidelight } from './tidelight.ts';
