/**
 * An App theme's source, as `check` reads and `check --fix` writes it: the
 * `defineTheme({ … })` whose `id` is the theme's, walked to a path of its
 * spec (`colors.light.accent`, `palettes[1].dark.status.critical`,
 * `colors.dark.chart`) with checkFix.ts's scanner of object literals.
 *
 * A finding is placed on the line that says the color, or on the nearest
 * object that would say it when the theme inherits it (`extends`), so a
 * palette's failure points into that palette and not at the theme's head.
 * A fix is written only where the source says the value as a literal: a
 * quoted color is replaced by another, a chart of quoted colors by the same
 * colors in another order, and a color the theme inherits is added to the
 * literal object nearest it. A value the source computes is left, and said.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { ThemeDefinition } from '@mistriwork/engine/schema/theme.js';
import type { FixedThemeProblem, ThemeFix } from '../../shared/themeFix.js';
import { appSources, maskedText, OPAQUE, Scanner, type ObjectNode, type Property } from './checkFix.js';

interface ThemeText {
  file: string;
  text: string;
  object: ObjectNode;
}

/** Every `defineTheme({ … })` in the App's own sources whose literal `id` is this one. */
function themesIn(files: readonly string[], id: string): ThemeText[] {
  const found: ThemeText[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (!text.includes('defineTheme')) continue;
    const masked = maskedText(text);
    for (const match of masked.matchAll(/\bdefineTheme\s*\(\s*\{/g)) {
      const scanner = new Scanner(text);
      scanner.i = match.index! + match[0].length - 1;
      const object = scanner.object();
      if (object.props.some((prop) => prop.key === 'id' && prop.value === id)) found.push({ file, text, object });
    }
  }
  return found;
}

type Step = string | number;
const steps = (path: string): Step[] =>
  [...path.matchAll(/([A-Za-z_$][\w$]*)|\[(\d+)\]/g)].map((match) => (match[2] !== undefined ? Number(match[2]) : match[1]!));

/** The property a path reaches, as far as the literal goes: the last one found, the object it is in, and the steps left. */
function walk(object: ObjectNode, path: string): { prop?: Property; holder: ObjectNode; left: Step[] } {
  let holder = object;
  let prop: Property | undefined;
  const list = steps(path);
  for (let index = 0; index < list.length; index++) {
    const step = list[index]!;
    if (typeof step === 'number') {
      const item = prop?.items?.[step];
      if (!item?.object) return { prop, holder, left: list.slice(index) };
      holder = item.object;
      prop = { key: String(step), start: item.start, end: item.end, value: item.value, object: item.object };
      continue;
    }
    const next = holder.props.find((candidate) => candidate.key === step);
    if (!next) return { prop, holder, left: list.slice(index) };
    prop = next;
    if (index < list.length - 1 && typeof list[index + 1] !== 'number') {
      if (!next.object) return { prop, holder, left: list.slice(index + 1) };
      holder = next.object;
    }
  }
  return { prop, holder, left: [] };
}

const lineAt = (text: string, offset: number) => text.slice(0, offset).split('\n').length;

/**
 * Where an App theme says the color at `path`: the file and line of its key,
 * or of the nearest key on the way to it when the theme inherits it.
 * Undefined when the theme is not a literal `defineTheme` in the App's sources.
 */
export function themePlace(dir: string, themeId: string, path: string): { file: string; line: number } | undefined {
  const [theme] = themesIn(appSources(dir), themeId);
  if (!theme) return undefined;
  const { prop } = walk(theme.object, path);
  return { file: theme.file, line: lineAt(theme.text, prop?.start ?? theme.object.start) };
}

const quoted = (value: string) => `'${value}'`;
const literal = (value: string | readonly string[]) => (typeof value === 'string' ? quoted(value) : `[${value.map(quoted).join(', ')}]`);

/** The text a path's missing steps take inside the object they are added to: `status: { critical: '#c7363e' }`. */
function nested(left: readonly Step[], value: string | readonly string[]): string | undefined {
  if (left.some((step) => typeof step === 'number')) return undefined;
  return left.reduceRight<string>(
    (inner, step, index) => (index === left.length - 1 ? `${step}: ${inner}` : `${step}: { ${inner} }`),
    literal(value),
  );
}

/**
 * Writes one fix into the theme's source. Returns the line said about it, or
 * a reason it was left: the theme is not a literal `defineTheme` in one
 * place, the value there is computed, or it is not the value the fix replaces.
 */
export function writeThemeFix(dir: string, themeId: string, fix: ThemeFix, was: unknown): { done: string } | { left: string } {
  const where = `theme "${themeId}" ${fix.path}`;
  const themes = themesIn(appSources(dir), themeId);
  if (themes.length !== 1)
    return {
      left: `${where}: ${themes.length ? 'defined in more than one place' : 'not a literal defineTheme({ … }) in the App'}; write ${fix.said} by hand`,
    };
  const { file, text, object } = themes[0]!;
  const { prop, holder, left } = walk(object, fix.path);
  let edited: string;
  if (!left.length && prop) {
    const start = prop.valueStart;
    /* Only the literal the check read is replaced: a value written as a variable or a call is the author's to change. */
    if (start === undefined || prop.value === OPAQUE || JSON.stringify(prop.value) !== JSON.stringify(was))
      return { left: `${where}: the source does not say it as a literal; write ${fix.said} by hand` };
    edited = `${text.slice(0, start)}${literal(fix.value)}${text.slice(prop.end)}`;
  } else {
    /* An inherited color is added to the literal object nearest it, after its last key. */
    /* A key that is there but computed (`colors: shared`) is not added to beside itself. */
    const into = prop && holder.props.includes(prop) ? undefined : holder;
    const said = nested(left, fix.value);
    if (!into || !said || was !== undefined) return { left: `${where}: no literal object to add it to; write ${fix.said} by hand` };
    const last = into.props.at(-1);
    if (!last) {
      edited = `${text.slice(0, into.start + 1)} ${said} ${text.slice(into.end - 1)}`;
    } else {
      const lineStart = text.lastIndexOf('\n', last.start - 1) + 1;
      const indent = /^[ \t]*/.exec(text.slice(lineStart))![0];
      const own = text.slice(lineStart, last.start).trim() === '';
      let after = last.end;
      while (/[ \t]/.test(text[after] ?? '')) after++;
      const comma = text[after] === ',';
      const at = comma ? after + 1 : last.end;
      edited = own
        ? `${text.slice(0, at)}${comma ? '' : ','}\n${indent}${said}${comma ? ',' : ''}${text.slice(at)}`
        : `${text.slice(0, at)}${comma ? '' : ','} ${said}${text.slice(at)}`;
    }
  }
  writeFileSync(file, edited);
  return { done: `${file}:${lineAt(edited, prop?.start ?? object.start)}  theme "${themeId}": ${fix.said}` };
}

/**
 * The line `check` starts its themes with: per theme, palette and mode, how
 * many colors to change (a color a palette inherits counts once, where it is
 * said): `Workshop light: 3 to fix · dark: 1 · Racing green light: 1`.
 */
export function themeSummary(themes: readonly ThemeDefinition[], problems: readonly FixedThemeProblem[]): string {
  const counts = new Map<string, Set<string>>();
  for (const problem of problems) {
    const theme = themes.find((item) => item.id === problem.themeId);
    const palette = /^palettes\[(\d+)\]/.exec(problem.at)?.[1];
    const label =
      palette !== undefined ? (theme?.palettes?.[Number(palette)]?.label ?? problem.paletteId) : (theme?.label ?? problem.themeId);
    const key = `${label}\u0000${problem.mode}`;
    counts.set(key, (counts.get(key) ?? new Set()).add(`${problem.themeId} ${problem.at}`));
  }
  if (!counts.size) {
    const palettes = themes.reduce((sum, theme) => sum + (theme.palettes?.length ?? 0), 0);
    return `${themes.length} theme${themes.length === 1 ? '' : 's'}${palettes ? `, ${palettes} palette${palettes === 1 ? '' : 's'}` : ''}: every color passes, light and dark`;
  }
  let previous = '';
  return [...counts]
    .map(([key, paths], index) => {
      const [label, mode] = key.split('\u0000');
      const said = `${label === previous ? '' : `${label} `}${mode}: ${paths.size}${index === 0 ? ' to fix' : ''}`;
      previous = label!;
      return said;
    })
    .join(' · ');
}
