/**
 * A picture at the width a page draws it, in the best format the browser
 * takes: the `w` parameter of the file route (`/api/file?…&inline=1&w=640`).
 *
 * A card draws a car at 320 pixels and a phone at three times that; the
 * file route sent every one the photo as uploaded, often 3,000 pixels and a
 * few megabytes. Now a public page says `srcset` over a fixed set of widths
 * (WIDTHS, the one list the client's srcset is written from too,
 * shared/imageWidths.ts) and the browser picks one. The set is fixed, and
 * any other width is refused, because every width asked for is a file kept
 * on disk: an open `w` would let anyone fill the disk one pixel at a time.
 *
 * Nothing here decides who may see a picture. The route reads the file as it
 * always did — the App's grants, field projection and row policy — and only
 * the bytes that read returned are resized; the copy on disk is named for
 * those bytes' hash, so it can only ever be sent as the answer to a read
 * that returned the same picture. The format is in the address (`&f=avif`,
 * `webp`, `jpeg`, `png`), because a CDN keys on the URL and ignores
 * `Vary: Accept`: a page offers each through `<picture>`'s `type` and the
 * browser picks. A bare `&w=` keeps the old answer by `Accept` (AVIF, then
 * WebP, else the original's own), and only that reply varies by it.
 *
 * Where the App keeps its files in a bucket the variants are kept there too
 * (`<prefix>_variants/<app>/`, outside the App's file folder so the object sweep never
 * sees them), so instances share one copy and a new one starts warm; the disk
 * is the near copy. A public picture is made at upload for the common widths
 * (`pregenerateVariants`), with a dominant colour and its true size
 * (`imagePlaceholder`) kept beside them for a page to hold the room.
 *
 * sharp is optional: a server without it sends the original, at every
 * width, as before. The kept copies are bounded (`IMAGE_CACHE_BYTES`) and
 * the least recently sent is let go first.
 */
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IMAGE_WIDTHS } from '@mistriwork/engine/shared/imageWidths.js';
import type { Bucket } from '../files/bucket.js';
import { sniffImage } from './imageSniff.js';

/** The formats a resized picture is sent in, by preference. */
export type Encoded = 'image/avif' | 'image/webp' | 'image/jpeg' | 'image/png';

/** The format names an address may carry (`&f=`), and the type each is. */
const FORMATS: Record<string, Encoded> = { avif: 'image/avif', webp: 'image/webp', jpeg: 'image/jpeg', png: 'image/png' };

/** Where variants are shared: a bucket and the prefix its keys begin with. */
export interface SharedVariants {
  bucket: Bucket;
  prefix: string;
  /** The App they belong to: its sweep lists and deletes only its own. */
  app: string;
}

/** The folder of an App's shared copies in its bucket: `<prefix>_variants/<app>/`. */
export const variantsPrefix = (shared: Pick<SharedVariants, 'prefix' | 'app'>): string => `${shared.prefix}_variants/${shared.app}/`;

/** The hash a shared copy's name begins with (`<hash>-<width>.<ext>`, `<hash>.json`), or undefined for a name that is not one. */
export const variantHash = (key: string): string | undefined => /\/([A-Za-z0-9_-]{32})(?:-\d+\.[a-z]+|\.json)$/.exec(key)?.[1];

/** What a page needs to hold a picture's room before it arrives: its true size and an average colour. */
export interface ImagePlaceholder {
  width: number;
  height: number;
  /** `#rrggbb`. */
  color: string;
}

/** The part of sharp this file uses: read, resize without enlarging, encode. */
interface SharpLike {
  (
    input: Uint8Array,
    options?: { limitInputPixels?: number; failOn?: string },
  ): {
    rotate(): ReturnType<SharpLike>;
    resize(options: { width: number; withoutEnlargement: boolean }): ReturnType<SharpLike>;
    avif(options?: { quality?: number; effort?: number }): ReturnType<SharpLike>;
    webp(options?: { quality?: number }): ReturnType<SharpLike>;
    jpeg(options?: { quality?: number; mozjpeg?: boolean }): ReturnType<SharpLike>;
    png(options?: { compressionLevel?: number }): ReturnType<SharpLike>;
    toBuffer(): Promise<Buffer>;
    metadata(): Promise<{ width?: number; height?: number; orientation?: number }>;
    stats(): Promise<{ dominant: { r: number; g: number; b: number } }>;
  };
}

/* Loaded once, by a name the bundler and the type checker do not follow:
   sharp is a native module a deployment may not have, and its absence is a
   supported configuration (the original is sent). */
let loading: Promise<SharpLike | undefined> | undefined;
function loadSharp(): Promise<SharpLike | undefined> {
  const name = 'sharp';
  loading ??= import(name).then(
    (module: { default?: SharpLike }) => module.default,
    () => undefined,
  );
  return loading;
}

/** Whether `w` names a width this server makes; anything else is refused before a read. */
export function imageWidth(raw: string | null): number | undefined | 'refused' {
  if (raw === null) return undefined;
  const width = /^\d{2,4}$/.test(raw) ? Number(raw) : NaN;
  return (IMAGE_WIDTHS as readonly number[]).includes(width) ? width : 'refused';
}

/** Whether `f` names a format this server makes; anything else is refused before a read. */
export function imageFormat(raw: string | null): Encoded | undefined | 'refused' | 'fallback' {
  if (raw === null) return undefined;
  // The page's `<img>`: the original's own kind (PNG keeps its transparency, the rest JPEG), named in the address so a CDN may keep it.
  if (raw === 'fallback') return 'fallback';
  return Object.hasOwn(FORMATS, raw) ? FORMATS[raw] : 'refused';
}

export const IMAGE_FORMAT_REFUSAL = `f must be one of ${Object.keys(FORMATS).join(', ')}, fallback.`;

export const IMAGE_WIDTH_REFUSAL = `w must be one of ${IMAGE_WIDTHS.join(', ')}.`;

/**
 * The format to send a resized picture in: AVIF or WebP where the browser
 * says it takes them, else the original's own (a GIF or AVIF original
 * becomes a PNG or JPEG only where it must be resized and the browser takes
 * neither modern format).
 */
export function negotiateFormat(accept: string | undefined, original: string): Encoded {
  const takes = (type: string) => (accept ?? '').split(',').some((part) => part.split(';')[0].trim().toLowerCase() === type);
  if (takes('image/avif')) return 'image/avif';
  if (takes('image/webp')) return 'image/webp';
  return original === 'image/png' || original === 'image/gif' ? 'image/png' : 'image/jpeg';
}

const EXTENSION: Record<Encoded, string> = {
  'image/avif': 'avif',
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

/* Resizing is CPU work; a page of forty cards asks forty at once. Two at a
   time keeps the server answering everything else while they wait. */
const AT_ONCE = 2;
let running = 0;
let backgroundRunning = 0;
const waiting: Array<() => void> = [];
const waitingBackground: Array<() => void> = [];
/* A visitor's picture goes before an upload's pre-made ones, and the pre-made ones may hold only one of the two
   places, so a visitor never waits behind them for more than the work already begun. */
function pump(): void {
  while (running < AT_ONCE && waiting.length) waiting.shift()!();
  while (running < AT_ONCE - 1 && backgroundRunning < 1 && !waiting.length && waitingBackground.length) waitingBackground.shift()!();
}
async function turn<T>(work: () => Promise<T>, background = false): Promise<T> {
  if (background) {
    if (running >= AT_ONCE - 1 || backgroundRunning >= 1 || waiting.length)
      await new Promise<void>((resolve) => waitingBackground.push(resolve));
    backgroundRunning++;
  } else if (running >= AT_ONCE) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  try {
    return await work();
  } finally {
    running--;
    if (background) backgroundRunning--;
    pump();
  }
}

/** The kept copies: where, how much in all, and what was sent last. */
interface Store {
  /** Where the copies are kept: the operator's folder, or (unset) one this process makes for itself, private to it, when first used. */
  dir: string | undefined;
  most: number;
  /** File name → bytes; a Map keeps insertion order, and a hit is moved to the end, so the first entry is the least recently used. */
  files: Map<string, number>;
  total: number;
  ready?: Promise<void>;
}

const DEFAULT_MOST = 256 * 1024 * 1024;
const fresh = (): Store => ({
  dir: process.env.MISTRI_IMAGE_CACHE || undefined,
  most: DEFAULT_MOST,
  files: new Map(),
  total: 0,
});
let store: Store = fresh();

/** For tests: forget the cache, so the next picture meets the default again. */
export function resetImageCache(): void {
  store = fresh();
}

/** For tests: keep copies in this directory, at most `most` bytes, starting from what is there. */
export function setImageCache(dir: string, most = DEFAULT_MOST): void {
  store = { dir, most, files: new Map(), total: 0 };
}

/* What is already on disk from an earlier run counts against the bound, oldest first. */
function opened(): Promise<void> {
  store.ready ??= (async () => {
    const current = store;
    /* Never a shared, predictable folder in the temp directory: a copy is sent by its name alone, so another local
       user who made the folder first could plant a picture under a public photo's name. mkdtemp makes one that is
       ours alone (mode 0700), and it goes when the process does, as nothing in it outlives what it was made for. */
    if (current.dir === undefined) {
      const made = await mkdtemp(join(tmpdir(), 'tablewalk-image-cache-'));
      current.dir = made;
      process.once('exit', () => rmSync(made, { recursive: true, force: true }));
    } else await mkdir(current.dir, { recursive: true });
    const found: Array<[string, number, number]> = [];
    for (const name of await readdir(current.dir!)) {
      if (!/^[\w-]+\.(avif|webp|jpg|png)$/.test(name)) continue;
      const info = await stat(join(current.dir!, name)).catch(() => undefined);
      if (info?.isFile()) found.push([name, info.size, info.mtimeMs]);
    }
    found.sort((a, b) => a[2] - b[2]);
    for (const [name, size] of found) {
      current.files.set(name, size);
      current.total += size;
    }
  })();
  return store.ready;
}

async function evict(current: Store): Promise<void> {
  // Down to nine tenths, so a full store does not evict on every write.
  while (current.total > current.most * 0.9 && current.files.size) {
    const [name, size] = current.files.entries().next().value!;
    current.files.delete(name);
    current.total -= size;
    await rm(join(current.dir!, name), { force: true });
  }
}

/** One resized picture: its bytes, type and strong tag. */
interface ImageVariant {
  bytes: Uint8Array;
  type: string;
  etag: string;
  /** The first 32 characters of the original's SHA-256 in base64url: what a hashed address (`&h=`) names. */
  hash: string;
}

/** The hash a hashed address names, for bytes. */
export const imageHash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('base64url').slice(0, 32);

/** The same hash from a stored hex SHA-256 (a file resource's `hash` column), or undefined when it is not one. */
export function imageHashOfHex(hex: unknown): string | undefined {
  return typeof hex === 'string' && /^[0-9a-f]{64}$/.test(hex) ? Buffer.from(hex, 'hex').toString('base64url').slice(0, 32) : undefined;
}

const sharedKey = (shared: SharedVariants, name: string) => `${variantsPrefix(shared)}${name}`;

/** Make one variant with sharp; undefined where sharp is absent or the bytes will not decode. */
async function make(bytes: Uint8Array, type: Encoded, width: number, background = false): Promise<Buffer | undefined> {
  const sharp = await loadSharp();
  if (!sharp) return undefined;
  try {
    return await turn(() => {
      // rotate(): a phone's photo is stored on its side with an EXIF turn; the resized copy is drawn upright and carries no EXIF.
      const pipeline = sharp(bytes, {
        limitInputPixels: 40_000_000,
        failOn: 'error',
      })
        .rotate()
        .resize({ width, withoutEnlargement: true });
      const encoded =
        type === 'image/avif'
          ? pipeline.avif({ quality: 55, effort: 3 })
          : type === 'image/webp'
            ? pipeline.webp({ quality: 78 })
            : type === 'image/png'
              ? pipeline.png({ compressionLevel: 8 })
              : pipeline.jpeg({ quality: 80, mozjpeg: true });
      return encoded.toBuffer();
    }, background);
  } catch {
    return undefined;
  }
}

/** A copy by name: the disk's, else the shared bucket's (which then warms the disk). */
async function kept(current: Store, name: string, shared: SharedVariants | undefined): Promise<Uint8Array | undefined> {
  try {
    await opened();
    if (current.files.has(name)) {
      const near = await readFile(join(current.dir!, name)).catch(() => undefined);
      if (near) {
        const size = current.files.get(name)!;
        current.files.delete(name);
        current.files.set(name, size);
        return near;
      }
      current.total -= current.files.get(name)!;
      current.files.delete(name);
    }
  } catch {
    /* A cache that cannot be opened only means the picture is made each time. */
  }
  if (!shared) return undefined;
  const far = await shared.bucket.bytes(sharedKey(shared, name)).catch(() => undefined);
  if (far) await keep(current, name, far);
  return far;
}

async function keep(current: Store, name: string, made: Uint8Array): Promise<void> {
  try {
    await opened();
    if (store === current && !current.files.has(name)) {
      const temporary = join(current.dir!, `.${name}.${process.pid}.tmp`);
      await writeFile(temporary, made);
      await rename(temporary, join(current.dir!, name));
      current.files.set(name, made.length);
      current.total += made.length;
      await evict(current);
    }
  } catch {
    /* Not kept: sent all the same. */
  }
}

/**
 * The picture `bytes` (already read under the reader's grants, and already
 * known to be a raster `original`) at `width`, in `format` when the address
 * names one, else the format `accept` prefers. A GIF, which may move, is sent
 * as it is. Without sharp, or when the bytes will not decode, the original is
 * the answer. `shared` is the App's bucket, when it has one.
 */
export async function imageVariant(
  bytes: Uint8Array,
  original: string,
  width: number,
  accept: string | undefined,
  options: { format?: Encoded; shared?: SharedVariants; background?: boolean } = {},
): Promise<ImageVariant> {
  const hash = imageHash(bytes);
  const asIs = { bytes, type: original, etag: `"${hash.slice(0, 27)}"`, hash };
  if (original === 'image/gif') return asIs;
  const type = options.format ?? negotiateFormat(accept, original);
  const name = `${hash}-${width}.${EXTENSION[type]}`;
  const etag = `"${createHash('sha256').update(name).digest('base64url').slice(0, 27)}"`;
  const current = store;
  const found = await kept(current, name, options.shared);
  if (found) return { bytes: found, type, etag, hash };
  const made = await make(bytes, type, width, options.background);
  if (!made) return asIs;
  await keep(current, name, made);
  if (options.shared) await options.shared.bucket.put(sharedKey(options.shared, name), made, type).catch(() => {});
  return { bytes: made, type, etag, hash };
}

/**
 * The widths and formats a public picture is made at the moment it is stored:
 * what a card, a gallery and a hero ask for first, in the two modern formats.
 * The rest are made on first use, as before.
 */
export const PREGENERATED_WIDTHS = [320, 480, 640, 960, 1280] as const;
export const PREGENERATED_FORMATS: readonly Encoded[] = ['image/avif', 'image/webp'];

const pending = new Set<Promise<unknown>>();
/* What waits for its turn is bounded by count and by the bytes it holds: an upload loop must not make the server keep
   every picture it was sent. Work past either is dropped, not queued; a dropped picture is made on its first read. */
const PENDING_MOST = 16;
const PENDING_BYTES_MOST = 64 * 1024 * 1024;
let pendingBytes = 0;
/** For tests, and a clean shutdown: resolves when every picture started by `pregenerateVariants` is done. */
export async function settlePregeneration(): Promise<void> {
  while (pending.size) await Promise.allSettled([...pending]);
}

/**
 * Start making a just-stored public picture's variants and its placeholder, off
 * the request: the upload answers at once and the work waits behind every
 * visitor's picture, in one of the two places (`turn`). Called after the row
 * is committed, never before. Bytes that are not a raster picture, a GIF, a
 * server without sharp, and a queue that is full make nothing. Never throws.
 */
export function pregenerateVariants(bytes: Uint8Array, shared?: SharedVariants): void {
  const original = sniffImage(bytes);
  if (!original || original === 'image/gif') return;
  if (pending.size >= PENDING_MOST || pendingBytes + bytes.byteLength > PENDING_BYTES_MOST) return;
  pendingBytes += bytes.byteLength;
  const work = (async () => {
    const hash = imageHash(bytes);
    const meta = await imagePlaceholder(bytes, true);
    if (meta) await keepPlaceholder(hash, meta, shared);
    for (const type of PREGENERATED_FORMATS)
      for (const width of PREGENERATED_WIDTHS)
        await imageVariant(bytes, original, width, undefined, { format: type, background: true, ...(shared ? { shared } : {}) });
  })()
    .catch(() => {})
    .finally(() => {
      pending.delete(work);
      pendingBytes -= bytes.byteLength;
    });
  pending.add(work);
}

/** A picture's true size (after its EXIF turn) and its dominant colour, or undefined without sharp or for bytes that will not decode. */
export async function imagePlaceholder(bytes: Uint8Array, background = false): Promise<ImagePlaceholder | undefined> {
  const sharp = await loadSharp();
  if (!sharp) return undefined;
  try {
    return await turn(async () => {
      const image = sharp(bytes, { limitInputPixels: 40_000_000, failOn: 'error' });
      const info = await image.metadata();
      if (!info.width || !info.height) return undefined;
      const turned = (info.orientation ?? 1) >= 5;
      const { dominant } = await image.stats();
      const hex = (n: number) =>
        Math.max(0, Math.min(255, Math.round(n)))
          .toString(16)
          .padStart(2, '0');
      return {
        width: turned ? info.height : info.width,
        height: turned ? info.width : info.height,
        color: `#${hex(dominant.r)}${hex(dominant.g)}${hex(dominant.b)}`,
      };
    }, background);
  } catch {
    return undefined;
  }
}

const placeholders = new Map<string, ImagePlaceholder>();
const placeholderName = (hash: string) => `${hash}.json`;

async function keepPlaceholder(hash: string, meta: ImagePlaceholder, shared: SharedVariants | undefined): Promise<void> {
  placeholders.set(hash, meta);
  if (placeholders.size > 5000) placeholders.delete(placeholders.keys().next().value!);
  if (shared)
    await shared.bucket
      .put(sharedKey(shared, placeholderName(hash)), Buffer.from(JSON.stringify(meta)), 'application/json')
      .catch(() => {});
}

/** The placeholder kept for a picture by its hash (`imageHash`): from memory, else the shared bucket's. */
async function keptPlaceholder(hash: string, shared?: SharedVariants): Promise<ImagePlaceholder | undefined> {
  const near = placeholders.get(hash);
  if (near) return near;
  const far = shared && (await shared.bucket.bytes(sharedKey(shared, placeholderName(hash))).catch(() => undefined));
  if (!far) return undefined;
  try {
    const meta = JSON.parse(Buffer.from(far).toString()) as ImagePlaceholder;
    if (typeof meta.width === 'number' && typeof meta.height === 'number' && /^#[0-9a-f]{6}$/.test(meta.color)) {
      placeholders.set(hash, meta);
      return meta;
    }
  } catch {
    /* Not ours: made again. */
  }
  return undefined;
}

/** A picture's placeholder, kept when it is made so the next ask is a lookup. */
export async function placeholderOf(bytes: Uint8Array, shared?: SharedVariants): Promise<ImagePlaceholder | undefined> {
  const hash = imageHash(bytes);
  const known = await keptPlaceholder(hash, shared);
  if (known) return known;
  const made = await imagePlaceholder(bytes);
  if (made) await keepPlaceholder(hash, made, shared);
  return made;
}
