import { defineTheme } from '@mistriwork/mistri/app';

/* Lumen, with the head on a band: a lease, a home and a list lead with one strip of the raised ground, the trail and
   the verbs in it, as an object page does, and a resident's initials stand large beside their name (a head's `hero`,
   which a record without an avatar draws as the band). Everything else is Lumen's. */
export const lintel = defineTheme({
  id: 'lintel',
  label: 'Lintel',
  extends: 'lumen',
  recipes: { header: 'hero' },
});

/* Three more themes a reader may pick: blueprint.ts, written from scratch; hearth.ts, one question at a time; and
   tidelight.ts, a brand in one block over Mono. */
export { blueprint } from './blueprint.ts';
export { hearth } from './hearth.ts';
export { tidelight } from './tidelight.ts';
