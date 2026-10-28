/**
 * The theme tools of 0.9.2: an App theme's own font files (type.faces) read
 * from the App's directory and served from its origin; a contrast or chart
 * failure that says the value that passes, placed on the line that says the
 * color and written by `check --fix`; `theme show` and its recipe table on
 * the looks page; and the looks `shot` and `grade` may wear.
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ThemeDefinition, ThemeSpec } from '../packages/engine/schema/theme.js';
import { compileAppTheme } from '../packages/mistri/src/shared/themeSpec.js';
import { checkTheme } from '../packages/mistri/src/shared/themeCheck.js';
import { checkThemeWithFixes, writtenAt } from '../packages/mistri/src/shared/themeFix.js';
import { faceRules, headingFace } from '../packages/engine/src/shared/themeFaces.js';
import { fontBudgetProblem, fontSummary, fontWarnings, readAppFonts, type AppFonts } from '../packages/mistri/src/server/app/appFonts.js';
import { fontRoute } from '../packages/mistri/src/server/http/fontRoutes.js';
import { themePlace, themeSummary, writeThemeFix } from '../packages/mistri/src/server/build/themeSource.js';
import { diffThemes, showTheme, themeDistance } from '../packages/mistri/src/server/build/themeShow.js';
import { RECIPE_PARTS } from '../packages/engine/src/shared/themeRecipes.js';
import { shotLooks } from '../packages/mistri/src/server/build/shot.js';
import { validationCode } from '../packages/mistri/src/server/build/checkProblems.js';
import { THEME_PRESETS } from '../packages/engine/src/shared/themePresets.js';
import type { LoadedApp } from '../packages/mistri/src/server/app/apps.js';

const ROOT = resolve('.');
/* An App's starts are mistri's (test/support/bins.ts). */
const ENTRY = join(ROOT, 'packages', 'mistri', 'src', 'server', 'index.ts');
const INTER = join(ROOT, 'packages/kit/src/client/fonts/inter-latin.woff2');
const work = mkdtempSync(join(tmpdir(), 'tablewalk-theme-tooling-'));
after(() => rmSync(work, { recursive: true, force: true }));

/* A draft with a failure of every kind: an orange too light on white as the text its accent is drawn in, a red too
   light, a muted ink too dark on the dark ground, a palette's own accent ink, and two blues side by side in the
   chart. The orange is fine as a fill: the words on it are derived. */
const WORKSHOP = `import { defineTheme } from '@mistriwork/mistri/app';

export const workshop = defineTheme({
  id: 'garage',
  label: 'Garage',
  extends: 'lumen',
  colors: {
    light: {
      accent: '#e8590c',
      accentInk: '#e8590c',
      link: '#e8590c',
      nav: { accent: '#e8590c' },
      status: { critical: '#ff6b6b' },
      chart: ['#2557e0', '#3559e6', '#0e9a6c', '#d97706', '#e0428a', '#0e8fb0', '#a3510b', '#94a3b8'],
    },
    dark: {
      inkMuted: '#555555',
    },
  },
  palettes: [
    {
      id: 'racing',
      label: 'Racing green',
      light: { accent: '#3a9a5a', accentInk: '#3a9a5a' },
      dark: {},
    },
  ],
  type: {
    font: { heading: 'Workshop Sans, sans-serif' },
    faces: [{ family: 'Workshop Sans', src: './fonts/workshop.woff2', weight: '100 900' }],
  },
});
`;
const APP = `import { defineApp, listView } from '@mistriwork/mistri/app';
import { workshop } from './theme.ts';

export default defineApp({
  id: 'tiny',
  name: 'Tiny',
  connection: 'tick',
  resources: { task: {} },
  views: { tasks: listView('Tasks', 'task') },
  home: 'tasks',
  ui: { customThemes: [workshop], theme: { preset: 'garage' } },
});
`;

/** The spec the draft's defineTheme takes, as an object: the same text, evaluated. */
const spec = (): ThemeSpec =>
  new Function(`return (${WORKSHOP.slice(WORKSHOP.indexOf('defineTheme(') + 'defineTheme('.length, WORKSHOP.lastIndexOf(');'))});`)();
const compiled = (raw: unknown = spec(), faces = true): ThemeDefinition => compileAppTheme(raw, 'ui.customThemes[0]', new Set(), { faces });

function appDir(name: string, files: Record<string, string>): string {
  const dir = join(work, name);
  mkdirSync(join(dir, 'fonts'), { recursive: true });
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  mkdirSync(join(dir, 'node_modules', '@mistriwork'), { recursive: true });
  symlinkSync(join(ROOT, 'packages', 'mistri'), join(dir, 'node_modules', '@mistriwork', 'mistri'), 'dir');
  copyFileSync(INTER, join(dir, 'fonts', 'workshop.woff2'));
  for (const [file, text] of Object.entries({ 'package.json': '{ "type": "module" }\n', ...files })) writeFileSync(join(dir, file), text);
  return dir;
}

describe('a theme ships its own faces', () => {
  test('only where an App serves it, from a file in its directory, said as WOFF2 or WOFF', () => {
    assert.throws(() => compiled(spec(), false), /type\.faces ships font files from an App's directory/);
    for (const src of ['../outside.woff2', 'https://fonts.example/x.woff2', './fonts/x.ttf', '/abs/x.woff2'])
      assert.throws(() => compiled({ ...spec(), type: { faces: [{ family: 'X', src }] } }), /src/, src);
    assert.throws(
      () =>
        compiled({
          ...spec(),
          type: {
            faces: [
              { family: 'X', src: './a.woff2' },
              { family: 'X', src: './b.woff2' },
            ],
          },
        }),
      /X/,
    );
    const theme = compiled();
    assert.deepEqual(theme.faces, [{ family: 'Workshop Sans', src: './fonts/workshop.woff2', weight: '100 900', style: 'normal' }]);
    // Preloaded only once the server has read it and said where it is served.
    assert.equal(headingFace(theme), undefined);
  });

  test('read from inside the App only, by its first bytes; refused with the file named', async () => {
    const dir = appDir('faces-read', {});
    const app = (src: string) => ({ id: 'tiny', ui: { customThemes: [compiled({ ...spec(), type: { faces: [{ family: 'W', src }] } })] } });
    const fonts = await readAppFonts(app('./fonts/workshop.woff2'), dir, 'app.ts');
    const [name] = Object.keys(fonts!.files);
    assert.match(name!, /^workshop-[0-9a-f]{12}\.woff2$/);
    assert.equal(fonts!.sources[name!], 'fonts/workshop.woff2');
    await assert.rejects(
      readAppFonts(app('./fonts/missing.woff2'), dir, 'app.ts'),
      /"\.\/fonts\/missing\.woff2" is not a file in the App's directory/,
    );
    writeFileSync(join(dir, 'fonts', 'fake.woff2'), 'not a font at all');
    await assert.rejects(readAppFonts(app('./fonts/fake.woff2'), dir, 'app.ts'), /is not a WOFF2 file/);
    symlinkSync(INTER, join(dir, 'fonts', 'linked.woff2'));
    await assert.rejects(readAppFonts(app('./fonts/linked.woff2'), dir, 'app.ts'), /leads outside the App's directory/);
    await assert.rejects(readAppFonts(app('./fonts/workshop.woff2'), undefined, 'app.ts'), /load the App from its directory/);
  });

  /* A font as a foundry ships it: Noto Sans, every script it covers, made a WOFF2 whole. */
  const NOTO = join(ROOT, 'node_modules/harfbuzzjs/test/fonts/noto/NotoSans-Regular.ttf');
  test('cut to Latin as it is read, unless it says subset: false', { skip: !existsSync(NOTO) && 'no whole font to cut' }, async () => {
    const dir = appDir('faces-cut', {});
    const subset = (await import('subset-font')).default;
    writeFileSync(join(dir, 'fonts', 'noto.woff2'), await subset(readFileSync(NOTO), '', { targetFormat: 'woff2', keepAllGlyphs: true }));
    const whole = readFileSync(join(dir, 'fonts', 'noto.woff2')).length;
    const app = (cut?: false) => ({
      id: 'tiny',
      ui: {
        customThemes: [
          compiled({
            ...spec(),
            type: { faces: [{ family: 'Noto', src: './fonts/noto.woff2', ...(cut === false ? { subset: false } : {}) }] },
          }),
        ],
      },
    });
    const latin = Object.values((await readAppFonts(app(), dir, 'app.ts'))!.files)[0]!;
    assert.equal(latin.subarray(0, 4).toString('latin1'), 'wOF2');
    assert.ok(latin.length * 3 < whole, `${latin.length} of ${whole}`);
    assert.equal(Object.values((await readAppFonts(app(false), dir, 'app.ts'))!.files)[0]!.length, whole);
    assert.throws(
      () => compiled({ ...spec(), type: { faces: [{ family: 'N', src: './n.woff2', subset: true }] } }),
      /subset must be false/,
    );
  });

  test('served by its content name, kept a year; nothing undeclared answers', async () => {
    const fonts: AppFonts = { files: { 'workshop-0123456789ab.woff2': readFileSync(INTER) }, sources: {} };
    const server = createServer((req, res) => {
      if (!fontRoute({ req, res }, new URL(req.url!, 'http://x').pathname, (id) => (id === 'tiny' ? fonts : undefined)))
        res.writeHead(418).end();
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const ok = await fetch(`${origin}/tiny/_fonts/workshop-0123456789ab.woff2`);
      assert.equal(ok.status, 200);
      assert.equal(ok.headers.get('content-type'), 'font/woff2');
      assert.match(ok.headers.get('cache-control')!, /immutable/);
      assert.equal(
        Buffer.from(await ok.arrayBuffer())
          .subarray(0, 4)
          .toString('latin1'),
        'wOF2',
      );
      assert.equal((await fetch(`${origin}/tiny/_fonts/app-0123456789ab.woff2`)).status, 404);
      assert.equal((await fetch(`${origin}/other/_fonts/workshop-0123456789ab.woff2`)).status, 404);
      assert.equal((await fetch(`${origin}/tiny/_fonts/../app.ts`)).status, 418);
    } finally {
      server.close();
    }
  });

  test('check warns past the budget and on a stack that cannot fall back, and sums the faces in one line', async () => {
    const dir = appDir('faces-warn', {});
    const theme = compiled({
      ...spec(),
      type: {
        font: { heading: 'Workshop Sans' },
        faces: [
          { family: 'Workshop Sans', src: './fonts/workshop.woff2' },
          { family: 'Unused', src: './fonts/workshop.woff2', weight: 700 },
        ],
      },
    });
    const app = { id: 'tiny', ui: { customThemes: [theme] } };
    const fonts = await readAppFonts(app, dir, 'app.ts');
    const warnings = fontWarnings(app, fonts);
    assert.ok(
      warnings.some((line) => /ships the face "Unused".*never drawn/.test(line)),
      warnings.join('\n'),
    );
    assert.ok(warnings.some((line) => /leads with/.test(line)) === false, 'a shipped family needs no fallback');
    const big = {
      ...fonts!,
      files: { ...fonts!.files, 'big-000000000000.woff2': Buffer.alloc(160 * 1024) },
      sources: { ...fonts!.sources, 'big-000000000000.woff2': 'fonts/big.woff2' },
    };
    // The big file is one more face of the same theme: its faces together are what a page wearing it fetches.
    const heavy = {
      ...theme,
      faces: [
        ...theme.faces!,
        { family: 'Workshop Sans', src: './fonts/big.woff2', weight: '900', style: 'normal' as const, file: 'big-000000000000.woff2' },
      ],
    };
    const heavyApp = { id: 'tiny', ui: { customThemes: [heavy] } };
    const over = fontWarnings(heavyApp, big);
    assert.ok(over.some((line) => /fonts\/big\.woff2 is 160 KB as served.*subset: false/.test(line)));
    assert.ok(over.some((line) => /past the 150 KB budget/.test(line)));
    assert.match(fontBudgetProblem(heavyApp, big)!, /the theme "garage" 200 KB are past the 150 KB budget/);
    assert.equal(fontBudgetProblem(app, fonts), undefined);
    /* Each theme is its own budget: a page wears one, and fetches only its faces. Two themes of 100 KB each are
       within it, though the App serves 200 KB in all. */
    const split = {
      files: { 'a-000000000000.woff2': Buffer.alloc(100 * 1024), 'b-000000000000.woff2': Buffer.alloc(100 * 1024) },
      sources: { 'a-000000000000.woff2': 'fonts/a.woff2', 'b-000000000000.woff2': 'fonts/b.woff2' },
    };
    const face = (file: string) => ({
      family: 'Workshop Sans',
      src: `./fonts/${file[0]}.woff2`,
      weight: '400',
      style: 'normal' as const,
      file,
    });
    const twoThemes = {
      id: 'tiny',
      ui: {
        customThemes: [
          { ...theme, id: 'first', faces: [face('a-000000000000.woff2')] },
          { ...theme, id: 'second', faces: [face('b-000000000000.woff2')] },
        ],
      },
    };
    assert.equal(fontBudgetProblem(twoThemes, split), undefined);
    assert.equal(fontSummary(app, fonts), '2 faces, 40 KB, heading preloaded');
    const stranger = {
      id: 'tiny',
      ui: {
        customThemes: [
          compiled({
            ...spec(),
            type: { font: { ui: 'Brand Grotesk' }, faces: [{ family: 'Workshop Sans', src: './fonts/workshop.woff2' }] },
          }),
        ],
      },
    };
    assert.ok(fontWarnings(stranger, fonts).some((line) => /type\.font\.ui leads with "Brand Grotesk".*no generic family/.test(line)));
    assert.match(
      faceRules(theme, (href) => href)!,
      /^@font-face\{font-family:"Workshop Sans";src:url\("\/tiny\/_fonts\/workshop-[0-9a-f]{12}\.woff2"\) format\("woff2"\)/,
    );
    assert.equal(headingFace(theme)?.family, 'Workshop Sans');
    /* The faces past their budget break the contract's C11 (stays fast); a face of its own is a font's matter. */
    for (const line of [...warnings, ...over])
      assert.equal(validationCode(line), /past the \d+ KB budget/.test(line) ? 'theme-budget' : 'theme-font', line);
  });
});

describe('a theme failure is coded by the promise it breaks', () => {
  test("a control's edge is theme-edge (C2), the ring theme-focus (C3), a dark light mode's accent theme-print (C12)", () => {
    const theme = compiled({
      id: 'night',
      label: 'Night',
      extends: 'lumen',
      colors: {
        light: {
          ground: '#101114',
          surface: '#17181c',
          raised: '#1f2025',
          ink: '#f2f2f2',
          inkMuted: '#c4c4c4',
          inkSubtle: '#b4b4b4',
          accent: '#8fb4ff',
          link: '#8fb4ff',
          lineControl: '#2a2b30',
          focus: '#22252c',
        },
      },
    } as never);
    const coded = new Map<string, string[]>();
    for (const problem of checkThemeWithFixes(theme)) {
      const code = validationCode(problem.message);
      coded.set(code, [...(coded.get(code) ?? []), problem.check]);
    }
    assert.ok(
      coded.get('theme-edge')?.some((check) => check.startsWith('lineControl on surface')),
      JSON.stringify([...coded]),
    );
    assert.ok(coded.get('theme-focus')?.includes('focus on surface'), JSON.stringify([...coded]));
    assert.deepEqual(coded.get('theme-print'), ['accentInk on printed paper', 'link on printed paper']);
    for (const preset of THEME_PRESETS)
      assert.deepEqual(
        /* A built-in's chart order is checked only where a theme writes its own (charts are the authored roles'). */
        checkTheme(preset)
          .map((problem) => problem.check)
          .filter((check) => !check.includes(' beside ')),
        [],
        `${preset.id} keeps every color promise the spec decides`,
      );
  });
});

describe('a theme failure says the value that passes', () => {
  test('each color fix is of its own hue and passes the checks it failed; a chart fix is the same series reordered', () => {
    const theme = compiled();
    const problems = checkThemeWithFixes(theme);
    assert.ok(problems.length > 10);
    for (const problem of problems) {
      assert.ok(problem.fix, problem.message);
      assert.match(problem.message, /Try /);
      /* Each failure is coded by the promise it breaks: a chart's order C7, a control's edge C2, the focus ring C3,
         paper C12, words C1. */
      const expected = problem.check.includes(' beside ')
        ? 'theme-chart'
        : problem.role === 'lineControl'
          ? 'theme-edge'
          : problem.role === 'focus' || problem.check.endsWith(' focus ring')
            ? 'theme-focus'
            : problem.check.endsWith(' on printed paper')
              ? 'theme-print'
              : 'theme-contrast';
      assert.equal(validationCode(problem.message), expected, problem.message);
    }
    const accent = problems.find((problem) => problem.at === 'colors.light.accentInk')!;
    assert.match(accent.message, /\(accentInk is #e8590c\)\. Try accentInk: '#[0-9a-f]{6}' \(\d\.\d\d:1\)\.$/);
    const racing = problems.find((problem) => problem.at === 'palettes[0].light.accentInk');
    assert.ok(racing?.fix, "a palette's own accent ink is fixed in the palette");
    // A palette that leaves link to the theme is fixed there, once.
    assert.ok(problems.filter((problem) => problem.role === 'link').every((problem) => problem.at === 'colors.light.link'));
    const chart = problems.find((problem) => problem.at === 'colors.light.chart')!;
    assert.deepEqual([...(chart.fix!.value as string[])].sort(), [...(writtenAt(theme, 'colors.light.chart') as string[])].sort());

    // Every fix written, the theme passes: what `check --fix` does, in memory.
    const raw = structuredClone(spec()) as Record<string, any>;
    for (const { fix } of problems) {
      const steps = [...fix!.path.matchAll(/([A-Za-z]\w*)|\[(\d+)\]/g)].map((m) => (m[2] !== undefined ? Number(m[2]) : m[1]!));
      let at = raw;
      for (const step of steps.slice(0, -1)) at = at[step] ??= {};
      at[steps.at(-1)!] = fix!.value;
    }
    const fixed = compiled(raw);
    const left = checkTheme(fixed, {}).filter((problem) => problem.themeId === 'garage');
    /* Each fix is proved alone; written together, one can move a pair another fixed (an accent darkened beside
       its own tint, and the pill menu's current entry on that tint): what is left, a second run fixes. */
    assert.ok(left.length <= 3, left.map((problem) => problem.message).join('\n'));
    assert.equal(checkThemeWithFixes(fixed).filter((problem) => !problem.fix).length, 0);
  });

  test('the summary counts what to change per theme, palette and mode', () => {
    const theme = compiled();
    assert.equal(themeSummary([theme], checkThemeWithFixes(theme)), 'Garage light: 5 to fix · dark: 1 · Racing green light: 1');
    assert.equal(themeSummary([THEME_PRESETS[0]!], []), '1 theme, 12 palettes: every color passes, light and dark');
  });

  test("a fix is written into the theme's own source: a literal replaced, an inherited color added beside its kin", () => {
    const dir = appDir('fix-source', { 'theme.ts': WORKSHOP, 'app.ts': APP });
    assert.deepEqual(themePlace(dir, 'garage', 'colors.light.status.critical'), { file: join(dir, 'theme.ts'), line: 13 });
    assert.equal(themePlace(dir, 'garage', 'palettes[0].light.accentInk')?.line, 24);
    // An inherited color is placed at the nearest key that would say it.
    assert.equal(themePlace(dir, 'garage', 'palettes[0].dark.inkMuted')?.line, 25);
    const said = (path: string, value: string | string[]) => ({ path, value, said: `${path}: ${value}` });
    assert.ok('done' in writeThemeFix(dir, 'garage', said('colors.light.accentInk', '#ba4400'), '#e8590c'));
    assert.ok('done' in writeThemeFix(dir, 'garage', said('palettes[0].dark.inkMuted', '#868686'), undefined));
    assert.ok('done' in writeThemeFix(dir, 'garage', said('colors.dark.status.critical', '#ff8080'), undefined));
    const order = ['#2557e0', '#0e9a6c', '#3559e6', '#d97706', '#e0428a', '#0e8fb0', '#a3510b', '#94a3b8'];
    assert.ok('done' in writeThemeFix(dir, 'garage', said('colors.light.chart', order), writtenAt(compiled(), 'colors.light.chart')));
    // Not the value it was read as: left, and said.
    assert.match((writeThemeFix(dir, 'garage', said('colors.light.link', '#c34700'), '#123456') as { left: string }).left, /by hand/);
    const text = readFileSync(join(dir, 'theme.ts'), 'utf8');
    assert.match(text, /accentInk: '#ba4400',\n {6}link: '#e8590c'/);
    assert.match(text, /dark: \{ inkMuted: '#868686' \}/);
    assert.match(text, /inkMuted: '#555555',\n {6}status: \{ critical: '#ff8080' \},\n/);
    assert.match(text, /chart: \['#2557e0', '#0e9a6c', '#3559e6'/);
  });
});

describe('theme show', () => {
  test('marks each value with where it comes from, and --diff says only what changed', () => {
    const shown = showTheme(compiled());
    assert.equal(shown.extends, 'lumen');
    assert.deepEqual(shown.colors.default!.light['accent'], { value: '#e8590c', from: 'own' });
    assert.deepEqual(shown.colors.default!.light['ground'], { value: '#ffffff', from: 'lumen' });
    assert.equal(shown.colors.racing!.light['accent']!.from, 'own');
    assert.equal(shown.colors.racing!.light['ground']!.from, 'default');
    assert.equal(shown.recipes.nav!.from, 'lumen');
    assert.equal(shown.type.fonts.heading.from, 'own');
    assert.equal(shown.type.faces[0]!.family, 'Workshop Sans');
    const lumen = THEME_PRESETS.find((theme) => theme.id === 'lumen')!;
    const differences = diffThemes(shown, showTheme(lumen));
    assert.ok(differences.some((item) => item.name === 'colors.light.accent' && item.other === '#2d4fd6'));
    assert.ok(!differences.some((item) => item.name === 'colors.light.ground' || item.name.startsWith('recipes.')));
    // The distance says it by kind: colors changed, no recipe part, so the same look in a new coat.
    const distance = themeDistance(differences);
    assert.equal(distance.recipes, 0);
    assert.equal(distance.of, RECIPE_PARTS.length);
    assert.ok(distance.colors > 0);
  });

  test("the looks page's recipe table is the one theme show prints", () => {
    const page = readFileSync(join(ROOT, 'site/src/content/docs/docs/looks.md'), 'utf8');
    const start = page.indexOf('## Recipes, look by look');
    const section = page.slice(start, page.indexOf('\n## ', start + 1));
    const rows = section
      .split('\n')
      .filter((line) => line.startsWith('| `'))
      .map((line) =>
        line
          .split('|')
          .slice(1, -1)
          .map((cell) => cell.trim().replace(/`/g, '')),
      );
    const header = section
      .split('\n')
      .find((line) => line.startsWith('| Part'))!
      .split('|')
      .slice(2, -1)
      .map((cell) => cell.trim());
    const shown = THEME_PRESETS.map(showTheme);
    assert.deepEqual(
      header,
      shown.map((theme) => theme.label),
    );
    assert.deepEqual(
      rows.map(([part]) => part),
      Object.keys(shown[0]!.recipes),
    );
    for (const [part, ...values] of rows)
      assert.deepEqual(
        values,
        shown.map((theme) => theme.recipes[part!]!.value),
        part,
      );
  });
});

test("shot and grade wear a built-in look or the App's own theme, and a palette every one of them has", () => {
  const loaded = {
    app: { id: 'tiny', name: 'Tiny', ui: { customThemes: [compiled()], theme: { preset: 'garage' } } },
  } as unknown as LoadedApp;
  assert.deepEqual(
    shotLooks(loaded, ['all']).map((look) => [look.theme, look.own]),
    [...THEME_PRESETS.map((theme) => [theme.id, false]), ['garage', true]],
  );
  assert.deepEqual(shotLooks(loaded, [], 'racing'), [
    { app: 'tiny', theme: 'garage', own: true, palette: 'racing', label: 'Garage Racing green' },
  ]);
  assert.deepEqual(shotLooks(loaded, []), []);
  assert.throws(() => shotLooks(loaded, ['harbor']), /"harbor" is not a look: .*Tiny"'s own \(garage\)/);
  assert.throws(() => shotLooks(loaded, ['mono'], 'racing'), /--palette "racing" is not a palette of Mono/);
});

test('check says the fix at the line, check --fix writes it and the next run passes; build ships the fonts', async () => {
  const db = join(work, 'tick.db');
  spawnSync(process.execPath, [join(ROOT, 'examples/databases/tick/seed.mjs'), db], { encoding: 'utf8' });
  const dir = appDir('draft', { 'theme.ts': WORKSHOP, 'app.ts': APP });
  const env = { ...process.env, XDG_CONFIG_HOME: join(work, 'xdg') };
  const run = (args: string[]) =>
    new Promise<{ code: number; out: string }>((done) =>
      execFile(process.execPath, ['--import', 'tsx', ENTRY, ...args], { cwd: ROOT, env, timeout: 240_000 }, (error, out) =>
        done({ code: (error as { code?: number } | null)?.code ?? 0, out }),
      ),
    );
  const first = await run(['check', '--app', dir, '--config', `${db}.json`, '--json']);
  assert.equal(first.code, 4, first.out);
  const report = JSON.parse(first.out) as { steps: Array<{ step: string; detail: string }>; problems: Array<Record<string, any>> };
  assert.deepEqual(report.steps.slice(0, 2), [
    { step: 'themes', status: 'failed', detail: 'Garage light: 5 to fix · dark: 1 · Racing green light: 1' },
    { step: 'fonts', status: 'passed', detail: '1 face, 40 KB, heading preloaded' },
  ]);
  const critical = report.problems.find((problem) => problem.path === 'ui.customThemes.garage.colors.light.status.critical')!;
  assert.equal(critical.code, 'theme-contrast');
  assert.equal(critical.line, 13);
  assert.match(critical.file, /theme\.ts$/);
  assert.match(critical.fix, /^status\.critical: '#[0-9a-f]{6}' \(\d\.\d\d:1\) \(mistri check --fix writes it\)$/);

  const fixed = await run(['check', '--app', dir, '--config', `${db}.json`, '--fix']);
  assert.equal(fixed.code, 0, fixed.out);
  assert.match(fixed.out, /fix\s+passed\s+\d+ theme colors written/);
  const again = await run(['check', '--app', dir, '--config', `${db}.json`]);
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /themes\s+passed\s+1 theme, 1 palette: every color passes, light and dark/);

  const out = join(work, 'built');
  const built = await run(['build', '--app', dir, '--out', out]);
  assert.equal(built.code, 0, built.out);
  assert.match(built.out, /fonts: fonts\/workshop\.woff2 \(workshop-[0-9a-f]{12}\.woff2\)/);
  const { loadApp } = await import('../packages/mistri/src/server/app/apps.js');
  const loaded = await loadApp(out);
  // The build ships the face as served, cut to Latin, and serving it reads it back as it is.
  const served = Object.values(loaded.fonts!.files).map((bytes) => bytes.length);
  assert.equal(served.length, 1);
  assert.ok(served[0]! < readFileSync(INTER).length, `${served[0]}`);
});
