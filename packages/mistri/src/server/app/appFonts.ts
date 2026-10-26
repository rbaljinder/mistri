/* The reference carries the declaration into an App project that typechecks this module through its
   `@mistriwork/mistri/commands` path (the sample tsconfigs), which does not include src/ itself; subsetFont.d.ts
   declares an ambient module, which an import cannot name. */
// oxlint-disable-next-line typescript/triple-slash-reference
/// <reference path="./subsetFont.d.ts" />
/**
 * An App theme's font files (`type.faces`, packages/engine/schema/theme.d.ts): read from the
 * App's directory when the App loads, held in memory, and served from the
 * App's own origin at `/{app}/_fonts/<name>-<hash>.woff2` (http/fontRoutes.ts),
 * the way Lumen's Inter is served beside its sheet. The page declares each as
 * an `@font-face` (client visualTheme.ts, and the first paint's head,
 * clientSurface.ts appFaceHead) and preloads the heading's.
 *
 * A file is read only from inside the App's directory, after its links are
 * resolved, and only a WOFF2 or WOFF file by its own first bytes: a theme is
 * an author's, but `src` is still a path a load follows, and nothing else on
 * the machine is the App's to serve. A file is named for its content, so a
 * changed face is a new address and the old one may be kept for a year.
 *
 * A face is cut to Latin as it is read (`latin` below), unless it says
 * `subset: false`: a font as a foundry ships it carries Cyrillic, Greek,
 * Vietnamese and every OpenType feature, three to five times the Latin an App
 * written in English draws, and all of it is fetched before a heading can be.
 * The cut is HarfBuzz's own subsetter, through `subset-font` — a small,
 * maintained package of its WebAssembly build and Google's WOFF2 encoder, so
 * nothing is compiled on install — loaded only when an App ships a face.
 */
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { themeFileRoot } from '../../shared/themeSpec.js';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import type { ThemeDefinition, ThemeFaceDefinition } from '@mistriwork/engine/schema/theme.js';
import type { AppDef } from '../../shared/app.js';
import { families, FONTS_SEGMENT, headingFace } from '@mistriwork/engine/shared/themeFaces.js';

/**
 * One face past this is warned about. Lumen's Inter, every weight in one
 * variable file cut to Latin, is 48 KB; a static Latin cut of one weight is
 * 15 to 30 KB. A file past 80 KB is almost always a whole font — Cyrillic,
 * Greek, Vietnamese and every OpenType feature — fetched before a heading can
 * be drawn in it, where a Latin subset would do.
 */
const FACE_WARN_BYTES = 80 * 1024;
/**
 * Every face one theme ships, together. A face is fetched while the page is
 * first drawn and swapped in when it lands, which moves the text it sets: the
 * budget keeps the faces of one theme to what arrives with the page's own
 * script on an ordinary connection — about three Latin cuts, or Inter twice.
 */
const FACES_BUDGET_BYTES = 150 * 1024;
/* A file past this is refused, not warned about: it is held in memory for as long as the App is served. */
const FACE_MAX_BYTES = 1024 * 1024;

/**
 * What a Latin cut keeps: the ranges Google Fonts serves as "latin" — ASCII and
 * Latin-1, the few Latin Extended letters Western European text uses, general
 * punctuation, the euro, the trademark, arrows and minus. A character outside
 * it falls back to the stack's next family, as it would for any face.
 */
const LATIN: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x00ff],
  [0x0131, 0x0131],
  [0x0152, 0x0153],
  [0x02bb, 0x02bc],
  [0x02c6, 0x02c6],
  [0x02da, 0x02da],
  [0x02dc, 0x02dc],
  [0x0304, 0x0304],
  [0x0308, 0x0308],
  [0x0329, 0x0329],
  [0x2000, 0x206f],
  [0x20ac, 0x20ac],
  [0x2122, 0x2122],
  [0x2191, 0x2191],
  [0x2193, 0x2193],
  [0x2212, 0x2212],
  [0x2215, 0x2215],
  [0xfeff, 0xfeff],
  [0xfffd, 0xfffd],
];
const LATIN_TEXT = LATIN.flatMap(([from, to]) => Array.from({ length: to - from + 1 }, (_, i) => String.fromCodePoint(from + i))).join('');

/* Each file's cut, by its content: an App reloaded on every save in dev cuts a face once, not once a save. */
const cuts = new Map<string, Promise<Buffer>>();

/** The file cut to Latin, in the format it came in; a variable file keeps its axes. */
function latin(bytes: Buffer, format: 'woff2' | 'woff'): Promise<Buffer> {
  const key = `${format} ${createHash('sha256').update(bytes).digest('hex')}`;
  let cut = cuts.get(key);
  if (!cut) {
    cut = import('subset-font').then(({ default: subset }) => subset(bytes, LATIN_TEXT, { targetFormat: format }));
    cuts.set(key, cut);
    cut.catch(() => cuts.delete(key));
  }
  return cut;
}

export interface AppFonts {
  /** The bytes of each served file, by its name. */
  files: Record<string, Buffer>;
  /** Each served file's source in the App directory, relative to it: what a watcher and a build follow. */
  sources: Record<string, string>;
}

/** The file's kind by its first four bytes: a theme that names a `.woff2` is served one. */
function sniff(bytes: Buffer): 'woff2' | 'woff' | undefined {
  const magic = bytes.subarray(0, 4).toString('latin1');
  return magic === 'wOF2' ? 'woff2' : magic === 'wOFF' ? 'woff' : undefined;
}

/** A served name: the file's own name, cut to a slug, and its content's hash. */
function servedName(src: string, bytes: Buffer): string {
  const extension = extname(src).toLowerCase();
  const stem =
    basename(src, extname(src))
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'face';
  return `${stem}-${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}${extension}`;
}

/** Every face of every theme the App registers, with where it is said: `ui.customThemes[0].type.faces[1]`. */
function appFaces(app: Pick<AppDef, 'ui'>): Array<{ theme: ThemeDefinition; face: ThemeFaceDefinition; where: string }> {
  return (app.ui.customThemes ?? []).flatMap((theme, t) =>
    (theme.faces ?? []).map((face, f) => ({ theme, face, where: `ui.customThemes[${t}] ("${theme.id}") type.faces[${f}]` })),
  );
}

/**
 * Reads each face's file from the App directory and names it on the face
 * (`file`), so the payload and the first paint say where it is served.
 * Refuses a file that is missing, outside the directory, not a WOFF2 or WOFF
 * file, or past 1 MB. Undefined for an App whose themes ship no faces.
 */
export async function readAppFonts(
  app: Pick<AppDef, 'id' | 'ui'>,
  dir: string | undefined,
  manifest: string,
): Promise<AppFonts | undefined> {
  const faces = appFaces(app);
  if (!faces.length) return undefined;
  if (!dir && faces.some(({ face }) => !themeFileRoot(face)))
    throw new Error(
      `${manifest}: a theme's type.faces are files in the App's directory; load the App from its directory: --app <dir>, with --app-entry ${manifest} to keep this manifest.`,
    );
  const fonts: AppFonts = { files: {}, sources: {} };
  /* One file named by two faces (a variable font as its regular and its bold) is read once, for each cut. */
  const read = new Map<string, string>();
  for (const { face, where } of faces) {
    const said = `${manifest}: ${where}.src "${face.src}"`;
    /* A package's face is read from the package (its theme's `from`), and held to it as the App's are to the App. */
    const root = themeFileRoot(face);
    const base = root ?? dir!;
    const owner = root ? 'its package' : "the App's directory";
    const home = await realpath(base);
    let file: string;
    try {
      file = await realpath(resolve(base, face.src));
    } catch {
      throw new Error(`${said} is not a file in ${owner}.`);
    }
    const inside = relative(home, file);
    if (!inside || inside.startsWith('..') || inside.split(sep).includes('..') || resolve(home, inside) !== file)
      throw new Error(`${said} leads outside ${owner}; a theme serves only ${root ? "its package's" : "the App's own"} files.`);
    const whole = face.subset === false;
    const known = read.get(`${whole ? 'whole' : 'latin'} ${file}`);
    if (known) {
      name(face, known);
      continue;
    }
    const info = await stat(file);
    if (!info.isFile()) throw new Error(`${said} is not a file in the App's directory.`);
    if (info.size > FACE_MAX_BYTES)
      throw new Error(
        `${said} is ${Math.round(info.size / 1024)} KB; a face is at most 1 MB. Cut it to the scripts the App is written in.`,
      );
    const source = await readFile(file);
    const kind = sniff(source);
    const named = extname(face.src).slice(1).toLowerCase();
    if (kind !== named)
      throw new Error(`${said} is not a ${named.toUpperCase()} file (its first bytes say ${kind ?? 'neither WOFF2 nor WOFF'}).`);
    let bytes: Buffer = source;
    if (!whole) {
      try {
        bytes = await latin(source, kind);
      } catch (error) {
        throw new Error(`${said} could not be cut to Latin (${(error as Error).message}); say subset: false to ship it whole.`);
      }
    }
    const served = servedName(face.src, bytes);
    fonts.files[served] = bytes;
    fonts.sources[served] = inside.split(sep).join('/');
    read.set(`${whole ? 'whole' : 'latin'} ${file}`, served);
    name(face, served);
  }
  return fonts;

  function name(face: ThemeFaceDefinition, file: string) {
    face.file = file;
    face.href = `/${encodeURIComponent(app.id)}/${FONTS_SEGMENT}/${file}`;
  }
}

/** A build's fonts, read back from its `fonts/` folder by the names its definition carries. */
export async function readBuiltFonts(app: Pick<AppDef, 'ui'>, dir: string, rebuild: string): Promise<AppFonts | undefined> {
  const faces = appFaces(app);
  if (!faces.length) return undefined;
  const fonts: AppFonts = { files: {}, sources: {} };
  for (const { face } of faces) {
    if (!face.file) throw new Error(`${dir}: a theme's face ${face.src} has no built file. ${rebuild}`);
    if (fonts.files[face.file]) continue;
    const bytes = await readFile(join(dir, 'fonts', face.file)).catch(() => undefined);
    if (!bytes) throw new Error(`${dir}: fonts/${face.file} is missing. ${rebuild}`);
    fonts.files[face.file] = bytes;
    fonts.sources[face.file] = face.src.replace(/^\.\//, '');
  }
  return fonts;
}

/**
 * What `check` and `mistri check` say about the faces beyond what refuses the
 * load: one past its size, all of them past the budget, a face no stack
 * names (shipped and never drawn), and a stack that leads with a family it
 * neither ships nor falls back from to a generic one.
 */
export function fontWarnings(app: Pick<AppDef, 'ui'>, fonts: AppFonts | undefined): string[] {
  const warnings: string[] = [];
  for (const [name, bytes] of Object.entries(fonts?.files ?? {}))
    if (bytes.length > FACE_WARN_BYTES)
      warnings.push(
        `the theme font ${fonts!.sources[name]} is ${kb(bytes.length)} as served; a face past ${kb(FACE_WARN_BYTES)} is a whole font (one that says subset: false) or a Latin cut that keeps more weights or features than a page draws.`,
      );
  const over = fontBudgetProblem(app, fonts);
  if (over) warnings.push(over);
  for (const [t, theme] of (app.ui.customThemes ?? []).entries()) {
    const stacks = Object.entries(theme.fonts ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
    const named = new Set(stacks.flatMap(([, stack]) => families(stack).map((family) => family.toLowerCase())));
    for (const face of theme.faces ?? [])
      if (!named.has(face.family.toLowerCase()))
        warnings.push(
          `ui.customThemes[${t}] ("${theme.id}") ships the face "${face.family}" (${face.src}), which no type.font stack names: it is never drawn.`,
        );
    const shipped = new Set((theme.faces ?? []).map((face) => face.family.toLowerCase()));
    if (!shipped.size) continue;
    for (const [part, stack] of stacks) {
      const list = families(stack);
      const lead = list[0];
      if (!lead || shipped.has(lead.toLowerCase())) continue;
      if (!list.some((family) => GENERIC.has(family.toLowerCase())))
        warnings.push(
          `ui.customThemes[${t}] ("${theme.id}") type.font.${part} leads with "${lead}", which type.faces does not ship, and ends in no generic family: a machine without it draws the browser's default. Ship it, or end the stack in sans-serif, serif or monospace.`,
        );
    }
  }
  return warnings;
}

/** The generic families every browser has: a stack that ends in one draws something chosen on every machine. */
const GENERIC = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-sans-serif',
  'ui-serif',
  'ui-monospace',
  'ui-rounded',
  'math',
]);

const kb = (bytes: number) => `${Math.round(bytes / 1024)} KB`;

const served = (fonts: AppFonts | undefined) => Object.values(fonts?.files ?? {}).reduce((sum, bytes) => sum + bytes.length, 0);

/**
 * The themes whose faces are past the budget, as `check` fails them: the bytes each theme serves, after the Latin
 * cut. A page fetches the faces of the theme it wears and no other (visualTheme.ts declares only the worn theme's,
 * and e2e/theme-fonts.spec.ts holds it), so an App that offers three themes of two faces each is three budgets, not
 * one: summed, a reader who never left the default was told of fonts they never fetched.
 */
export function fontBudgetProblem(app: Pick<AppDef, 'ui'>, fonts: AppFonts | undefined): string | undefined {
  const over = (app.ui.customThemes ?? []).flatMap((theme) => {
    const files = new Set((theme.faces ?? []).map((face) => face.file).filter((file): file is string => Boolean(file)));
    const total = [...files].reduce((sum, file) => sum + (fonts?.files[file]?.length ?? 0), 0);
    return total > FACES_BUDGET_BYTES ? [`"${theme.id}" ${kb(total)}`] : [];
  });
  return over.length
    ? `the fonts of ${over.length === 1 ? 'the theme' : 'the themes'} ${over.join(', ')} are past the ${kb(FACES_BUDGET_BYTES)} budget a theme's faces have together as served: each is fetched as a page wearing it is first drawn. Ship fewer weights, or a variable file.`
    : undefined;
}

/** The one line `check` says about the faces: how many, how much is served, and whether the heading's is preloaded. */
export function fontSummary(app: Pick<AppDef, 'ui'>, fonts: AppFonts | undefined): string | undefined {
  if (!fonts || !Object.keys(fonts.files).length) return undefined;
  const faces = appFaces(app).length;
  const preloaded = (app.ui.customThemes ?? []).some((theme) => headingFace(theme));
  return `${faces} face${faces === 1 ? '' : 's'}, ${kb(served(fonts))}${preloaded ? ', heading preloaded' : ''}`;
}
