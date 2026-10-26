/**
 * A share card drawn (shareCard.ts says what one is and when it is asked):
 * satori lays the card out as SVG, resvg paints it as a PNG.
 *
 * Both are optional peers, loaded once by names the bundler and the type
 * checker do not follow, as sharp is (imageVariants.ts): a server without
 * either draws no card. Only the server that serves pages ever loads this
 * module, and only on a public page's first ask.
 *
 * The card is quiet like the rest of the house: the look's ground, its ink
 * for the title and its muted ink for the site and the summary, the accent
 * for one rule along the top and the App's mark. One face, Inter, carried
 * in shareCardFaces.ts — resvg is told to load no system font, so a card
 * reads the same on every machine — and a letter Inter does not draw is
 * left off rather than drawn as a box.
 */
import { INTER_400, INTER_700, INTER_COVERS } from './shareCardFaces.js';
import type { CardDrawing, ShareCard } from './shareCard.js';

const WIDTH = 1200;
const HEIGHT = 630;

/** The parts of satori and resvg this file uses. */
type Satori = (
  element: unknown,
  options: { width: number; height: number; fonts: Array<{ name: string; data: Buffer; weight: 400 | 700; style: 'normal' }> },
) => Promise<string>;
type ResvgLike = new (
  svg: string,
  options: { fitTo: { mode: 'width'; value: number }; font: { loadSystemFonts: boolean } },
) => { render(): { asPng(): Uint8Array } };

/** A node satori lays out: React's element shape, without React. */
interface Node {
  type: string;
  props: Record<string, unknown> & { children?: Node | string | Array<Node | string> };
}
const node = (type: string, props: Node['props']): Node => ({ type, props });

const covered = (point: number) => INTER_COVERS.some(([from, to]) => point >= from && point <= to);

/** The text as Inter draws it: an accented letter it lacks loses its accent, anything else it lacks is left off. */
export function inInter(text: string): string {
  let out = '';
  for (const char of text) {
    if (covered(char.codePointAt(0)!)) out += char;
    else for (const part of char.normalize('NFD')) if (covered(part.codePointAt(0)!)) out += part;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/* The title steps down as it grows, so a long name still sits in three lines. */
const titleSize = (title: string) => (title.length > 80 ? 52 : title.length > 44 ? 62 : 72);

function layout(card: ShareCard): Node {
  const site = inInter(card.site);
  const title = inInter(card.title) || site;
  const summary = card.summary ? inInter(card.summary) : '';
  const mark = card.mark?.length
    ? node('svg', {
        width: 52,
        height: 52,
        viewBox: '0 0 256 256',
        children: card.mark.map((d) => node('path', { d, fill: card.accent })),
      })
    : undefined;
  return node('div', {
    style: {
      width: WIDTH,
      height: HEIGHT,
      display: 'flex',
      flexDirection: 'column',
      backgroundColor: card.ground,
      fontFamily: 'Inter',
      borderTop: `10px solid ${card.accent}`,
      padding: '64px 80px 72px',
    },
    children: [
      node('div', {
        style: { display: 'flex', alignItems: 'center', gap: 20, color: card.muted, fontSize: 30, fontWeight: 400 },
        children: [...(mark ? [mark] : []), node('div', { style: { display: 'flex' }, children: site })],
      }),
      node('div', { style: { display: 'flex', flexGrow: 1 } }),
      node('div', {
        style: {
          display: 'block',
          color: card.ink,
          fontSize: titleSize(title),
          fontWeight: 700,
          lineHeight: 1.12,
          letterSpacing: '-0.02em',
          lineClamp: 3,
        },
        children: title,
      }),
      ...(summary
        ? [
            node('div', {
              style: { display: 'block', color: card.muted, fontSize: 30, fontWeight: 400, lineHeight: 1.4, marginTop: 24, lineClamp: 2 },
              children: summary,
            }),
          ]
        : []),
    ],
  });
}

/** satori and resvg, with the faces: the drawing, or undefined where either is missing. */
export async function loadCardDrawing(): Promise<CardDrawing | undefined> {
  const satoriName = 'satori';
  const resvgName = '@resvg/resvg-js';
  let satori: Satori | undefined;
  let Resvg: ResvgLike | undefined;
  try {
    const [laid, painted] = await Promise.all([
      import(satoriName) as Promise<{ default?: Satori }>,
      import(resvgName) as Promise<{ Resvg?: ResvgLike; default?: { Resvg?: ResvgLike } }>,
    ]);
    satori = laid.default;
    Resvg = painted.Resvg ?? painted.default?.Resvg;
  } catch {
    return undefined;
  }
  if (typeof satori !== 'function' || typeof Resvg !== 'function') return undefined;
  const fonts = [
    { name: 'Inter', data: Buffer.from(INTER_400, 'base64'), weight: 400 as const, style: 'normal' as const },
    { name: 'Inter', data: Buffer.from(INTER_700, 'base64'), weight: 700 as const, style: 'normal' as const },
  ];
  const lay = satori;
  const Paint = Resvg;
  return async (card) => {
    const svg = await lay(layout(card), { width: WIDTH, height: HEIGHT, fonts });
    return new Paint(svg, { fitTo: { mode: 'width', value: WIDTH }, font: { loadSystemFonts: false } }).render().asPng();
  };
}
