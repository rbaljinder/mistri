/**
 * Where the seed's car photos come from. With no `photos/manifest.json` beside
 * this file they are drawn by photos.mjs, as they always were. With one, the
 * catalog is the photo set's: each entry is a real photograph of one make,
 * model, body and colour, and the seed lists only cars it has a picture of,
 * in that picture's colour. Either way the seed reads nothing from the
 * network and makes the same file every time.
 *
 *   photos/manifest.json
 *   {
 *     "hero": { "file": "hero.jpg", "alt": "…" },
 *     "photos": [
 *       { "file": "toyota-camry-white.jpg", "thumb": "toyota-camry-white-thumb.jpg",
 *         "make": "Toyota", "model": "Camry", "body": "Sedan", "colour": "White",
 *         "years": [2018, 2024], "license": "CC0", "source": "https://…" }
 *     ]
 *   }
 *
 * Every file named is in photos/ beside the manifest; `thumb` is optional (the
 * full photo serves as its own thumbnail without it), and `years` the model
 * years the picture passes for. fetch-photos.mjs writes the set, the manifest
 * and photos/CREDITS.md; the seed never fetches anything.
 */
import { existsSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { renderPhotoSet, renderScene } from './photos.mjs';

const DIR = new URL('./photos/', import.meta.url);
const TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const BODIES = new Set(['Hatchback', 'Sedan', 'Wagon', 'SUV', 'Coupe', 'Pickup', 'Van']);

function file(name) {
  const type = TYPES[extname(name).toLowerCase()];
  if (!type || name.includes('/') || name.includes('\\'))
    throw new Error(`photos/manifest.json: "${name}" is not a .jpg, .png or .webp file in photos/.`);
  return { bytes: readFileSync(new URL(name, DIR)), type, ext: extname(name).toLowerCase() };
}

/** The drawn photos: every angle of every car, and the three-car scene. */
const generated = {
  manifest: false,
  /** Every model is pictured; the catalog draws from all of them. */
  pictures: null,
  photo(car, angle) {
    const { photo, thumb } = renderPhotoSet({ body: car.silhouette, colour: car.color, angle, lighting: car.lighting });
    return { bytes: photo, thumb, type: 'image/png', ext: '.png' };
  },
  hero() {
    return { bytes: renderScene({ lighting: 'gallery' }), type: 'image/png', ext: '.png' };
  },
};

function fromManifest(manifest) {
  const entries = manifest.photos ?? [];
  if (!entries.length) throw new Error('photos/manifest.json lists no photos.');
  const pictures = new Map();
  for (const entry of entries) {
    for (const key of ['file', 'make', 'model', 'body', 'colour', 'license'])
      if (typeof entry[key] !== 'string' || !entry[key]) throw new Error(`photos/manifest.json: a photo has no "${key}".`);
    if (!BODIES.has(entry.body)) throw new Error(`photos/manifest.json: "${entry.file}" has body "${entry.body}".`);
    const [first, last] = entry.years ?? [];
    if (!(Number.isInteger(first) && Number.isInteger(last) && first <= last))
      throw new Error(`photos/manifest.json: "${entry.file}" needs "years": [first, last].`);
    const key = `${entry.make}|${entry.model}`;
    pictures.set(key, [...(pictures.get(key) ?? []), entry]);
  }
  return {
    manifest: true,
    /** make|model → its photographs; the catalog lists only these models. */
    pictures,
    /* One photograph a car: a real shoot has no second angle to offer, so the
       gallery is the one picture. A model photographed in two colours takes
       the one its colour names, else the first. */
    photo(car, angle) {
      if (angle !== 'three-quarter') return null;
      const shots = pictures.get(`${car.make}|${car.model}`) ?? [];
      const shot = shots.find((s) => s.colour === car.color) ?? shots[0];
      if (!shot) throw new Error(`photos/manifest.json has no photo of a ${car.make} ${car.model}.`);
      const full = file(shot.file);
      return { bytes: full.bytes, thumb: shot.thumb ? file(shot.thumb).bytes : full.bytes, type: full.type, ext: full.ext };
    },
    hero() {
      if (!manifest.hero?.file) return generated.hero();
      return file(manifest.hero.file);
    },
  };
}

export function photoSource() {
  const path = new URL('manifest.json', DIR);
  return existsSync(path) ? fromManifest(JSON.parse(readFileSync(path, 'utf8'))) : generated;
}
