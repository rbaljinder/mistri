/**
 * Pictures for the Commons seed, drawn here so the sample downloads nothing
 * and carries nobody's likeness or product. Two kinds:
 *
 *   renderAvatar(seed)            → PNG, 256×256: a drawn head-and-shoulders
 *                                   figure on a tinted ground, the default
 *                                   picture a forum gives a member
 *   renderProject(kind, seed)     → { photo, thumb }: a flat-lay of a maker's
 *                                   project on a cutting mat or a bench, 4:3
 *                                   (640×480, thumbnail 320×240)
 *   renderBench()                 → PNG, 1200×900: the front page's photo, a
 *                                   workbench seen from above
 *
 * Everything is drawn at twice the size and averaged down, so edges are
 * smooth. Deterministic: the same seed draws the same picture.
 */
import { deflateSync } from 'node:zlib';

/* ---------- PNG ---------- */

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
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
/** An 8-bit RGB PNG, each row filtered with Sub. */
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

/* ---------- a tiny rasterizer ---------- */

const S = 2;
const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const mix = (a, b, t) => a + (b - a) * t;
const hex = (value) => [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16));
const shade = (rgb, t) => rgb.map((c) => (t >= 0 ? mix(c, 255, t) : mix(c, 0, -t)));

function random(seed) {
  let state = (seed * 2654435761) >>> 0 || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

class Canvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.w = width * S;
    this.h = height * S;
    this.px = new Float32Array(this.w * this.h * 3);
  }
  /** Colour every sample by `paint(x, y) → [r, g, b, a]` in output pixels, within a box. */
  each(box, paint) {
    const [x0, y0, x1, y1] = box.map((v) => v * S);
    const top = Math.max(0, Math.floor(y0)),
      bottom = Math.min(this.h, Math.ceil(y1));
    const left = Math.max(0, Math.floor(x0)),
      right = Math.min(this.w, Math.ceil(x1));
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) {
        const out = paint((x + 0.5) / S, (y + 0.5) / S);
        if (!out) continue;
        const a = out[3] ?? 1;
        if (a <= 0) continue;
        const i = (y * this.w + x) * 3,
          px = this.px;
        px[i] += (out[0] - px[i]) * a;
        px[i + 1] += (out[1] - px[i + 1]) * a;
        px[i + 2] += (out[2] - px[i + 2]) * a;
      }
    }
  }
  fill(color) {
    this.each([0, 0, this.width, this.height], () => color);
  }
  /** A rounded rectangle, with an optional vertical light across it. */
  rect(x, y, w, h, r, color, { light = 0, alpha = 1 } = {}) {
    this.each([x, y, x + w, y + h], (px, py) => {
      const dx = Math.max(x + r - px, 0, px - (x + w - r)),
        dy = Math.max(y + r - py, 0, py - (y + h - r));
      if (dx * dx + dy * dy > r * r) return null;
      return light ? [...shade(color, light * (0.5 - (py - y) / h)), alpha] : [...color, alpha];
    });
  }
  /** A soft shadow under a rounded rectangle: a distance falloff, never a hard offset. */
  shadow(x, y, w, h, r, blur, strength = 0.35) {
    this.each([x - blur, y - blur, x + w + blur, y + h + blur], (px, py) => {
      const qx = Math.max(Math.abs(px - (x + w / 2)) - (w / 2 - r), 0),
        qy = Math.max(Math.abs(py - (y + h / 2)) - (h / 2 - r), 0);
      const d = Math.hypot(qx, qy) - r;
      const a = strength * (1 - clamp(d / blur));
      return a > 0 ? [0, 0, 0, a * a] : null;
    });
  }
  circle(cx, cy, r, color, { light = 0, alpha = 1 } = {}) {
    this.each([cx - r, cy - r, cx + r, cy + r], (px, py) => {
      const d = Math.hypot(px - cx, py - cy);
      if (d > r) return null;
      return light ? [...shade(color, light * ((cy - py) / r) * 0.6), alpha] : [...color, alpha];
    });
  }
  ellipse(cx, cy, rx, ry, color, alpha = 1) {
    this.each([cx - rx, cy - ry, cx + rx, cy + ry], (px, py) =>
      ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2 <= 1 ? [...color, alpha] : null,
    );
  }
  /** A straight stroke of a given width with round ends. */
  line(x1, y1, x2, y2, width, color, alpha = 1) {
    const lx = x2 - x1,
      ly = y2 - y1,
      len = lx * lx + ly * ly || 1;
    this.each([Math.min(x1, x2) - width, Math.min(y1, y2) - width, Math.max(x1, x2) + width, Math.max(y1, y2) + width], (px, py) => {
      const t = clamp(((px - x1) * lx + (py - y1) * ly) / len);
      return Math.hypot(px - (x1 + t * lx), py - (y1 + t * ly)) <= width / 2 ? [...color, alpha] : null;
    });
  }
  /** A polyline, stroke by stroke. */
  path(points, width, color, alpha = 1) {
    for (let i = 1; i < points.length; i++) this.line(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1], width, color, alpha);
  }
  png() {
    const { width, height } = this;
    const rgb = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        for (let c = 0; c < 3; c++) {
          let sum = 0;
          for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) sum += this.px[((y * S + sy) * this.w + x * S + sx) * 3 + c];
          rgb[(y * width + x) * 3 + c] = clamp(Math.round(sum / (S * S)), 0, 255);
        }
    return { width, height, rgb };
  }
}

function downscale({ width, height, rgb }, factor) {
  const w = Math.floor(width / factor),
    h = Math.floor(height / factor);
  const out = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let sy = 0; sy < factor; sy++)
          for (let sx = 0; sx < factor; sx++) sum += rgb[((y * factor + sy) * width + x * factor + sx) * 3 + c];
        out[(y * w + x) * 3 + c] = Math.round(sum / (factor * factor));
      }
  return { width: w, height: h, rgb: out };
}
const encode = (image) => encodePng(image.width, image.height, image.rgb);

/* ---------- grounds ---------- */

/** A self-healing cutting mat: deep green, a fine grid and a bolder one every five. */
function mat(canvas, rand) {
  const base = hex(['#27514a', '#2d4a5e', '#3b3f46'][Math.floor(rand() * 3)]);
  canvas.each([0, 0, canvas.width, canvas.height], (x, y) => {
    const vignette = 1 - 0.28 * Math.hypot((x - canvas.width / 2) / canvas.width, (y - canvas.height / 2) / canvas.height);
    return [...shade(base, (vignette - 1) * 0.9), 1];
  });
  const step = 24;
  for (let x = step / 2; x < canvas.width; x += step)
    canvas.line(x, 0, x, canvas.height, ((x / step) | 0) % 5 === 0 ? 1.4 : 0.6, [230, 240, 235], ((x / step) | 0) % 5 === 0 ? 0.22 : 0.12);
  for (let y = step / 2; y < canvas.height; y += step)
    canvas.line(0, y, canvas.width, y, ((y / step) | 0) % 5 === 0 ? 1.4 : 0.6, [230, 240, 235], ((y / step) | 0) % 5 === 0 ? 0.22 : 0.12);
}

/** A light maple bench top: planks with a soft grain. */
function bench(canvas, rand) {
  const base = hex(['#c9a27a', '#b88c62', '#d2b48c'][Math.floor(rand() * 3)]);
  const plank = 150 + Math.floor(rand() * 40);
  const phase = rand() * 100;
  canvas.each([0, 0, canvas.width, canvas.height], (x, y) => {
    const row = Math.floor(y / plank);
    const grain = Math.sin((x + row * 211 + phase) * 0.018 + Math.sin(y * 0.05 + row) * 1.8) * 0.5 + Math.sin(x * 0.11 + row * 3) * 0.12;
    const seam = y % plank < 2 ? -0.22 : 0;
    return [...shade(base, grain * 0.07 + (row % 2 ? -0.04 : 0.02) + seam), 1];
  });
}

/* ---------- the projects ---------- */

const KEYCAP_SETS = [
  { alpha: '#f2efe6', mod: '#5b6770', accent: '#d9653b', legend: '#3a3a3a', case: '#2b2f33' },
  { alpha: '#e7e4f5', mod: '#6d5fa8', accent: '#e8b54d', legend: '#40385f', case: '#d7d3e6' },
  { alpha: '#1f2428', mod: '#394249', accent: '#57b894', legend: '#b8c2c8', case: '#9aa4ab' },
  { alpha: '#f4e3c3', mod: '#8b5e34', accent: '#3f7d74', legend: '#5a4430', case: '#e9dcc5' },
];

function keyboard(canvas, x, y, width, rand) {
  const set = KEYCAP_SETS[Math.floor(rand() * KEYCAP_SETS.length)];
  const u = width / 15.6,
    rows = [
      [[1, 'mod'], ...Array(12).fill([1, 'alpha']), [2, 'mod']],
      [[1.5, 'mod'], ...Array(12).fill([1, 'alpha']), [1.5, 'mod']],
      [[1.75, 'mod'], ...Array(11).fill([1, 'alpha']), [2.25, 'accent']],
      [[2.25, 'mod'], ...Array(10).fill([1, 'alpha']), [2.75, 'mod']],
      [
        [1.25, 'mod'],
        [1.25, 'mod'],
        [1.25, 'mod'],
        [6.25, 'alpha'],
        [1.25, 'mod'],
        [1.25, 'mod'],
        [1.25, 'mod'],
        [1.25, 'accent'],
      ],
    ];
  const height = u * 5 + u * 0.6;
  canvas.shadow(x, y + 6, width, height, 10, 22, 0.45);
  canvas.rect(x, y, width, height, 10, hex(set.case), { light: 0.25 });
  rows.forEach((row, r) => {
    let cx = x + u * 0.3;
    for (const [size, kind] of row) {
      const color = hex(set[kind]);
      const kx = cx + 2,
        ky = y + u * 0.3 + r * u + 2,
        kw = size * u - 4,
        kh = u - 4;
      canvas.rect(kx, ky, kw, kh, 5, shade(color, -0.18));
      canvas.rect(kx + 3, ky + 2, kw - 6, kh - 8, 4, color, { light: 0.18 });
      if (kind !== 'alpha' || rand() > 0.55) canvas.rect(kx + 8, ky + 7, Math.min(kw - 16, 7), 2.5, 1, hex(set.legend), { alpha: 0.7 });
      cx += size * u;
    }
  });
  return height;
}

function pcb(canvas, x, y, w, h, rand) {
  const board = hex(['#1f6b43', '#4b2f7a', '#1c2126', '#1d4f8a'][Math.floor(rand() * 4)]);
  canvas.shadow(x, y + 5, w, h, 8, 18, 0.45);
  canvas.rect(x, y, w, h, 8, board, { light: 0.12 });
  const copper = [214, 172, 92];
  // Traces: right-angled runs with a 45° corner, the way a router lays them.
  for (let i = 0; i < 26; i++) {
    const sx = x + 14 + rand() * (w - 28),
      sy = y + 14 + rand() * (h - 28);
    const ex = x + 14 + rand() * (w - 28),
      ey = y + 14 + rand() * (h - 28);
    const mid =
      Math.abs(ex - sx) > Math.abs(ey - sy)
        ? [ex - Math.sign(ex - sx) * Math.abs(ey - sy), sy]
        : [sx, ey - Math.sign(ey - sy) * Math.abs(ex - sx)];
    canvas.path([[sx, sy], mid, [ex, ey]], 2.2, shade(board, 0.28));
    canvas.circle(sx, sy, 3.2, copper);
    canvas.circle(ex, ey, 3.2, copper);
  }
  // Chips, a crystal, header pins, a USB port.
  const chip = [28, 30, 33];
  const cw = w * 0.26,
    ch = h * 0.3,
    cx = x + w * 0.38,
    cy = y + h * 0.32;
  for (let i = 0; i < 8; i++) {
    canvas.rect(cx - 6, cy + 6 + (i * (ch - 12)) / 7, 8, 3, 1, [200, 200, 205]);
    canvas.rect(cx + cw - 2, cy + 6 + (i * (ch - 12)) / 7, 8, 3, 1, [200, 200, 205]);
  }
  canvas.rect(cx, cy, cw, ch, 3, chip, { light: 0.2 });
  canvas.circle(cx + 8, cy + 8, 2.5, [70, 72, 76]);
  canvas.rect(x + w * 0.1, y + h * 0.62, w * 0.14, h * 0.12, 2, chip, { light: 0.2 });
  canvas.rect(x + w * 0.72, y + h * 0.66, w * 0.1, h * 0.08, 6, [196, 198, 204], { light: 0.35 });
  for (let i = 0; i < 12; i++) {
    const px = x + w * 0.12 + (i * (w * 0.76)) / 11;
    canvas.rect(px - 5, y + h - 22, 10, 10, 1, [22, 22, 24]);
    canvas.circle(px, y + h - 17, 2.4, [224, 190, 110]);
  }
  canvas.rect(x - 8, y + h * 0.42, 26, 30, 3, [188, 190, 196], { light: 0.35 });
  // An LED, lit.
  const led = [
    [255, 90, 70],
    [90, 220, 140],
    [80, 160, 255],
  ][Math.floor(rand() * 3)];
  canvas.circle(x + w * 0.86, y + h * 0.22, 12, led, { alpha: 0.18 });
  canvas.rect(x + w * 0.86 - 5, y + h * 0.22 - 3, 10, 6, 1, led, { light: 0.4 });
}

function print3d(canvas, cx, cy, size, rand) {
  const filament = hex(['#e4572e', '#f3a712', '#29a3a3', '#7a5cc4', '#e0e0e0', '#3b9b50'][Math.floor(rand() * 6)]);
  // A twisted vase seen from above: rings of layers, lighter toward the lip.
  canvas.each([cx - size * 1.4, cy - size * 1.4, cx + size * 1.4, cy + size * 1.4], (x, y) => {
    const d = Math.hypot(x - cx - 6, y - cy - 10) / (size * 1.25);
    return d < 1 ? [0, 0, 0, 0.32 * (1 - d) ** 1.5] : null;
  });
  const lobes = 5 + Math.floor(rand() * 3);
  canvas.each([cx - size, cy - size, cx + size, cy + size], (x, y) => {
    const a = Math.atan2(y - cy, x - cx),
      d = Math.hypot(x - cx, y - cy);
    const edge = size * (0.9 + 0.1 * Math.cos(a * lobes));
    if (d > edge) return null;
    const ring = Math.sin(d * 1.3) * 0.05;
    const inner = d < edge * 0.55 ? -0.35 : 0;
    return [...shade(filament, ring + inner + (0.5 - d / edge) * 0.25 - Math.cos(a + 0.8) * 0.12), 1];
  });
}

function woodBox(canvas, x, y, w, h, rand) {
  const tone = hex(['#8b5a2b', '#a0703e', '#5e3b22'][Math.floor(rand() * 3)]);
  canvas.shadow(x, y + 8, w, h, 6, 24, 0.5);
  canvas.each([x, y, x + w, y + h], (px, py) => {
    const grain = Math.sin(py * 0.19 + Math.sin(px * 0.021) * 3) * 0.5 + Math.sin(py * 0.9) * 0.08;
    return [...shade(tone, grain * 0.12 + 0.05), 1];
  });
  // A lid with a finger pull and dovetails showing at the corners.
  canvas.rect(x + 14, y + 14, w - 28, h - 28, 4, shade(tone, 0.12), { light: 0.1, alpha: 0.55 });
  canvas.ellipse(x + w / 2, y + h / 2, w * 0.12, h * 0.05, shade(tone, -0.4), 0.8);
  for (let i = 0; i < 4; i++) {
    const dy = y + 12 + (i * (h - 24)) / 3.4;
    canvas.rect(x, dy, 12, (h - 24) / 7, 1, shade(tone, 0.28));
    canvas.rect(x + w - 12, dy, 12, (h - 24) / 7, 1, shade(tone, 0.28));
  }
}

function synth(canvas, x, y, w, h, rand) {
  const panel = hex(['#d9d7cf', '#20242a', '#c9d3cf'][Math.floor(rand() * 3)]);
  const dark = panel[0] < 100;
  canvas.shadow(x, y + 6, w, h, 6, 20, 0.45);
  canvas.rect(x, y, w, h, 6, panel, { light: 0.15 });
  const ink = dark ? [210, 214, 220] : [40, 44, 50];
  const accent = hex(['#e4572e', '#2f9ad3', '#f1b53c'][Math.floor(rand() * 3)]);
  const knobs = [
    [0.25, 0.2, 0.13],
    [0.72, 0.2, 0.13],
    [0.25, 0.47, 0.1],
    [0.72, 0.47, 0.1],
  ];
  for (const [kx, ky, kr] of knobs) {
    const cx = x + kx * w,
      cy = y + ky * h,
      r = kr * w;
    canvas.circle(cx + 2, cy + 4, r, [0, 0, 0], { alpha: 0.25 });
    canvas.circle(cx, cy, r, dark ? [58, 62, 70] : [36, 38, 42], { light: 0.5 });
    const turn = rand() * Math.PI * 1.5 + Math.PI * 0.75;
    canvas.line(cx, cy, cx + Math.cos(turn) * r * 0.8, cy + Math.sin(turn) * r * 0.8, 3, accent);
  }
  for (let i = 0; i < 6; i++) {
    const jx = x + w * (0.2 + (i % 3) * 0.3),
      jy = y + h * (0.72 + Math.floor(i / 3) * 0.14);
    canvas.circle(jx, jy, 10, [190, 192, 198], { light: 0.4 });
    canvas.circle(jx, jy, 4.5, [20, 20, 22]);
  }
  canvas.rect(x + w * 0.1, y + h * 0.05 - 4, w * 0.35, 5, 2, ink, { alpha: 0.7 });
  // One patch cable, drooping between two jacks.
  const a = [x + w * 0.2, y + h * 0.72],
    b = [x + w * 0.8, y + h * 0.86];
  const points = Array.from({ length: 24 }, (_, i) => {
    const t = i / 23;
    return [mix(a[0], b[0], t), mix(a[1], b[1], t) + Math.sin(t * Math.PI) * h * 0.28];
  });
  canvas.path(points, 7, shade(accent, -0.1));
}

function breadboard(canvas, x, y, w, h, rand) {
  canvas.shadow(x, y + 5, w, h, 5, 18, 0.4);
  canvas.rect(x, y, w, h, 5, [240, 238, 232], { light: 0.08 });
  canvas.rect(x + 6, y + h / 2 - 5, w - 12, 10, 2, [218, 216, 208]);
  for (let r = 0; r < 12; r++)
    for (let c = 0; c < 30; c++) {
      const hx = x + 14 + (c * (w - 28)) / 29,
        hy = y + 16 + (r * (h - 32)) / 11 + (r >= 6 ? 8 : 0);
      if (hy > y + h - 10) continue;
      canvas.rect(hx - 1.6, hy - 1.6, 3.2, 3.2, 0.6, [70, 70, 72]);
    }
  const wires = [
    [230, 70, 60],
    [60, 120, 220],
    [250, 190, 40],
    [60, 170, 90],
    [30, 30, 32],
  ];
  for (let i = 0; i < 9; i++) {
    const color = wires[Math.floor(rand() * wires.length)];
    const sx = x + 20 + rand() * (w - 40),
      sy = y + 20 + rand() * (h - 40);
    const ex = x + 20 + rand() * (w - 40),
      ey = y + 20 + rand() * (h - 40);
    canvas.path(
      [
        [sx, sy],
        [sx, (sy + ey) / 2 - 12],
        [ex, (sy + ey) / 2 - 12],
        [ex, ey],
      ],
      4,
      color,
    );
  }
  // A microcontroller board seated across the middle.
  canvas.rect(x + w * 0.32, y + h * 0.3, w * 0.3, h * 0.4, 3, [30, 90, 160], { light: 0.2 });
  canvas.rect(x + w * 0.4, y + h * 0.38, w * 0.12, h * 0.18, 2, [28, 30, 33], { light: 0.2 });
}

const PROJECTS = {
  keyboard: (canvas, rand) => {
    mat(canvas, rand);
    const w = canvas.width * 0.84;
    keyboard(canvas, (canvas.width - w) / 2, canvas.height * 0.26, w, rand);
  },
  pcb: (canvas, rand) => {
    mat(canvas, rand);
    pcb(canvas, canvas.width * 0.16, canvas.height * 0.16, canvas.width * 0.68, canvas.height * 0.66, rand);
  },
  print: (canvas, rand) => {
    mat(canvas, rand);
    print3d(canvas, canvas.width * 0.36, canvas.height * 0.52, canvas.height * 0.26, rand);
    print3d(canvas, canvas.width * 0.7, canvas.height * 0.44, canvas.height * 0.16, rand);
  },
  woodwork: (canvas, rand) => {
    bench(canvas, rand);
    woodBox(canvas, canvas.width * 0.2, canvas.height * 0.2, canvas.width * 0.6, canvas.height * 0.58, rand);
  },
  synth: (canvas, rand) => {
    bench(canvas, rand);
    synth(canvas, canvas.width * 0.3, canvas.height * 0.08, canvas.width * 0.4, canvas.height * 0.84, rand);
  },
  breadboard: (canvas, rand) => {
    mat(canvas, rand);
    breadboard(canvas, canvas.width * 0.12, canvas.height * 0.2, canvas.width * 0.76, canvas.height * 0.6, rand);
  },
};
export const PROJECT_KINDS = Object.keys(PROJECTS);

/** One project photo and its 320×240 thumbnail. */
export function renderProject(kind, seed) {
  const canvas = new Canvas(640, 480);
  PROJECTS[kind](canvas, random(seed));
  const image = canvas.png();
  return { photo: encode(image), thumb: encode(downscale(image, 2)) };
}

/* ---------- avatars ---------- */

const GROUNDS = ['#d7e8e3', '#e8dcc8', '#dcdff0', '#f0d9d2', '#e2ecd5', '#e9d8ea', '#d3e4ef', '#efe6c9'];
const SKIN = ['#f1c9a5', '#e0ac85', '#c68a62', '#9c6644', '#6f4a33', '#f5d6bf'];
const HAIR = ['#2b2320', '#5a3a26', '#8c5a32', '#c9a063', '#b9b4ac', '#3c2f4a', '#7a2f25'];
const SHIRT = ['#2f5d62', '#8a4f7d', '#3e6ea8', '#c46a3b', '#4b5d3a', '#34393f', '#a8323e', '#5b4b9a'];

/** A drawn head and shoulders, 256×256: no one's likeness. */
export function renderAvatar(seed) {
  const rand = random(seed + 7);
  const canvas = new Canvas(256, 256);
  const pick = (list) => hex(list[Math.floor(rand() * list.length)]);
  const ground = pick(GROUNDS),
    skin = pick(SKIN),
    hair = pick(HAIR),
    shirt = pick(SHIRT);
  canvas.each([0, 0, 256, 256], (x, y) => [...shade(ground, 0.12 - (y / 256) * 0.2), 1]);
  // Shoulders.
  canvas.ellipse(128, 262, 100, 78, shirt);
  canvas.ellipse(128, 196, 26, 16, shade(skin, -0.12));
  canvas.rect(110, 150, 36, 50, 14, shade(skin, -0.08));
  // Head, then hair in one of four cuts.
  const cut = Math.floor(rand() * 4);
  if (cut === 3) canvas.ellipse(128, 120, 62, 70, hair);
  canvas.ellipse(128, 110, 46, 54, skin);
  if (cut === 0)
    canvas.each([70, 48, 186, 110], (x, y) =>
      ((x - 128) / 50) ** 2 + ((y - 104) / 58) ** 2 <= 1 && y < 88 + Math.sin(x * 0.08) * 6 ? [...hair, 1] : null,
    );
  if (cut === 1) {
    canvas.ellipse(128, 70, 48, 26, hair);
    canvas.ellipse(88, 96, 10, 22, hair);
    canvas.ellipse(168, 96, 10, 22, hair);
  }
  if (cut === 2)
    canvas.each([74, 50, 182, 100], (x, y) => (((x - 128) / 50) ** 2 + ((y - 100) / 50) ** 2 <= 1 && y < 78 ? [...hair, 1] : null));
  if (cut === 3)
    canvas.each([74, 50, 182, 104], (x, y) =>
      ((x - 128) / 50) ** 2 + ((y - 104) / 56) ** 2 <= 1 && y < 82 + (x - 90) * 0.18 ? [...hair, 1] : null,
    );
  // Glasses, sometimes.
  if (rand() > 0.62) {
    const frame = [40, 40, 44];
    for (const cx of [108, 148]) {
      canvas.circle(cx, 114, 13, frame);
      canvas.circle(cx, 114, 10, shade(skin, 0.1));
    }
    canvas.line(121, 113, 135, 113, 3, frame);
  }
  return encode(canvas.png());
}

/* ---------- the front page ---------- */

/** A workbench from above, 1200×900: a keyboard, a board, prints and a box. */
export function renderBench() {
  const rand = random(2026);
  const canvas = new Canvas(1200, 900);
  bench(canvas, rand);
  // A cutting mat under the keyboard and the calipers.
  canvas.shadow(40, 60, 700, 470, 10, 26, 0.3);
  canvas.each([40, 60, 740, 530], (x, y) => {
    const line = (x - 40) % 24 < 1.1 || (y - 60) % 24 < 1.1;
    return [...(line ? [72, 112, 102] : [39, 81, 74]), 1];
  });
  keyboard(canvas, 80, 110, 620, random(11));
  canvas.shadow(100, 440, 560, 26, 4, 14, 0.35);
  canvas.rect(100, 440, 560, 26, 4, [196, 200, 206], { light: 0.4 });
  canvas.rect(520, 420, 36, 70, 4, [176, 180, 188], { light: 0.35 });
  for (let i = 0; i < 38; i++) canvas.line(120 + i * 10, 442, 120 + i * 10, 442 + (i % 5 === 0 ? 12 : 7), 1.2, [60, 64, 70]);
  pcb(canvas, 790, 70, 360, 250, random(5));
  print3d(canvas, 880, 470, 80, random(3));
  print3d(canvas, 1070, 440, 52, random(9));
  woodBox(canvas, 70, 600, 330, 240, random(4));
  breadboard(canvas, 460, 620, 300, 190, random(8));
  synth(canvas, 850, 580, 260, 290, random(6));
  return encode(canvas.png());
}
