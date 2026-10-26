/**
 * Studio product shots for the Depot seed: real PNG files drawn here, so the
 * sample needs no downloaded image and carries no maker's mark. Each shot is
 * a seamless light backdrop with a soft floor shadow and one piece of gear —
 * a tent, a pack, a helmet, a U-lock — in the product's colour, lit from above
 * and drawn at twice the size then averaged down for smooth edges. 4:3, the
 * cards' own ratio, with a thumbnail half the size either way.
 *
 *   renderProduct({ shape: 'tent', colour: 'Sage', variant: 3 }) → { photo, thumb } (PNG buffers)
 *   SHAPES — every shape it can draw
 */
import { deflateSync } from 'node:zlib';

export const WIDTH = 480;
export const HEIGHT = 360;
const S = 2;

/* ---------- PNG ---------- */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}
/** An 8-bit RGB PNG, each row filtered with Sub: a studio gradient compresses to almost nothing. */
function encodePng(width, height, rgb) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1);
    raw[row] = 1;
    for (let i = 0; i < stride; i++) raw[row + 1 + i] = (rgb[y * stride + i] - (i >= 3 ? rgb[y * stride + i - 3] : 0)) & 0xff;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- a tiny rasterizer, in unit coordinates ---------- */

const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const toward = (rgb, t) => rgb.map((c) => (t >= 0 ? c + (255 - c) * t : c * (1 + t)));

class Canvas {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.px = new Float32Array(w * h * 3);
  }
  put(x, y, rgb, a) {
    const i = (y * this.w + x) * 3,
      px = this.px;
    px[i] += (rgb[0] - px[i]) * a;
    px[i + 1] += (rgb[1] - px[i + 1]) * a;
    px[i + 2] += (rgb[2] - px[i + 2]) * a;
  }
  /** Even-odd scanline fill of a closed outline given in unit coordinates (x across 0–1, y down 0–1). */
  polygon(points, paint, alpha = 1) {
    const pts = points.map(([x, y]) => [x * this.w, y * this.h]);
    const ys = pts.map((p) => p[1]);
    const top = Math.max(0, Math.floor(Math.min(...ys))),
      bottom = Math.min(this.h - 1, Math.ceil(Math.max(...ys)));
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
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const from = Math.max(0, Math.round(xs[k])),
          to = Math.min(this.w - 1, Math.round(xs[k + 1]) - 1);
        for (let x = from; x <= to; x++) this.put(x, y, paint((y - top) / span, x / this.w), alpha);
      }
    }
  }
  /** An ellipse in unit coordinates; `soft` fades it towards its rim (a shadow). */
  ellipse(cx, cy, rx, ry, paint, alpha = 1, soft = 0) {
    const X = cx * this.w,
      Y = cy * this.h,
      RX = rx * this.w,
      RY = ry * this.h;
    for (let y = Math.max(0, Math.floor(Y - RY)); y <= Math.min(this.h - 1, Math.ceil(Y + RY)); y++) {
      for (let x = Math.max(0, Math.floor(X - RX)); x <= Math.min(this.w - 1, Math.ceil(X + RX)); x++) {
        const d = ((x + 0.5 - X) / RX) ** 2 + ((y + 0.5 - Y) / RY) ** 2;
        if (d > 1) continue;
        this.put(x, y, paint((y - (Y - RY)) / (2 * RY), x / this.w), soft ? alpha * (1 - d) ** soft : alpha);
      }
    }
  }
  pixels() {
    const w = this.w / S,
      h = this.h / S,
      rgb = new Uint8Array(w * h * 3),
      px = this.px,
      row = this.w * 3;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (y * S * this.w + x * S) * 3,
          o = (y * w + x) * 3;
        for (let c = 0; c < 3; c++)
          rgb[o + c] = clamp((px[i + c] + px[i + 3 + c] + px[i + row + c] + px[i + row + 3 + c]) / 4 + 0.5, 0, 255);
      }
    return { w, h, rgb };
  }
}

function halve({ w, h, rgb }) {
  const hw = w >> 1,
    hh = h >> 1,
    out = new Uint8Array(hw * hh * 3),
    row = w * 3;
  for (let y = 0; y < hh; y++)
    for (let x = 0; x < hw; x++) {
      const i = (y * 2 * w + x * 2) * 3,
        o = (y * hw + x) * 3;
      for (let c = 0; c < 3; c++) out[o + c] = (rgb[i + c] + rgb[i + 3 + c] + rgb[i + row + c] + rgb[i + row + 3 + c] + 2) >> 2;
    }
  return { w: hw, h: hh, rgb: out };
}

/** Chaikin corner cutting: a closed outline with its corners rounded. */
function rounded(points, passes = 3) {
  let out = points;
  for (let pass = 0; pass < passes; pass++) {
    const next = [];
    for (let i = 0; i < out.length; i++) {
      const [x1, y1] = out[i],
        [x2, y2] = out[(i + 1) % out.length];
      next.push([x1 * 0.75 + x2 * 0.25, y1 * 0.75 + y2 * 0.25], [x1 * 0.25 + x2 * 0.75, y1 * 0.25 + y2 * 0.75]);
    }
    out = next;
  }
  return out;
}
const rect = (x, y, w, h) => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
];
const box = (x, y, w, h, passes = 3) => rounded(rect(x, y, w, h), passes);
/** A thick line from a to b, `t` wide, as a quad. */
function bar([x1, y1], [x2, y2], t) {
  const dx = x2 - x1,
    dy = (y2 - y1) * 0.75,
    len = Math.hypot(dx, dy) || 1;
  const nx = ((-dy / len) * t) / 2,
    ny = ((dx / len) * t) / 2 / 0.75;
  return [
    [x1 + nx, y1 + ny],
    [x2 + nx, y2 + ny],
    [x2 - nx, y2 - ny],
    [x1 - nx, y1 - ny],
  ];
}
/** An arc of an ellipse, as points: `from` and `to` in radians, 0 to the right, clockwise on screen. */
const arc = (cx, cy, rx, ry, from, to, steps = 28) =>
  Array.from({ length: steps + 1 }, (_, i) => {
    const a = from + (to - from) * (i / steps);
    return [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry];
  });

/* Lit from above: the top of a shape a little lighter, its foot a little darker. */
const lit =
  (rgb, spread = 0.28) =>
  (t) =>
    toward(rgb, spread * (0.5 - t) * 1.4);
const flat = (rgb) => () => rgb;

export const COLOURS = {
  Slate: [74, 86, 100],
  Graphite: [52, 55, 60],
  Black: [34, 35, 38],
  Sage: [118, 140, 104],
  Moss: [86, 104, 62],
  Ember: [196, 84, 52],
  Coral: [226, 112, 96],
  Red: [184, 44, 48],
  Ochre: [204, 150, 52],
  Yellow: [230, 196, 60],
  Glacier: [120, 176, 204],
  Cobalt: [44, 88, 170],
  Blue: [58, 110, 186],
  Teal: [34, 128, 128],
  Sand: [196, 176, 140],
  Orange: [226, 120, 40],
  Silver: [176, 180, 186],
  White: [232, 232, 228],
  Plum: [110, 62, 104],
  Navy: [36, 50, 84],
};
const METAL = [150, 154, 160],
  DARK = [44, 46, 50],
  LENS = [236, 238, 226];

function backdrop(canvas, tone) {
  // A seamless sweep: lighter at the top, a soft floor under the product.
  const top = toward(tone, 0.55),
    floor = toward(tone, 0.2);
  canvas.polygon(rect(0, 0, 1, 1), (t) => (t < 0.72 ? top.map((c, i) => c + (floor[i] - c) * (t / 0.72) ** 2) : floor));
}
function shadow(canvas, cx, cy, rx, ry = 0.035) {
  canvas.ellipse(cx, cy, rx, ry, flat([40, 40, 44]), 0.34, 1.6);
}

/* ---------- the gear ---------- */

const DRAW = {
  tent(c, rgb, v) {
    const w = 0.34 + (v % 3) * 0.04;
    shadow(c, 0.5, 0.8, w + 0.06);
    const dome = [...arc(0.5, 0.8, w, 0.46, Math.PI, 2 * Math.PI)];
    c.polygon(dome, lit(rgb, 0.34));
    // The fly's seams and the door, a darker arch.
    c.polygon(bar([0.5 - w * 0.7, 0.8], [0.5, 0.35], 0.012), flat(toward(rgb, -0.3)), 0.8);
    c.polygon(bar([0.5 + w * 0.7, 0.8], [0.5, 0.35], 0.012), flat(toward(rgb, -0.3)), 0.8);
    c.polygon([...arc(0.5, 0.8, w * 0.36, 0.26, Math.PI, 2 * Math.PI)], lit(toward(rgb, -0.45), 0.2));
    c.polygon(rect(0.5 - w - 0.02, 0.795, 2 * w + 0.04, 0.012), flat(DARK), 0.85);
  },
  sack(c, rgb, v) {
    const w = 0.2 + (v % 2) * 0.03;
    shadow(c, 0.5, 0.84, w * 0.8);
    c.polygon(box(0.5 - w / 2, 0.22, w, 0.62, 4), lit(rgb));
    c.ellipse(0.5, 0.23, w / 2 - 0.01, 0.035, flat(toward(rgb, -0.35)));
    c.polygon(rect(0.5 - 0.006, 0.12, 0.012, 0.1), flat(DARK));
    for (const y of [0.4, 0.62]) c.polygon(rect(0.5 - w / 2, y, w, 0.03), flat(toward(DARK, 0.1)), 0.85);
  },
  pad(c, rgb, v) {
    const len = 0.46 + (v % 2) * 0.06;
    shadow(c, 0.5, 0.74, len * 0.62);
    c.polygon(box(0.5 - len / 2, 0.42, len, 0.3, 3), lit(rgb));
    // The rolled end: rings of the pad.
    const ex = 0.5 + len / 2 - 0.02;
    for (const [r, t] of [
      [0.105, -0.25],
      [0.08, 0.1],
      [0.055, -0.2],
      [0.03, 0.12],
    ])
      c.ellipse(ex, 0.57, r * 0.5, r * 1.4, flat(toward(rgb, t)));
    for (const x of [0.5 - len / 4, 0.5 + len / 8]) c.polygon(rect(x, 0.42, 0.025, 0.3), flat(DARK), 0.8);
  },
  stove(c, rgb) {
    shadow(c, 0.5, 0.82, 0.2);
    c.polygon(box(0.36, 0.5, 0.28, 0.32, 3), lit(rgb));
    c.polygon(rect(0.36, 0.56, 0.28, 0.07), flat(toward(rgb, 0.45)), 0.9);
    c.polygon(box(0.465, 0.38, 0.07, 0.13, 2), lit(METAL));
    c.ellipse(0.5, 0.36, 0.1, 0.03, flat(toward(METAL, -0.3)));
    for (const a of [-0.9, 0, 0.9]) c.polygon(bar([0.5, 0.35], [0.5 + Math.sin(a) * 0.13, 0.31 + Math.cos(a) * 0.02], 0.014), flat(DARK));
  },
  pot(c, rgb, v) {
    const w = 0.26 + (v % 3) * 0.03;
    shadow(c, 0.5, 0.8, w * 0.75);
    c.polygon(box(0.5 - w / 2, 0.44, w, 0.36, 2), lit(rgb, 0.4));
    c.ellipse(0.5, 0.44, w / 2, 0.045, flat(toward(rgb, -0.25)));
    c.ellipse(0.5, 0.425, w / 2 - 0.02, 0.035, lit(toward(rgb, 0.3)));
    c.polygon(rect(0.49, 0.37, 0.02, 0.05), flat(DARK));
    c.polygon(bar([0.5 + w / 2, 0.5], [0.5 + w / 2 + 0.16, 0.47], 0.03), flat(DARK));
  },
  headlamp(c, rgb) {
    shadow(c, 0.5, 0.78, 0.26);
    // The band, seen from above and in front.
    c.ellipse(0.5, 0.6, 0.27, 0.14, flat(toward(rgb, -0.1)));
    c.ellipse(0.5, 0.6, 0.23, 0.1, (t) => backdropAt(t));
    c.polygon(box(0.4, 0.5, 0.2, 0.2, 3), lit(DARK, 0.4));
    c.ellipse(0.5, 0.6, 0.065, 0.085, flat(LENS));
    c.ellipse(0.5, 0.6, 0.035, 0.045, flat([250, 248, 230]));
    c.polygon(rect(0.43, 0.52, 0.14, 0.02), flat(rgb));
  },
  bottle(c, rgb, v) {
    const w = 0.13 + (v % 2) * 0.03;
    shadow(c, 0.5, 0.86, w);
    c.polygon(box(0.5 - w / 2, 0.24, w, 0.62, 3), lit(rgb, 0.36));
    c.polygon(box(0.5 - w * 0.32, 0.14, w * 0.64, 0.12, 2), lit(DARK));
    c.polygon(rect(0.5 - w / 2, 0.48, w, 0.14), flat(toward(rgb, 0.55)), 0.9);
    c.polygon(rect(0.5 - w / 2 + 0.015, 0.3, 0.012, 0.52), flat(toward(rgb, 0.5)), 0.5);
  },
  pack(c, rgb, v) {
    const w = 0.3 + (v % 3) * 0.02,
      h = 0.56;
    shadow(c, 0.5, 0.86, w * 0.72);
    c.polygon(box(0.5 - w / 2, 0.3, w, h, 4), lit(rgb));
    c.polygon(box(0.5 - w / 2 + 0.01, 0.2, w - 0.02, 0.16, 3), lit(toward(rgb, -0.2)));
    c.polygon(box(0.5 - w / 3, 0.56, (2 * w) / 3, 0.24, 3), lit(toward(rgb, 0.12)));
    c.polygon(rect(0.5 - w / 3, 0.6, (2 * w) / 3, 0.012), flat(DARK), 0.8);
    for (const x of [0.5 - w / 4, 0.5 + w / 4 - 0.02]) c.polygon(rect(x, 0.36, 0.02, 0.18), flat(DARK), 0.85);
    c.polygon(box(0.47, 0.13, 0.06, 0.09, 2), flat(DARK));
  },
  poles(c, rgb) {
    shadow(c, 0.5, 0.86, 0.22, 0.03);
    for (const [x1, x2] of [
      [0.42, 0.36],
      [0.58, 0.64],
    ]) {
      c.polygon(bar([x1, 0.2], [x2, 0.84], 0.02), lit(METAL));
      c.polygon(bar([x1, 0.14], [x1 + (x2 - x1) * 0.2, 0.34], 0.045), lit(DARK));
      c.polygon(bar([x1 + (x2 - x1) * 0.45, 0.48], [x1 + (x2 - x1) * 0.5, 0.52], 0.03), flat(rgb));
      c.ellipse(x2 - (x2 - x1) * 0.08, 0.78, 0.04, 0.018, flat(DARK));
    }
  },
  helmet(c, rgb, v) {
    shadow(c, 0.5, 0.78, 0.3);
    c.polygon([...arc(0.5, 0.74, 0.3, 0.42 - (v % 2) * 0.03, Math.PI, 2 * Math.PI)], lit(rgb, 0.4));
    for (const [x, w] of [
      [0.33, 0.05],
      [0.42, 0.06],
      [0.52, 0.06],
      [0.62, 0.05],
    ]) {
      c.polygon(box(x, 0.4, w, 0.16, 2), flat(toward(rgb, -0.45)), 0.9);
    }
    c.polygon(rect(0.2, 0.72, 0.6, 0.035), flat(DARK));
    c.polygon(
      [
        [0.2, 0.72],
        [0.12, 0.66],
        [0.26, 0.66],
      ],
      flat(DARK),
    );
  },
  bikelight(c, rgb) {
    shadow(c, 0.5, 0.74, 0.2);
    c.polygon(box(0.36, 0.42, 0.28, 0.3, 4), lit(DARK, 0.4));
    c.ellipse(0.5, 0.57, 0.09, 0.11, flat(LENS));
    c.ellipse(0.5, 0.57, 0.045, 0.055, flat([255, 252, 236]));
    c.polygon(rect(0.36, 0.44, 0.28, 0.03), flat(rgb));
    c.polygon(box(0.44, 0.72, 0.12, 0.05, 2), flat(toward(rgb, -0.2)));
  },
  tire(c, rgb, v) {
    shadow(c, 0.5, 0.88, 0.3, 0.03);
    c.ellipse(0.5, 0.52, 0.27, 0.36, lit(DARK, 0.3));
    c.ellipse(0.5, 0.52, 0.21, 0.28, flat(toward(rgb, v % 2 ? -0.2 : 0.1)));
    c.ellipse(0.5, 0.52, 0.19, 0.255, (t) => backdropAt(t));
    for (let k = 0; k < 18; k++) {
      const a = (k / 18) * Math.PI * 2;
      c.polygon(
        bar([0.5 + Math.cos(a) * 0.245, 0.52 + Math.sin(a) * 0.33], [0.5 + Math.cos(a) * 0.27, 0.52 + Math.sin(a) * 0.36], 0.012),
        flat([20, 20, 22]),
      );
    }
  },
  pump(c, rgb) {
    shadow(c, 0.5, 0.84, 0.18);
    c.polygon(box(0.44, 0.3, 0.12, 0.52, 3), lit(rgb, 0.4));
    c.polygon(box(0.32, 0.2, 0.36, 0.06, 2), lit(DARK));
    c.polygon(rect(0.49, 0.25, 0.02, 0.06), flat(METAL));
    c.polygon(box(0.34, 0.8, 0.32, 0.04, 2), flat(DARK));
    c.polygon(bar([0.56, 0.4], [0.7, 0.62], 0.012), flat(DARK), 0.9);
  },
  lock(c, rgb) {
    shadow(c, 0.5, 0.86, 0.22);
    const shackle = [
      ...arc(0.5, 0.42, 0.16, 0.24, Math.PI, 2 * Math.PI),
      [0.66, 0.78],
      [0.61, 0.78],
      ...arc(0.5, 0.42, 0.11, 0.18, 2 * Math.PI, Math.PI),
      [0.39, 0.78],
      [0.34, 0.78],
    ];
    c.polygon(shackle, lit(METAL, 0.45));
    c.polygon(box(0.26, 0.62, 0.48, 0.14, 3), lit(rgb, 0.4));
    c.ellipse(0.66, 0.69, 0.02, 0.028, flat(DARK));
  },
  jacket(c, rgb, v) {
    shadow(c, 0.5, 0.9, 0.26);
    const hood = v % 2 === 0;
    const body = rounded(
      [
        [0.32, 0.26],
        [0.42, 0.2],
        [0.58, 0.2],
        [0.68, 0.26],
        [0.84, 0.62],
        [0.76, 0.66],
        [0.68, 0.46],
        [0.68, 0.88],
        [0.32, 0.88],
        [0.32, 0.46],
        [0.24, 0.66],
        [0.16, 0.62],
      ],
      2,
    );
    c.polygon(body, lit(rgb));
    if (hood)
      c.polygon(
        rounded(
          [
            [0.42, 0.21],
            [0.44, 0.1],
            [0.56, 0.1],
            [0.58, 0.21],
          ],
          2,
        ),
        lit(toward(rgb, -0.15)),
      );
    else c.polygon(rect(0.42, 0.17, 0.16, 0.05), flat(toward(rgb, -0.25)));
    c.polygon(rect(0.495, 0.22, 0.01, 0.66), flat(DARK), 0.85);
    c.polygon(rect(0.38, 0.6, 0.08, 0.008), flat(DARK), 0.6);
    c.polygon(rect(0.54, 0.6, 0.08, 0.008), flat(DARK), 0.6);
  },
  shirt(c, rgb) {
    shadow(c, 0.5, 0.9, 0.24);
    c.polygon(
      rounded(
        [
          [0.34, 0.24],
          [0.44, 0.2],
          [0.56, 0.2],
          [0.66, 0.24],
          [0.84, 0.66],
          [0.77, 0.7],
          [0.66, 0.46],
          [0.66, 0.88],
          [0.34, 0.88],
          [0.34, 0.46],
          [0.23, 0.7],
          [0.16, 0.66],
        ],
        2,
      ),
      lit(rgb),
    );
    c.polygon([...arc(0.5, 0.2, 0.065, 0.05, 0, Math.PI)], flat(toward(rgb, -0.3)));
    c.polygon(rect(0.34, 0.84, 0.32, 0.02), flat(toward(rgb, -0.2)));
  },
  glove(c, rgb) {
    shadow(c, 0.5, 0.86, 0.2);
    c.polygon(
      rounded(
        [
          [0.4, 0.86],
          [0.38, 0.5],
          [0.4, 0.26],
          [0.47, 0.24],
          [0.48, 0.44],
          [0.5, 0.2],
          [0.56, 0.2],
          [0.56, 0.42],
          [0.6, 0.24],
          [0.65, 0.27],
          [0.62, 0.5],
          [0.7, 0.44],
          [0.73, 0.5],
          [0.62, 0.66],
          [0.6, 0.86],
        ],
        2,
      ),
      lit(rgb),
    );
    c.polygon(rect(0.4, 0.76, 0.2, 0.05), flat(DARK), 0.85);
  },
  sock(c, rgb) {
    shadow(c, 0.5, 0.86, 0.2);
    c.polygon(
      rounded(
        [
          [0.42, 0.14],
          [0.58, 0.14],
          [0.58, 0.62],
          [0.72, 0.72],
          [0.74, 0.84],
          [0.44, 0.84],
          [0.42, 0.7],
        ],
        2,
      ),
      lit(rgb),
    );
    c.polygon(rect(0.42, 0.14, 0.16, 0.06), flat(toward(rgb, -0.3)));
    c.polygon(
      rounded(
        [
          [0.62, 0.7],
          [0.74, 0.74],
          [0.74, 0.84],
          [0.62, 0.84],
        ],
        1,
      ),
      flat(toward(rgb, 0.4)),
      0.8,
    );
  },
};
export const SHAPES = Object.keys(DRAW);

/* The backdrop's colour at a row, for a hole a shape leaves (a tyre's middle,
   a headlamp's band). Set before each render. */
let backdropAt = () => [240, 240, 240];

/** A product shot and its thumbnail (240×180), both PNG. */
export function renderProduct({ shape = 'pack', colour = 'Slate', variant = 0 } = {}) {
  const canvas = new Canvas(WIDTH * S, HEIGHT * S);
  const tone = [
    [226, 228, 230],
    [232, 228, 222],
    [224, 229, 226],
  ][variant % 3];
  backdrop(canvas, tone);
  const top = toward(tone, 0.55),
    floor = toward(tone, 0.2);
  backdropAt = () => top.map((c, i) => c + (floor[i] - c) * 0.35);
  (DRAW[shape] ?? DRAW.pack)(canvas, COLOURS[colour] ?? COLOURS.Slate, variant);
  const full = canvas.pixels(),
    thumb = halve(full);
  return { photo: encodePng(full.w, full.h, full.rgb), thumb: encodePng(thumb.w, thumb.h, thumb.rgb) };
}
