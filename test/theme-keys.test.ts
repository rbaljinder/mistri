import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileAppTheme, compileTheme } from '../packages/mistri/src/shared/themeSpec.js';
import { themePreset } from '../packages/engine/src/shared/themePresets.js';
import { shapeTokens } from '../packages/engine/src/shared/themeTokens.js';
import { showTheme } from '../packages/mistri/src/server/build/themeShow.js';

/**
 * Every key `defineTheme` accepts reaches what it compiles to, or is refused: none is taken and dropped. Aurora
 * Care's `shape.radius.panel` was accepted by the types, the docs and the validator, and `theme show` never said it
 * (T-1). The keys are read off the published schema (packages/mistri/schema/theme.schema.json), so a key added there and forgotten
 * by the compiler fails here.
 */
const schema = JSON.parse(readFileSync(new URL('../packages/mistri/schema/theme.schema.json', import.meta.url), 'utf8'));
type Node = Record<string, any>;
const deref = (node: Node): Node => (node.$ref ? schema.$defs[node.$ref.split('/').pop()] : node);

/** Each leaf a spec can say, by path: `shape.radius.panel`, `palettes[].light.link`, `parts.*.ground`. */
function leaves(node: Node, path: string, out: string[]): string[] {
  node = deref(node);
  const object = node.properties ? node : (node.oneOf ?? node.anyOf)?.map(deref).find((alt: Node) => alt.properties);
  if (object) {
    for (const [key, value] of Object.entries(object.properties)) leaves(value as Node, path ? `${path}.${key}` : key, out);
    return out;
  }
  if (node.additionalProperties && typeof node.additionalProperties === 'object' && node.propertyNames)
    return leaves(node.additionalProperties, `${path}.*`, out);
  if (node.type === 'array' && deref(node.items ?? {}).properties) return leaves(node.items, `${path}[]`, out);
  out.push(path);
  return out;
}

/** A value for every leaf, none of them what the theme would wear with the leaf left out. */
/* A distinct six-digit color per slot: a multiplicative hash, so no two slots meet and none is derived. */
const color = (mode: 'light' | 'dark', n: number) =>
  `#${(((n + (mode === 'dark' ? 500 : 1)) * 2654435761) >>> 8).toString(16).slice(-6).padStart(6, '0')}`;
function colors(mode: 'light' | 'dark', shift: number) {
  let n = shift;
  const next = () => color(mode, n++);
  return {
    ground: next(),
    surface: next(),
    raised: next(),
    ink: next(),
    inkMuted: next(),
    inkSubtle: next(),
    line: next(),
    lineStrong: next(),
    lineControl: next(),
    field: next(),
    accent: next(),
    onAccent: next(),
    accentInk: next(),
    accentSoft: next(),
    primary: next(),
    onPrimary: next(),
    link: next(),
    focus: next(),
    status: { good: next(), warning: next(), critical: next(), info: next() },
    nav: { ground: next(), ink: next(), muted: next(), line: next(), accent: next(), current: next(), onCurrent: next() },
    rules: { section: next(), head: next() },
    shadow: next(),
    band: next(),
    chart: Array.from({ length: 8 }, next),
  };
}
const role = { face: 'heading', size: '30px', leading: 1.3, tracking: '0.01em', weight: 600, case: 'small-caps', features: ['lnum'] };
const FULL = {
  kind: 'theme',
  id: 'every-key',
  label: 'Every key',
  colors: { light: colors('light', 0), dark: colors('dark', 0) },
  palettes: [{ id: 'second', label: 'Second', light: colors('light', 40), dark: colors('dark', 40) }],
  defaultPalette: 'second',
  scheme: 'dark',
  shape: {
    radius: { control: '7px', field: '5px', pill: '3px', panel: '16px' },
    elevation: { card: 'mid', float: 'high' },
    border: { rule: '2px', control: '2px', panel: '2px', focus: '3px' },
    height: { control: '44px' },
  },
  type: {
    font: { ui: 'Alpha, sans-serif', data: 'Beta, monospace', heading: 'Gamma, serif', code: 'Delta, monospace' },
    faces: [{ family: 'Gamma', src: './fonts/gamma.woff2', weight: '700', style: 'italic', subset: false }],
    icons: 'bold',
    base: '15px',
    roles: {
      display: { face: role.face, size: '40px', leading: role.leading, tracking: role.tracking, weight: 800, features: role.features },
      title: { ...role },
      heading: { ...role, size: '20px' },
      section: { face: role.face, size: '16px', tracking: role.tracking, weight: role.weight, case: 'upper', features: role.features },
      body: { leading: 1.6, features: ['tnum'] },
      label: { face: role.face, tracking: role.tracking, weight: role.weight, case: 'upper', features: role.features },
      data: { features: ['zero'], reach: 'figures' },
      figure: { face: role.face, size: '28px', tracking: role.tracking, weight: role.weight, features: role.features },
      nav: { face: role.face, tracking: role.tracking, weight: role.weight, case: 'upper' },
    },
  },
  density: 'compact',
  motion: 'brisk',
  rhythm: 'airy',
  recipes: {
    nav: 'pill',
    bar: 'dark',
    tabs: 'underline',
    windows: 'lifted',
    stat: 'icon',
    section: 'card',
    fields: 'card',
    table: 'banded',
    status: 'pill',
    board: 'strip',
    chart: 'gradient',
    buttons: 'raised',
    links: 'underline',
    rules: 'hairline',
    avatar: 'round',
    workflow: 'pills',
    banner: 'gradient',
    steps: 'tinted',
    lanes: 'tag',
    header: 'hero',
    required: 'optional-word',
    checkbox: 'drawn',
    formStep: 'ruled',
    actionBar: 'raised',
  },
  shell: { placement: 'top' },
  surface: { ground: { kind: 'grid', strength: 2 }, nav: { kind: 'dots', strength: 3 } },
  parts: {
    stat: {
      ground: 'raised',
      ink: 'accent',
      edge: 'lineStrong',
      radius: 'panel',
      lift: 'mid',
      face: 'heading',
      weight: 700,
      case: 'upper',
    },
  },
  stylesheet: './theme.css',
  contract: 1,
  from: 'file:///packages/every-key/theme.js',
} as const;

/** Keys that say what a theme is rather than how it is drawn: each is held by a test of its own. */
const NOT_DRAWN: Record<string, string> = {
  kind: 'defineTheme’s brand: anything but "theme" is refused (theme-spec.test.ts)',
  'extends.kind': 'a theme value to start from; extends is a base, not a value worn (theme-package.test.ts)',
  contract: 'the contract a published look was written to; another is refused (theme-package.test.ts)',
  from: 'where a published look’s files are read from, kept off the definition the browser is sent (theme-package.test.ts)',
};

type Path = Array<string | number>;
const steps = (leaf: string): Path =>
  leaf
    .replace(/\[\]/g, '.0')
    .replace(/\.\*/g, '.stat')
    .split('.')
    .map((step) => (/^\d+$/.test(step) ? Number(step) : step));
const at = (value: unknown, path: Path) => path.reduce<any>((node, step) => node?.[step], value);
function without(value: unknown, path: Path): unknown {
  const copy = structuredClone(value) as any;
  const parent = at(copy, path.slice(0, -1));
  delete parent[path.at(-1)!];
  return copy;
}
const compile = (raw: unknown) => compileTheme(raw, 'every-key', themePreset, new Set(), { faces: true });

test('every key the schema accepts reaches the compiled theme, or is refused', () => {
  const paths = leaves(schema, '', []).flatMap((leaf) =>
    leaf === 'parts' ? Object.keys(FULL.parts.stat).map((property) => `parts.*.${property}`) : [leaf],
  );
  assert.ok(paths.length > 200, `the schema walk found ${paths.length} keys`);
  const full = JSON.stringify(compile(FULL));
  const dropped: string[] = [];
  for (const leaf of paths) {
    if (NOT_DRAWN[leaf]) continue;
    const path = steps(leaf);
    assert.notEqual(at(FULL, path), undefined, `the test's theme says nothing at ${leaf}: give it a value`);
    let compiled: string;
    try {
      compiled = JSON.stringify(compile(without(FULL, path)));
    } catch {
      continue; // Required where it stands: the spec does not compile without it.
    }
    if (compiled === full) dropped.push(leaf);
  }
  assert.deepEqual(dropped, [], `accepted and dropped by the compiler: ${dropped.join(', ')}`);
});

test("a panel's corner is compiled, worn as --panel-radius and said by theme show", () => {
  // As an App compiles it, so theme show reads its spec and says which values are its own.
  const theme = compileAppTheme(FULL, 'every-key', new Set(), { faces: true });
  assert.equal(theme.radius?.panel, '16px');
  assert.equal(shapeTokens(theme)['--panel-radius'], '16px');
  const shown = showTheme(theme);
  assert.deepEqual(shown.shape.radius.panel, { value: '16px', from: 'own' });
  assert.deepEqual(shown.shape.border.panel, { value: '2px', from: 'own' });
  assert.deepEqual(shown.shape.border.rule, { value: '2px', from: 'own' });
});
