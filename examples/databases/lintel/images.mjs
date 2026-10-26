/**
 * Building photographs for the Lintel seed: real PNG files drawn here, so the
 * sample downloads nothing and carries no one's photograph. Each is a street
 * view at dusk — a sky, the building's face in its own brick or render, rows
 * of windows (some lit), a door, trees and the kerb — drawn at twice the size
 * and averaged down for smooth edges; 4:3, the cards' ratio, with a
 * thumbnail half the size.
 *
 *   renderBuilding('apartments', 3) → { photo, thumb } (PNG buffers)
 */
import { deflateSync } from 'node:zlib';

const W = 480,
  H = 360,
  S = 2;

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}
function png(w, h, rgb) {
  const stride = w * 3,
    raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (stride + 1);
    raw[row] = 1; // Sub filter: flat walls and a soft sky compress to almost nothing.
    for (let i = 0; i < stride; i++) raw[row + 1 + i] = (rgb[y * stride + i] - (i >= 3 ? rgb[y * stride + i - 3] : 0)) & 0xff;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(w, 0);
  header.writeUInt32BE(h, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const mix = (a, b, t) => a.map((c, i) => Math.round(c + (b[i] - c) * t));

class Canvas {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.px = new Float32Array(w * h * 3);
  }
  rect(x0, y0, x1, y1, rgb) {
    const [ax, ay, bx, by] = [x0, y0, x1, y1].map((v) => Math.round(v * S));
    for (let y = Math.max(0, ay); y < Math.min(this.h, by); y++)
      for (let x = Math.max(0, ax); x < Math.min(this.w, bx); x++) this.px.set(rgb, (y * this.w + x) * 3);
  }
  /** A vertical gradient between two colors. */
  fade(x0, y0, x1, y1, top, bottom) {
    const [ay, by] = [y0 * S, y1 * S].map(Math.round);
    for (let y = Math.max(0, ay); y < Math.min(this.h, by); y++) {
      const rgb = mix(top, bottom, (y - ay) / Math.max(1, by - ay));
      for (let x = Math.max(0, Math.round(x0 * S)); x < Math.min(this.w, Math.round(x1 * S)); x++) this.px.set(rgb, (y * this.w + x) * 3);
    }
  }
  /** A triangle (a gable), filled by its edges. */
  gable(x0, x1, base, peak, rgb) {
    const mid = (x0 + x1) / 2;
    for (let y = Math.round(peak * S); y < Math.round(base * S); y++) {
      const t = (y / S - peak) / (base - peak);
      this.rect(mid - (mid - x0) * t, y / S, mid + (x1 - mid) * t, (y + 1) / S, rgb);
    }
  }
  disc(cx, cy, r, rgb) {
    for (let y = Math.round((cy - r) * S); y < Math.round((cy + r) * S); y++)
      for (let x = Math.round((cx - r) * S); x < Math.round((cx + r) * S); x++) {
        if (x < 0 || y < 0 || x >= this.w || y >= this.h) continue;
        if ((x / S - cx) ** 2 + (y / S - cy) ** 2 <= r * r) this.px.set(rgb, (y * this.w + x) * 3);
      }
  }
  /** Averaged down to its real size: each pixel the mean of its S×S block. */
  encode(scale = 1) {
    const w = Math.round(this.w / S / scale),
      h = Math.round(this.h / S / scale),
      step = S * scale,
      out = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        for (let c = 0; c < 3; c++) {
          let sum = 0;
          for (let dy = 0; dy < step; dy++)
            for (let dx = 0; dx < step; dx++) sum += this.px[((y * step + dy) * this.w + x * step + dx) * 3 + c];
          out[(y * w + x) * 3 + c] = Math.round(sum / (step * step));
        }
    return png(w, h, out);
  }
}

/** A tiny repeatable random, so a photo is the same every seed. */
function random(seed) {
  let s = seed >>> 0 || 1;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

const WALLS = {
  apartments: [
    [214, 196, 172],
    [196, 170, 140],
    [228, 216, 196],
  ],
  lofts: [
    [158, 82, 62],
    [140, 72, 56],
    [172, 96, 70],
  ],
  townhomes: [
    [92, 116, 132],
    [204, 184, 150],
    [128, 142, 112],
  ],
};
const LIT = [255, 214, 140],
  DARK = [52, 62, 78],
  FRAME = [238, 234, 226];

function windows(canvas, x0, x1, y0, y1, columns, rows, rand, tall = false) {
  const cw = (x1 - x0) / columns,
    rh = (y1 - y0) / rows;
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < columns; c++) {
      const wx = x0 + c * cw + cw * 0.22,
        wy = y0 + r * rh + rh * (tall ? 0.14 : 0.24);
      const ww = cw * 0.56,
        wh = rh * (tall ? 0.7 : 0.5);
      canvas.rect(wx - 2, wy - 2, wx + ww + 2, wy + wh + 2, FRAME);
      canvas.fade(wx, wy, wx + ww, wy + wh, rand() < 0.45 ? LIT : DARK, rand() < 0.45 ? mix(LIT, [255, 180, 110], 0.5) : [70, 84, 104]);
      canvas.rect(wx + ww / 2 - 1, wy, wx + ww / 2 + 1, wy + wh, FRAME);
    }
}

function tree(canvas, x, ground, size, rand) {
  canvas.rect(x - 3, ground - size * 0.9, x + 3, ground, [86, 64, 48]);
  const green = mix([62, 104, 70], [96, 136, 82], rand());
  canvas.disc(x, ground - size * 1.1, size * 0.55, green);
  canvas.disc(x - size * 0.3, ground - size * 0.85, size * 0.4, mix(green, [40, 70, 48], 0.3));
  canvas.disc(x + size * 0.32, ground - size * 0.9, size * 0.42, mix(green, [120, 160, 96], 0.2));
}

/** One street view of a building of `kind`; `variant` changes the wall, the hour and which windows are lit. */
export function renderBuilding(kind, variant = 0) {
  const rand = random(variant * 7919 + kind.length * 104729);
  const canvas = new Canvas(W * S, H * S);
  const dusk = variant % 2 === 0;
  canvas.fade(0, 0, W, H * 0.7, dusk ? [62, 84, 140] : [126, 176, 222], dusk ? [238, 168, 128] : [214, 230, 240]);
  const ground = H * 0.82;
  const wall = WALLS[kind]?.[variant % 3] ?? WALLS.apartments[0];
  if (kind === 'townhomes') {
    // A row of four, each with its own gable and door.
    for (let i = 0; i < 4; i++) {
      const x0 = 34 + i * 103,
        x1 = x0 + 100,
        face = mix(wall, i % 2 ? [255, 255, 255] : [0, 0, 0], 0.08);
      canvas.rect(x0, ground - 170, x1, ground, face);
      canvas.gable(x0 - 6, x1 + 6, ground - 168, ground - 226, [70, 64, 66]);
      windows(canvas, x0 + 6, x1 - 6, ground - 160, ground - 72, 2, 1, rand, true);
      canvas.rect(x0 + 38, ground - 62, x0 + 62, ground, [58, 74, 96]);
      canvas.rect(x0 + 34, ground - 4, x0 + 66, ground, [180, 176, 168]);
    }
  } else {
    const floors = kind === 'lofts' ? 4 : 5;
    const x0 = kind === 'lofts' ? 70 : 52,
      x1 = W - x0,
      top = ground - (kind === 'lofts' ? 216 : 246);
    canvas.rect(x0, top, x1, ground, wall);
    canvas.rect(x0 - 8, top - 10, x1 + 8, top, mix(wall, [30, 30, 30], 0.45));
    // Floor lines in the wall's own darker shade.
    for (let f = 1; f < floors; f++)
      canvas.rect(x0, top + (f * (ground - top)) / floors - 2, x1, top + (f * (ground - top)) / floors + 1, mix(wall, [0, 0, 0], 0.12));
    windows(canvas, x0 + 10, x1 - 10, top + 6, ground - 46, kind === 'lofts' ? 5 : 7, floors - 1, rand, kind === 'lofts');
    const door = (x0 + x1) / 2;
    canvas.rect(door - 26, ground - 44, door + 26, ground, mix(wall, [0, 0, 0], 0.35));
    canvas.fade(door - 20, ground - 40, door + 20, ground, LIT, [214, 160, 96]);
    canvas.rect(door - 34, ground - 50, door + 34, ground - 44, [60, 60, 64]);
  }
  canvas.fade(0, ground, W, H, [150, 150, 146], [112, 112, 110]);
  canvas.rect(0, ground, W, ground + 5, [200, 198, 192]);
  for (let i = 0; i < 3; i++) tree(canvas, 24 + i * 216 + rand() * 30, ground + 4, 34 + rand() * 12, rand);
  return { photo: canvas.encode(1), thumb: canvas.encode(2) };
}
