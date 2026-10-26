/**
 * Studio renders for the Forecourt seed: real PNG files drawn here, so the
 * sample needs no downloaded image and carries no maker's logo or badge. A
 * render is a curved seamless backdrop with a soft floor and vignette, a
 * soft shadow with a darker contact under each tyre, and a rounded car silhouette
 * in the vehicle's colour — shaded along the shoulder, glass reflecting the
 * sky, spoked rims in dark tyres — drawn at twice the size and averaged down
 * for smooth edges. 4:3, the cards' own ratio. Five framings and five
 * lighting setups give each vehicle a gallery that reads like one shoot.
 *
 *   renderPhoto({ body: 'hatchback', colour: 'Blue', angle: 'three-quarter', lighting: 'studio' }) → Buffer (PNG)
 *   renderPhotoSet({ … }) → { photo, thumb }, the thumbnail 320×240
 *   renderScene() → Buffer (PNG), three cars at 16:7 for a front page
 */
import { deflateSync } from 'node:zlib';

export const WIDTH = 640;
export const HEIGHT = 480;
const S = 2; // supersampling factor: every render is drawn at twice the size and averaged down

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
/** An 8-bit RGB PNG, each row filtered with Sub, which a studio gradient compresses to almost nothing. */
export function encodePng(width, height, rgb) {
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
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- a tiny rasterizer ---------- */

const mix = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const tint = (rgb, t) => rgb.map((c) => (t >= 0 ? mix(c, 255, t) : mix(c, 0, -t)));
const smooth = (a, b, v) => {
  const t = clamp((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

class Canvas {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.px = new Float32Array(w * h * 3);
  }
  put(i, r, g, b, a) {
    const px = this.px;
    px[i] += (r - px[i]) * a;
    px[i + 1] += (g - px[i + 1]) * a;
    px[i + 2] += (b - px[i + 2]) * a;
  }
  /** Even-odd scanline fill of a closed polygon; `shade(x, y, out)` colours each pixel. */
  polygon(points, shade, alpha = 1) {
    const ys = points.map((p) => p[1]);
    const top = Math.max(0, Math.floor(Math.min(...ys))),
      bottom = Math.min(this.h - 1, Math.ceil(Math.max(...ys)));
    const out = [0, 0, 0];
    for (let y = top; y <= bottom; y++) {
      const cy = y + 0.5;
      const xs = [];
      for (let i = 0; i < points.length; i++) {
        const [x1, y1] = points[i],
          [x2, y2] = points[(i + 1) % points.length];
        if ((y1 <= cy && y2 > cy) || (y2 <= cy && y1 > cy)) xs.push(x1 + ((cy - y1) / (y2 - y1)) * (x2 - x1));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const from = Math.max(0, Math.round(xs[k])),
          to = Math.min(this.w - 1, Math.round(xs[k + 1]) - 1);
        for (let x = from; x <= to; x++) {
          shade(x, y, out);
          this.put((y * this.w + x) * 3, out[0], out[1], out[2], alpha);
        }
      }
    }
  }
  /** An ellipse; `soft` > 0 fades it out towards its rim (a shadow, a glow); `below` stops it at a row. */
  ellipse(cx, cy, rx, ry, shade, alpha = 1, soft = 0, below = Infinity) {
    const out = [0, 0, 0];
    for (let y = Math.max(0, Math.floor(cy - ry)); y <= Math.min(this.h - 1, Math.ceil(cy + ry), below); y++) {
      for (let x = Math.max(0, Math.floor(cx - rx)); x <= Math.min(this.w - 1, Math.ceil(cx + rx)); x++) {
        const d = ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2;
        if (d > 1) continue;
        shade(x, y, out);
        this.put((y * this.w + x) * 3, out[0], out[1], out[2], soft ? alpha * (1 - d) ** soft : alpha);
      }
    }
  }
  /** The picture at its nominal size, each pixel the average of the supersampled block it covers. */
  pixels() {
    const w = this.w / S,
      h = this.h / S;
    const rgb = new Uint8Array(w * h * 3);
    const px = this.px,
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
  png() {
    const { w, h, rgb } = this.pixels();
    return encodePng(w, h, rgb);
  }
}

/** A picture half its size either way, each pixel the average of the four it covers. */
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
const solid = (rgb) => (_x, _y, out) => {
  out[0] = rgb[0];
  out[1] = rgb[1];
  out[2] = rgb[2];
};
/** A colour moved toward white (t > 0) or black (t < 0), written into `out` without allocating. */
const shadeInto = (rgb, t, out) => {
  const toward = t >= 0 ? 255 : 0,
    k = Math.min(1, Math.abs(t));
  out[0] = rgb[0] + (toward - rgb[0]) * k;
  out[1] = rgb[1] + (toward - rgb[1]) * k;
  out[2] = rgb[2] + (toward - rgb[2]) * k;
};

/** Chaikin corner cutting: a closed outline with its corners rounded, a little more each pass. */
function rounded(points, passes = 2) {
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

/* ---------- the cars ---------- */

export const COLOURS = {
  White: [232, 234, 236],
  Black: [30, 32, 36],
  Silver: [176, 182, 189],
  Gray: [104, 110, 118],
  Blue: [36, 84, 164],
  Red: [172, 30, 36],
  Green: [44, 102, 72],
  Orange: [212, 110, 36],
  Beige: [192, 174, 146],
  Navy: [30, 44, 86],
  Teal: [22, 110, 118],
};

/* Side silhouettes, nose to the right, in car lengths: x 0 (tail) → 1 (nose),
   y up from the road. Corners are rounded when drawn, so these are control
   outlines. Each type is told apart at card size by its roof line, height,
   clearance and tail: a hatchback's short upright hatch, a saloon's boot
   step, an estate's roof run out to the tail, an SUV standing tall and high
   on big wheels, a coupé low with a fastback. `glass` is the
   greenhouse, `wheels` the axle positions and radius, `pillar` where the
   B-pillar falls, `doors` the shut lines. */
const BODIES = {
  hatchback: {
    body: [
      [0.035, 0.1],
      [0.0, 0.2],
      [0.012, 0.33],
      [0.09, 0.405],
      [0.42, 0.415],
      [0.6, 0.29],
      [0.88, 0.255],
      [0.995, 0.2],
      [1.0, 0.12],
      [0.96, 0.095],
    ],
    glass: [
      [0.04, 0.3],
      [0.095, 0.38],
      [0.41, 0.385],
      [0.56, 0.29],
      [0.05, 0.28],
    ],
    wheels: [0.18, 0.8, 0.084],
    pillar: 0.3,
    doors: [0.3, 0.58],
  },
  saloon: {
    body: [
      [0.02, 0.1],
      [0.0, 0.19],
      [0.015, 0.27],
      [0.2, 0.285],
      [0.31, 0.39],
      [0.58, 0.4],
      [0.72, 0.29],
      [0.94, 0.265],
      [1.0, 0.18],
      [0.98, 0.1],
    ],
    glass: [
      [0.225, 0.286],
      [0.318, 0.373],
      [0.57, 0.379],
      [0.686, 0.289],
    ],
    wheels: [0.19, 0.8, 0.08],
    pillar: 0.46,
    doors: [0.46, 0.66],
  },
  estate: {
    body: [
      [0.02, 0.1],
      [0.0, 0.21],
      [0.018, 0.385],
      [0.07, 0.412],
      [0.6, 0.418],
      [0.73, 0.29],
      [0.94, 0.265],
      [1.0, 0.18],
      [0.98, 0.1],
    ],
    glass: [
      [0.035, 0.305],
      [0.075, 0.388],
      [0.588, 0.393],
      [0.695, 0.291],
      [0.045, 0.288],
    ],
    wheels: [0.19, 0.8, 0.08],
    pillar: 0.41,
    doors: [0.41, 0.64],
  },
  suv: {
    body: [
      [0.02, 0.16],
      [0.0, 0.33],
      [0.018, 0.57],
      [0.07, 0.61],
      [0.62, 0.615],
      [0.74, 0.445],
      [0.96, 0.415],
      [1.0, 0.31],
      [0.99, 0.16],
    ],
    glass: [
      [0.045, 0.465],
      [0.08, 0.575],
      [0.605, 0.58],
      [0.71, 0.45],
      [0.055, 0.445],
    ],
    wheels: [0.19, 0.8, 0.118],
    pillar: 0.39,
    doors: [0.39, 0.65],
  },
  coupe: {
    body: [
      [0.02, 0.1],
      [0.0, 0.18],
      [0.06, 0.245],
      [0.22, 0.285],
      [0.42, 0.355],
      [0.56, 0.36],
      [0.72, 0.265],
      [0.955, 0.24],
      [1.0, 0.17],
      [0.98, 0.1],
    ],
    glass: [
      [0.26, 0.286],
      [0.43, 0.345],
      [0.55, 0.348],
      [0.69, 0.27],
    ],
    wheels: [0.2, 0.8, 0.082],
    pillar: 0.5,
    doors: [0.62],
  },
  pickup: {
    body: [
      [0.02, 0.15],
      [0.0, 0.36],
      [0.4, 0.36],
      [0.42, 0.56],
      [0.66, 0.57],
      [0.76, 0.42],
      [0.965, 0.39],
      [1.0, 0.3],
      [0.99, 0.15],
    ],
    glass: [
      [0.45, 0.425],
      [0.46, 0.535],
      [0.65, 0.54],
      [0.73, 0.425],
    ],
    wheels: [0.17, 0.81, 0.115],
    pillar: 0.56,
    doors: [0.43, 0.56, 0.7],
  },
  van: {
    body: [
      [0.02, 0.12],
      [0.0, 0.3],
      [0.02, 0.6],
      [0.06, 0.64],
      [0.72, 0.645],
      [0.845, 0.43],
      [0.975, 0.37],
      [1.0, 0.27],
      [0.99, 0.12],
    ],
    glass: [
      [0.745, 0.425],
      [0.73, 0.585],
      [0.8, 0.59],
      [0.86, 0.435],
    ],
    wheels: [0.17, 0.82, 0.1],
    pillar: 0.2,
    doors: [0.2, 0.5, 0.74],
  },
};
export const BODY_TYPES = Object.keys(BODIES);

/* Studio setups: the wall above, the floor it curves into, where the key
   light stands (x, y, reach), and how much the paint shines under it. */
const LIGHTING = {
  /* The catalog's own shoot: a near-white cove in warm stone greys, a broad
     soft key overhead and a pale floor, the way a current marketplace
     photographs every car the same so the cars, not the rooms, differ. */
  gallery: {
    wall: [
      [252, 251, 250],
      [236, 234, 231],
    ],
    floor: [
      [231, 229, 226],
      [204, 201, 197],
    ],
    glow: [0.5, 0.12, 0.62],
    sheen: 0.3,
    // Barely darkened at the corners: the frame stays white to its edges.
    vignette: 0.08,
  },
  studio: {
    wall: [
      [240, 242, 245],
      [218, 222, 228],
    ],
    floor: [
      [210, 214, 220],
      [176, 181, 189],
    ],
    glow: [0.5, 0.18, 0.5],
    sheen: 0.34,
  },
  warm: {
    wall: [
      [246, 238, 227],
      [226, 212, 194],
    ],
    floor: [
      [216, 202, 184],
      [180, 164, 146],
    ],
    glow: [0.35, 0.16, 0.5],
    sheen: 0.3,
  },
  cool: {
    wall: [
      [220, 229, 238],
      [186, 199, 214],
    ],
    floor: [
      [178, 190, 204],
      [140, 152, 168],
    ],
    glow: [0.62, 0.14, 0.5],
    sheen: 0.32,
  },
  dusk: {
    wall: [
      [76, 84, 110],
      [48, 52, 74],
    ],
    floor: [
      [56, 60, 82],
      [30, 32, 46],
    ],
    glow: [0.5, 0.22, 0.55],
    sheen: 0.42,
  },
  graphite: {
    wall: [
      [88, 92, 98],
      [56, 59, 64],
    ],
    floor: [
      [64, 67, 72],
      [36, 38, 42],
    ],
    glow: [0.4, 0.2, 0.5],
    sheen: 0.38,
  },
};
export const LIGHTS = Object.keys(LIGHTING);

/* Framings: a three-quarter front and rear — the silhouette narrower and in
   perspective, its near end (`near`: 1 the nose, 0 the tail) drawn larger —
   a profile either side, and a close crop on the front wheel and lamp. */
const ANGLES = {
  'three-quarter': { mirror: false, squash: 0.86, near: 1, perspective: 0.26, scale: 0.74, centre: 0.48, ground: 0.76 },
  side: { mirror: false, squash: 1, scale: 0.8, centre: 0.5, ground: 0.74 },
  'rear-quarter': { mirror: true, squash: 0.86, near: 0, perspective: 0.26, scale: 0.74, centre: 0.52, ground: 0.76 },
  offside: { mirror: true, squash: 1, scale: 0.8, centre: 0.5, ground: 0.74 },
  detail: { mirror: false, squash: 1, scale: 1.85, centre: 0.5, ground: 0.9, focus: 0.82 },
};
export const ANGLE_NAMES = Object.keys(ANGLES);

/* The backdrop: a wall that curves into the floor with no seam, the key
   light's pool on the wall, and a vignette drawing the eye to the car. */
function drawBackdrop(canvas, light, cove) {
  const w = canvas.w,
    h = canvas.h;
  // A smooth gradient needs no supersampling: each output pixel is worked
  // out once and laid into its four samples.
  {
    const [gx, gy, gr] = light.glow;
    const px = canvas.px;
    const row = [0, 0, 0];
    const ow = w / S,
      oh = h / S;
    for (let oy = 0; oy < oh; oy++) {
      const v = (oy + 0.5) / oh;
      const blend = smooth(cove - 0.16, cove + 0.08, v);
      const wall = clamp(v / cove),
        floor = clamp((v - cove) / (1 - cove));
      for (let c = 0; c < 3; c++)
        row[c] = mix(mix(light.wall[0][c], light.wall[1][c], wall), mix(light.floor[0][c], light.floor[1][c], floor), blend);
      const dy = (v - gy) * 1.4,
        vy = (v - 0.46) * (v - 0.46) * 1.3;
      for (let ox = 0; ox < ow; ox++) {
        const u = (ox + 0.5) / ow;
        const dx = u - gx;
        const reach = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) / gr);
        const glow = reach * reach * 0.26;
        const vignette = 1 - (light.vignette ?? 0.3) * ((u - 0.5) * (u - 0.5) * 1.6 + vy);
        const r = (row[0] + (255 - row[0]) * glow) * vignette,
          g = (row[1] + (255 - row[1]) * glow) * vignette,
          b = (row[2] + (255 - row[2]) * glow) * vignette;
        for (let sy = 0; sy < S; sy++)
          for (let sx = 0; sx < S; sx++) {
            const i = ((oy * S + sy) * w + ox * S + sx) * 3;
            px[i] = r;
            px[i + 1] = g;
            px[i + 2] = b;
          }
      }
    }
  }
}

/* One car on the canvas, framed by `view`: its scale, where it stands and
   which way it faces. */
function drawCar(canvas, { body, colour, lighting, view }) {
  const shape = BODIES[body] ?? BODIES.hatchback;
  const paint = COLOURS[colour] ?? COLOURS.Silver;
  const light = LIGHTING[lighting] ?? LIGHTING.studio;
  const w = canvas.w,
    h = canvas.h;
  const dark = lighting === 'dusk' || lighting === 'graphite';
  const L = w * view.scale;
  const left = w * view.centre - L * view.squash * (view.focus ?? 0.5);
  const road = h * view.ground;
  const X = (x) => left + (view.mirror ? 1 - x : x) * L * view.squash;
  /* How much nearer the camera a point of the car is: the near end of a
     three-quarter view stands taller, the far end shorter; a profile is flat. */
  const depth = (x) => 1 + (view.perspective ?? 0) * ((view.near === 0 ? 1 - x : x) - 0.5);
  const Y = (y, x = 0.5) => road - y * L * depth(x);
  const at = (points) => points.map(([x, y]) => [X(x), Y(y, x)]);
  const top = Math.max(...shape.body.map((p) => p[1]));
  const outline = rounded(at(shape.body), 3);
  const [rear, front, radius] = shape.wheels;
  const sideLight = view.mirror ? 1 - light.glow[0] : light.glow[0];

  // The shadows: a wide soft one under the body and a dark contact where
  // each tyre meets the floor.
  canvas.ellipse(X(0.5), road + L * 0.01, L * view.squash * 0.6, L * 0.055, solid([0, 0, 0]), dark ? 0.55 : 0.38, 1.8);
  for (const axle of [rear, front])
    canvas.ellipse(X(axle), road + L * 0.004, radius * depth(axle) * L * view.squash * 1.1, L * 0.016, solid([0, 0, 0]), 0.6, 1.2);

  // The paint: lighter along the shoulder with one crisp highlight line,
  // darker down the lower panels, and falling off away from the key light.
  canvas.polygon(outline, (x, y, out) => {
    const along = clamp((x - left) / (L * view.squash));
    const up = clamp((road - y) / (top * L * depth(view.mirror ? 1 - along : along)));
    const lit = 0.1 * (1 - Math.abs(along - sideLight) * 1.4);
    const shoulder = up > 0.6 ? light.sheen * (up - 0.6) * 1.8 : 0;
    const crease = Math.exp(-(((up - 0.62) / 0.012) ** 2)) * light.sheen * 0.9;
    const lower = up < 0.42 ? -0.3 * ((0.42 - up) / 0.42) ** 1.2 : 0;
    const sill = up < 0.1 ? -0.25 : 0;
    shadeInto(paint, clamp(lit + shoulder + crease + lower + sill, -0.6, 0.7), out);
  });
  // The wheel openings: the dark arch above each axle only.
  for (const axle of [rear, front]) {
    const r = radius * depth(axle);
    canvas.ellipse(X(axle), road - r * L, r * 1.16 * L * view.squash, r * 1.16 * L, solid([18, 19, 22]), 1, 0, road - r * L);
  }
  // Door shut lines, the sill and a handle: faint, the way a panel gap reads
  // in a photo, each placed from the body's own heights.
  const bottom = Math.min(...shape.body.map((p) => p[1]));
  const waist = Math.min(...shape.glass.map((p) => p[1]));
  for (const door of shape.doors) {
    canvas.polygon(
      at([
        [door - 0.0022, bottom + 0.028],
        [door - 0.0022, waist - 0.008],
        [door + 0.0022, waist - 0.008],
        [door + 0.0022, bottom + 0.028],
      ]),
      solid(tint(paint, -0.45)),
      0.45,
    );
  }
  canvas.polygon(
    rounded(
      at([
        [0.27, bottom - 0.004],
        [0.27, bottom + 0.02],
        [0.71, bottom + 0.02],
        [0.71, bottom - 0.004],
      ]),
      1,
    ),
    solid(tint(paint, -0.55)),
    0.9,
  );
  canvas.polygon(
    rounded(
      at([
        [shape.pillar + 0.05, waist - 0.05],
        [shape.pillar + 0.05, waist - 0.04],
        [shape.pillar + 0.1, waist - 0.04],
        [shape.pillar + 0.1, waist - 0.05],
      ]),
      1,
    ),
    solid(tint(paint, -0.35)),
  );

  // The glass: the sky reflected at the top fading to the dark cabin, one
  // soft diagonal streak, and a thin dark B-pillar in the trim's black.
  const glassPoints = at(shape.glass);
  const glassTop = Math.min(...glassPoints.map((p) => p[1])),
    glassBottom = Math.max(...glassPoints.map((p) => p[1]));
  const sky = dark ? [120, 132, 164] : [214, 226, 240];
  const cabin = dark ? [26, 30, 44] : [30, 36, 46];
  canvas.polygon(rounded(glassPoints, 2), (x, y, out) => {
    const up = clamp((glassBottom - y) / Math.max(1, glassBottom - glassTop));
    const streak = Math.exp(-((((x - left) / L - up * 0.16 - 0.36) / 0.03) ** 2)) * 0.16;
    const t = up ** 1.6 * 0.62 + streak;
    for (let c = 0; c < 3; c++) out[c] = cabin[c] + (sky[c] - cabin[c]) * t;
  });
  const glassHigh = Math.max(...shape.glass.map((p) => p[1])) - 0.008;
  canvas.polygon(
    at([
      [shape.pillar - 0.007, waist],
      [shape.pillar - 0.007, glassHigh],
      [shape.pillar + 0.007, glassHigh],
      [shape.pillar + 0.007, waist],
    ]),
    solid([20, 22, 26]),
  );
  // The mirror, and the lamps at either end of the profile.
  const mirror = Math.max(...shape.glass.map((p) => p[0])) - 0.06;
  canvas.polygon(
    rounded(
      at([
        [mirror, waist],
        [mirror - 0.018, waist + 0.03],
        [mirror + 0.03, waist + 0.028],
        [mirror + 0.037, waist + 0.002],
      ]),
      2,
    ),
    solid(tint(paint, -0.2)),
  );
  const noseY = shape.body.find((p) => p[0] === 1.0)?.[1] ?? 0.2;
  canvas.polygon(
    rounded(
      at([
        [0.95, noseY + 0.022],
        [0.965, noseY + 0.052],
        [0.994, noseY + 0.045],
        [0.997, noseY + 0.02],
      ]),
      2,
    ),
    (_x, y, out) => shadeInto([226, 232, 240], clamp((Y(noseY, 1) - y) / (L * 0.05)) * 0.6, out),
  );
  const lampY = bottom + (waist - bottom) * 0.62;
  canvas.polygon(
    rounded(
      at([
        [0.004, lampY - 0.02],
        [0.004, lampY + 0.018],
        [0.035, lampY + 0.02],
        [0.035, lampY - 0.018],
      ]),
      2,
    ),
    solid([170, 22, 30]),
  );

  // Tyres, sidewalls, ten-spoke rims catching the light, a centre cap.
  for (const axle of [rear, front]) {
    const r = radius * depth(axle);
    const cx = X(axle),
      cy = road - r * L,
      rx = r * L * view.squash,
      ry = r * L;
    canvas.ellipse(cx, cy, rx, ry, solid([22, 23, 26]));
    canvas.ellipse(cx, cy, rx * 0.9, ry * 0.9, solid([36, 38, 42]));
    canvas.ellipse(cx, cy, rx * 0.86, ry * 0.86, solid([24, 25, 28]));
    canvas.ellipse(cx, cy, rx * 0.66, ry * 0.66, (_x, y, out) => shadeInto([146, 152, 160], 0.1 + clamp((cy - y) / ry) * 0.45, out));
    canvas.ellipse(cx, cy, rx * 0.58, ry * 0.58, solid([52, 55, 60]));
    for (let spoke = 0; spoke < 10; spoke++) {
      const a = (spoke / 10) * Math.PI * 2 + 0.2;
      const sx = Math.cos(a),
        sy = Math.sin(a),
        k = 0.035;
      canvas.polygon(
        [
          [cx + sx * rx * 0.14 - sy * rx * k, cy + sy * ry * 0.14 + sx * ry * k],
          [cx + sx * rx * 0.6 - sy * rx * k * 0.7, cy + sy * ry * 0.6 + sx * ry * k * 0.7],
          [cx + sx * rx * 0.6 + sy * rx * k * 0.7, cy + sy * ry * 0.6 - sx * ry * k * 0.7],
          [cx + sx * rx * 0.14 + sy * rx * k, cy + sy * ry * 0.14 - sx * ry * k],
        ],
        (_x, y, out) => shadeInto([168, 174, 182], clamp((cy - y) / ry) * 0.4, out),
      );
    }
    canvas.ellipse(cx, cy, rx * 0.15, ry * 0.15, (_x, y, out) => shadeInto([120, 126, 134], clamp((cy - y) / ry) * 0.5, out));
  }
}

function studio({ body = 'hatchback', colour = 'Silver', angle = 'side', lighting = 'studio' } = {}) {
  const view = ANGLES[angle] ?? ANGLES.side;
  const canvas = new Canvas(WIDTH * S, HEIGHT * S);
  drawBackdrop(canvas, LIGHTING[lighting] ?? LIGHTING.studio, view.ground - 0.1);
  drawCar(canvas, { body, colour, lighting, view });
  return canvas;
}

export function renderPhoto(options = {}) {
  return studio(options).png();
}

/**
 * A photo and its thumbnail, half its size either way (320×240): what a
 * card or a gallery strip draws at about 300 pixels wide, in about half the
 * bytes. The file resource names it (`file.thumbnail`), and the server sends
 * it for `?variant=thumb`.
 */
export function renderPhotoSet(options = {}) {
  const full = studio(options).pixels();
  const thumb = halve(full);
  return { photo: encodePng(full.w, full.h, full.rgb), thumb: encodePng(thumb.w, thumb.h, thumb.rgb) };
}

/**
 * A wide studio scene for a front page's hero: three cars on one seamless
 * backdrop, the nearest largest, set to the right so words can sit on the
 * left under a scrim. 16:7, 1600×700 by default.
 */
export function renderScene({
  width = 1600,
  height = 700,
  lighting = 'studio',
  cars = [
    { body: 'saloon', colour: 'Silver', angle: 'rear-quarter', scale: 0.2, centre: 0.5, ground: 0.72 },
    { body: 'suv', colour: 'Red', angle: 'side', scale: 0.23, centre: 0.68, ground: 0.78 },
    { body: 'hatchback', colour: 'Blue', angle: 'three-quarter', scale: 0.26, centre: 0.85, ground: 0.85 },
  ],
} = {}) {
  const canvas = new Canvas(width * S, height * S);
  drawBackdrop(canvas, LIGHTING[lighting] ?? LIGHTING.studio, 0.66);
  for (const car of cars) {
    drawCar(canvas, {
      body: car.body,
      colour: car.colour,
      lighting,
      view: { ...(ANGLES[car.angle] ?? ANGLES.side), scale: car.scale, centre: car.centre, ground: car.ground },
    });
  }
  return canvas.png();
}
