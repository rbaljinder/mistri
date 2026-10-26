/**
 * The photos the stories show: Forecourt's own studio renderer, run into
 * public/photos before Storybook starts or builds. Generated rather than
 * committed, so the repository carries the code that draws a car and no
 * pictures of one.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { ANGLE_NAMES, BODY_TYPES, renderPhoto, renderScene } from '../../test/fixtures/databases/forecourt/photos.mjs';

const out = new URL('../public/photos/', import.meta.url);
mkdirSync(out, { recursive: true });
const write = (name, bytes) => writeFileSync(new URL(`${name}.png`, out), bytes);

// One car per card, each a different body and colour.
const colours = ['Red', 'Blue', 'Silver', 'Green', 'White', 'Orange', 'Black', 'Teal'];
colours.forEach((colour, i) => write(`car-${i}`, renderPhoto({ body: BODY_TYPES[i % BODY_TYPES.length], colour, angle: ANGLE_NAMES[0] })));
// One car from every angle, for the gallery and its lightbox.
const angles = ANGLE_NAMES.slice(0, 4);
angles.forEach((angle, i) => write(`gallery-${i}`, renderPhoto({ body: BODY_TYPES[0], colour: 'Orange', angle })));
// The landing's 16:7 studio scene.
write('scene', renderScene());

console.log(`photos: ${colours.length} cars, ${angles.length} angles (${angles.join(', ')}) and the scene in public/photos`);
