/**
 * What image a file's bytes are, read from the bytes themselves. A stored
 * type is only the uploader's claim, so a file is drawn inline only when its
 * first bytes are one of the raster formats a browser decodes as a picture
 * and never runs. SVG is a document that can carry script, and is never on
 * this list; neither is anything else.
 */
const ascii = (bytes: Uint8Array, at: number, text: string) =>
  bytes.length >= at + text.length && [...text].every((ch, i) => bytes[at + i] === ch.charCodeAt(0));

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

type SniffedImage = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'image/avif';

export function sniffImage(bytes: Uint8Array): SniffedImage | undefined {
  if (bytes.length >= PNG.length && PNG.every((byte, i) => bytes[i] === byte)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (ascii(bytes, 0, 'GIF87a') || ascii(bytes, 0, 'GIF89a')) return 'image/gif';
  if (ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')) return 'image/webp';
  /* AVIF is an ISO media file: an `ftyp` box whose major brand, or one of
     its compatible brands inside that box, is `avif` (still) or `avis`
     (sequence). */
  if (ascii(bytes, 4, 'ftyp') && bytes.length >= 16) {
    const size = Math.min(((bytes[0] << 24) >>> 0) + (bytes[1] << 16) + (bytes[2] << 8) + bytes[3], bytes.length, 256);
    for (let at = 8; at + 4 <= size; at += at === 8 ? 8 : 4) {
      if (ascii(bytes, at, 'avif') || ascii(bytes, at, 'avis')) return 'image/avif';
    }
  }
  return undefined;
}
