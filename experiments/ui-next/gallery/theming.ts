import { useSyncExternalStore } from 'react';
import { wearTheme } from '../src';
import { type Look, LOOKS, PALETTES, type Rhythm, worn } from './theme';

/* What the gallery is dressed in: one of mistri's looks in one of its palettes, with any recipes picked over
   it, or ui-next's own drawing. Kept for the next visit, and put on before the first draw (the module is
   imported by main.tsx), so the page does not change clothes in front of the reader. */
export type Dress = { look: Look | 'own'; palette: string; recipes: Record<string, string>; rhythm: Rhythm };

const KEY = 'm-gallery:dress';
const OWN: Dress = { look: 'own', palette: 'default', recipes: {}, rhythm: 'house' };

function read(): Dress {
  try {
    const kept = JSON.parse(window.localStorage.getItem(KEY) ?? 'null') as Partial<Dress> | null;
    /* An address can ask for a look, for a link to one and for the checks: `?look=sage&palette=cobalt`. */
    const asked = new URLSearchParams(window.location.search);
    const look = asked.get('look') ?? kept?.look;
    const palette = asked.get('palette') ?? kept?.palette;
    if (!look || !(LOOKS as readonly string[]).includes(look)) return OWN;
    return {
      look: look as Look,
      palette: PALETTES.some((one) => one.id === palette) ? palette! : 'default',
      recipes: asked.has('look') ? {} : (kept?.recipes ?? {}),
      rhythm: (['tight', 'airy'] as const).find((one) => one === (asked.get('rhythm') ?? kept?.rhythm)) ?? 'house',
    };
  } catch {
    return OWN;
  }
}

let dress = read();
const heard = new Set<() => void>();
const put = () => wearTheme(worn(dress.look, dress.palette, dress.recipes, dress.rhythm));
put();

/* The faces what is worn is set in, as `document.fonts.load` takes them: the first family of each stack a theme
   names, in the weights a page uses. The page's first draw waits for these as it does for ui-next's own face
   (main.tsx); mistri does the same for an App by preloading a look's files. */
export function wornFaces(): string[] {
  const theme = worn(dress.look, dress.palette, dress.recipes, dress.rhythm);
  if (!theme) return [];
  const families = new Set<string>();
  for (const name of ['--sans', '--heading-font', '--mono', '--figures-face']) {
    const first = theme.light[name]?.split(',')[0]?.trim();
    // A keyword (`ui-sans-serif`, `system-ui`) is the machine's own face: there is nothing to wait for.
    if (first && !/^(ui-|system-ui|-apple-system|sans-serif|serif|monospace)/.test(first)) families.add(first);
  }
  return [...families].flatMap((family) => [400, 500, 600, 700].map((weight) => `${weight} 1em ${family}`));
}

export function setDress(next: Partial<Dress>): void {
  /* Recipes picked over one look are not carried to another: they were choices against that look's own. */
  dress = { ...dress, ...next, ...(next.look && next.look !== dress.look ? { recipes: next.recipes ?? {} } : {}) };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(dress));
  } catch {
    // Not kept, and still worn.
  }
  put();
  for (const hear of heard) hear();
}

export function useDress(): Dress {
  return useSyncExternalStore(
    (hear) => {
      heard.add(hear);
      return () => heard.delete(hear);
    },
    () => dress,
  );
}
