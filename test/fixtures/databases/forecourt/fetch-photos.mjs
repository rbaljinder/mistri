/**
 * How Forecourt's photographs were fetched, kept so the set can be made again.
 * The seed never runs this: it reads the files it wrote, offline.
 *
 *   node test/fixtures/databases/forecourt/fetch-photos.mjs
 *
 * Each photograph is a Wikimedia Commons file whose license is CC0 or public
 * domain, checked on its file page through the Commons API before it is
 * downloaded; anything else stops the run. The picture is cropped to 3:2 and
 * written at 1280 pixels wide (a 420-pixel thumbnail beside it) as JPEG at
 * quality 64 by redrawing it in a headless Chromium canvas, which keeps no
 * EXIF or other metadata. The hero is a 16:7 crop at 1920 pixels. Writes
 * photos/*.jpg, photos/manifest.json and photos/CREDITS.md, replacing them.
 *
 * `focus` moves a crop off center: x and y from 0 (left, top) to 1; `zoom`
 * above 1 crops closer, for a car photographed small in its frame.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const OUT = new URL('./photos/', import.meta.url);
const UA = { 'User-Agent': 'tablewalk-forecourt-seed/1.0 (https://github.com/rbaljinder/mistri; sample photos)' };
const FREE = new Set(['CC0', 'Public domain']);

/* The catalog's cars, one photograph each: a make and model the seed sells
   (seed.mjs MODELS), the body it lists it under, its colour as a listing
   says it, and the model years the picture passes for. */
const PHOTOS = [
  ['Moscow, Toyota Camry (XV70), Aug 2025 02.jpg', 'Toyota', 'Camry', 'Sedan', 'White', [2018, 2024]],
  ['Tesla Model 3 (2023), long range, Japan, left-front.jpg', 'Tesla', 'Model 3', 'Sedan', 'White', [2024, 2025]],
  [
    '2024 BMW M340i xDrive - 2998cc 3.0 (374PS) Petrol - Brooklyn Grey - 11-2024, Front.jpg',
    'BMW',
    '3 Series',
    'Sedan',
    'Gray',
    [2023, 2025],
  ],
  ['2025 Volkswagen Jetta in Monterey Blue Pearl, front right, 04-26-2025.jpg', 'Volkswagen', 'Jetta', 'Sedan', 'Blue', [2025, 2025]],
  ['2021 Toyota RAV4 PHV.jpg', 'Toyota', 'RAV4', 'SUV', 'White', [2019, 2025]],
  ['2024 Honda CR-V 2.0 eHEV RS Crystal Black Pearl in Indonesia 01.jpg', 'Honda', 'CR-V', 'SUV', 'Black', [2023, 2025]],
  ['Moscow, Mazda CX-5 red, Sept 2026 01.jpg', 'Mazda', 'CX-5', 'SUV', 'Red', [2017, 2025]],
  ['22 Tesla Model Y Performance.jpg', 'Tesla', 'Model Y', 'SUV', 'Gray', [2020, 2024]],
  ['23 Hyundai Ioniq 5 SEL (3).jpg', 'Hyundai', 'Ioniq 5', 'SUV', 'Gray', [2022, 2024]],
  ['21 Chevrolet Equinox Premier.jpg', 'Chevrolet', 'Equinox', 'SUV', 'Red', [2018, 2024]],
  ['Jeep Wrangler Rubicon - October 2025 - Sarah Stierch.jpg', 'Jeep', 'Wrangler', 'SUV', 'Blue', [2018, 2025]],
  ['Moscow, Hyundai Tucson (China, NX4) Aug 2025 02.jpg', 'Hyundai', 'Tucson', 'SUV', 'Gray', [2022, 2025]],
  ['22 Kia Niro EV EX Premium.jpg', 'Kia', 'Niro EV', 'SUV', 'Gray', [2019, 2022]],
  [
    '2016 Volkswagen Golf GTI S in Night Blue Metallic, front left, 07-04-2026.jpg',
    'Volkswagen',
    'Golf GTI',
    'Hatchback',
    'Navy',
    [2015, 2021],
  ],
  ['2019 Honda Civic Hatch 1.5 VTEC Turbo E in Bandung Jawa Barat 40122 01.jpg', 'Honda', 'Civic', 'Hatchback', 'Red', [2017, 2021]],
  ['Moscow, Mini Hatch (F56) Cooper S 60-years, May 2026 02.jpg', 'Mini', 'Cooper', 'Hatchback', 'Green', [2016, 2023]],
  ['Nissan Leaf (ZE1) Urban Chrome,2021,left.jpg', 'Nissan', 'Leaf', 'Hatchback', 'Beige', [2018, 2024]],
  ['Ford F-150 Raptor (49522651487).jpg', 'Ford', 'F-150', 'Pickup', 'Gray', [2017, 2020]],
  ['Chevrolet SIlverado Z71 (27611570309).jpg', 'Chevrolet', 'Silverado 1500', 'Pickup', 'Black', [2016, 2018]],
  [
    '2024 Ford Ranger Wildtrak X EcoBlue 4x4 - 1996cc 2.0 (205PS) Diesel - Blue Lightning - 02-2025, Front.jpg',
    'Ford',
    'Ranger',
    'Pickup',
    'Blue',
    [2024, 2025],
  ],
  ['2024 Ford Mustang GT 5.0 v8.jpg', 'Ford', 'Mustang', 'Coupe', 'Gray', [2024, 2025]],
  ['Moscow, Mazda MX-5 red, Aug 2025 02.jpg', 'Mazda', 'MX-5 Miata', 'Coupe', 'Red', [2017, 2025]],
  [
    '2016 Subaru Outback 2.6i Limited in Crystal Black Silica, front right, 07-07-2026.jpg',
    'Subaru',
    'Outback',
    'Wagon',
    'Black',
    [2015, 2019],
  ],
  ['Audi A4 Allroad Sport 50 TDI Quattro (2021) (54814050666).jpg', 'Audi', 'A4 allroad', 'Wagon', 'Silver', [2020, 2025]],
];
/* The front page: a car in the open, wide enough for the heading over it. */
const HERO = {
  file: '2024 Ford Mustang GT 5.0 v8.jpg',
  alt: 'A slate-blue Ford Mustang GT parked in an open lot under a clear sky.',
  focus: { x: 0.5, y: 0.62 },
};
/* Crops for cars photographed small or off center. */
const FOCUS = {
  'Moscow, Toyota Camry (XV70), Aug 2025 02.jpg': { x: 0.55, y: 0.72, zoom: 1.12 },
  'Audi A4 Allroad Sport 50 TDI Quattro (2021) (54814050666).jpg': { x: 0.35, y: 0.62, zoom: 1.5 },
};

const slug = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

async function info(file) {
  const api = `https://commons.wikimedia.org/w/api.php?action=query&format=json&titles=${encodeURIComponent(`File:${file}`)}&prop=imageinfo&iiprop=url|size|extmetadata&iiurlwidth=2560`;
  const page = Object.values((await (await fetch(api, { headers: UA })).json()).query.pages)[0];
  const image = page.imageinfo?.[0];
  if (!image) throw new Error(`No such Commons file: ${file}`);
  const license = image.extmetadata?.LicenseShortName?.value;
  if (!FREE.has(license)) throw new Error(`${file} is ${license}, not CC0 or public domain.`);
  const artist = (image.extmetadata?.Artist?.value ?? '').replace(/<[^>]+>/g, '').trim();
  return { url: image.thumburl ?? image.url, page: image.descriptionurl, license, artist };
}

async function download(url) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, { headers: UA });
    if (response.ok) return Buffer.from(await response.arrayBuffer());
    if (attempt === 4) throw new Error(`${response.status} for ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
  }
}

/* Cropped to `ratio` around `focus`, drawn at `width`, encoded as JPEG: the canvas writes pixels and nothing else. */
async function render(page, bytes, { width, ratio, quality, focus = { x: 0.5, y: 0.5, zoom: 1 } }) {
  const data = `data:image/jpeg;base64,${bytes.toString('base64')}`;
  const out = await page.evaluate(
    async ({ data, width, ratio, quality, focus }) => {
      const image = new globalThis.Image();
      image.src = data;
      await image.decode();
      let sw = image.naturalWidth;
      let sh = sw / ratio;
      if (sh > image.naturalHeight) {
        sh = image.naturalHeight;
        sw = sh * ratio;
      }
      sw /= focus.zoom ?? 1;
      sh /= focus.zoom ?? 1;
      const sx = (image.naturalWidth - sw) * focus.x;
      const sy = (image.naturalHeight - sh) * focus.y;
      const canvas = globalThis.document.createElement('canvas');
      canvas.width = width;
      canvas.height = Math.round(width / ratio);
      const context = canvas.getContext('2d');
      context.imageSmoothingQuality = 'high';
      context.drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', quality);
    },
    { data, width, ratio, quality, focus },
  );
  return Buffer.from(out.split(',')[1], 'base64');
}

mkdirSync(OUT, { recursive: true });
for (const name of readdirSync(OUT)) if (/\.(jpg|json|md)$/.test(name)) rmSync(new URL(name, OUT));
const today = new Date().toISOString().slice(0, 10);
const browser = await chromium.launch();
const page = await browser.newPage();
const manifest = { hero: null, photos: [] };
const credits = [];
try {
  for (const [file, make, model, body, colour, years] of PHOTOS) {
    const source = await info(file);
    const original = await download(source.url);
    const name = slug(`${make} ${model} ${colour}`);
    const focus = FOCUS[file];
    writeFileSync(new URL(`${name}.jpg`, OUT), await render(page, original, { width: 1280, ratio: 3 / 2, quality: 0.64, focus }));
    writeFileSync(new URL(`${name}-thumb.jpg`, OUT), await render(page, original, { width: 420, ratio: 3 / 2, quality: 0.6, focus }));
    manifest.photos.push({
      file: `${name}.jpg`,
      thumb: `${name}-thumb.jpg`,
      make,
      model,
      body,
      colour,
      years,
      license: source.license,
      source: source.page,
    });
    credits.push(`| ${name}.jpg | [${file}](${source.page}) | ${source.artist || '—'} | ${source.license} | ${today} |`);
    console.log(`${name}.jpg`);
  }
  const hero = await info(HERO.file);
  writeFileSync(
    new URL('hero.jpg', OUT),
    await render(page, await download(hero.url), { width: 1920, ratio: 16 / 7, quality: 0.72, focus: HERO.focus }),
  );
  manifest.hero = { file: 'hero.jpg', alt: HERO.alt, license: hero.license, source: hero.page };
  credits.push(`| hero.jpg | [${HERO.file}](${hero.page}) | ${hero.artist || '—'} | ${hero.license} | ${today} |`);
} finally {
  await browser.close();
}
writeFileSync(new URL('manifest.json', OUT), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(
  new URL('CREDITS.md', OUT),
  `# Forecourt photographs

Every photograph here is from Wikimedia Commons and was released by its author
under CC0 1.0 (or into the public domain), checked on its file page when it was
fetched. CC0 asks for no credit; it is given anyway. Each was cropped and
resized by \`fetch-photos.mjs\`, which also wrote \`manifest.json\`. Brands and
models appear as photographed; no maker endorses this sample.

| File | Source | Author | License | Retrieved |
| --- | --- | --- | --- | --- |
${credits.join('\n')}
`,
);
