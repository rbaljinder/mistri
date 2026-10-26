/**
 * A theme's own font files (`type.faces`) as a page declares them: the
 * `@font-face` rules, the face its headings are drawn in, and the families a
 * stack names. Shared by the server's first paint (clientSurface.ts) and the
 * browser's look (client visualTheme.ts), so a face is declared the same way
 * before the script runs and after; the files themselves are the server's
 * (server/app/appFonts.ts).
 */
import type { ThemeDefinition, ThemeFaceDefinition } from '../../schema/theme.js';

/** The path segment an App's fonts are served under, beside its `_components`. */
export const FONTS_SEGMENT = '_fonts';

/** A stack's families, unquoted. */
export function families(stack: string): string[] {
  return stack
    .split(',')
    .map((family) => family.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

/**
 * The face a theme's headings are drawn in, preloaded on first paint: the
 * first served face of the family its heading stack leads with, at the
 * heading weight where it ships one. A theme whose headings lead with a
 * family it does not ship has none: nothing is fetched for a face the page
 * would not draw a line in.
 */
export function headingFace(theme: ThemeDefinition): ThemeFaceDefinition | undefined {
  const lead = families(theme.fonts?.heading ?? theme.fonts?.ui ?? '')[0]?.toLowerCase();
  if (!lead) return undefined;
  const faces = (theme.faces ?? []).filter((face) => face.family.toLowerCase() === lead && face.style === 'normal' && face.href);
  const weight = theme.type?.roles?.title?.weight ?? 700;
  return (
    faces.find((face) => {
      const [low, high = low] = face.weight.split(' ').map(Number);
      return weight >= low! && weight <= high!;
    }) ?? faces[0]
  );
}

/**
 * The `@font-face` rules for a theme's served faces, each `url()` the
 * browser's own form of its address (`shown`). `swap`, as Inter's is
 * (lumenLook.css): the text is drawn at once in the stack's next family and
 * set again when the face lands, never held invisible. The family and the
 * address are both checked to a character set that cannot close the rule
 * (themeSpec.ts, appFonts.ts), so nothing a theme says becomes a stylesheet.
 */
export function faceRules(theme: ThemeDefinition | undefined, shown: (href: string) => string = (href) => href): string {
  return (theme?.faces ?? [])
    .filter((face) => face.href && /^[\w/.%-]+$/.test(face.href))
    .map(
      (face) =>
        `@font-face{font-family:"${face.family}";src:url("${shown(face.href!)}") format("${face.href!.endsWith('.woff') ? 'woff' : 'woff2'}");` +
        `font-weight:${face.weight};font-style:${face.style};font-display:swap}`,
    )
    .join('\n');
}
