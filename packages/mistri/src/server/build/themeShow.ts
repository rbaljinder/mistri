/**
 * `mistri theme show <look|id|.>`: a theme as it is worn — every color in
 * light and dark and in each palette, every recipe, the type and the shape —
 * after `extends` is resolved, each value marked with where it comes from: the
 * theme's own, the look it extends, its Default palette (for a palette), a
 * color derived from the others, or the plain structure's default. The
 * question it answers is the one an author of a theme asks before changing
 * one: what does this look already do, and what did I say myself?
 *
 * `--diff <look>` says only what differs from another theme; `--json` says the
 * same as one document. The looks page's recipe table is held to showTheme by
 * test/theme-tooling.test.ts, so the page and the command say the same.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ThemeDefinition, ThemePalette, ThemeSpec } from '@mistriwork/engine/schema/theme.js';
import { COLOR_ROLES } from '../../shared/themeBuild.js';
import { LOOKS } from '@mistriwork/engine/shared/themeLooks.js';
import {
  effectiveThemeDefinition,
  effectiveThemePalette,
  headingWeight,
  inheritThemePreset,
  THEME_PRESETS,
  themePreset,
} from '@mistriwork/engine/shared/themePresets.js';
import { DEFAULT_RECIPES, RECIPE_PARTS } from '@mistriwork/engine/shared/themeRecipes.js';
import { ROUND } from '@mistriwork/engine/shared/themeTokens.js';
import { themeExtends, themeSpecOf } from '../../shared/themeSpec.js';

const THEME_USAGE = 'mistri theme show <look|theme-id|.> [--app <dir>] [--diff <look|theme-id>] [--json]';

/** A panel's corner where a theme names none: style.css's --radius-lg, a control's and a half, at most 20px; a round
    control's boxes are ROUND_BOX (8px), so its panels are 12px. */
function panelFrom(control: string | undefined): string {
  if (control === undefined) return 'default';
  const px = control === ROUND ? 8 : /^(\d+(?:\.\d+)?)px$/.exec(control) ? Number(/^(\d+(?:\.\d+)?)px$/.exec(control)![1]) : undefined;
  return px === undefined ? 'default' : `${Math.min(px * 1.5, 20)}px`;
}

/** A value and where it comes from: `own`, a look's id, `default` (its Default palette, or the plain structure), or `derived`. */
interface Shown {
  value: string;
  from: string;
}
type Mode = 'light' | 'dark';

interface ShownTheme {
  id: string;
  label: string;
  kind: 'look' | 'app';
  extends: string | null;
  /** By palette id (`default` first), then mode, then the color's name in the spec (`status.critical`, `chart[2]`). */
  colors: Record<string, Record<Mode, Record<string, Shown>>>;
  palettes: Array<{ id: string; label: string }>;
  recipes: Record<string, Shown>;
  type: {
    fonts: Record<'ui' | 'data' | 'heading' | 'code', Shown>;
    faces: Array<{ family: string; src: string; weight: string; style: string }>;
    base: Shown;
    /** Each property a role says, as worn (the look's under the theme's), by `<role>.<property>`. */
    roles: Record<string, Shown>;
    headingWeight: Shown;
  };
  shape: {
    radius: Record<'control' | 'field' | 'pill' | 'panel', Shown>;
    border: Record<'rule' | 'control' | 'panel' | 'focus', Shown>;
    elevation: Shown;
  };
  density: Shown;
  motion: Shown;
  rhythm: Shown;
}

type Step = string | number;
const steps = (path: string): Step[] =>
  [...path.matchAll(/([A-Za-z_$][\w$]*)|\[(\d+)\]/g)].map((match) => (match[2] !== undefined ? Number(match[2]) : match[1]!));
/** What the spec says at a path; undefined (or a chart's `null`, "keep the look's") where it says nothing. */
function said(spec: unknown, path: string): unknown {
  let at = spec;
  for (const step of steps(path)) {
    if (at === null || typeof at !== 'object') return undefined;
    at = (at as Record<string | number, unknown>)[step];
  }
  return at === null ? undefined : at;
}

/**
 * The theme as worn, with where each value comes from. `theme` is a built-in
 * look or an App's theme as the App compiled it; its spec is the look's own
 * (themeLooks.ts) or the one `defineTheme` was given.
 */
export function showTheme(theme: ThemeDefinition): ShownTheme {
  const look = LOOKS.find((spec) => spec.id === theme.id);
  const spec: ThemeSpec | undefined = look && themePreset(theme.id) === theme ? look : (themeSpecOf(theme)?.raw as ThemeSpec | undefined);
  const base = look ? undefined : (themeExtends(theme) ?? undefined);
  const worn = inheritThemePreset(theme);
  const origin = (path: string, mine: string, theirs: unknown, fallback = 'derived') =>
    said(spec, path) !== undefined ? 'own' : base && theirs !== undefined && String(theirs) === mine ? base.id : fallback;

  const colors: ShownTheme['colors'] = {};
  const paletteIds = ['default', ...(theme.palettes ?? []).map((palette) => palette.id)];
  /* As worn: a palette that moves the accent and says no focus or tint of its own is worn with ones that follow it. */
  const wornAs = (definition: ThemeDefinition) => ({
    light: effectiveThemePalette(definition.light, false) as ThemePalette,
    dark: effectiveThemePalette(definition.dark, true) as ThemePalette,
  });
  for (const [index, paletteId] of paletteIds.entries()) {
    const ours = wornAs(effectiveThemeDefinition(theme, paletteId));
    const defaults = wornAs(effectiveThemeDefinition(theme, 'default'));
    const theirs =
      base && wornAs(effectiveThemeDefinition(base, base.palettes?.some((item) => item.id === paletteId) ? paletteId : 'default'));
    colors[paletteId] = { light: {}, dark: {} };
    for (const mode of ['light', 'dark'] as const)
      for (const [name, role] of COLOR_ROLES) {
        const value = ours[mode][role as keyof ThemePalette];
        if (value === undefined) continue;
        const from =
          paletteId === 'default'
            ? origin(`colors.${mode}.${name}`, value, theirs?.[mode][role])
            : said(spec, `palettes[${index - 1}].${mode}.${name}`) !== undefined
              ? 'own'
              : value === defaults[mode][role]
                ? 'default'
                : theirs && value === theirs[mode][role]
                  ? base!.id
                  : 'derived';
        colors[paletteId]![mode][name] = { value, from };
      }
  }

  const recipes = Object.fromEntries(
    RECIPE_PARTS.map((part) => {
      const value = String({ ...DEFAULT_RECIPES, ...worn.recipes }[part]);
      return [part, { value, from: origin(`recipes.${part}`, value, base?.recipes?.[part], 'default') }];
    }),
  );
  const font = said(spec, 'type.font');
  const fonts = Object.fromEntries(
    (['ui', 'data', 'heading', 'code'] as const).map((part) => {
      const value = worn.fonts?.[part] ?? "the browser's";
      const own = typeof font === 'string' ? part !== 'code' : said(font, part) !== undefined;
      return [part, { value, from: own ? 'own' : base?.fonts?.[part] === value ? base.id : 'default' }];
    }),
  ) as ShownTheme['type']['fonts'];
  const radius = said(spec, 'shape.radius');
  const radii = Object.fromEntries(
    (['control', 'field', 'pill', 'panel'] as const).map((part) => {
      // A pill left alone is round, not the look's control corner; a panel left alone is a control and a half, at most
      // 20px (style.css --radius-lg), so it is said as that.
      const value = worn.radius?.[part] ?? (part === 'pill' ? 'round' : part === 'panel' ? panelFrom(worn.radius?.control) : 'default');
      const own = said(radius, part) !== undefined;
      const from = own ? 'own' : base?.radius?.[part] === value ? base.id : part === 'panel' && value !== 'default' ? 'derived' : 'default';
      return [part, { value, from }];
    }),
  ) as ShownTheme['shape']['radius'];
  /* A rule's and a control's width ride in each mode's palette (the same in both); a panel's and the ring's in border. */
  const widths: Record<keyof ShownTheme['shape']['border'], string | undefined> = {
    rule: worn.light.rulesWeight,
    control: worn.light.rulesControl,
    panel: worn.border?.panel,
    focus: worn.border?.focus,
  };
  const borders = Object.fromEntries(
    Object.entries(widths).map(([part, value]) => {
      const theirs =
        base && (part === 'rule' ? base.light.rulesWeight : part === 'control' ? base.light.rulesControl : base.border?.[part as 'panel']);
      return [part, { value: value ?? 'default', from: origin(`shape.border.${part}`, value ?? 'default', theirs, 'default') }];
    }),
  ) as ShownTheme['shape']['border'];
  const typeBase = worn.type?.base ?? '13px';
  const weight = String(headingWeight(worn));
  const text = (value: unknown) => (Array.isArray(value) ? value.join(' ') : String(value));
  const roles: Record<string, Shown> = {};
  for (const [role, properties] of Object.entries(worn.type?.roles ?? {}))
    for (const [property, value] of Object.entries(properties)) {
      const under = (base?.type?.roles as Record<string, Record<string, unknown>> | undefined)?.[role]?.[property];
      roles[`${role}.${property}`] = {
        value: text(value),
        from: origin(`type.roles.${role}.${property}`, text(value), under === undefined ? undefined : text(under), 'default'),
      };
    }
  const lifts =
    worn.lifts && Object.keys(worn.lifts).length
      ? Object.entries(worn.lifts)
          .map(([step, lift]) => `${step} ${lift}`)
          .join(', ')
      : '';
  const elevation = `${worn.elevation ?? 'hairline'}${lifts ? ` (${lifts})` : ''}`;
  const density = worn.density ?? 'comfortable';
  const motion = worn.motion ?? 'house';
  const rhythm = worn.rhythm ?? 'house';
  return {
    id: theme.id,
    label: theme.label,
    kind: look ? 'look' : 'app',
    extends: base?.id ?? null,
    colors,
    palettes: [{ id: 'default', label: 'Default' }, ...(theme.palettes ?? []).map((palette) => ({ id: palette.id, label: palette.label }))],
    recipes,
    type: {
      fonts,
      faces: (theme.faces ?? []).map(({ family, src, weight, style }) => ({ family, src, weight, style })),
      base: { value: typeBase, from: origin('type.base', typeBase, base?.type?.base, 'default') },
      roles,
      headingWeight: { value: weight, from: origin('type.roles.title.weight', weight, base && headingWeight(base), 'default') },
    },
    shape: {
      radius: radii,
      border: borders,
      elevation: { value: elevation, from: origin('shape.elevation', elevation, base?.elevation, 'default') },
    },
    density: { value: density, from: origin('density', density, base?.density, 'default') },
    motion: { value: motion, from: origin('motion', motion, base?.motion, 'default') },
    rhythm: { value: rhythm, from: origin('rhythm', rhythm, base?.rhythm, 'default') },
  };
}

/** Every value of a shown theme by one flat name — `colors.light.accent`, `palettes.violet.dark.link`, `recipes.nav` — for a diff. */
function flat(shown: ShownTheme): Map<string, Shown> {
  const out = new Map<string, Shown>();
  for (const [paletteId, modes] of Object.entries(shown.colors))
    for (const mode of ['light', 'dark'] as const)
      for (const [name, value] of Object.entries(modes[mode]))
        out.set(paletteId === 'default' ? `colors.${mode}.${name}` : `palettes.${paletteId}.${mode}.${name}`, value);
  for (const [part, value] of Object.entries(shown.recipes)) out.set(`recipes.${part}`, value);
  for (const [part, value] of Object.entries(shown.type.fonts)) out.set(`type.font.${part}`, value);
  out.set('type.base', shown.type.base);
  for (const [name, value] of Object.entries(shown.type.roles)) out.set(`type.roles.${name}`, value);
  for (const [part, value] of Object.entries(shown.shape.radius)) out.set(`shape.radius.${part}`, value);
  for (const [part, value] of Object.entries(shown.shape.border)) out.set(`shape.border.${part}`, value);
  out.set('shape.elevation', shown.shape.elevation);
  out.set('density', shown.density);
  out.set('motion', shown.motion);
  out.set('rhythm', shown.rhythm);
  return out;
}

/** What differs between two themes' Default colors, recipes, type and shape: each name, this theme's value and the other's. */
export function diffThemes(shown: ShownTheme, other: ShownTheme): Array<{ name: string; value: string; other: string }> {
  const ours = flat(shown),
    theirs = flat(other);
  return [...new Set([...ours.keys(), ...theirs.keys()])]
    .filter((name) => !name.startsWith('palettes.'))
    .flatMap((name) => {
      const value = ours.get(name)?.value ?? '—',
        that = theirs.get(name)?.value ?? '—';
      return value === that ? [] : [{ name, value, other: that }];
    });
}

/**
 * How far a theme stands from the one it is compared with, by kind: how many recipe parts of all of them, and how
 * many colors, type and shape values. A look of its own differs on at least half the parts; one that changes only
 * colors is the other look in a new coat.
 */
export function themeDistance(differences: ReadonlyArray<{ name: string }>): {
  recipes: number;
  of: number;
  colors: number;
  type: number;
  shape: number;
} {
  const count = (prefix: string) => differences.filter((item) => item.name.startsWith(prefix)).length;
  return {
    recipes: count('recipes.'),
    of: RECIPE_PARTS.length,
    colors: count('colors.'),
    type: count('type.'),
    shape: count('shape.'),
  };
}

const mark = (shown: Shown) => (shown.from === 'own' ? '' : shown.from === 'default' ? '(default)' : `(${shown.from})`);

/** The human form: a table per part, each inherited value marked with where it comes from. */
function sayTheme(shown: ShownTheme): string[] {
  const lines: string[] = [];
  const from = shown.extends ? `, extends ${shown.extends}` : '';
  lines.push(
    `${shown.label} (${shown.id}) — ${shown.kind === 'look' ? 'a built-in look' : 'an App theme'}${from}.`,
    `A value in parentheses comes from there: ${shown.extends ? `${shown.extends}, the look it extends; ` : ''}default, the plain structure${shown.palettes.length > 1 ? " (in a palette, its Default palette's)" : ''}; derived, worked out from its other colors. The rest are its own.`,
    '',
  );
  const names = COLOR_ROLES.map(([name]) => name);
  const width = Math.max(...names.map((name) => name.length)) + 2;
  const cell = (shown?: Shown) => (shown ? `${shown.value} ${mark(shown)}`.trim() : '').padEnd(24);
  const table = (palette: string, changes: boolean) => {
    const modes = shown.colors[palette]!;
    for (const name of names) {
      const light = modes.light[name],
        dark = modes.dark[name];
      if (!light && !dark) continue;
      if (changes && light?.from === 'default' && dark?.from === 'default') continue;
      lines.push(`  ${name.padEnd(width)}${cell(light)}${cell(dark)}`.trimEnd());
    }
  };
  lines.push(`Colors${' '.repeat(width - 4)}${'light'.padEnd(24)}dark`);
  table('default', false);
  for (const palette of shown.palettes.slice(1)) {
    lines.push('', `Palette ${palette.label} (${palette.id}): the colors it changes; the rest are Default's`);
    table(palette.id, true);
  }
  const rows = (title: string, entries: Array<[string, Shown]>) => {
    lines.push('', title);
    const pad = Math.max(...entries.map(([name]) => name.length)) + 2;
    for (const [name, value] of entries) lines.push(`  ${name.padEnd(pad)}${value.value} ${mark(value)}`.trimEnd());
  };
  rows('Recipes', Object.entries(shown.recipes));
  rows('Type', [
    ...Object.entries(shown.type.fonts).map(([part, value]) => [`font.${part}`, value] as [string, Shown]),
    ['base', shown.type.base],
    ...Object.entries(shown.type.roles).map(([name, value]) => [`roles.${name}`, value] as [string, Shown]),
    ['title weight', shown.type.headingWeight],
  ]);
  for (const face of shown.type.faces) lines.push(`  face          ${face.family} ${face.weight} ${face.style}  ${face.src}`);
  rows('Shape', [
    ...Object.entries(shown.shape.radius).map(([part, value]) => [`radius.${part}`, value] as [string, Shown]),
    ...Object.entries(shown.shape.border).map(([part, value]) => [`border.${part}`, value] as [string, Shown]),
    ['elevation', shown.shape.elevation],
  ]);
  rows('Density and pace', [
    ['density', shown.density],
    ['motion', shown.motion],
    ['rhythm', shown.rhythm],
  ]);
  return lines;
}

/** `mistri theme …`, as the command line runs it. Returns the exit code. */
export async function runTheme(
  argv: string[],
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Promise<number> {
  if (argv[0] !== 'show' || argv.includes('--help') || argv.includes('-h')) {
    const help = argv.includes('--help') || argv.includes('-h');
    (help ? write : (line: string) => console.error(line))(
      `${THEME_USAGE}\n\nA theme as it is worn: every color in light and dark and each palette, every recipe, the type and\n` +
        'the shape, after extends, each value it inherits marked with where from. <look> is a built-in look (' +
        THEME_PRESETS.map((theme) => theme.id).join(', ') +
        '); a theme id or . (the one the App wears) reads the App in --app <dir>, else the current directory.\n' +
        '--diff <look|theme-id> says only what differs from that theme. --json prints one JSON document.',
    );
    return help ? 0 : 1;
  }
  let name: string | undefined;
  let app: string | undefined;
  let against: string | undefined;
  let json = false;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--app' || arg === '--diff') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) {
        console.error(`mistri theme show: ${arg} needs a value. ${THEME_USAGE}`);
        return 1;
      }
      if (arg === '--app') app = value;
      else against = value;
    } else if (!arg.startsWith('--') && name === undefined) name = arg;
    else {
      console.error(`mistri theme show: unknown option "${arg}". ${THEME_USAGE}`);
      return 1;
    }
  }
  if (!name) {
    console.error(`mistri theme show: name a look or a theme. ${THEME_USAGE}`);
    return 1;
  }

  /* An App is read only when a name is not a built-in look's, or --app says to. */
  let themes: readonly ThemeDefinition[] = [];
  let worn: string | undefined;
  const needsApp = [name, against].some((given) => given !== undefined && !themePreset(given));
  if (needsApp || app) {
    const dir = resolve(app ?? '.');
    if (!['app.ts', 'app.mjs', 'app.json'].some((file) => existsSync(join(dir, file)))) {
      console.error(
        `mistri theme show: ${app ? `${app} has no app.ts` : `"${[name, against].find((given) => given && !themePreset(given))}" is not a built-in look (${THEME_PRESETS.map((theme) => theme.id).join(', ')}), and there is no App here to read it from`}. ${THEME_USAGE}`,
      );
      return 1;
    }
    const log = console.log;
    console.log = () => {};
    try {
      const { loadApp } = await import('../app/apps.js');
      const loaded = await loadApp(dir, { lock: 'report' });
      themes = loaded.app.ui.customThemes ?? [];
      worn = loaded.app.ui.theme?.preset ?? 'lumen';
    } catch (error) {
      console.error(`mistri theme show: the App did not load: ${(error as Error).message}`);
      return 1;
    } finally {
      console.log = log;
    }
  }
  const find = (given: string) => {
    const id = given === '.' ? (worn ?? 'lumen') : given;
    return themes.find((theme) => theme.id === id) ?? themePreset(id);
  };
  const theme = find(name);
  const other = against === undefined ? undefined : find(against);
  const unknown = !theme ? name : against !== undefined && !other ? against : undefined;
  if (unknown !== undefined) {
    const known = [...THEME_PRESETS.map((item) => item.id), ...themes.map((item) => item.id)];
    console.error(`mistri theme show: no theme "${unknown}". It is one of: ${known.join(', ')}.`);
    return 1;
  }
  const shown = showTheme(theme!);
  if (other) {
    const otherShown = showTheme(other);
    const differences = diffThemes(shown, otherShown);
    const distance = themeDistance(differences);
    if (json) write(JSON.stringify({ theme: shown.id, against: otherShown.id, distance, differences }, null, 2));
    else {
      write(
        `${shown.label} (${shown.id}) against ${otherShown.label} (${otherShown.id}): ${differences.length} difference${differences.length === 1 ? '' : 's'}`,
      );
      write(
        `  distance: ${distance.recipes} of ${distance.of} recipe parts, ${distance.colors} color${distance.colors === 1 ? '' : 's'}, ${distance.type} type and ${distance.shape} shape value${distance.shape === 1 ? '' : 's'}`,
      );
      const width = Math.max(0, ...differences.map((item) => item.name.length)) + 2;
      const left = Math.max(0, ...differences.map((item) => item.value.length)) + 2;
      for (const item of differences) write(`  ${item.name.padEnd(width)}${item.value.padEnd(left)}${otherShown.id}: ${item.other}`);
    }
    return 0;
  }
  if (json) write(JSON.stringify(shown, null, 2));
  else for (const line of sayTheme(shown)) write(line);
  return 0;
}
