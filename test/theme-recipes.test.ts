import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inPackages } from './support/packages.js';
import {
  ELEVATIONS,
  LIFTS,
  MOTIONS,
  RECIPE_MENU,
  RECIPE_PARTS,
  RHYTHMS,
  TYPE_ATTRIBUTES,
} from '../packages/engine/src/shared/themeRecipes.js';
import { TYPE_ROLES } from '../packages/engine/src/shared/themeType.js';

/**
 * The recipe menu (themeRecipes.ts) says which `data-look-<part>` values exist and
 * which sheet answers each. The sheets are held to it from the other side: no
 * rule answers a value that is off the menu, none sits in a sheet the value
 * does not name (a worn theme would not have loaded it), and every value that
 * is not a part's default is answered somewhere.
 */
/* Every package's sheets, each by its path under its src/client (the one tree's name for it). */
const SHEETS = new Map(
  inPackages('src/client').flatMap((dir) =>
    readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.css'))
      .map((file) => [file.split('\\').join('/'), join(dir, file)] as const),
  ),
);
/* @mistriwork/ui's form controls' sheet arrives with the first control a page draws: the form recipes (required, checkbox,
   formStep, actionBar) are answered there, not in a first stylesheet. */
SHEETS.set('forms.css', join('packages/ui/src', 'forms.css'));
const sheets = [...SHEETS.keys()].sort();
const at = (sheet: string) => SHEETS.get(sheet) ?? sheet;

/** The sheets a page always loads: a menu value that names none lives in one of these. */
const FIRST_SHEETS = ['themeFamilies.css', 'components/sdk/kit.css', 'forms.css'];

const MENUS: Record<string, Record<string, string | null>> = {
  ...(RECIPE_MENU as Record<string, Record<string, string | null>>),
  elevation: ELEVATIONS,
  motion: MOTIONS,
  rhythm: RHYTHMS,
  card: LIFTS,
  float: LIFTS,
};
const PARTS = new Set([...RECIPE_PARTS, 'elevation', 'motion', 'rhythm', 'card', 'float']);

interface Rule {
  sheet: string;
  part: string;
  value: string;
}
const rules: Rule[] = [];
const themeStyleValues: string[] = [];
for (const sheet of sheets) {
  const css = readFileSync(at(sheet), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  /* A part of two words is kebab in the attribute (data-look-form-step) and camel on the menu (formStep). */
  for (const match of css.matchAll(/data-look-([a-z-]+)=["']?([^"'\]\s]+)["']?/g))
    rules.push({ sheet, part: match[1]!.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()), value: match[2]! });
  for (const match of css.matchAll(/data-theme-style=["']?([^"'\]\s]*)/g)) themeStyleValues.push(`${sheet}: ${match[0]}`);
}

/** A menu value's sheet name (`lumen`) as the file that holds its rules. */
const sheetFile = (name: string) => `${name}Look.css`;

test('the sheets answer some recipes at all (the scan finds the rules)', () => {
  assert.ok(rules.length > 200, `${rules.length} rules found`);
});

test('every data-look rule names a part the menu has', () => {
  const unknown = rules.filter((rule) => !PARTS.has(rule.part));
  assert.deepEqual(unknown, [], 'a part that is not in RECIPE_PARTS (or elevation, motion, rhythm, card, float)');
});

test('every data-look rule answers a value that is on the menu', () => {
  const off = rules.filter((rule) => PARTS.has(rule.part) && !Object.hasOwn(MENUS[rule.part]!, rule.value));
  assert.deepEqual(
    off.map((rule) => `${rule.sheet}: data-look-${rule.part}="${rule.value}" (the menu: ${Object.keys(MENUS[rule.part]!).join(', ')})`),
    [],
  );
});

test('every data-look rule lives in the sheet its menu value names', () => {
  const misplaced = rules
    .filter((rule) => PARTS.has(rule.part) && Object.hasOwn(MENUS[rule.part]!, rule.value))
    .filter((rule) => {
      // An always-loaded sheet may answer any value (kit.css keys a segment's fill off Mono's tabs); a look's sheet only its own.
      const named = MENUS[rule.part]![rule.value]!;
      return named ? rule.sheet !== sheetFile(named) && !FIRST_SHEETS.includes(rule.sheet) : !FIRST_SHEETS.includes(rule.sheet);
    });
  assert.deepEqual(
    misplaced.map((rule) => {
      const named = MENUS[rule.part]![rule.value];
      return `${rule.sheet}: data-look-${rule.part}="${rule.value}" belongs in ${named ? `${sheetFile(named)} or ` : ''}${FIRST_SHEETS.join(' or ')}`;
    }),
    [],
  );
});

test('no selector reads a theme by its family name: data-theme-style has no value to select on', () => {
  assert.deepEqual(
    themeStyleValues.filter((reading) => /=/.test(reading)),
    [],
  );
});

/** Values the menu offers that no rule answers, and why. */
const RULE_LESS: Record<string, string> = {};

test("every value that is not its part's default is answered by a rule", () => {
  const answered = new Set(rules.map((rule) => `${rule.part}=${rule.value}`));
  const unanswered: string[] = [];
  for (const [part, menu] of Object.entries(MENUS)) {
    for (const value of Object.keys(menu).slice(1)) {
      const key = `${part}=${value}`;
      if (!answered.has(key) && !(key in RULE_LESS)) unanswered.push(key);
    }
  }
  assert.deepEqual(unanswered, [], 'a menu value no sheet draws: add its rules, or list it in RULE_LESS with the reason');
  for (const key of Object.keys(RULE_LESS)) assert.ok(!answered.has(key), `${key} is answered now; take it off RULE_LESS`);
});

test('the sheets a menu names exist', () => {
  const named = new Set<string>();
  for (const menu of Object.values(MENUS)) for (const sheet of Object.values(menu)) if (sheet) named.add(sheetFile(sheet));
  for (const file of named) assert.ok(sheets.includes(file), `${file} is named by the menu and is not under src/client`);
  for (const file of FIRST_SHEETS) assert.ok(sheets.includes(file), file);
});

test('a pace is the five durations and nothing else: brisk a quarter quicker, still none at all', () => {
  const css = readFileSync(at('themeFamilies.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const block = (value: string) => /\{([^}]*)\}/.exec(css.slice(css.indexOf(`[data-look-motion='${value}']`)))?.[1] ?? '';
  const durations = (body: string) => Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2]!.trim()]));
  const house = { '--t-press': '140ms', '--t-hover': '120ms', '--t-popover': '160ms', '--t-panel': '200ms', '--t-changed': '1200ms' };
  const style = durations(/:root\s*\{([\s\S]*?)\n\}/.exec(readFileSync('packages/ui/src/tokens.css', 'utf8'))![1]!);
  for (const [token, value] of Object.entries(house)) assert.equal(style[token], value, `tokens.css ${token}`);
  const brisk = durations(block('brisk')),
    still = durations(block('still'));
  assert.deepEqual(Object.keys(brisk).sort(), Object.keys(house).sort());
  for (const [token, value] of Object.entries(house)) assert.equal(parseFloat(brisk[token]!), Math.round(parseFloat(value) * 0.75), token);
  assert.deepEqual(still, Object.fromEntries(Object.keys(house).map((token) => [token, '0ms'])));
});

test("a rhythm moves the layout steps and the seam a quarter, and never a control's own", () => {
  const css = readFileSync(at('themeFamilies.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const block = (value: string) => /\{([^}]*)\}/.exec(css.slice(css.indexOf(`[data-look-rhythm='${value}']`)))?.[1] ?? '';
  const steps = (body: string) => Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2]!.trim()]));
  const style = steps(/:root\s*\{([\s\S]*?)\n\}/.exec(readFileSync('packages/ui/src/tokens.css', 'utf8'))![1]!);
  const layout = ['--space-5', '--space-6', '--space-7', '--space-8', '--section-seam'];
  for (const [value, k] of [
    ['tight', 0.75],
    ['airy', 1.25],
  ] as const) {
    const moved = steps(block(value));
    assert.deepEqual(Object.keys(moved).sort(), [...layout].sort(), value);
    for (const token of layout) assert.equal(parseFloat(moved[token]!), parseFloat(style[token]!) * k, `${value} ${token}`);
  }
});

/* Type roles (themeType.ts): each property a role takes is a word of its `data-type-<role>` attribute, and an
   always-loaded sheet answers every word, so a role a theme says is drawn wherever the theme is worn. A size, a
   title's weight and a heading's weight that ride a token every sheet reads already need no rule of their own. */
const TOKEN_ONLY = new Set(['title size', 'title weight', 'display size']);
test('every type role property is answered by a rule in an always-loaded sheet', () => {
  assert.deepEqual(
    TYPE_ATTRIBUTES,
    /* The nav role also dresses the side menu's entries on an attribute of their own (themeRecipes.ts). */
    [...Object.keys(TYPE_ROLES).map((role) => `data-type-${role}`), 'data-type-nav-side'],
    "themeRecipes.ts lists the roles in themeType.ts's order",
  );
  const css = FIRST_SHEETS.map((sheet) => readFileSync(at(sheet), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')).join('\n');
  const answered = new Set([...css.matchAll(/data-type-([a-z]+)~='([a-z-]+)'/g)].map((m) => `${m[1]} ${m[2]}`));
  const missing: string[] = [];
  for (const [role, rule] of Object.entries(TYPE_ROLES)) {
    const words = rule.takes.flatMap((property) =>
      property === 'features'
        ? ['numeric', 'features']
        : property === 'case'
          ? ['upper', 'small-caps']
          : /* data's reach is said as the word it turns on: figures (values is the default and sets none). */
            property === 'reach'
            ? ['figures']
            : [property],
    );
    for (const word of words) if (!TOKEN_ONLY.has(`${role} ${word}`) && !answered.has(`${role} ${word}`)) missing.push(`${role} ${word}`);
  }
  assert.deepEqual(missing, []);
  for (const key of answered) {
    const role = key.split(' ')[0]!;
    assert.ok(Object.hasOwn(TYPE_ROLES, role), `a rule answers data-type-${role}, which is no role`);
  }
  // No sheet reads the old type recipes: they are type roles now.
  for (const sheet of sheets) {
    const text = readFileSync(at(sheet), 'utf8');
    assert.doesNotMatch(text, /data-look-(?:scale|labels|figures|headings)\b/, sheet);
  }
});
