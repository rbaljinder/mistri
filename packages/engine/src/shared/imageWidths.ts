/**
 * The widths a picture from the file route is made at (`&w=`), and the
 * `srcset` a page writes over them. One list for both sides: the server
 * refuses any other width (server/http/imageVariants.ts says why), so a
 * srcset written from anything else would ask for pictures that never come.
 */
export const IMAGE_WIDTHS = [160, 320, 480, 640, 960, 1280, 1920] as const;

/**
 * A `srcset` for a picture at a file-route address (`/api/file?…&inline=1`),
 * over the widths from `from` to `to`: each the original made at that width,
 * so a thumbnail address (`variant=thumb`) is asked at full quality instead.
 * Anything else — an https photo, a blob on a tenant's lease — has none.
 */
export function imageSrcSet(src: string | undefined, from = 320, to = 1920, format?: ImageFormat): string | undefined {
  if (!src || !/\/api\/file\?.*[?&]inline=1(&|$)/.test(src)) return undefined;
  const base = src.replace(/&(variant|w|f)=[^&]*/g, '');
  return IMAGE_WIDTHS.filter((width) => width >= from && width <= to)
    .map((width) => `${base}&w=${width}${format ? `&f=${format}` : ''} ${width}w`)
    .join(', ');
}

/** The formats a picture is offered in, by name in the address (`&f=`). */
type ImageFormat = 'avif' | 'webp' | 'jpeg' | 'png' | 'fallback';

/**
 * The `<source>`s of a `<picture>` over the same widths: AVIF, then WebP, each its own address, so the browser
 * chooses by `type` and a CDN, which keys on the URL and ignores `Vary: Accept`, keeps one copy of each. The
 * `<img>` inside is `imageFallbackSet`: `f=fallback`, the original's own kind, so no address is answered by `Accept`.
 */
export function imageSources(src: string | undefined, from = 320, to = 1920): Array<{ type: string; srcSet: string }> {
  return (['avif', 'webp'] as const).flatMap((format) => {
    const srcSet = imageSrcSet(src, from, to, format);
    return srcSet ? [{ type: `image/${format}`, srcSet }] : [];
  });
}

/** The `<img>`'s `srcset`: JPEG, or PNG for a PNG original, in the address, so a CDN keeps one copy per address. */
export const imageFallbackSet = (src: string | undefined, from = 320, to = 1920): string | undefined =>
  imageSrcSet(src, from, to, 'fallback');

/** How wide a card's picture is drawn: the column's width on a phone, a card's beside others (CardsList.css). */
export const CARD_IMAGE_SIZES = '(max-width: 600px) 100vw, 300px';

/** How wide a record's lead picture or a landing's hero is drawn: most of a desk's width, all of a phone's. */
export const MEDIA_IMAGE_SIZES = '(min-width: 1100px) 60vw, 100vw';
