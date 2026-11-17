/**
 * A picture's shape, read from its header bytes: width over height, or undefined when the bytes do not say. No decoder
 * and no dependency: a logo's shape is only needed to place it (the sign-in door stands a square mark beside its heading
 * and a wordmark over it, SignIn.tsx), and the server knows it before the page paints, so the page never moves when
 * the picture arrives. Called on bytes already admitted (brandImage.ts), so an SVG is the rebuilt one.
 */

const positive = (width: number, height: number): number | undefined =>
  Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? Math.round((width / height) * 1000) / 1000 : undefined;

function png(bytes: Buffer): number | undefined {
  // The signature, then the IHDR chunk: length, "IHDR", width, height.
  return bytes.length >= 24 && bytes.toString('latin1', 12, 16) === 'IHDR'
    ? positive(bytes.readUInt32BE(16), bytes.readUInt32BE(20))
    : undefined;
}

function gif(bytes: Buffer): number | undefined {
  return bytes.length >= 10 ? positive(bytes.readUInt16LE(6), bytes.readUInt16LE(8)) : undefined;
}

function jpeg(bytes: Buffer): number | undefined {
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return undefined;
    const marker = bytes[at + 1]!;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    // Markers with no length: standalone (RSTn, SOI, EOI, TEM).
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      at += 2;
      continue;
    }
    // A start of frame (SOF0..SOF15 except DHT, JPG and DAC): length, precision, height, width.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
      return at + 9 <= bytes.length ? positive(bytes.readUInt16BE(at + 7), bytes.readUInt16BE(at + 5)) : undefined;
    at += 2 + bytes.readUInt16BE(at + 2);
  }
  return undefined;
}

function webp(bytes: Buffer): number | undefined {
  if (bytes.length < 30) return undefined;
  const kind = bytes.toString('latin1', 12, 16);
  if (kind === 'VP8X') return positive(1 + bytes.readUIntLE(24, 3), 1 + bytes.readUIntLE(27, 3));
  if (kind === 'VP8 ')
    return bytes.readUInt8(23) === 0x9d ? positive(bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff) : undefined;
  if (kind === 'VP8L' && bytes[20] === 0x2f) {
    const bits = bytes.readUInt32LE(21);
    return positive((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
  }
  return undefined;
}

/** A length in an SVG's own number syntax; a percentage or an unknown unit says nothing of the shape. */
function length(text: string | undefined): number | undefined {
  const match = text === undefined ? null : /^\s*([0-9]*\.?[0-9]+)\s*(px|pt|pc|mm|cm|in|em|ex)?\s*$/i.exec(text);
  return match ? Number(match[1]) : undefined;
}

function svg(bytes: Buffer): number | undefined {
  const tag = /<svg\b[^>]*>/i.exec(bytes.toString('utf8', 0, Math.min(bytes.length, 4096)))?.[0];
  if (!tag) return undefined;
  const attribute = (name: string) => new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag)?.slice(1).find(Boolean);
  const width = length(attribute('width'));
  const height = length(attribute('height'));
  if (width && height) return positive(width, height);
  const box = attribute('viewBox')
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  return box?.length === 4 ? positive(box[2]!, box[3]!) : undefined;
}

/** Width over height of a PNG, GIF, JPEG, WebP or SVG, to three places; undefined for anything else or anything cut short. */
export function imageAspect(bytes: Buffer): number | undefined {
  try {
    if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47) return png(bytes);
    if (bytes.length >= 6 && bytes.toString('latin1', 0, 3) === 'GIF') return gif(bytes);
    if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return jpeg(bytes);
    if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return webp(bytes);
    return svg(bytes);
  } catch {
    return undefined;
  }
}
