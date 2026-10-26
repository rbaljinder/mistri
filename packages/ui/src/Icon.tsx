/**
 * An icon: a glyph drawn from path data on a 256 box, in the text's colour.
 *
 * The glyphs are data rather than one component per icon (the kit's
 * scripts/generate-icons.mjs says why), and this module knows none of them:
 * whoever draws with it registers the set it uses. The kit registers the
 * chrome's own few at once, an App's as its payload brings them, and a loader
 * for the rest (`loadIconsWith`), which an icon whose name is not yet known
 * calls once; every icon waiting on it draws when it lands, and keeps its box
 * meanwhile, so nothing moves. A page's icon weight, when it wears one beyond
 * the two every glyph carries, is lent the same way (`weighIconsWith`).
 */
import { useEffect, useSyncExternalStore } from 'react';

/** A glyph's drawings: its paths in the regular weight, and in bold (for a logo). */
export type IconGlyph = readonly [regular: readonly string[], bold: readonly string[]];
/** The two weights every glyph keeps. */
export type IconWeight = 'regular' | 'bold';

/** A page-wide icon weight: the one an icon that says none draws in, and that weight's drawing of a name when it is
    not one every glyph carries (undefined draws the glyph's own). */
export interface IconWeighting {
  weight: () => string;
  drawing: (name: string) => readonly string[] | undefined;
  subscribe: (listener: () => void) => () => void;
  version: () => number;
}

const glyphs = new Map<string, IconGlyph>();
const listeners = new Set<() => void>();
let known = 0;
let loader: (() => Promise<Readonly<Record<string, IconGlyph>> | undefined>) | undefined;
let loading: Promise<void> | undefined;
const unweighted: IconWeighting = { weight: () => 'regular', drawing: () => undefined, subscribe: () => () => {}, version: () => 0 };
let weighting = unweighted;

/** Glyphs to draw, by name. A name already known keeps its glyph. */
export function registerIcons(sent: Readonly<Record<string, IconGlyph>> | undefined): void {
  if (!sent) return;
  let added = false;
  for (const [name, glyph] of Object.entries(sent)) {
    if (glyphs.has(name) || !Array.isArray(glyph)) continue;
    glyphs.set(name, glyph);
    added = true;
  }
  if (!added) return;
  known += 1;
  for (const listener of listeners) listener();
}

/** Where the glyphs not yet registered come from: called once, when an icon first names one. */
export function loadIconsWith(load: () => Promise<Readonly<Record<string, IconGlyph>> | undefined>): void {
  loader = load;
  loading = undefined;
}

/** The page's icon weight, from now on. */
export function weighIconsWith(weights: IconWeighting): void {
  weighting = weights;
}

function loadEveryGlyph(): void {
  if (!loader) return;
  loading ??= loader()
    .then(registerIcons)
    // A failed load is tried again by the next icon that asks.
    .catch(() => {
      loading = undefined;
    });
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const version = () => known;

export interface IconProps<Name extends string = string> {
  name: Name;
  /** Omit for decoration. Icon-only controls still need their own name. */
  label?: string;
  /** Relative sizes follow the surrounding typography and density. */
  size?: number | string;
  /** Omitted, the page's weight (`weighIconsWith`), regular unless it says another. */
  weight?: IconWeight;
  className?: string;
}

export function Icon<Name extends string = string>({ name, label, size = '1em', weight, className }: IconProps<Name>) {
  useSyncExternalStore(subscribe, version, version);
  const weights = weighting;
  useSyncExternalStore(weights.subscribe, weights.version, weights.version);
  const glyph = glyphs.get(name);
  const drawn = weight ?? weights.weight();
  const drawing = (weight ? undefined : weights.drawing(name)) ?? glyph?.[drawn === 'bold' ? 1 : 0];
  useEffect(() => {
    if (!glyph) loadEveryGlyph();
  }, [glyph]);
  const accessibleLabel = label?.trim() || undefined;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      fill="currentColor"
      viewBox="0 0 256 256"
      className={`tw-icon${className ? ` ${className}` : ''}`}
      role={accessibleLabel ? 'img' : undefined}
      aria-label={accessibleLabel}
      aria-hidden={accessibleLabel ? undefined : true}
      focusable="false"
    >
      {drawing?.map((d, index) => (
        <path key={index} d={d} />
      ))}
    </svg>
  );
}
