/**
 * Flat-lay product shots for the Atelier seed: real PNG files drawn here, so
 * the sample downloads nothing and carries no maker's mark. Each shot is one
 * garment or accessory, in its color, on a warm paper backdrop with a soft
 * shadow, drawn at twice the size and averaged down for smooth edges; 4:3,
 * the cards' ratio, with a thumbnail half the size.
 *
 *   renderGarment('dress', [190, 106, 76], 2) → { photo, thumb } (PNG buffers)
 */
import { deflateSync } from 'node:zlib';

const W = 400,
  H = 300,
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
    raw[row] = 1; // Sub filter: a soft gradient compresses to almost nothing.
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

const shade = (rgb, t) => rgb.map((c) => Math.max(0, Math.min(255, t >= 0 ? c + (255 - c) * t : c * (1 + t))));

class Canvas {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.px = new Float32Array(w * h * 3);
  }
  put(x, y, rgb, a) {
    const i = (y * this.w + x) * 3,
      p = this.px;
    p[i] += (rgb[0] - p[i]) * a;
    p[i + 1] += (rgb[1] - p[i + 1]) * a;
    p[i + 2] += (rgb[2] - p[i + 2]) * a;
  }
  /** Even-odd fill of an outline in unit coordinates; `paint(t)` takes 0 at its top and 1 at its foot. */
  fill(points, paint, alpha = 1) {
    const pts = points.map(([x, y]) => [x * this.w, y * this.h]);
    const top = Math.max(0, Math.floor(Math.min(...pts.map((p) => p[1])))),
      bottom = Math.min(this.h - 1, Math.ceil(Math.max(...pts.map((p) => p[1]))));
    const span = Math.max(1, bottom - top);
    for (let y = top; y <= bottom; y++) {
      const cy = y + 0.5,
        xs = [];
      for (let i = 0; i < pts.length; i++) {
        const [x1, y1] = pts[i],
          [x2, y2] = pts[(i + 1) % pts.length];
        if ((y1 <= cy && y2 > cy) || (y2 <= cy && y1 > cy)) xs.push(x1 + ((cy - y1) / (y2 - y1)) * (x2 - x1));
      }
      xs.sort((a, b) => a - b);
      const color = paint((y - top) / span);
      for (let k = 0; k + 1 < xs.length; k += 2)
        for (let x = Math.max(0, Math.round(xs[k])); x <= Math.min(this.w - 1, Math.round(xs[k + 1]) - 1); x++)
          this.put(x, y, color, alpha);
    }
  }
  ellipse(cx, cy, rx, ry, rgb, alpha = 1, soft = 0) {
    const X = cx * this.w,
      Y = cy * this.h,
      RX = rx * this.w,
      RY = ry * this.h;
    for (let y = Math.max(0, Math.floor(Y - RY)); y <= Math.min(this.h - 1, Math.ceil(Y + RY)); y++)
      for (let x = Math.max(0, Math.floor(X - RX)); x <= Math.min(this.w - 1, Math.ceil(X + RX)); x++) {
        const d = ((x + 0.5 - X) / RX) ** 2 + ((y + 0.5 - Y) / RY) ** 2;
        if (d <= 1) this.put(x, y, rgb, soft ? alpha * (1 - d) ** soft : alpha);
      }
  }
  /** Averaged down by `by` in each direction. */
  pixels(by) {
    const w = this.w / by,
      h = this.h / by,
      out = new Uint8Array(w * h * 3);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        for (let c = 0; c < 3; c++) {
          let sum = 0;
          for (let dy = 0; dy < by; dy++) for (let dx = 0; dx < by; dx++) sum += this.px[((y * by + dy) * this.w + x * by + dx) * 3 + c];
          out[(y * w + x) * 3 + c] = Math.round(sum / (by * by));
        }
    return { w, h, rgb: out };
  }
}

/** Chaikin corner cutting: the outline with its corners softened. */
function soften(points, passes = 2) {
  let out = points;
  for (let p = 0; p < passes; p++)
    out = out.flatMap(([x1, y1], i) => {
      const [x2, y2] = out[(i + 1) % out.length];
      return [
        [x1 * 0.75 + x2 * 0.25, y1 * 0.75 + y2 * 0.25],
        [x1 * 0.25 + x2 * 0.75, y1 * 0.25 + y2 * 0.75],
      ];
    });
  return out;
}
const mirror = (half) => [...half, ...half.map(([x, y]) => [1 - x, y]).reverse()];
const rect = (x, y, w, h) => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
];
const ring = (cx, cy, rx, ry, steps = 40) =>
  Array.from({ length: steps }, (_, i) => [cx + Math.cos((i / steps) * 2 * Math.PI) * rx, cy + Math.sin((i / steps) * 2 * Math.PI) * ry]);

/* Each shape is a list of [outline, tint]: a tint darkens (−) or lightens (+) the garment's own color. */
const SHAPES = {
  tee: () => [
    [
      soften(
        mirror([
          [0.5, 0.2],
          [0.44, 0.17],
          [0.36, 0.2],
          [0.25, 0.3],
          [0.3, 0.39],
          [0.37, 0.35],
          [0.37, 0.84],
          [0.5, 0.84],
        ]),
      ),
      0,
    ],
    [ring(0.5, 0.2, 0.05, 0.04), -0.25],
  ],
  shirt: () => [
    [
      soften(
        mirror([
          [0.5, 0.18],
          [0.43, 0.15],
          [0.36, 0.19],
          [0.24, 0.5],
          [0.22, 0.72],
          [0.28, 0.73],
          [0.32, 0.5],
          [0.36, 0.38],
          [0.36, 0.86],
          [0.5, 0.86],
        ]),
        1,
      ),
      0,
    ],
    [
      mirror([
        [0.5, 0.25],
        [0.44, 0.15],
        [0.42, 0.21],
      ]),
      0.18,
    ],
    [rect(0.495, 0.25, 0.01, 0.6), -0.18],
  ],
  knit: () => [
    [
      soften(
        mirror([
          [0.5, 0.17],
          [0.42, 0.15],
          [0.34, 0.2],
          [0.23, 0.48],
          [0.21, 0.76],
          [0.29, 0.77],
          [0.33, 0.5],
          [0.36, 0.4],
          [0.35, 0.84],
          [0.5, 0.84],
        ]),
      ),
      0,
    ],
    [rect(0.35, 0.79, 0.3, 0.05), -0.16],
    [ring(0.5, 0.18, 0.06, 0.04), -0.2],
  ],
  dress: () => [
    [
      soften(
        mirror([
          [0.5, 0.17],
          [0.46, 0.13],
          [0.42, 0.13],
          [0.4, 0.3],
          [0.43, 0.42],
          [0.29, 0.88],
          [0.5, 0.9],
        ]),
      ),
      0,
    ],
    [rect(0.42, 0.4, 0.16, 0.025), -0.18],
  ],
  skirt: () => [
    [rect(0.39, 0.2, 0.22, 0.06), -0.14],
    [
      soften(
        mirror([
          [0.5, 0.26],
          [0.39, 0.26],
          [0.3, 0.84],
          [0.5, 0.86],
        ]),
        1,
      ),
      0,
    ],
  ],
  trousers: () => [
    [rect(0.38, 0.12, 0.24, 0.05), -0.14],
    [
      mirror([
        [0.5, 0.17],
        [0.38, 0.17],
        [0.34, 0.9],
        [0.45, 0.9],
        [0.49, 0.36],
      ]),
      0,
    ],
    [rect(0.495, 0.17, 0.01, 0.18), -0.2],
  ],
  coat: () => [
    [
      soften(
        mirror([
          [0.5, 0.2],
          [0.42, 0.13],
          [0.33, 0.18],
          [0.22, 0.5],
          [0.21, 0.8],
          [0.29, 0.8],
          [0.32, 0.52],
          [0.34, 0.42],
          [0.33, 0.9],
          [0.5, 0.9],
        ]),
        1,
      ),
      0,
    ],
    [
      mirror([
        [0.5, 0.48],
        [0.42, 0.13],
        [0.44, 0.32],
      ]),
      0.14,
    ],
    [ring(0.47, 0.55, 0.008, 0.01), -0.35],
    [ring(0.47, 0.66, 0.008, 0.01), -0.35],
  ],
  shoe: () => [
    [
      soften(
        [
          [0.2, 0.62],
          [0.23, 0.44],
          [0.36, 0.42],
          [0.46, 0.5],
          [0.66, 0.56],
          [0.8, 0.6],
          [0.82, 0.66],
          [0.2, 0.68],
        ],
        2,
      ),
      0,
    ],
    [rect(0.19, 0.66, 0.64, 0.05), -0.45],
  ],
  bag: () => [
    [
      soften(
        [
          [0.3, 0.36],
          [0.7, 0.36],
          [0.74, 0.8],
          [0.26, 0.8],
        ],
        1,
      ),
      0,
    ],
    [
      ring(0.5, 0.4, 0.13, 0.2, 48)
        .filter(([, y]) => y <= 0.4)
        .concat(
          ring(0.5, 0.4, 0.11, 0.18, 48)
            .filter(([, y]) => y <= 0.4)
            .reverse(),
        ),
      -0.2,
    ],
    [rect(0.3, 0.44, 0.4, 0.02), -0.15],
  ],
  scarf: () => [
    [
      soften(
        [
          [0.28, 0.18],
          [0.72, 0.18],
          [0.66, 0.42],
          [0.58, 0.86],
          [0.46, 0.86],
          [0.5, 0.42],
          [0.34, 0.4],
        ],
        2,
      ),
      0,
    ],
    [rect(0.47, 0.82, 0.11, 0.04), -0.15],
  ],
  belt: () => [
    [rect(0.12, 0.47, 0.76, 0.08), 0],
    [[...rect(0.18, 0.44, 0.1, 0.14)], -0.05],
    [rect(0.2, 0.46, 0.06, 0.1), 0.7],
    ...[0.4, 0.48, 0.56, 0.64].map((x) => [ring(x, 0.51, 0.008, 0.012), -0.4]),
  ],
  jewelry: () => [
    [ring(0.38, 0.5, 0.11, 0.2), 0],
    [ring(0.38, 0.5, 0.085, 0.165), 'ground'],
    [ring(0.62, 0.5, 0.11, 0.2), 0],
    [ring(0.62, 0.5, 0.085, 0.165), 'ground'],
  ],
  glasses: () => [
    [ring(0.36, 0.5, 0.12, 0.14), 0],
    [ring(0.36, 0.5, 0.1, 0.115), -0.55],
    [ring(0.64, 0.5, 0.12, 0.14), 0],
    [ring(0.64, 0.5, 0.1, 0.115), -0.55],
    [rect(0.47, 0.44, 0.06, 0.025), 0],
  ],
};
export const GARMENT_SHAPES = Object.keys(SHAPES);

/** One shot of a shape in an [r, g, b] color; `variant` moves the backdrop's warmth a little. */
export function renderGarment(shape, rgb, variant = 0) {
  const draw = SHAPES[shape];
  if (!draw) throw new Error(`No drawing for ${shape}`);
  const c = new Canvas(W * S, H * S);
  const ground = [244 - (variant % 3) * 3, 239 - (variant % 3) * 2, 230];
  c.fill(rect(0, 0, 1, 1), (t) => shade(ground, -0.05 * t));
  c.ellipse(0.5, 0.9, 0.3, 0.05, [120, 110, 98], 0.35, 1.6);
  for (const [outline, tint] of draw()) {
    if (tint === 'ground') c.fill(outline, (t) => shade(ground, -0.05 * (0.5 + t * 0.2)));
    else c.fill(outline, (t) => shade(rgb, tint + 0.12 * (0.5 - t)));
  }
  const full = c.pixels(S);
  const small = c.pixels(S * 2);
  return { photo: png(full.w, full.h, full.rgb), thumb: png(small.w, small.h, small.rgb) };
}
